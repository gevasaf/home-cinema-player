/**
 * Thin wrapper that calls window.cinema.storage IPC.
 * Same interface as the main-process store — keeps consumer code symmetric.
 */

export const store = {
  get: (key) => window.cinema.storage.get(key),
  set: (key, value) => window.cinema.storage.set(key, value),
  subscribe: (key, callback) => window.cinema.storage.subscribe(key, callback),
}
