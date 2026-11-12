// In-memory cache with per-entry TTL and LRU eviction (spec 9.1).

export class TtlLruCache {
  /**
   * @param {{ ttl?: number, maxSize?: number }} [options]
   *   ttl: default time-to-live in ms; maxSize: maximum number of entries.
   */
  constructor({ ttl = Infinity, maxSize = Infinity } = {}) {
    this.defaultTtl = ttl;
    this.maxSize = maxSize;
    this.entries = new Map(); // Map iteration order = LRU order (oldest first)
  }

  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU position only; the expiry time is not extended.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttl = this.defaultTtl) {
    this.entries.delete(key);
    while (this.entries.size > 0 && this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttl });
  }

  delete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}
