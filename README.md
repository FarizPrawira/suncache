# suncache

[![npm version](https://img.shields.io/npm/v/suncache.svg)](https://www.npmjs.com/package/suncache)
[![npm downloads](https://img.shields.io/npm/dm/suncache.svg)](https://www.npmjs.com/package/suncache)
![zero dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![types included](https://img.shields.io/badge/types-included-blue)
[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Process-local in-memory cache for Node.js with TTL, sorted sets, named instances, and stampede protection. Single-process; not for sharing across servers.

Lives inside your Node.js process — no separate service, no network. But named caches don't lose state when modules re-evaluate, so the cache survives hot-reload, ESM/CJS duplication, and serverless warm starts.

```ts
import { Cache } from "suncache";

// 1. Named cache survives hot-reload — same instance across module re-evaluation.
const users = Cache.for<User>("users", { maxSize: 1_000 });
users.set("u1", alice, { ttl: 60_000 });
users.get("u1");                              // → alice

// 2. Stampede-safe cache-aside — concurrent callers share one DB fetch.
const user = await users.getOrCompute(`u:${id}`, () => db.fetchUser(id), { ttl: 60_000 });

// 3. Counters and TTL refreshes work without re-reading the value.
const counter = Cache.for<number>("rate-limits");
if (counter.incr(`ip:${ip}`) === 1) counter.expire(`ip:${ip}`, 60_000);

// 4. Sorted sets for leaderboards / top-N / time-windowed feeds.
const board = Cache.for("leaderboards");
board.zadd("global", 1500, "alice");
board.zadd("global", 2300, "bob");
board.zrevrange("global", 0, 9);              // → top 10 by score
```

## Features

- Named caches shared across module reloads (hot-reload, ESM/CJS duplication, serverless warm starts)
- Per-key TTL with both lazy and on-demand active expiry
- `getOrCompute` with built-in stampede protection
- `mget` / `mset` batch helpers
- `incr` / `decr` / `expire` for counter and TTL ergonomics
- Sorted sets: `zadd` / `zrem` / `zrange` / `zrangebyscore` / `zincrby` / …
- LRU eviction with `maxSize`
- TypeScript-first, fully typed, ESM
- Zero runtime dependencies
- Node 20+

## Install

```sh
npm install suncache
# or
pnpm add suncache
# or
yarn add suncache
# or
bun add suncache
```

Both ESM and CommonJS are shipped:

```ts
import { Cache } from "suncache";            // ESM / TypeScript
const { Cache } = require("suncache");       // CommonJS
```

Zero runtime dependencies. DevDeps (tsup, vitest, typescript) are not installed for consumers.

## Usage

### Named cache (recommended)

```ts
import { Cache } from "suncache";

const users = Cache.for<User>("users", { maxSize: 1_000 });

users.set("u1", alice);                  // no TTL — lives until evicted
users.set("u2", bob, { ttl: 5_000 });   // expires after 5s
users.get("u1");                         // User | undefined
users.has("u1");                         // boolean
users.del("u1");
users.clear();
```

Two calls to `Cache.for("users")` anywhere in the process return the same instance — that's the whole point. Survives:

- Hot-reload dev servers re-evaluating modules
- Warm-start invocations on serverless platforms
- ESM/CJS dual-package situations where two copies of suncache get loaded

### One-off cache

```ts
const tmp = new Cache<string>({ maxSize: 100 });
```

`new Cache()` skips the registry — useful for tests, request-scoped state, or anywhere you want isolation from the global registry.

### Sorted sets

A sorted set is an ordered collection of unique `string` members keyed by a numeric `score`. Useful for leaderboards, top-N feeds, time-windowed queues, and anything ordered by a numeric axis.

No type parameter is needed on the cache instance — sorted-set members are always `string` regardless of `Cache<T>`.

```ts
import { Cache } from "suncache";

const board = Cache.for("leaderboards");

board.zadd("global", 1500, "alice");
board.zadd("global", 2300, "bob");
board.zadd("global", 1750, "carol");

board.zrevrange("global", 0, 2);          // ["bob", "carol", "alice"] — top 3
board.zscore("global", "alice");          // 1500
board.zincrby("global", 100, "alice");    // 1600
board.zrangebyscore("global", 1600, 2000); // ["alice", "carol"]
board.zrem("global", "alice");
board.zcard("global");                     // 2
```

A single `Cache` instance can hold scalars, counters, and sorted sets under one key namespace. `set` on a key that holds a zset will overwrite it; other ops throw `WrongTypeError` on a type mismatch (see [Errors](#errors)).

## API

```ts
import { Cache, WrongTypeError } from "suncache";
import type { CacheOptions, SetOptions, EntryKind } from "suncache";

class Cache<T = unknown> {
  static for<T>(name: string, options?: CacheOptions): Cache<T>;
  constructor(options?: CacheOptions);

  // scalar ops
  set(key: string, value: T, options?: SetOptions): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  del(key: string): boolean;
  clear(): void;
  keys(): string[];
  readonly size: number;

  mget(keys: string[]): Partial<Record<string, T>>;
  mset(entries: Record<string, T>, options?: SetOptions): void;

  incr(this: Cache<number>, key: string, delta?: number): number;
  decr(this: Cache<number>, key: string, delta?: number): number;
  expire(key: string, ttl: number): boolean;

  getOrCompute(
    key: string,
    compute: () => T | Promise<T>,
    options?: SetOptions,
  ): Promise<T>;

  // sorted set ops
  zadd(key: string, score: number, member: string): number;
  zrem(key: string, member: string): boolean;
  zscore(key: string, member: string): number | undefined;
  zrange(key: string, start: number, stop: number): string[];
  zrevrange(key: string, start: number, stop: number): string[];
  zrangebyscore(key: string, min: number, max: number): string[];
  zincrby(key: string, delta: number, member: string): number;
  zcard(key: string): number;
}

interface CacheOptions {
  maxSize?: number;      // positive integer; LRU-evict the oldest entry when exceeded; omit for unbounded
  sweepDelay?: number;   // ms; delays expiry sweeps to batch nearby expirations; default 1000
}

interface SetOptions {
  ttl?: number;          // per-call TTL in ms; <= 0 deletes the key
}

type EntryKind = "value" | "zset";

class WrongTypeError extends Error {
  readonly key: string;
  readonly has: EntryKind;
  readonly wanted: EntryKind;
}
```

### `Cache.for(name, options?)`

**O(1).** Returns the cache registered under `name`, creating one on first call. `options` is only read on creation — subsequent calls with the same name return the existing instance and ignore their `options` argument (same semantics as `Symbol.for`).

```ts
const users = Cache.for<User>("users", { maxSize: 1_000 });
```

### `new Cache(options?)`

**O(1).** Creates a fresh, unregistered cache instance. Caller manages its lifetime — useful for tests, request-scoped state, or anywhere you want isolation from the global registry.

```ts
const tmp = new Cache<string>({ maxSize: 100 });
```

### `Cache.set(key, value, options?)`

**O(1).** Stores `value` under `key`. `options.ttl` sets how many ms the entry lives; without it the entry has no TTL. `ttl <= 0` deletes the key without storing. Overwriting an existing key replaces both value and TTL **and bumps the entry to MRU**. New entries land at MRU; when the cache is at `maxSize`, inserting a new key first evicts the LRU entry. `set` will overwrite a key that previously held a sorted set — no type guard.

```ts
cache.set("u1", alice);
cache.set("u2", bob, { ttl: 5_000 });
```

### `Cache.get(key)`

**O(1).** Returns the cached value, or `undefined` if the key is missing or expired. On hit, the entry is bumped to most-recently-used. Expired entries are deleted on access (lazy expiry). Throws `WrongTypeError` if the key holds a sorted set.

```ts
const user = cache.get("u1");   // User | undefined
```

### `Cache.has(key)`

**O(1).** Returns `true` if the key is present and not expired, regardless of kind. Safe to call against sorted-set keys — does not throw.

```ts
if (cache.has("u1")) { /* ... */ }
```

### `Cache.del(key)`

**O(1).** Deletes the entry. Returns `true` if the key was in the store, `false` otherwise. Works on any kind.

```ts
cache.del("u1");   // true | false
```

### `Cache.clear()`

**O(n)** in the cache size. Empties the cache, cancels any pending expiry timer, and invalidates any in-flight `getOrCompute` calls — their eventual results are still returned to awaiters but **not** written back into the cache.

```ts
cache.clear();
```

### `Cache.keys()`

**O(n)** in the cache size. Returns the live keys in least-recently-used → most-recently-used order, regardless of kind. Expired entries are deleted as they're encountered during the walk.

```ts
const all = cache.keys();   // ["lru-key", ..., "mru-key"]
```

### `Cache.size`

**O(1).** Raw entry count of the underlying store, including expired entries that haven't been cleaned up yet. Use `keys().length` if you need the live count.

```ts
console.log(cache.size);
```

### `Cache.mget(keys)`

**O(k)** where `k = keys.length`. Batch read. Returns an object keyed by the input keys, with missing or expired entries omitted. Sorted-set entries are also silently omitted so one wrong-type key doesn't abort the whole batch. Each hit bumps the entry's LRU position.

```ts
const result = cache.mget(["u1", "u2", "u3"]);
const alice = result.u1;   // User | undefined
```

### `Cache.mset(entries, options?)`

**O(k)** where `k` is the number of entries. Stores every key/value pair from the object literal. An optional `options.ttl` applies the same TTL to every entry in the batch; without it the entries have no TTL. If `options.ttl <= 0`, every entry is deleted instead of stored.

```ts
cache.mset({ u1: alice, u2: bob });
cache.mset({ q1: r1, q2: r2 }, { ttl: 30_000 });   // 30s TTL for the batch
```

### `Cache.incr(key, delta?)`

**O(1).** Counter increment, only available on `Cache<number>`. Increments the value at `key` by `delta` (default `1`) and returns the new value. Missing keys start at `0` and are created without a TTL. Existing TTLs are preserved across increments. Bumps LRU. Throws `WrongTypeError` if the key holds a sorted set.

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

**O(1).** Counter decrement, only available on `Cache<number>`. Equivalent to `incr(key, -delta)` — same TTL and LRU semantics.

```ts
counter.decr("tokens");       // -1
counter.decr("balance", 50);  // -50
```

### `Cache.expire(key, ttl)`

**O(1).** Sets or refreshes the TTL on an existing entry without touching its value. Works on any kind. Returns `true` if the key existed (whether the TTL was refreshed or the entry was deleted via `ttl <= 0`), `false` if it was missing or already expired.

```ts
cache.expire("session:abc", 30 * 60_000);   // refresh to 30 minutes
```

**Bumps LRU order.** Refreshing TTL counts as a use of the entry — it gets promoted to most-recently-used, protecting it from `maxSize` eviction. This makes the common "keep this session alive" pattern work with a single call.

### `Cache.getOrCompute(key, compute, options?)`

**O(1)** on hit; cost of `compute` on miss. Returns the cached value (bumped to MRU on hit), or runs `compute` and caches its result on miss. Concurrent callers for the same missing key share a single `compute` call — no thundering herd:

```ts
const user = await cache.getOrCompute(`user:${id}`, async () => {
  return await db.fetchUser(id);
});
```

If `compute` throws or rejects, the error propagates to all waiters and nothing is cached — the next call retries. Use `options.ttl` to set a per-call TTL.

A cached `undefined` is a hit — `compute` is **not** re-run. Distinguishes "the cached value is `undefined`" from "the key is absent."

If `clear()` runs while a `compute` is in flight, the eventual value still resolves to its awaiters but is **not** written back into the cache.

## Sorted set API

The methods below operate on sorted sets — ordered collections of unique `string` members keyed by a numeric `score` — sharing the same key namespace as scalar entries. They throw `WrongTypeError` if the key exists but holds a scalar. Missing keys return zero-valued defaults (`undefined`, `false`, `0`, `[]`) instead of throwing, except `zadd` and `zincrby`, which create the zset on first call. Reads bump the zset's LRU position; writes do too.

Below, `n` refers to the number of members in the targeted zset and `k` to the size of the returned slice.

### `Cache.zadd(key, score, member)`

**O(n).** Adds `member` with `score`. Returns `1` if new, `0` if the member already existed (score updated). `score` must be a finite number.

```ts
cache.zadd("board", 1500, "alice");   // 1
cache.zadd("board", 2300, "alice");   // 0 — updated
```

### `Cache.zrem(key, member)`

**O(n).** Removes `member`. Returns `true` if it existed, `false` otherwise. **Auto-deletes the key** from the cache when the last member is removed.

```ts
cache.zrem("board", "alice");   // true | false
```

### `Cache.zscore(key, member)`

**O(1).** Returns the score, or `undefined` if the member or key is missing.

```ts
const score = cache.zscore("board", "alice");   // number | undefined
```

### `Cache.zrange(key, start, stop)`

**O(k).** Returns members in score-ascending order by rank. Supports negative indices (`-1` is the last element, `-2` second-to-last, etc.). Ties between equal scores are broken lexicographically by member.

```ts
cache.zrange("board", 0, -1);   // all members, lowest score first
```

### `Cache.zrevrange(key, start, stop)`

**O(k).** Same as `zrange` but in descending order. Useful for top-N: `zrevrange(key, 0, 9)` returns the top 10.

```ts
cache.zrevrange("board", 0, 9);   // top 10
```

### `Cache.zrangebyscore(key, min, max)`

**O(log n + k).** Returns members with score in `[min, max]` inclusive, in ascending order. `min`/`max` accept `±Infinity` for open-ended ranges. `NaN` is rejected.

```ts
cache.zrangebyscore("board", 1000, 2000);
cache.zrangebyscore("board", 1500, Infinity);   // everything ≥ 1500
```

### `Cache.zincrby(key, delta, member)`

**O(n).** Adds `delta` to `member`'s score, creating the member with `delta` if it didn't exist. Returns the new score. `delta` must be finite; a result of `NaN` (e.g. `Infinity + -Infinity`) throws.

```ts
cache.zincrby("board", 50, "alice");   // new score
```

### `Cache.zcard(key)`

**O(1).** Number of members in the zset, or `0` if the key is missing.

```ts
cache.zcard("board");   // number
```

> The **O(n)** writes (`zadd`/`zrem`/`zincrby`) are fine for small-to-medium zsets — leaderboards, top-N feeds, recent-item buffers. Past tens of thousands of members under one key, write throughput degrades; consider sharding the zset across multiple keys.

## How expiry works

- **Lazy** — `get`, `has`, `mget`, `keys`, and all `z*` reads clean up expired entries the moment they touch them. Functional behavior is precise to the millisecond regardless of `sweepDelay`.
- **Active** — when you `set` an entry with a TTL, the cache schedules one `setTimeout`. When it fires, every expired entry is swept and the next-soonest expiration is rescheduled. The single timer is delayed by `sweepDelay` (default `1000` ms) past the soonest expiry, so neighbors that fall in the window get pruned in the same pass. No periodic polling; if nothing has a TTL, no timer runs.

## Errors

`WrongTypeError` is thrown when an operation targets a key that holds the wrong kind — e.g. calling `zadd` on a key that holds a string, or `get` on a key that holds a sorted set. The error carries `key`, `has`, and `wanted` properties so you can branch on them.

```ts
import { WrongTypeError } from "suncache";

try {
  cache.zadd("user:1", 1, "x");
} catch (e) {
  if (e instanceof WrongTypeError) {
    console.warn(`${e.key} holds a ${e.has}, expected ${e.wanted}`);
  }
}
```

`set` is the unusual case: it overwrites a key that previously held a different kind without complaint. The cross-kind ops — `has`, `del`, `expire`, `clear`, `keys`, `size` — also never throw `WrongTypeError`; they operate by key regardless of the stored kind.

## Gotchas

- `Cache.for(name, options)` ignores `options` after the first call (first call wins).
- `Cache.for<T>(name)` doesn't enforce that two callers use the same `T`. Pick one type per cache name.
- Concurrent async "get-then-set" callers can both miss and double-fetch. Use `getOrCompute` to dedupe automatically.
- Invalid options throw `TypeError`: `maxSize` must be a positive integer; `sweepDelay` must be a finite non-negative number (ms). For per-call `ttl`, `NaN` and `±Infinity` are rejected; `<= 0` deletes the key immediately; any other finite number is the TTL in ms.

## Security

The registry is keyed by `Symbol.for("suncache.registry")` on `globalThis`. Every copy of suncache loaded in the same process shares it, so cache names are effectively a process-wide namespace — pick names unlikely to collide with another library's internal caches. When keys come from untrusted input, set `maxSize` to bound memory.

## License

MIT
