/**
 * A bounded FIFO log: keeps the most recent `maxEntries` items and counts
 * how many older items were dropped. Used for per-run activity buffers.
 */
export class BoundedLog<T> {
  private items: T[] = [];
  private droppedCount = 0;

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("BoundedLog maxEntries must be a positive integer");
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxEntries) {
      const excess = this.items.length - this.maxEntries;
      this.items.splice(0, excess);
      this.droppedCount += excess;
    }
  }

  entries(): readonly T[] {
    return this.items.slice();
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get size(): number {
    return this.items.length;
  }

  /** Rebuild a log from persisted entries (restore path). */
  static from<T>(maxEntries: number, entries: readonly T[], dropped: number): BoundedLog<T> {
    const log = new BoundedLog<T>(maxEntries);
    for (const entry of entries) log.push(entry);
    log.droppedCount += Math.max(0, dropped);
    return log;
  }
}
