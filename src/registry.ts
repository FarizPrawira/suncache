import type { Cache } from "./cache.js";

const GLOBAL_KEY = Symbol.for("suncache.registry");

type Registry = Map<string, Cache<unknown>>;

interface GlobalWithRegistry {
  [GLOBAL_KEY]?: Registry;
}

function getRegistry(): Registry {
  const g = globalThis as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map();
  }
  return g[GLOBAL_KEY];
}

export function registerCache(name: string, cache: Cache<unknown>): void {
  getRegistry().set(name, cache);
}

export function getRegisteredCache<T = unknown>(name: string): Cache<T> | undefined {
  return getRegistry().get(name) as Cache<T> | undefined;
}
