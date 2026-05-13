import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cache } from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Cache.for", () => {
  describe("with the same name", () => {
    it("returns the same instance on repeated calls", () => {
      const name = `users-${Math.random()}`;
      const a = Cache.for(name);
      const b = Cache.for(name);
      expect(a).toBe(b);
      a.clear();
    });

    it("shares state across all callers", () => {
      const name = `shared-${Math.random()}`;
      const writer = Cache.for<number>(name);
      const reader = Cache.for<number>(name);
      writer.set("k", 42);
      expect(reader.get("k")).toBe(42);
      writer.clear();
    });

    it("ignores options passed to subsequent calls (first call wins)", () => {
      const name = `cfg-${Math.random()}`;
      const first = Cache.for<number>(name, { defaultTtl: 100 });
      const second = Cache.for<number>(name, { defaultTtl: 999_999 });
      expect(second).toBe(first);

      first.set("k", 1);
      vi.advanceTimersByTime(200);
      expect(first.get("k")).toBeUndefined();
      first.clear();
    });
  });

  describe("with different names", () => {
    it("returns distinct instances", () => {
      const a = Cache.for(`a-${Math.random()}`);
      const b = Cache.for(`b-${Math.random()}`);
      expect(a).not.toBe(b);
      a.clear();
      b.clear();
    });

    it("isolates state between caches", () => {
      const a = Cache.for<number>(`a-${Math.random()}`);
      const b = Cache.for<number>(`b-${Math.random()}`);
      a.set("k", 1);
      expect(b.get("k")).toBeUndefined();
      a.clear();
      b.clear();
    });
  });

  describe("vs new Cache()", () => {
    it("new Cache() always returns a fresh, unregistered instance", () => {
      const a = new Cache();
      const b = new Cache();
      expect(a).not.toBe(b);
      a.clear();
      b.clear();
    });

    it("a fresh instance does not share state with a registered one of any name", () => {
      const name = `iso-${Math.random()}`;
      const registered = Cache.for<number>(name);
      const fresh = new Cache<number>();
      registered.set("k", 1);
      expect(fresh.get("k")).toBeUndefined();
      registered.clear();
      fresh.clear();
    });
  });
});
