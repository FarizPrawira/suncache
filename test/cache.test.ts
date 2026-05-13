import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cache } from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Cache", () => {
  describe("when a key is set", () => {
    it("returns its value from get()", () => {
      const cache = new Cache<string>();
      cache.set("a", "hello");
      expect(cache.get("a")).toBe("hello");
      cache.clear();
    });

    it("reports it as present via has()", () => {
      const cache = new Cache();
      cache.set("a", 1);
      expect(cache.has("a")).toBe(true);
      cache.clear();
    });

    it("includes it in keys() in least-recently-used order", () => {
      const cache = new Cache();
      cache.set("c", 1);
      cache.set("a", 1);
      cache.set("b", 1);
      expect(cache.keys()).toEqual(["c", "a", "b"]);
      cache.clear();
    });

    it("counts it in size", () => {
      const cache = new Cache();
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.size).toBe(2);
      cache.clear();
    });

    it("stores the value by reference, not by copy", () => {
      const cache = new Cache<{ n: number }>();
      const obj = { n: 1 };
      cache.set("k", obj);
      const got = cache.get("k");
      expect(got).toBe(obj);
      got!.n = 42;
      expect(cache.get("k")!.n).toBe(42);
      cache.clear();
    });
  });

  describe("when a key has not been set", () => {
    it("returns undefined from get()", () => {
      const cache = new Cache();
      expect(cache.get("missing")).toBeUndefined();
      cache.clear();
    });

    it("returns false from has()", () => {
      const cache = new Cache();
      expect(cache.has("missing")).toBe(false);
      cache.clear();
    });

    it("returns false from del()", () => {
      const cache = new Cache();
      expect(cache.del("missing")).toBe(false);
      cache.clear();
    });
  });

  describe("when overwriting an existing key", () => {
    it("replaces the value", () => {
      const cache = new Cache<number>();
      cache.set("k", 1);
      cache.set("k", 2);
      expect(cache.get("k")).toBe(2);
      cache.clear();
    });

    it("does not grow the cache size", () => {
      const cache = new Cache<number>();
      cache.set("k", 1);
      cache.set("k", 2);
      expect(cache.size).toBe(1);
      cache.clear();
    });

    it("does not evict another entry at maxSize", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("a", 99);
      expect(cache.size).toBe(2);
      expect(cache.get("b")).toBe(2);
      cache.clear();
    });

    it("bumps the entry to most-recently-used", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("a", 99);          // a → MRU, b → LRU
      cache.set("c", 3);           // should evict b, not a
      expect(cache.get("a")).toBe(99);
      expect(cache.get("b")).toBeUndefined();
      cache.clear();
    });
  });

  describe("when deleted or cleared", () => {
    it("del removes a single key", () => {
      const cache = new Cache();
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.del("a")).toBe(true);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.size).toBe(1);
      cache.clear();
    });

    it("clear empties the store", () => {
      const cache = new Cache();
      cache.set("a", 1);
      cache.set("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
      cache.clear();
    });

    it("clear cancels any pending expiry timer", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 1000 });
      cache.clear();
      expect(vi.getTimerCount()).toBe(0);
      cache.clear();
    });
  });

  describe("with a TTL", () => {
    it("returns the value before it expires", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 1000 });
      expect(cache.get("k")).toBe(1);
      cache.clear();
    });

    it("returns undefined after it expires", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 1000 });
      vi.advanceTimersByTime(1001);
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });

    it("deletes the entry on the read that observes expiry", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 100 });
      vi.advanceTimersByTime(200);
      cache.get("k");
      expect(cache.size).toBe(0);
      cache.clear();
    });

    it("deletes the entry from has() when expired", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 100 });
      vi.advanceTimersByTime(200);
      expect(cache.has("k")).toBe(false);
      expect(cache.size).toBe(0);
      cache.clear();
    });

    it("deletes expired entries during keys() iteration", () => {
      const cache = new Cache<number>();
      cache.set("live", 1);
      cache.set("dead", 2, { ttl: 100 });
      vi.advanceTimersByTime(200);
      expect(cache.keys()).toEqual(["live"]);
      expect(cache.size).toBe(1);
      cache.clear();
    });

    it("lazily evicts on get() when the clock has passed expiry but the sweeper hasn't fired", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 100 });
      // Jump the wall clock past expiry without firing the scheduled sweeper.
      vi.setSystemTime(Date.now() + 200);
      expect(cache.get("k")).toBeUndefined();
      expect(cache.size).toBe(0);
      cache.clear();
    });

    it("lazily evicts during keys() when the clock has passed expiry but the sweeper hasn't fired", () => {
      const cache = new Cache<number>();
      cache.set("live", 1);
      cache.set("dead", 2, { ttl: 100 });
      vi.setSystemTime(Date.now() + 200);
      expect(cache.keys()).toEqual(["live"]);
      expect(cache.size).toBe(1);
      cache.clear();
    });

    it("deletes the entry automatically even without a read", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 100 });
      vi.advanceTimersByTime(150);
      expect(cache.size).toBe(0);
      cache.clear();
    });

    it("schedules cleanup for the soonest expiry when several are set", () => {
      const cache = new Cache<number>();
      cache.set("late", 1, { ttl: 1000 });
      cache.set("early", 2, { ttl: 100 });
      vi.advanceTimersByTime(150);
      expect(cache.has("early")).toBe(false);
      expect(cache.has("late")).toBe(true);
      cache.clear();
    });

    it("reschedules for the next-soonest after one expires", () => {
      const cache = new Cache<number>();
      cache.set("a", 1, { ttl: 100 });
      cache.set("b", 2, { ttl: 500 });
      vi.advanceTimersByTime(150);
      expect(cache.size).toBe(1);
      vi.advanceTimersByTime(400);
      expect(cache.size).toBe(0);
      cache.clear();
    });

    it("reschedules sooner when a later set has an earlier expiry", () => {
      const cache = new Cache<number>();
      cache.set("late", 1, { ttl: 1000 });
      cache.set("early", 2, { ttl: 50 });
      vi.advanceTimersByTime(100);
      expect(cache.has("early")).toBe(false);
      expect(cache.has("late")).toBe(true);
      cache.clear();
    });
  });

  describe("without a TTL", () => {
    it("never expires", () => {
      const cache = new Cache<number>();
      cache.set("k", 1);
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(cache.get("k")).toBe(1);
      cache.clear();
    });

    it("does not schedule any timer", () => {
      const cache = new Cache<number>();
      const spy = vi.spyOn(global, "setTimeout");
      cache.set("k", 1);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      cache.clear();
    });
  });

  describe("when ttl is zero or negative", () => {
    it("does not store the value", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 0 });
      cache.set("k2", 2, { ttl: -100 });
      expect(cache.get("k")).toBeUndefined();
      expect(cache.get("k2")).toBeUndefined();
      expect(cache.size).toBe(0);
      cache.clear();
    });

    it("removes any prior value for the same key", () => {
      const cache = new Cache<number>();
      cache.set("k", 1);
      cache.set("k", 99, { ttl: 0 });
      expect(cache.get("k")).toBeUndefined();
      expect(cache.size).toBe(0);
      cache.clear();
    });
  });

  describe("with defaultTtl", () => {
    it("applies to entries that do not specify a ttl", () => {
      const cache = new Cache<number>({ defaultTtl: 500 });
      cache.set("k", 1);
      vi.advanceTimersByTime(501);
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });

    it("is overridden by a per-set ttl", () => {
      const cache = new Cache<number>({ defaultTtl: 100 });
      cache.set("k", 1, { ttl: 10_000 });
      vi.advanceTimersByTime(500);
      expect(cache.get("k")).toBe(1);
      cache.clear();
    });
  });

  describe("with maxSize (LRU eviction)", () => {
    it("evicts the least-recently-used entry when at capacity", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
      cache.clear();
    });

    it("evicts repeatedly to keep size within the limit", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.set("d", 4);
      expect(cache.keys()).toEqual(["c", "d"]);
      cache.clear();
    });

    it("promotes a recently-read entry so it survives eviction", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.get("a");           // bumps "a" to most-recently-used; "b" is now LRU
      cache.set("c", 3);        // should evict "b", not "a"
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      cache.clear();
    });

    it("with maxSize 1 keeps only the latest accessed entry", () => {
      const cache = new Cache<number>({ maxSize: 1 });
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      cache.clear();
    });
  });

  describe("mget", () => {
    it("returns an object keyed by the requested keys", () => {
      const cache = new Cache<number>();
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.mget(["a", "b", "c"])).toEqual({ a: 1, b: 2, c: 3 });
      cache.clear();
    });

    it("omits missing keys from the result", () => {
      const cache = new Cache<number>();
      cache.set("a", 1);
      const result = cache.mget(["a", "missing"]);
      expect(result).toEqual({ a: 1 });
      expect("missing" in result).toBe(false);
      cache.clear();
    });

    it("treats expired entries as missing and cleans them up", () => {
      const cache = new Cache<number>();
      cache.set("live", 1);
      cache.set("dead", 2, { ttl: 100 });
      vi.advanceTimersByTime(200);
      expect(cache.mget(["live", "dead"])).toEqual({ live: 1 });
      expect(cache.size).toBe(1);
      cache.clear();
    });

    it("promotes each hit to most-recently-used", () => {
      const cache = new Cache<number>({ maxSize: 3 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.mget(["a", "b"]);            // a, b are now MRU; c is LRU
      cache.set("d", 4);                 // should evict c
      expect(cache.get("c")).toBeUndefined();
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
      cache.clear();
    });
  });

  describe("mset", () => {
    it("stores every entry", () => {
      const cache = new Cache<number>();
      cache.mset({ a: 1, b: 2, c: 3 });
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
      cache.clear();
    });

    it("applies a batch-level ttl to every entry", () => {
      const cache = new Cache<number>();
      cache.mset({ a: 1, b: 2 }, { ttl: 100 });
      expect(cache.get("a")).toBe(1);
      vi.advanceTimersByTime(200);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      cache.clear();
    });

    it("falls back to defaultTtl when no ttl is given", () => {
      const cache = new Cache<number>({ defaultTtl: 100 });
      cache.mset({ a: 1, b: 2 });
      vi.advanceTimersByTime(200);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      cache.clear();
    });

    it("respects ttl <= 0 (entries are not stored)", () => {
      const cache = new Cache<number>();
      cache.mset({ a: 1, b: 2 }, { ttl: 0 });
      expect(cache.size).toBe(0);
      cache.clear();
    });
  });

  describe("incr / decr", () => {
    it("starts a missing key at delta", () => {
      const cache = new Cache<number>();
      expect(cache.incr("k")).toBe(1);
      cache.clear();
    });

    it("accumulates across calls", () => {
      const cache = new Cache<number>();
      cache.incr("k");
      cache.incr("k", 5);
      cache.incr("k");
      expect(cache.get("k")).toBe(7);
      cache.clear();
    });

    it("returns the new value", () => {
      const cache = new Cache<number>();
      expect(cache.incr("k", 3)).toBe(3);
      expect(cache.incr("k", 4)).toBe(7);
      cache.clear();
    });

    it("decr decrements", () => {
      const cache = new Cache<number>();
      cache.set("k", 10);
      expect(cache.decr("k")).toBe(9);
      expect(cache.decr("k", 4)).toBe(5);
      cache.clear();
    });

    it("preserves the existing TTL across increments", () => {
      const cache = new Cache<number>();
      cache.set("k", 0, { ttl: 1000 });
      vi.advanceTimersByTime(500);
      cache.incr("k");                    // 500ms into the 1000ms window
      vi.advanceTimersByTime(600);        // 1100ms total → past expiry
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });

    it("creates new keys without a TTL even when defaultTtl is set", () => {
      const cache = new Cache<number>({ defaultTtl: 200 });
      cache.incr("k");
      vi.advanceTimersByTime(1000);
      expect(cache.get("k")).toBe(1);     // still alive — no TTL applied
      cache.clear();
    });

    it("evicts the oldest entry when incr() creates a new key at maxSize", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.incr("c")).toBe(1);
      expect(cache.keys()).toEqual(["b", "c"]);   // "a" was the LRU and got evicted
      expect(cache.size).toBe(2);
      cache.clear();
    });

    it("promotes the entry to most-recently-used when incrementing", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 0);
      cache.set("b", 0);
      cache.incr("a");                 // "a" → MRU, "b" → LRU
      cache.set("c", 3);               // should evict "b", not "a"
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      cache.clear();
    });

    it("promotes the entry to most-recently-used when decrementing", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 0);
      cache.set("b", 0);
      cache.decr("a");                 // "a" → MRU, "b" → LRU
      cache.set("c", 3);               // should evict "b", not "a"
      expect(cache.get("a")).toBe(-1);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      cache.clear();
    });
  });

  describe("expire", () => {
    it("sets the TTL on an existing key", () => {
      const cache = new Cache<number>();
      cache.set("k", 42);
      expect(cache.expire("k", 100)).toBe(true);
      vi.advanceTimersByTime(200);
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });

    it("returns false for a missing key", () => {
      const cache = new Cache<number>();
      expect(cache.expire("missing", 1000)).toBe(false);
      cache.clear();
    });

    it("returns false for an already-expired key and cleans it up", () => {
      const cache = new Cache<number>();
      cache.set("k", 1, { ttl: 100 });
      vi.advanceTimersByTime(200);
      expect(cache.expire("k", 1000)).toBe(false);
      expect(cache.size).toBe(0);
      cache.clear();
    });

    it("with ttl <= 0 deletes the entry", () => {
      const cache = new Cache<number>();
      cache.set("k", 1);
      expect(cache.expire("k", 0)).toBe(true);
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });

    it("bumps LRU order — refreshing TTL protects the entry from eviction", () => {
      const cache = new Cache<number>({ maxSize: 2 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.expire("a", 10_000);           // promotes "a" to MRU; "b" is now LRU
      cache.set("c", 3);                   // should evict "b", not "a"
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined();
      cache.clear();
    });
  });

  describe("with invalid options", () => {
    describe("maxSize", () => {
      it("rejects zero", () => {
        expect(() => new Cache({ maxSize: 0 })).toThrow(TypeError);
      });

      it("rejects negative numbers", () => {
        expect(() => new Cache({ maxSize: -1 })).toThrow(TypeError);
      });

      it("rejects fractional numbers", () => {
        expect(() => new Cache({ maxSize: 1.5 })).toThrow(TypeError);
      });

      it("rejects NaN", () => {
        expect(() => new Cache({ maxSize: NaN })).toThrow(TypeError);
      });

      it("rejects Infinity", () => {
        expect(() => new Cache({ maxSize: Infinity })).toThrow(TypeError);
      });
    });

    describe("defaultTtl", () => {
      it("rejects zero", () => {
        expect(() => new Cache({ defaultTtl: 0 })).toThrow(TypeError);
      });

      it("rejects negative numbers", () => {
        expect(() => new Cache({ defaultTtl: -100 })).toThrow(TypeError);
      });

      it("rejects NaN", () => {
        expect(() => new Cache({ defaultTtl: NaN })).toThrow(TypeError);
      });

      it("rejects Infinity", () => {
        expect(() => new Cache({ defaultTtl: Infinity })).toThrow(TypeError);
      });
    });

    describe("ttl in set()", () => {
      it("rejects NaN", () => {
        const cache = new Cache<number>();
        expect(() => cache.set("k", 1, { ttl: NaN })).toThrow(TypeError);
        cache.clear();
      });

      it("rejects Infinity", () => {
        const cache = new Cache<number>();
        expect(() => cache.set("k", 1, { ttl: Infinity })).toThrow(TypeError);
        cache.clear();
      });
    });

    describe("ttl in expire()", () => {
      it("rejects NaN", () => {
        const cache = new Cache<number>();
        cache.set("k", 1);
        expect(() => cache.expire("k", NaN)).toThrow(TypeError);
        cache.clear();
      });

      it("rejects Infinity", () => {
        const cache = new Cache<number>();
        cache.set("k", 1);
        expect(() => cache.expire("k", Infinity)).toThrow(TypeError);
        cache.clear();
      });
    });

    describe("ttl in mset()", () => {
      it("rejects NaN", () => {
        const cache = new Cache<number>();
        expect(() => cache.mset({ a: 1 }, { ttl: NaN })).toThrow(TypeError);
        cache.clear();
      });
    });
  });

  describe("clear()", () => {
    it("is safe to call more than once", () => {
      const cache = new Cache();
      cache.set("k", 1);
      cache.clear();
      expect(() => cache.clear()).not.toThrow();
    });

    it("leaves the cache usable", () => {
      const cache = new Cache<number>();
      cache.clear();
      cache.set("k", 1);
      expect(cache.get("k")).toBe(1);
    });
  });
});

describe("Cache.getOrCompute", () => {
  describe("on cache hit", () => {
    it("returns the cached value", async () => {
      const cache = new Cache<number>();
      cache.set("k", 7);
      expect(await cache.getOrCompute("k", async () => 99)).toBe(7);
      cache.clear();
    });

    it("does not call the compute function", async () => {
      const cache = new Cache<number>();
      cache.set("k", 7);
      const compute = vi.fn(async () => 99);
      await cache.getOrCompute("k", compute);
      expect(compute).not.toHaveBeenCalled();
      cache.clear();
    });
  });

  describe("on cache miss", () => {
    it("calls compute and caches the result", async () => {
      const cache = new Cache<number>();
      const compute = vi.fn(async () => 42);
      expect(await cache.getOrCompute("k", compute)).toBe(42);
      expect(cache.get("k")).toBe(42);
      expect(compute).toHaveBeenCalledTimes(1);
      cache.clear();
    });

    it("accepts a synchronous compute function", async () => {
      const cache = new Cache<number>();
      const value = await cache.getOrCompute("k", () => 5);
      expect(value).toBe(5);
      expect(cache.get("k")).toBe(5);
      cache.clear();
    });

    it("respects per-call ttl", async () => {
      const cache = new Cache<number>();
      await cache.getOrCompute("k", async () => 1, { ttl: 100 });
      vi.advanceTimersByTime(200);
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });

    it("falls back to defaultTtl when no ttl is given", async () => {
      const cache = new Cache<number>({ defaultTtl: 100 });
      await cache.getOrCompute("k", async () => 1);
      vi.advanceTimersByTime(200);
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });
  });

  describe("with concurrent callers", () => {
    it("runs compute only once for the same key", async () => {
      const cache = new Cache<number>();
      const compute = vi.fn(async () => 123);
      const results = await Promise.all([
        cache.getOrCompute("k", compute),
        cache.getOrCompute("k", compute),
        cache.getOrCompute("k", compute),
      ]);
      expect(results).toEqual([123, 123, 123]);
      expect(compute).toHaveBeenCalledTimes(1);
      cache.clear();
    });

    it("runs compute independently for different keys", async () => {
      const cache = new Cache<number>();
      const compute = vi.fn(async (k: string) => k.length);
      await Promise.all([
        cache.getOrCompute("a", () => compute("a")),
        cache.getOrCompute("bb", () => compute("bb")),
        cache.getOrCompute("ccc", () => compute("ccc")),
      ]);
      expect(compute).toHaveBeenCalledTimes(3);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("ccc")).toBe(3);
      cache.clear();
    });

    it("rejects all waiters together when compute fails", async () => {
      const cache = new Cache<number>();
      const compute = vi.fn(async () => {
        throw new Error("boom");
      });
      const results = await Promise.allSettled([
        cache.getOrCompute("k", compute),
        cache.getOrCompute("k", compute),
      ]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(compute).toHaveBeenCalledTimes(1);
      cache.clear();
    });
  });

  describe("when compute fails", () => {
    it("propagates the rejection to the caller", async () => {
      const cache = new Cache<number>();
      await expect(
        cache.getOrCompute("k", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      cache.clear();
    });

    it("does not cache the failure", async () => {
      const cache = new Cache<number>();
      await cache
        .getOrCompute("k", async () => {
          throw new Error("boom");
        })
        .catch(() => {});
      expect(cache.get("k")).toBeUndefined();
      cache.clear();
    });

    it("retries on the next call", async () => {
      const cache = new Cache<number>();
      const compute = vi
        .fn<() => Promise<number>>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(7);

      await expect(cache.getOrCompute("k", compute)).rejects.toThrow("boom");
      expect(await cache.getOrCompute("k", compute)).toBe(7);
      expect(compute).toHaveBeenCalledTimes(2);
      cache.clear();
    });
  });

  describe("when clear() runs during compute", () => {
    it("still resolves the awaiter with the computed value", async () => {
      const cache = new Cache<string>();
      let resolve!: (v: string) => void;
      const p = cache.getOrCompute("k", () => new Promise<string>((r) => { resolve = r; }));
      cache.clear();
      resolve("late");
      await expect(p).resolves.toBe("late");
    });

    it("does not write the eventual result into the cache", async () => {
      const cache = new Cache<string>();
      let resolve!: (v: string) => void;
      const p = cache.getOrCompute("k", () => new Promise<string>((r) => { resolve = r; }));
      cache.clear();
      resolve("late");
      await p;
      expect(cache.get("k")).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it("does not re-arm the expiry timer after the late write", async () => {
      const cache = new Cache<string>();
      let resolve!: (v: string) => void;
      const p = cache.getOrCompute(
        "k",
        () => new Promise<string>((r) => { resolve = r; }),
        { ttl: 1000 },
      );
      cache.clear();
      resolve("late");
      await p;
      expect(vi.getTimerCount()).toBe(0);
      cache.clear();
    });

    it("does not poison a subsequent getOrCompute call for the same key", async () => {
      const cache = new Cache<string>();
      let resolve1!: (v: string) => void;
      const p1 = cache.getOrCompute("k", () => new Promise<string>((r) => { resolve1 = r; }));
      cache.clear();
      const p2 = cache.getOrCompute("k", async () => "fresh");
      resolve1("late");
      await p1;
      expect(await p2).toBe("fresh");
      expect(cache.get("k")).toBe("fresh");
      cache.clear();
    });
  });
});
