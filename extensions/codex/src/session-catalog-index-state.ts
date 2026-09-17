import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseCatalogPage } from "./session-catalog-parsing.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

// Match the existing Codex managed-thread retention ceiling; previews remain 500 characters.
export const CODEX_CATALOG_MAX_ROWS = 20_000;
export const CODEX_CATALOG_STATE_NAMESPACE = "session-catalog-resident";
export type CodexCatalogRolloutFingerprint = { mtimeMs: number; size: number };
export type CodexCatalogIndexRow = {
  threadId: string;
  updatedAt: number | null;
  recencyAt: number | null;
  archived: boolean;
  preview?: string;
  /** Stable tie position, initially assigned in native order. */
  sourceOrder?: number;
  rolloutPath?: string;
  fingerprint?: CodexCatalogRolloutFingerprint;
  page: CodexSessionCatalogPage;
};
export type StoredCodexCatalogEntry =
  | { version: 1; kind: "complete" }
  | { version: 1; kind: "row"; row: CodexCatalogIndexRow };
export type CodexCatalogState = Pick<
  PluginStateKeyedStore<StoredCodexCatalogEntry>,
  "entries" | "register" | "delete"
>;

/** Durable metadata never asserts that a native process is still running. */
export function codexCatalogMetadataPage(page: CodexSessionCatalogPage): CodexSessionCatalogPage {
  return {
    sessions: page.sessions.map(({ status: _status, activeFlags: _flags, ...session }) => ({
      ...session,
      status: "notLoaded",
    })),
  };
}

export function readStoredCodexCatalogRow(value: unknown): CodexCatalogIndexRow | undefined {
  if (!isRecord(value) || value.version !== 1 || value.kind !== "row" || !isRecord(value.row)) {
    return undefined;
  }
  const row = value.row;
  if (
    typeof row.threadId !== "string" ||
    !row.threadId ||
    row.threadId.length > 256 ||
    typeof row.archived !== "boolean" ||
    (row.preview !== undefined && (typeof row.preview !== "string" || row.preview.length > 500)) ||
    (row.sourceOrder !== undefined &&
      (typeof row.sourceOrder !== "number" || !Number.isSafeInteger(row.sourceOrder))) ||
    (row.rolloutPath !== undefined && typeof row.rolloutPath !== "string") ||
    !(
      row.updatedAt === null ||
      (typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt))
    ) ||
    !(
      row.recencyAt === null ||
      (typeof row.recencyAt === "number" && Number.isFinite(row.recencyAt))
    )
  ) {
    return undefined;
  }
  try {
    const page = parseCatalogPage(row.page);
    if (
      page.sessions.length > 1 ||
      page.sessions.some((session) => session.threadId !== row.threadId)
    ) {
      return undefined;
    }
    const fingerprint =
      isRecord(row.fingerprint) &&
      typeof row.fingerprint.mtimeMs === "number" &&
      Number.isFinite(row.fingerprint.mtimeMs) &&
      typeof row.fingerprint.size === "number" &&
      Number.isFinite(row.fingerprint.size)
        ? { mtimeMs: row.fingerprint.mtimeMs, size: row.fingerprint.size }
        : undefined;
    return {
      threadId: row.threadId,
      updatedAt: row.updatedAt,
      recencyAt: row.recencyAt,
      archived: row.archived,
      page: codexCatalogMetadataPage(page),
      ...(typeof row.preview === "string" ? { preview: row.preview } : {}),
      ...(typeof row.sourceOrder === "number" ? { sourceOrder: row.sourceOrder } : {}),
      ...(typeof row.rolloutPath === "string" ? { rolloutPath: row.rolloutPath } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Serializes reconstructible cache writes without blocking resident queries. */
export class CodexCatalogPersistence {
  private readonly pending = new Map<string, StoredCodexCatalogEntry | undefined>();
  private writing: Promise<void> | undefined;
  private failed = false;
  private retired = false;

  constructor(
    private readonly state: CodexCatalogState | undefined,
    private readonly report: (error: unknown) => void,
  ) {}

  private key(threadId: string): string {
    return `thread:${createHash("sha256").update(threadId).digest("hex")}`;
  }

  put(row: CodexCatalogIndexRow): void {
    if (!this.state || this.retired) {
      return;
    }
    this.queue(this.key(row.threadId), { version: 1, kind: "row", row });
  }

  remove(threadId: string): void {
    this.queue(this.key(threadId), undefined);
  }

  async finishHydration(): Promise<void> {
    await this.drain();
    if (!this.failed) {
      this.queue("complete", { version: 1, kind: "complete" });
      await this.drain();
    }
  }

  private async drain(): Promise<void> {
    await this.writing;
  }

  retire(): Promise<void> {
    this.retired = true;
    return this.drain();
  }

  private queue(key: string, value: StoredCodexCatalogEntry | undefined): void {
    if (!this.state || this.retired) {
      return;
    }
    this.pending.set(key, value);
    this.writing ??= this.writePending().finally(() => {
      this.writing = undefined;
    });
  }

  private async writePending(): Promise<void> {
    await nextTurn();
    for (const [key, value] of this.pending) {
      this.pending.delete(key);
      try {
        // Bound state operations retain authority for already-admitted shutdown work.
        if (value) {
          await this.state!.register(key, value);
        } else {
          await this.state!.delete(key);
        }
      } catch (error) {
        if (!this.failed) {
          this.report(error);
          this.pending.set("complete", undefined);
        }
        this.failed = true;
      }
    }
  }
}
