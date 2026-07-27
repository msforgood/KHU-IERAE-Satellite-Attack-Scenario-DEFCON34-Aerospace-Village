// Copyright (c) 2026 SunHyuk Hwang. All Rights Reserved.

export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  return {
    getState: () => state,

    setState(updater) {
      state = typeof updater === "function" ? updater(state) : { ...state, ...updater };
      for (const fn of listeners) fn(state);
    },

    subscribe(fn) {
      listeners.add(fn);
      fn(state); // call immediately with current state
      return () => listeners.delete(fn);
    },
  };
}
