export class RequestMappingIndex<T extends { readonly replayKey: string }> implements Iterable<readonly [string, T]> {
  readonly #entries = new Map<string, T>();
  readonly #keysByReplay = new Map<string, Set<string>>();

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: T): void {
    this.delete(key);
    this.#entries.set(key, value);
    const keys = this.#keysByReplay.get(value.replayKey) ?? new Set<string>();
    keys.add(key);
    this.#keysByReplay.set(value.replayKey, keys);
  }

  delete(key: string): boolean {
    const value = this.#entries.get(key);
    if (value === undefined || !this.#entries.delete(key)) return false;
    const keys = this.#keysByReplay.get(value.replayKey);
    keys?.delete(key);
    if (keys?.size === 0) this.#keysByReplay.delete(value.replayKey);
    return true;
  }

  deleteReplay(replayKey: string): void {
    const keys = this.#keysByReplay.get(replayKey);
    if (keys === undefined) return;
    for (const key of keys) this.#entries.delete(key);
    this.#keysByReplay.delete(replayKey);
  }

  [Symbol.iterator](): IterableIterator<readonly [string, T]> {
    return this.#entries[Symbol.iterator]();
  }
}
