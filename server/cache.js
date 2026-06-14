// Query cache with single-flight coalescing.
//
// Two concerns for the upcoming multi-user mode:
//   1. Coalescing: N clients issuing the same query within the same tick must
//      trigger exactly one upstream InfluxDB call (the rest await the inflight
//      promise). This is the debounce/dedup the brief asks for.
//   2. Caching: identical queries within a TTL window reuse the resolved value.
//      Live ranges (ending ~now) get a short TTL; historical ranges a long one.
//
// Implementation is a small LRU keyed by an opaque string; eviction is O(1)
// amortised via a Map (insertion-ordered) used as the recency list.

export class QueryCache {
  /**
   * @param {{ maxEntries: number }} options
   */
  constructor({ maxEntries }) {
    this.maxEntries = maxEntries
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.entries = new Map()
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map()
    this.stats = { hits: 0, misses: 0, coalesced: 0, evictions: 0 }
  }

  /**
   * Resolve a value for `key`, fetching via `loader` at most once across
   * concurrent callers and reusing cached results until `ttlMs` elapses.
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<T>} loader
   * @returns {Promise<T>}
   */
  async resolve(key, ttlMs, loader) {
    const now = Date.now()

    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > now) {
      // Refresh recency (LRU): re-insert to move to the tail.
      this.entries.delete(key)
      this.entries.set(key, cached)
      this.stats.hits += 1
      return cached.value
    }
    if (cached) this.entries.delete(key)

    const pending = this.inflight.get(key)
    if (pending) {
      this.stats.coalesced += 1
      return pending
    }

    this.stats.misses += 1
    const promise = (async () => {
      const value = await loader()
      this.set(key, value, ttlMs)
      return value
    })()
      .finally(() => {
        this.inflight.delete(key)
      })

    this.inflight.set(key, promise)
    return promise
  }

  set(key, value, ttlMs) {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
      this.stats.evictions += 1
    }
  }

  snapshot() {
    return {
      size: this.entries.size,
      inflight: this.inflight.size,
      ...this.stats,
    }
  }
}
