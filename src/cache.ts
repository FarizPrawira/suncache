import { WrongTypeError } from "./errors.js";
import { getRegisteredCache, registerCache } from "./registry.js";
import { SortedSet } from "./sorted-set.js";

export interface CacheOptions {
  maxSize?: number;
  sweepDelay?: number;
}

export interface SetOptions {
  ttl?: number;
}

type ValueEntry<T> = {
  kind: "value";
  value: T;
  expiresAt: number | null;
};

type ZSetEntry = {
  kind: "zset";
  value: SortedSet;
  expiresAt: number | null;
};

type Entry<T> = ValueEntry<T> | ZSetEntry;

export class Cache<T = unknown> {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private readonly maxSize: number | null;
  private readonly sweepDelay: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private nextSweepAt: number | null = null;
  private version = 0;

  static for<T = unknown>(name: string, options: CacheOptions = {}): Cache<T> {
    const existing = getRegisteredCache<T>(name);
    if (existing) return existing;

    const cache = new Cache<T>(options);
    registerCache(name, cache as Cache<unknown>);
    return cache;
  }

  constructor(options: CacheOptions = {}) {
    if (options.maxSize != null) {
      if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
        throw new TypeError(
          `maxSize must be a positive integer, got ${options.maxSize}`,
        );
      }
    }
    if (options.sweepDelay != null) {
      if (!Number.isFinite(options.sweepDelay) || options.sweepDelay < 0) {
        throw new TypeError(
          `sweepDelay must be a finite non-negative number (ms), got ${options.sweepDelay}`,
        );
      }
    }
    this.maxSize = options.maxSize ?? null;
    this.sweepDelay = options.sweepDelay ?? 1000;
  }

  set(key: string, value: T, options: SetOptions = {}): void {
    const { ttl } = options;

    if (ttl != null && !Number.isFinite(ttl)) {
      throw new TypeError(`ttl must be a finite number, got ${ttl}`);
    }

    if (ttl != null && ttl <= 0) {
      this.store.delete(key);
      return;
    }

    const expiresAt = ttl != null ? Date.now() + ttl : null;

    // Delete-then-set so overwrites move the key to most-recently-used.
    // No kind guard here: set() overwrites any prior entry, including zsets.
    this.store.delete(key);
    if (this.isAtCapacity(key)) this.evictOldest();

    this.store.set(key, { kind: "value", value, expiresAt });
    if (expiresAt != null) this.scheduleSweepIfSooner(expiresAt);
  }

  get(key: string): T | undefined {
    const entry = this.getLiveEntry(key);
    if (!entry) return undefined;
    this.assertKind(entry, key, "value");
    this.lruBump(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.getLiveEntry(key) !== undefined;
  }

  mget(keys: string[]): Partial<Record<string, T>> {
    const result: Partial<Record<string, T>> = {};
    for (const key of keys) {
      const entry = this.getLiveEntry(key);
      // skip wrong-type entries silently, one bad key shouldn't abort the whole batch.
      if (!entry || entry.kind !== "value") continue;
      this.lruBump(key, entry);
      result[key] = entry.value;
    }
    return result;
  }

  mset(entries: Record<string, T>, options: SetOptions = {}): void {
    for (const [key, value] of Object.entries(entries)) {
      this.set(key, value, options);
    }
  }

  incr(this: Cache<number>, key: string, delta: number = 1): number {
    const entry = this.getLiveEntry(key);
    if (!entry) {
      this.set(key, delta);
      return delta;
    }
    this.assertKind(entry, key, "value");
    this.lruBump(key, entry);
    entry.value += delta;
    return entry.value;
  }

  decr(this: Cache<number>, key: string, delta: number = 1): number {
    return this.incr(key, -delta);
  }

  expire(key: string, ttl: number): boolean {
    if (!Number.isFinite(ttl)) {
      throw new TypeError(`ttl must be a finite number, got ${ttl}`);
    }
    const entry = this.getLiveEntry(key);
    if (!entry) return false;

    if (ttl <= 0) {
      this.store.delete(key);
      return true;
    }

    entry.expiresAt = Date.now() + ttl;
    this.lruBump(key, entry);
    this.scheduleSweepIfSooner(entry.expiresAt);
    return true;
  }

  async getOrCompute(
    key: string,
    compute: () => T | Promise<T>,
    options: SetOptions = {},
  ): Promise<T> {
    // Presence check via getLiveEntry — distinguishes "key is set to
    // undefined" from "key is absent" so a cached undefined still hits.
    const entry = this.getLiveEntry(key);
    if (entry) {
      this.assertKind(entry, key, "value");
      this.lruBump(key, entry);
      return entry.value;
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    // Snapshot before yielding: if clear()/dispose() runs during compute,
    // the version bump invalidates this write so we don't repopulate.
    const startVersion = this.version;

    const promise = (async () => {
      try {
        const value = await compute();
        if (this.version === startVersion) this.set(key, value, options);
        return value;
      } finally {
        if (this.version === startVersion) this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  del(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.version++;
    this.store.clear();
    this.inflight.clear();
    this.cancelSweep();
  }

  get size(): number {
    return this.store.size;
  }

  keys(): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
      } else {
        out.push(key);
      }
    }
    return out;
  }

  zadd(key: string, score: number, member: string): number {
    if (!Number.isFinite(score)) {
      throw new TypeError(`score must be a finite number, got ${score}`);
    }
    const zset = this.getOrCreateZSet(key);
    return zset.add(score, member);
  }

  zrem(key: string, member: string): boolean {
    const entry = this.getZSetEntry(key);
    if (!entry) return false;
    const removed = entry.value.rem(member);
    // Drop the key once the last member is gone — keeps has()/keys() honest.
    if (removed && entry.value.card() === 0) {
      this.store.delete(key);
    }
    return removed;
  }

  zscore(key: string, member: string): number | undefined {
    const entry = this.getZSetEntry(key);
    if (!entry) return undefined;
    return entry.value.score(member);
  }

  zrange(key: string, start: number, stop: number): string[] {
    const entry = this.getZSetEntry(key);
    if (!entry) return [];
    return entry.value.rangeByRank(start, stop);
  }

  zrevrange(key: string, start: number, stop: number): string[] {
    const entry = this.getZSetEntry(key);
    if (!entry) return [];
    return entry.value.revRangeByRank(start, stop);
  }

  zrangebyscore(key: string, min: number, max: number): string[] {
    // Allow ±Infinity for open-ended ranges, but reject NaN — NaN comparisons
    // are always false and would silently return [] otherwise.
    if (Number.isNaN(min) || Number.isNaN(max)) {
      throw new TypeError(`min and max must not be NaN, got min=${min}, max=${max}`);
    }
    const entry = this.getZSetEntry(key);
    if (!entry) return [];
    return entry.value.rangeByScore(min, max);
  }

  zincrby(key: string, delta: number, member: string): number {
    if (!Number.isFinite(delta)) {
      throw new TypeError(`delta must be a finite number, got ${delta}`);
    }
    const zset = this.getOrCreateZSet(key);
    return zset.incrBy(delta, member);
  }

  zcard(key: string): number {
    const entry = this.getZSetEntry(key);
    if (!entry) return 0;
    return entry.value.card();
  }

  private getZSetEntry(key: string): ZSetEntry | undefined {
    const entry = this.getLiveEntry(key);
    if (!entry) return undefined;
    this.assertKind(entry, key, "zset");
    this.lruBump(key, entry);
    return entry;
  }

  // Same as getZSetEntry but creates an empty zset when the key is missing.
  private getOrCreateZSet(key: string): SortedSet {
    const existing = this.getZSetEntry(key);
    if (existing) return existing.value;
    if (this.isAtCapacity(key)) this.evictOldest();
    const zset = new SortedSet();
    this.store.set(key, { kind: "zset", value: zset, expiresAt: null });
    return zset;
  }

  // Fetches an entry that is present and not expired. Sweeps the slot as a
  // side effect when the entry has expired.
  private getLiveEntry(key: string): Entry<T> | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private lruBump(key: string, entry: Entry<T>): void {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  private assertKind<K extends Entry<T>["kind"]>(
    entry: Entry<T>,
    key: string,
    wanted: K,
  ): asserts entry is Extract<Entry<T>, { kind: K }> {
    if (entry.kind !== wanted) {
      throw new WrongTypeError(key, entry.kind, wanted);
    }
  }

  private isExpired(entry: Entry<T>): boolean {
    return entry.expiresAt != null && entry.expiresAt <= Date.now();
  }

  private isAtCapacity(incomingKey: string): boolean {
    return (
      this.maxSize != null &&
      this.maxSize <= this.store.size &&
      !this.store.has(incomingKey)
    );
  }

  private evictOldest(): void {
    // Map iterates in insertion order; set()/get() re-insert on touch, so the
    // first key is the least-recently-used.
    const oldest = this.store.keys().next().value;
    if (oldest !== undefined) this.store.delete(oldest);
  }

  private scheduleSweepIfSooner(when: number): void {
    const target = when + this.sweepDelay;

    if (this.nextSweepAt != null && this.nextSweepAt <= target) return;
    this.cancelSweep();
    this.nextSweepAt = target;
    const delay = Math.max(0, target - Date.now());
    this.sweepTimer = setTimeout(() => this.runSweep(), delay);
    // Don't let a pending sweep keep the Node event loop alive on its own.
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  private cancelSweep(): void {
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.nextSweepAt = null;
  }

  private runSweep(): void {
    this.sweepTimer = null;
    this.nextSweepAt = null;

    let nextExpiry = Infinity;
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
      } else if (entry.expiresAt != null && entry.expiresAt < nextExpiry) {
        nextExpiry = entry.expiresAt;
      }
    }

    if (nextExpiry !== Infinity) this.scheduleSweepIfSooner(nextExpiry);
  }
}
