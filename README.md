# suncache

> Process-local in-memory cache for Node.js with TTL, named instances, and stampede protection.

Lives inside your Node.js process — no separate service, no network. But named caches don't lose state when modules re-evaluate, so the cache survives hot-reload, ESM/CJS duplication, and serverless warm starts. Single-process; not for sharing across servers.

```ts
import { Cache } from "suncache";

const users = Cache.for<User>("users", { defaultTtl: 60_000, maxSize: 1_000 });

users.set("u1", alice);
users.get("u1");   // → alice
```

## Features

- Named caches shared across module reloads (HMR, ESM/CJS duplication, serverless warm starts)
- Per-key and default TTL with both lazy and on-demand active expiry
- `getOrCompute` with built-in stampede protection
- `mget` / `mset` batch helpers
- `incr` / `decr` / `expire` for counter and TTL ergonomics
- LRU eviction with `maxSize`
- TypeScript-first, fully typed, ESM
- Zero runtime dependencies
- Node 20+

## Install

```sh
npm install suncache
```

## Usage

### Named cache (recommended)

```ts
import { Cache } from "suncache";

const users = Cache.for<User>("users", {
  defaultTtl: 60_000,
  maxSize: 1_000,
});

users.set("u1", alice);
users.set("u2", bob, { ttl: 5_000 });   // override TTL for this entry
users.get("u1");                         // User | undefined
users.has("u1");                         // boolean
users.del("u1");
users.clear();
```

Two calls to `Cache.for("users")` anywhere in the process return the same instance — that's the whole point. Survives:

- Hot-reload (Next.js, Vite, `tsx --watch`)
- Warm-start invocations on serverless platforms
- ESM/CJS dual-package situations where two copies of suncache get loaded

### One-off cache

```ts
const tmp = new Cache<string>({ defaultTtl: 1_000 });
```

`new Cache()` skips the registry — useful for tests, request-scoped state, or anywhere you want to manage the lifetime yourself.

## API

```ts
class Cache<T = unknown> {
  static for<T>(name: string, options?: CacheOptions): Cache<T>;
  constructor(options?: CacheOptions);

  set(key: string, value: T, options?: { ttl?: number }): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  del(key: string): boolean;
  clear(): void;
  keys(): string[];
  readonly size: number;

  mget(keys: string[]): Partial<Record<string, T>>;
  mset(entries: Record<string, T>, options?: { ttl?: number }): void;

  incr(this: Cache<number>, key: string, delta?: number): number;
  decr(this: Cache<number>, key: string, delta?: number): number;
  expire(key: string, ttl: number): boolean;

  getOrCompute(
    key: string,
    compute: () => T | Promise<T>,
    options?: { ttl?: number },
  ): Promise<T>;
}

interface CacheOptions {
  defaultTtl?: number;   // ms; finite positive number; entries without per-set ttl use this
  maxSize?: number;      // positive integer; LRU-evict least-recently-used entry when exceeded
}
```

### `Cache.for(name, options?)`

Returns the cache registered under `name`, creating one on first call. `options` is only read on creation — subsequent calls with the same name return the existing instance and ignore their `options` argument (same semantics as `Symbol.for`).

### `new Cache(options?)`

Creates a fresh, unregistered cache instance. Caller manages its lifetime — useful for tests, request-scoped state, or anywhere you want isolation from the global registry.

### `Cache.set(key, value, options?)`

Stores `value` under `key`. `options.ttl` (or the cache's `defaultTtl`) sets how many ms the entry lives. `ttl <= 0` deletes the key without storing. Overwriting an existing key replaces both value and TTL **and bumps the entry to MRU**. New entries land at MRU; when the cache is at `maxSize`, inserting a new key first evicts the LRU entry.

### `Cache.get(key)`

Returns the cached value, or `undefined` if the key is missing or expired. On hit, the entry is bumped to most-recently-used. Expired entries are deleted on access (lazy expiry).

### `Cache.has(key)`

Returns `true` if the key is present and not expired. Internally calls `get`, so it also bumps LRU and deletes expired entries on observation — not a pure read.

### `Cache.del(key)`

Deletes the entry. Returns `true` if the key was in the store, `false` otherwise. Doesn't distinguish between live and expired-pending-cleanup — an entry that has passed its TTL but hasn't been cleaned will still return `true`.

### `Cache.clear()`

Empties the cache, cancels any pending expiry timer, and invalidates any in-flight `getOrCompute` calls — their eventual results are still returned to awaiters but **not** written back into the cache.

### `Cache.keys()`

Returns the live keys in least-recently-used → most-recently-used order. Expired entries are deleted as they're encountered during the walk.

### `Cache.size`

Raw entry count of the underlying store, including expired entries that haven't been cleaned up yet. Use `keys().length` if you need the live count.

### `Cache.mget(keys)`

Batch read. Returns an object keyed by the input keys, with missing or expired entries omitted (so `result.missing` is `undefined` and `'missing' in result` is `false`). Each hit bumps the entry's LRU position.

```ts
const result = cache.mget(["u1", "u2", "u3"]);
const alice = result.u1;   // User | undefined
```

### `Cache.mset(entries, options?)`

Batch write. Stores every key/value pair from the object literal. An optional `options.ttl` applies the same TTL to every entry in the batch; otherwise `defaultTtl` is used per entry. If `options.ttl <= 0`, every entry is deleted instead of stored (same as `set` semantics applied per-entry).

```ts
cache.mset({ u1: alice, u2: bob });
cache.mset({ q1: r1, q2: r2 }, { ttl: 30_000 });   // 30s TTL for the batch
```

### `Cache.incr(key, delta?)`

Counter increment, only available on `Cache<number>`. Increments the value at `key` by `delta` (default `1`) and returns the new value. Missing keys start at `0` and are created **without a TTL** — `defaultTtl` is *not* applied when `incr` creates a new counter. Existing TTLs are preserved across increments. Always lands at MRU — existing entries are bumped, new entries are appended to MRU position.

```ts
counter.incr("views");        // 1, 2, 3, ...
counter.incr("hits", 10);     // +10

// TTL'd counter — initialize once, then incr:
if (!counter.has("rate:1.2.3.4")) {
  counter.set("rate:1.2.3.4", 0, { ttl: 60_000 });
}
const count = counter.incr("rate:1.2.3.4");
if (count > 100) throw new Error("rate limit");
```

### `Cache.decr(key, delta?)`

Counter decrement, only available on `Cache<number>`. Equivalent to `incr(key, -delta)` — same TTL and LRU semantics.

```ts
counter.decr("tokens");       // -1
counter.decr("balance", 50);  // -50
```

### `Cache.expire(key, ttl)`

Sets or refreshes the TTL on an existing entry without touching its value. Returns `true` if the key existed (whether the TTL was refreshed or the entry was deleted via `ttl <= 0`), `false` if it was missing or already expired.

```ts
cache.expire("session:abc", 30 * 60_000);   // refresh to 30 minutes
```

**Bumps LRU order.** Refreshing TTL counts as a use of the entry — it gets promoted to most-recently-used, protecting it from `maxSize` eviction. This makes the common "keep this session alive" pattern work with a single call.

### `Cache.getOrCompute(key, compute, options?)`

Returns the cached value (bumped to MRU on hit), or runs `compute` and caches its result on miss. Concurrent callers for the same missing key share a single `compute` call — no thundering herd:

```ts
const user = await cache.getOrCompute(`user:${id}`, async () => {
  return await db.fetchUser(id);
});
```

If `compute` throws or rejects, the error propagates to all waiters and nothing is cached — the next call retries. Use `options.ttl` to set a per-call TTL.

If `clear()` runs while a `compute` is in flight, the eventual value still resolves to its awaiters but is **not** written back into the cache.

## How expiry works

- **Lazy** — `get`, `has`, and `keys` clean up expired entries the moment they touch them.
- **Active** — when you `set` an entry with a TTL, the cache schedules one `setTimeout` that fires at exactly that expiration time. When it fires, every expired entry is deleted and the next-soonest expiration is rescheduled. No periodic polling; if nothing has a TTL, no timer runs.

## Gotchas

- `Cache.for(name, options)` ignores `options` after the first call (first call wins).
- `Cache.for<T>(name)` doesn't enforce that two callers use the same `T`. Pick one type per cache name.
- Concurrent async "get-then-set" callers can both miss and double-fetch. Use `getOrCompute` to dedupe automatically.
- Invalid options throw `TypeError`: `maxSize` must be a positive integer; `defaultTtl` must be a finite positive number (ms); per-call `ttl` must be a finite number (`<= 0` is a valid "delete" sentinel, but `NaN` / `Infinity` are rejected).

## Security

The registry is keyed by `Symbol.for("suncache.registry")` on `globalThis`. Every copy of suncache loaded in the same process shares it, so cache names are effectively a process-wide namespace — pick names unlikely to collide with another library's internal caches. When keys come from untrusted input, set `maxSize` to bound memory.

## License

MIT
