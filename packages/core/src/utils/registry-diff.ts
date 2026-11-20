// @x-code-cli/core — Shared registry reload diff helper
//
// Computes the added/removed/changed/unchanged breakdown when a named
// registry is hot-replaced. Each registry brings its own change-detection
// predicate while sharing this structural algorithm.

export interface ReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

/** Diff two named entry maps. `isChanged(prev, next)` returns true when
 *  entries with the same key differ in a domain-relevant way. */
export function diffNamedEntries<T>(
  previous: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
  isChanged: (prev: T, next: T) => boolean,
): ReloadSummary {
  const summary: ReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
  for (const [name, entry] of next) {
    const prev = previous.get(name)
    if (!prev) summary.added.push(name)
    else if (isChanged(prev, entry)) summary.changed.push(name)
    else summary.unchanged.push(name)
  }
  for (const name of previous.keys()) {
    if (!next.has(name)) summary.removed.push(name)
  }
  return summary
}
