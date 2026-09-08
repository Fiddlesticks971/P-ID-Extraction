/**
 * pdfjs-dist 6.x uses `Map.prototype.getOrInsertComputed` / `getOrInsert`
 * (the TC39 "Map upsert" proposal). As of this writing that method isn't
 * shipped by default in most browsers yet (including current stable
 * Chromium), so without this polyfill PDF rendering throws
 * "getOrInsertComputed is not a function" on every real-world browser.
 * Must run in both the main thread and the pdf.js web worker, since the
 * worker bundle uses it too.
 */
export function installMapUpsertPolyfill(): void {
  const proto = Map.prototype as unknown as {
    getOrInsertComputed?: <K, V>(this: Map<K, V>, key: K, callback: (key: K) => V) => V;
    getOrInsert?: <K, V>(this: Map<K, V>, key: K, value: V) => V;
  };

  if (typeof proto.getOrInsertComputed !== "function") {
    proto.getOrInsertComputed = function <K, V>(
      this: Map<K, V>,
      key: K,
      callback: (key: K) => V,
    ): V {
      if (this.has(key)) return this.get(key) as V;
      const value = callback(key);
      this.set(key, value);
      return value;
    };
  }

  if (typeof proto.getOrInsert !== "function") {
    proto.getOrInsert = function <K, V>(this: Map<K, V>, key: K, value: V): V {
      if (this.has(key)) return this.get(key) as V;
      this.set(key, value);
      return value;
    };
  }
}
