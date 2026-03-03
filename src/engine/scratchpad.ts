/**
 * RunScratchpad — ephemeral in-memory working memory for a single DAG run.
 *
 * Steps read and write values during execution. The scratchpad is cleared
 * when the run completes. It does NOT persist across runs — for that,
 * use the Memory system.
 */

// ── RunScratchpad ───────────────────────────────────────────────

export class RunScratchpad {
  private store = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  entries(): Array<[string, unknown]> {
    return Array.from(this.store.entries());
  }

  clear(): void {
    this.store.clear();
  }
}
