/** Fences asynchronous observations against later catalog mutations. */
export class CodexCatalogObservations {
  private revision = 0;
  private readonly mutations = new Map<string, number>();
  private readonly observations = new Map<symbol, number>();

  mark(threadId: string): void {
    this.revision++;
    if (this.observations.size) {
      this.mutations.set(threadId, this.revision);
    }
  }

  async observe<T>(read: (isCurrent: (id: string) => boolean) => Promise<T>): Promise<T> {
    const token = Symbol("catalog observation");
    const revision = this.revision;
    this.observations.set(token, revision);
    try {
      return await read((id) => (this.mutations.get(id) ?? 0) <= revision);
    } finally {
      this.observations.delete(token);
      const oldest = Math.min(...this.observations.values());
      for (const [id, changed] of this.mutations) {
        if (changed <= oldest) {
          this.mutations.delete(id);
        }
      }
    }
  }
}
