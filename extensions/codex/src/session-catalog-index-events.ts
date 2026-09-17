import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CodexServerNotification,
  CodexThread,
  CodexThreadStatus,
} from "./app-server/protocol.js";
import type { CodexCatalogStatus } from "./session-catalog-index-field.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-index-state.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-state.js";
import { codexCatalogThreadName, codexCatalogThreadStatus } from "./session-catalog-parsing.js";

type ReadThread = (id: string) => Promise<CodexThread>;
type CodexCatalogIndexEventOwner = {
  get(id: string): CodexCatalogIndexRow | undefined;
  rename(id: string, name: string | null): void;
  updateStatus(id: string, status: CodexCatalogStatus): void;
  upsert(thread: CodexThread): Promise<void>;
  refresh(id: string, readThread: ReadThread): Promise<void>;
  archive(id: string): void;
  remove(id: string): void;
  report(error: unknown): void;
};

type PendingRefresh = { readThread: ReadThread; dirty: boolean; promise: Promise<void> };

/** Event scheduling only; the index owns row publication and stale-read fencing. */
export class CodexCatalogIndexEvents {
  private closed = false;
  private readonly pending = new Map<string, PendingRefresh>();
  private readonly upserting = new Set<Promise<void>>();

  constructor(private readonly owner: CodexCatalogIndexEventOwner) {}

  handle(event: CodexServerNotification, readThread: ReadThread): void {
    if (this.closed || !isRecord(event.params)) {
      return;
    }
    const params = event.params;
    if (event.method === "thread/started") {
      if (!isRecord(params.thread) || typeof params.thread.id !== "string") {
        return;
      }
      // SAFETY: native v2 ThreadStartedNotification carries Thread, as thread/list does.
      const thread = params.thread as CodexThread;
      if (!thread.preview?.trim() && thread.recencyAt == null) {
        return;
      }
      if (!this.hasCapacity()) {
        return;
      }
      const operation = this.owner
        .upsert(thread)
        .catch((error: unknown) => this.owner.report(error))
        .finally(() => this.upserting.delete(operation));
      this.upserting.add(operation);
      return;
    }
    const id = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!id) {
      return;
    }
    if (event.method === "thread/archived" || event.method === "thread/deleted") {
      const pending = this.pending.get(id);
      if (pending) {
        pending.dirty = false;
      }
      if (event.method === "thread/deleted") {
        this.owner.remove(id);
      } else {
        this.owner.archive(id);
      }
      return;
    }
    if (event.method === "thread/name/updated") {
      this.owner.rename(id, codexCatalogThreadName(params.threadName ?? null) ?? null);
      return;
    }
    if (event.method === "thread/status/changed") {
      if (!isRecord(params.status)) {
        return;
      }
      // SAFETY: native v2 ThreadStatusChangedNotification carries the protocol status union.
      this.owner.updateStatus(id, codexCatalogThreadStatus(params.status as CodexThreadStatus));
      return;
    }
    if (
      event.method === "turn/completed" ||
      event.method === "thread/unarchived" ||
      event.method === "thread/reverted"
    ) {
      if (event.method !== "thread/unarchived" && this.owner.get(id)?.archived) {
        return;
      }
      this.enqueueRefresh(id, readThread);
    }
  }

  private hasCapacity(): boolean {
    if (this.pending.size + this.upserting.size < CODEX_CATALOG_MAX_ROWS) {
      return true;
    }
    this.owner.report(new Error("Codex catalog event queue reached its resident row limit"));
    return false;
  }

  private enqueueRefresh(id: string, readThread: ReadThread): void {
    const existing = this.pending.get(id);
    if (existing) {
      existing.readThread = readThread;
      existing.dirty = true;
      return;
    }
    if (!this.hasCapacity()) {
      return;
    }
    const pending: PendingRefresh = { readThread, dirty: true, promise: Promise.resolve() };
    this.pending.set(id, pending);
    pending.promise = Promise.resolve().then(async () => {
      try {
        while (!this.closed && pending.dirty) {
          pending.dirty = false;
          try {
            await this.owner.refresh(id, pending.readThread);
          } catch (error) {
            this.owner.report(error);
          }
        }
      } finally {
        this.pending.delete(id);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([
      ...this.upserting,
      ...[...this.pending.values()].map((entry) => entry.promise),
    ]);
  }
}
