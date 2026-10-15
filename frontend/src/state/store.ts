import { useRef, useSyncExternalStore } from 'react';

/** Tiny external store with selector subscriptions (no external state library needed). */
export interface Store<S> {
  get(): S;
  set(updater: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(updater) {
      const patch = typeof updater === 'function' ? updater(state) : updater;
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Structural equality two levels deep (enough for selector results like {id: {a, b}} or arrays of refs). */
function equal(a: unknown, b: unknown, depth = 2): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1));
}

/** Subscribes to a slice; re-renders only when the selected value changes. */
export function useStoreSelector<S, T>(store: Store<S>, selector: (s: S) => T): T {
  const cache = useRef<{ state: S; selector: (s: S) => T; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = store.get();
    // Same state object → same snapshot (required by useSyncExternalStore).
    if (cache.current && cache.current.state === state && cache.current.selector === selector) return cache.current.value;
    const next = selector(state);
    if (cache.current && equal(cache.current.value, next)) {
      cache.current = { state, selector, value: cache.current.value };
      return cache.current.value;
    }
    cache.current = { state, selector, value: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
