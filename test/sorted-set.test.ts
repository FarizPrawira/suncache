import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cache, WrongTypeError } from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Cache sorted sets", () => {
  describe("when a new member is added", () => {
    it("returns 1", () => {
      const c = new Cache();
      expect(c.zadd("k", 10, "alice")).toBe(1);
      c.clear();
    });

    it("creates the zset on first add", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      expect(c.zcard("k")).toBe(1);
      c.clear();
    });

    it("stores its score retrievable via zscore", () => {
      const c = new Cache();
      c.zadd("k", 42, "alice");
      expect(c.zscore("k", "alice")).toBe(42);
      c.clear();
    });

    it("appears in zrange ordered by score", () => {
      const c = new Cache();
      c.zadd("k", 30, "c");
      c.zadd("k", 10, "a");
      c.zadd("k", 20, "b");
      expect(c.zrange("k", 0, -1)).toEqual(["a", "b", "c"]);
      c.clear();
    });
  });

  describe("when adding an existing member", () => {
    it("returns 0", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      expect(c.zadd("k", 20, "alice")).toBe(0);
      c.clear();
    });

    it("updates the score", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zadd("k", 20, "alice");
      expect(c.zscore("k", "alice")).toBe(20);
      c.clear();
    });

    it("reorders the member in zrange", () => {
      const c = new Cache();
      c.zadd("k", 10, "a");
      c.zadd("k", 20, "b");
      c.zadd("k", 30, "c");
      c.zadd("k", 100, "a"); // bump a to the end
      expect(c.zrange("k", 0, -1)).toEqual(["b", "c", "a"]);
      c.clear();
    });

    it("does not change zcard", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zadd("k", 20, "alice");
      expect(c.zcard("k")).toBe(1);
      c.clear();
    });
  });

  describe("when a member has the same score as another", () => {
    it("breaks ties lexicographically in zrange", () => {
      const c = new Cache();
      c.zadd("k", 10, "charlie");
      c.zadd("k", 10, "alice");
      c.zadd("k", 10, "bob");
      expect(c.zrange("k", 0, -1)).toEqual(["alice", "bob", "charlie"]);
      c.clear();
    });
  });

  describe("when reading a missing member's score", () => {
    it("returns undefined", () => {
      const c = new Cache();
      c.zadd("k", 42, "alice");
      expect(c.zscore("k", "bob")).toBeUndefined();
      c.clear();
    });
  });

  describe("when the key does not exist", () => {
    it("returns undefined from zscore", () => {
      const c = new Cache();
      expect(c.zscore("nope", "alice")).toBeUndefined();
      c.clear();
    });

    it("returns false from zrem", () => {
      const c = new Cache();
      expect(c.zrem("nope", "alice")).toBe(false);
      c.clear();
    });

    it("returns 0 from zcard", () => {
      const c = new Cache();
      expect(c.zcard("nope")).toBe(0);
      c.clear();
    });

    it("returns [] from zrange", () => {
      const c = new Cache();
      expect(c.zrange("nope", 0, -1)).toEqual([]);
      c.clear();
    });

    it("returns [] from zrangebyscore", () => {
      const c = new Cache();
      expect(c.zrangebyscore("nope", 0, 100)).toEqual([]);
      c.clear();
    });
  });

  describe("when an existing member is removed", () => {
    it("returns true", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      expect(c.zrem("k", "alice")).toBe(true);
      c.clear();
    });

    it("removes it from zscore lookups", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zrem("k", "alice");
      expect(c.zscore("k", "alice")).toBeUndefined();
      c.clear();
    });

    it("decrements zcard", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zadd("k", 20, "bob");
      c.zrem("k", "alice");
      expect(c.zcard("k")).toBe(1);
      c.clear();
    });
  });

  describe("when the last member is removed", () => {
    it("auto-deletes the empty zset key", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zrem("k", "alice");
      expect(c.has("k")).toBe(false);
      c.clear();
    });

    it("removes the key from keys()", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zrem("k", "alice");
      expect(c.keys()).toEqual([]);
      c.clear();
    });

    it("does not delete when other members remain", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zadd("k", 20, "bob");
      c.zrem("k", "alice");
      expect(c.has("k")).toBe(true);
      expect(c.zcard("k")).toBe(1);
      c.clear();
    });

    it("lets a fresh zadd recreate the key after auto-deletion", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      c.zrem("k", "alice");
      c.zadd("k", 99, "bob");
      expect(c.zcard("k")).toBe(1);
      expect(c.zscore("k", "bob")).toBe(99);
      c.clear();
    });
  });

  describe("when removing a missing member", () => {
    it("returns false", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      expect(c.zrem("k", "bob")).toBe(false);
      c.clear();
    });
  });

  describe("when incrementing a member's score", () => {
    it("creates the member with the delta when missing", () => {
      const c = new Cache();
      expect(c.zincrby("k", 5, "alice")).toBe(5);
      expect(c.zscore("k", "alice")).toBe(5);
      c.clear();
    });

    it("adds the delta to an existing score", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      expect(c.zincrby("k", 3, "alice")).toBe(13);
      c.clear();
    });

    it("accepts negative deltas", () => {
      const c = new Cache();
      c.zadd("k", 10, "alice");
      expect(c.zincrby("k", -4, "alice")).toBe(6);
      c.clear();
    });
  });

  describe("when ranging by rank (zrange)", () => {
    it("supports negative indices like Redis", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      c.zadd("k", 2, "b");
      c.zadd("k", 3, "c");
      c.zadd("k", 4, "d");
      expect(c.zrange("k", -2, -1)).toEqual(["c", "d"]);
      expect(c.zrange("k", 0, 1)).toEqual(["a", "b"]);
      c.clear();
    });

    it("clamps stop to the last index", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      c.zadd("k", 2, "b");
      expect(c.zrange("k", 0, 100)).toEqual(["a", "b"]);
      c.clear();
    });

    it("returns [] when start is greater than stop", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      c.zadd("k", 2, "b");
      expect(c.zrange("k", 5, 1)).toEqual([]);
      c.clear();
    });
  });

  describe("when ranging in reverse (zrevrange)", () => {
    it("returns members in descending score order", () => {
      const c = new Cache();
      c.zadd("k", 10, "a");
      c.zadd("k", 20, "b");
      c.zadd("k", 30, "c");
      expect(c.zrevrange("k", 0, -1)).toEqual(["c", "b", "a"]);
      c.clear();
    });

    it("supports top-N via 0..N-1", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      c.zadd("k", 2, "b");
      c.zadd("k", 3, "c");
      c.zadd("k", 4, "d");
      expect(c.zrevrange("k", 0, 1)).toEqual(["d", "c"]);
      c.clear();
    });
  });

  describe("when ranging by score (zrangebyscore)", () => {
    it("returns members within the inclusive range", () => {
      const c = new Cache();
      c.zadd("k", 10, "a");
      c.zadd("k", 20, "b");
      c.zadd("k", 30, "c");
      c.zadd("k", 40, "d");
      expect(c.zrangebyscore("k", 15, 35)).toEqual(["b", "c"]);
      c.clear();
    });

    it("includes boundary scores", () => {
      const c = new Cache();
      c.zadd("k", 10, "a");
      c.zadd("k", 20, "b");
      c.zadd("k", 30, "c");
      expect(c.zrangebyscore("k", 10, 30)).toEqual(["a", "b", "c"]);
      c.clear();
    });

    it("returns [] when min is greater than max", () => {
      const c = new Cache();
      c.zadd("k", 10, "a");
      expect(c.zrangebyscore("k", 50, 10)).toEqual([]);
      c.clear();
    });

    it("returns [] when no scores fall in range", () => {
      const c = new Cache();
      c.zadd("k", 10, "a");
      c.zadd("k", 20, "b");
      expect(c.zrangebyscore("k", 100, 200)).toEqual([]);
      c.clear();
    });
  });

  describe("when given an invalid score", () => {
    it("rejects NaN in zadd", () => {
      const c = new Cache();
      expect(() => c.zadd("k", NaN, "a")).toThrow(TypeError);
      c.clear();
    });

    it("rejects Infinity in zadd", () => {
      const c = new Cache();
      expect(() => c.zadd("k", Infinity, "a")).toThrow(TypeError);
      c.clear();
    });

    it("rejects NaN in zincrby", () => {
      const c = new Cache();
      expect(() => c.zincrby("k", NaN, "a")).toThrow(TypeError);
      c.clear();
    });

    it("rejects NaN min in zrangebyscore", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      expect(() => c.zrangebyscore("k", NaN, 100)).toThrow(TypeError);
      c.clear();
    });

    it("rejects NaN max in zrangebyscore", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      expect(() => c.zrangebyscore("k", 0, NaN)).toThrow(TypeError);
      c.clear();
    });

    it("accepts ±Infinity in zrangebyscore for open-ended ranges", () => {
      const c = new Cache();
      c.zadd("k", 10, "a");
      c.zadd("k", 20, "b");
      c.zadd("k", 30, "c");
      expect(c.zrangebyscore("k", -Infinity, Infinity)).toEqual(["a", "b", "c"]);
      expect(c.zrangebyscore("k", 15, Infinity)).toEqual(["b", "c"]);
      expect(c.zrangebyscore("k", -Infinity, 25)).toEqual(["a", "b"]);
      c.clear();
    });
  });

  describe("when the key holds a value, not a zset", () => {
    it("throws WrongTypeError from zadd", () => {
      const c = new Cache();
      c.set("k", "hello");
      expect(() => c.zadd("k", 1, "a")).toThrow(WrongTypeError);
      c.clear();
    });

    it("throws WrongTypeError from zscore", () => {
      const c = new Cache();
      c.set("k", "hello");
      expect(() => c.zscore("k", "a")).toThrow(WrongTypeError);
      c.clear();
    });

    it("carries key, has, and wanted on the error", () => {
      const c = new Cache();
      c.set("k", "hello");
      try {
        c.zadd("k", 1, "a");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(WrongTypeError);
        const err = e as WrongTypeError;
        expect(err.key).toBe("k");
        expect(err.has).toBe("value");
        expect(err.wanted).toBe("zset");
      }
      c.clear();
    });
  });

  describe("when the key holds a zset, not a value", () => {
    it("throws WrongTypeError from get", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      expect(() => c.get("k")).toThrow(WrongTypeError);
      c.clear();
    });

    it("throws WrongTypeError from incr", () => {
      const c = new Cache<number>();
      c.zadd("k", 1, "a");
      expect(() => c.incr("k")).toThrow(WrongTypeError);
      c.clear();
    });

    it("returns true from has() without throwing", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      expect(c.has("k")).toBe(true);
      c.clear();
    });

    it("is silently skipped by mget()", () => {
      const c = new Cache<string>();
      c.set("a", "x");
      c.zadd("b", 1, "m");
      c.set("c", "y");
      expect(c.mget(["a", "b", "c"])).toEqual({ a: "x", c: "y" });
      c.clear();
    });

    it("is overwritten by set() without throwing", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      c.set("k", "now a string");
      expect(c.get("k")).toBe("now a string");
      c.clear();
    });
  });

  describe("when a zset key has a TTL", () => {
    it("expires the whole zset", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      expect(c.expire("k", 1000)).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(c.zcard("k")).toBe(0);
      c.clear();
    });
  });

  describe("when del / keys / size are used with zsets", () => {
    it("del removes a zset key", () => {
      const c = new Cache();
      c.zadd("k", 1, "a");
      expect(c.del("k")).toBe(true);
      expect(c.zcard("k")).toBe(0);
      c.clear();
    });

    it("keys() includes zset keys", () => {
      const c = new Cache();
      c.set("a", 1);
      c.zadd("b", 1, "m");
      expect(c.keys().sort()).toEqual(["a", "b"]);
      c.clear();
    });

    it("size counts zset keys", () => {
      const c = new Cache();
      c.set("a", 1);
      c.zadd("b", 1, "m");
      expect(c.size).toBe(2);
      c.clear();
    });
  });

  describe("when at maxSize with mixed kinds", () => {
    it("can evict a zset entry as the least-recently-used", () => {
      const c = new Cache({ maxSize: 2 });
      c.zadd("a", 1, "m");
      c.set("b", 2);
      c.set("c", 3); // evicts "a"
      expect(c.zcard("a")).toBe(0);
      expect(c.has("b")).toBe(true);
      expect(c.has("c")).toBe(true);
      c.clear();
    });

    it("bumps a zset's LRU position on zadd", () => {
      const c = new Cache({ maxSize: 2 });
      c.zadd("a", 1, "m");
      c.set("b", 2);
      c.zadd("a", 2, "m"); // touch "a"
      c.set("c", 3);        // should evict "b", not "a"
      expect(c.zcard("a")).toBe(1);
      expect(c.has("b")).toBe(false);
      expect(c.has("c")).toBe(true);
      c.clear();
    });
  });
});
