import { getRegisteredCache, registerCache } from "./registry.js";

export interface CacheOptions {
  defaultTtl?: number;
  maxSize?: number;
}

export interface SetOptions {
  ttl?: number;
}

interface Entry<T> {
  value: T;
  expiresAt: number | null;
}

export class Cache<T = unknown> {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private readonly defaultTtl: number | null;
  private readonly maxSize: number | null;
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
    if (options.defaultTtl != null) {
      if (!Number.isFinite(options.defaultTtl) || options.defaultTtl <= 0) {
        throw new TypeError(
          `defaultTtl must be a finite positive number (ms), got ${options.defaultTtl}`,
        );
      }
    }
    this.defaultTtl = options.defaultTtl ?? null;
    this.maxSize = options.maxSize ?? null;
  }

  set(key: string, value: T, options: SetOptions = {}): void {
    const ttl = options.ttl ?? this.defaultTtl;

    if (ttl != null && !Number.isFinite(ttl)) {
      throw new TypeError(`ttl must be a finite number, got ${ttl}`);
    }

    if (ttl != null && ttl <= 0) {
      this.store.delete(key);
      return;
    }

    const expiresAt = ttl != null ? Date.now() + ttl : null;

    // Delete-then-set so overwrites move the key to most-recently-used.
    this.store.delete(key);
    if (this.isAtCapacity(key)) this.evictOldest();

    this.store.set(key, { value, expiresAt });
    if (expiresAt != null) this.scheduleSweepIfSooner(expiresAt);
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    // LRU bump.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  mget(keys: string[]): Partial<Record<string, T>> {
    const result: Partial<Record<string, T>> = {};
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  mset(entries: Record<string, T>, options: SetOptions = {}): void {
    for (const [key, value] of Object.entries(entries)) {
      this.set(key, value, options);
    }
  }

  incr(this: Cache<number>, key: string, delta: number = 1): number {
    if (this.get(key) === undefined) {
      // Fresh counters never inherit defaultTtl.
      if (this.isAtCapacity(key)) this.evictOldest();
      this.store.set(key, { value: delta, expiresAt: null });
      return delta;
    }

    const entry = this.store.get(key)!;
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
    if (this.get(key) === undefined) return false;

    if (ttl <= 0) {
      this.store.delete(key);
      return true;
    }

    const entry = this.store.get(key)!;
    entry.expiresAt = Date.now() + ttl;
    this.scheduleSweepIfSooner(entry.expiresAt);
    return true;
  }

  async getOrCompute(
    key: string,
    compute: () => T | Promise<T>,
    options: SetOptions = {},
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

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
    if (this.nextSweepAt != null && this.nextSweepAt <= when) return;
    this.cancelSweep();
    this.nextSweepAt = when;
    const delay = Math.max(0, when - Date.now());
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
