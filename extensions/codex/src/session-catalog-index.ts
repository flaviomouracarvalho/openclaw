import { watch, type FSWatcher } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexThreadListParams, CodexThread } from "./app-server/protocol.js";
import { subscribeCodexCatalogEvents } from "./session-catalog-events.js";
import { CodexCatalogIndexEvents } from "./session-catalog-index-events.js";
import { CodexCatalogField, type CodexCatalogStatus } from "./session-catalog-index-field.js";
import {
  applyCodexCatalogName,
  reconcileCodexCatalogNames,
  type CodexCatalogNamesRead,
} from "./session-catalog-index-names.js";
import {
  compareCodexCatalogRows as order,
  CodexCatalogOrdering,
} from "./session-catalog-index-order.js";
import { prepareCodexCatalogQuery } from "./session-catalog-index-query.js";
import {
  CODEX_CATALOG_MAX_ROWS,
  codexCatalogMetadataPage,
  readStoredCodexCatalogRow,
  type CodexCatalogState,
  type CodexCatalogIndexRow,
  CodexCatalogPersistence,
} from "./session-catalog-index-state.js";
import { readControlCursor } from "./session-catalog-parsing.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import {
  scanCodexCatalogRollouts,
  codexCatalogRolloutLogicalPath,
  isCodexCatalogRolloutPathCovered,
  readCodexCatalogRollout,
  type CodexCatalogRolloutFingerprint,
} from "./session-catalog-rollouts.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

const NATIVE_PAGE_LIMIT = 64;
const RECONCILE_MS = 30_000;
type CodexCatalogIndexRead = (
  params: CodexThreadListParams,
  remainingRows: number,
) => Promise<{
  rows: CodexCatalogIndexRow[];
  nextCursor?: string;
}>;
type FieldRevision = { status: number; name: number };

type IndexOptions = {
  homeId: string;
  localSessionsRoot?: string;
  state?: CodexCatalogState;
  readNative: CodexCatalogIndexRead;
  readNativeNames: CodexCatalogNamesRead;
  assertCurrent: () => void;
  runBackground?: (run: () => Promise<void>) => Promise<void>;
};
/** One home owns all queries. Only hydration, notifications and directory currency do I/O. */
export class CodexCatalogIndex {
  private readonly rows = new Map<string, CodexCatalogIndexRow>();
  private readonly liveStatus = new CodexCatalogField<CodexCatalogStatus>();
  private readonly names = new CodexCatalogField<string | null>();
  private ordered: CodexCatalogIndexRow[] | undefined;
  private initializing: Promise<void> | undefined;
  private initialized = false;
  private needsNativeNames = false;
  private restored = false;
  private restoring: Promise<void> | undefined;
  private background: NodeJS.Immediate | undefined;
  private failure: { error: unknown } | undefined;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private watcher: FSWatcher | undefined;
  private readonly unsubscribe: () => void;
  private reconciling: Promise<void> | undefined;
  private reconcilingNative: Promise<void> | undefined;
  private observedFiles = new Map<string, CodexCatalogRolloutFingerprint>();
  private readonly persistence: CodexCatalogPersistence;
  private revision = 0;
  private sourceRevision = 0;
  private readonly ordering = new CodexCatalogOrdering();
  private readonly mutations = new Map<string, number>();
  private readonly observations = new Map<symbol, number>();
  private readonly events: CodexCatalogIndexEvents;

  constructor(private readonly options: IndexOptions) {
    this.persistence = new CodexCatalogPersistence(options.state, (error) => this.report(error));
    this.events = new CodexCatalogIndexEvents({
      get: (id) => this.rows.get(id),
      updateStatus: (id, status) => this.liveStatus.update(id, status),
      rename: (id, name) => {
        this.names.update(id, name);
        const row = this.rows.get(id);
        if (row && !this.closed) {
          this.put(row);
        }
      },
      upsert: (thread) => this.upsertThread(thread),
      refresh: (id, readThread) => this.refreshThread(id, readThread),
      archive: (id) => this.archive(id),
      remove: (id) => this.remove(id),
      report: (error) => this.report(error),
    });
    this.unsubscribe = subscribeCodexCatalogEvents(
      options.homeId,
      (event, readThread) => this.events.handle(event, readThread),
      {
        onClose: () => this.liveStatus.invalidate(),
        onRemoteReady: () => {
          if (this.closed || options.localSessionsRoot) {
            return;
          }
          this.sourceRevision++;
          if (!this.initializing) {
            this.initialized = false;
            this.scheduleHydration();
          }
        },
      },
    );
  }

  private markMutation(threadId: string): void {
    this.revision++;
    if (this.observations.size) {
      this.mutations.set(threadId, this.revision);
    }
  }

  private async observe<T>(read: (isCurrent: (id: string) => boolean) => Promise<T>): Promise<T> {
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

  private assertCurrent(): void {
    if (this.closed) {
      throw new Error("Codex resident catalog is closed");
    }
    try {
      this.options.assertCurrent();
    } catch (error) {
      void this.close();
      throw error;
    }
  }

  private report(error: unknown): void {
    if (!this.closed) {
      embeddedAgentLog.warn("Codex resident catalog background update failed", { error });
    }
  }

  private withName(row: CodexCatalogIndexRow): CodexCatalogIndexRow {
    const known = this.names.get(row.threadId);
    const name = known !== undefined ? known : this.rows.get(row.threadId)?.page.sessions[0]?.name;
    return applyCodexCatalogName(row, name);
  }

  private put(candidate: CodexCatalogIndexRow): void {
    if (this.closed) {
      return;
    }
    const previous = this.rows.get(candidate.threadId);
    const preview = candidate.preview ?? previous?.preview;
    const patched = this.withName({ ...candidate, ...(preview ? { preview } : {}) });
    const row = {
      ...patched,
      page: codexCatalogMetadataPage(patched.page),
      ...(patched.rolloutPath
        ? { rolloutPath: codexCatalogRolloutLogicalPath(patched.rolloutPath) }
        : {}),
      sourceOrder: this.ordering.position(patched, previous),
    };
    if (isDeepStrictEqual(previous, row)) {
      return;
    }
    this.rows.set(row.threadId, row);
    this.ordered = undefined;
    if (this.rows.size > CODEX_CATALOG_MAX_ROWS) {
      const oldest = [...this.rows.values()].toSorted(
        (a, b) => Number(b.archived) - Number(a.archived) || -order(a, b),
      )[0];
      if (oldest?.threadId === row.threadId) {
        this.rows.delete(row.threadId);
        this.liveStatus.delete(row.threadId);
        this.names.delete(row.threadId);
        return;
      }
      if (oldest) {
        this.remove(oldest.threadId);
      }
    }
    this.persistence.put(row);
  }

  private remove(threadId: string): void {
    this.markMutation(threadId);
    this.rows.delete(threadId);
    this.liveStatus.delete(threadId);
    this.names.delete(threadId);
    this.ordered = undefined;
    this.persistence.remove(threadId);
  }

  async initialize(): Promise<void> {
    this.assertCurrent();
    clearImmediate(this.background);
    this.background = undefined;
    if (this.initialized && !this.needsNativeNames) {
      return;
    }
    if (!this.initializing) {
      const sourceRevision = this.sourceRevision;
      this.initializing = (async () => {
        await this.restore();
        await this.reconcilingNative?.catch((error: unknown) => this.report(error));
        if (!this.initialized) {
          let observedRevision: number;
          do {
            observedRevision = await this.observe((isCurrent) => this.hydrate(isCurrent));
          } while (observedRevision !== this.sourceRevision);
        }
        if (this.needsNativeNames) {
          await this.reconcile();
          await this.reconcileNative();
          this.needsNativeNames = false;
        }
        this.initialized = true;
        this.failure = undefined;
        this.startCurrency();
      })()
        .catch((error: unknown) => {
          this.failure = { error };
          throw error;
        })
        .finally(() => {
          this.initializing = undefined;
          if (this.failure && sourceRevision !== this.sourceRevision) {
            this.scheduleHydration();
          }
        });
    }
    return this.initializing;
  }

  private async restore(): Promise<void> {
    if (this.restored) {
      return;
    }
    this.restoring ??= this.observe(async (isCurrent) => {
      let complete = false;
      let validSnapshot = true;
      if (this.options.state) {
        try {
          const entries = await this.options.state.entries();
          this.assertCurrent();
          for (const entry of entries) {
            if (entry.value?.version === 1 && entry.value.kind === "complete") {
              complete = true;
            }
            const row = readStoredCodexCatalogRow(entry.value);
            if (entry.value?.kind === "row" && !row) {
              validSnapshot = false;
            }
            if (row && isCurrent(row.threadId)) {
              const restored = row.rolloutPath
                ? { ...row, rolloutPath: codexCatalogRolloutLogicalPath(row.rolloutPath) }
                : row;
              const patched = this.withName(restored);
              if (patched !== restored) {
                this.persistence.put(patched);
              }
              this.rows.set(row.threadId, patched);
              this.ordering.restore(row);
            }
          }
        } catch (error) {
          this.report(error);
        }
      }
      this.restored = true;
      if (complete && validSnapshot && this.options.localSessionsRoot) {
        this.initialized = true;
        this.needsNativeNames = true;
        this.startCurrency();
      }
    });
    await this.restoring;
  }

  private scheduleHydration(): void {
    if (
      (this.initialized && !this.needsNativeNames) ||
      this.initializing ||
      this.background ||
      this.closed
    ) {
      return;
    }
    this.background = setImmediate(() => {
      this.background = undefined;
      const run = () => this.initialize();
      void (this.options.runBackground ? this.options.runBackground(run) : run()).catch(
        (error: unknown) => this.report(error),
      );
    });
    this.background.unref();
  }

  private captureFields(): FieldRevision {
    return { status: this.liveStatus.capture(), name: this.names.capture() };
  }

  private observeFields(row: CodexCatalogIndexRow, revision: FieldRevision): void {
    const session = row.page.sessions[0];
    if (!session) {
      return;
    }
    this.liveStatus.observe(
      row.threadId,
      {
        status: session.status,
        ...(session.activeFlags ? { activeFlags: session.activeFlags } : {}),
      },
      revision.status,
    );
    if (
      session.name !== undefined &&
      this.names.observe(row.threadId, session.name, revision.name)
    ) {
      const current = this.rows.get(row.threadId);
      if (current && current.page.sessions[0]?.name !== session.name) {
        this.put(current);
      }
    }
  }

  private reconcileNative(): Promise<void> {
    if (!this.options.localSessionsRoot && this.initializing) {
      return this.initializing;
    }
    if (!this.reconcilingNative) {
      const revision = this.names.capture();
      const refresh = this.options.localSessionsRoot
        ? reconcileCodexCatalogNames({
            read: this.options.readNativeNames,
            assertCurrent: () => this.assertCurrent(),
            publish: (threadId, name) => {
              const row = this.rows.get(threadId);
              if (
                row &&
                this.names.observe(threadId, name, revision) &&
                row.page.sessions[0]?.name !== name
              ) {
                this.put(row);
              }
            },
          })
        : this.observe(async (isCurrent) => {
            await this.hydrate(isCurrent, true);
          });
      this.reconcilingNative = refresh.finally(() => {
        this.reconcilingNative = undefined;
      });
    }
    return this.reconcilingNative;
  }

  private async hydrate(
    isCurrent: (id: string) => boolean,
    useStateDbOnly = false,
  ): Promise<number> {
    this.assertCurrent();
    const files = this.options.localSessionsRoot
      ? (await scanCodexCatalogRollouts(this.options.localSessionsRoot, new Set())).files
      : new Map<string, CodexCatalogRolloutFingerprint>();
    let cursor: string | undefined;
    let observedRevision = this.sourceRevision;
    let firstPage = true;
    let sourceOrder = 0;
    const batchOrder = this.ordering.captureBatch(this.rows.size > 0);
    const remaining = new Map(this.rows);
    const cursors = new Set<string>();
    do {
      this.assertCurrent();
      const fieldRevision = this.captureFields();
      const page = await this.options.readNative(
        {
          archived: false,
          modelProviders: [],
          sortKey: "recency_at",
          sortDirection: "desc",
          limit: NATIVE_PAGE_LIMIT,
          ...(useStateDbOnly ? { useStateDbOnly } : {}),
          ...(cursor ? { cursor } : {}),
        },
        Math.max(0, CODEX_CATALOG_MAX_ROWS - sourceOrder),
      );
      this.assertCurrent();
      if (firstPage) {
        // The first page includes readiness of the client opened by this walk.
        observedRevision = this.sourceRevision;
        firstPage = false;
      }
      for (const row of page.rows) {
        const position = sourceOrder++;
        if (position >= CODEX_CATALOG_MAX_ROWS) {
          continue;
        }
        remaining.delete(row.threadId);
        this.observeFields(row, fieldRevision);
        if (!isCurrent(row.threadId)) {
          continue;
        }
        const logicalPath = row.rolloutPath && codexCatalogRolloutLogicalPath(row.rolloutPath);
        const fingerprint = logicalPath
          ? (files.get(logicalPath) ?? files.get(`${logicalPath}.zst`))
          : undefined;
        const previous = this.rows.get(row.threadId);
        this.markMutation(row.threadId);
        this.put({
          ...row,
          sourceOrder: batchOrder(row, previous, position),
          ...(fingerprint ? { fingerprint } : {}),
        });
      }
      cursor = readControlCursor(page.nextCursor, "hydration response");
      if (cursor && cursors.has(cursor)) {
        throw new Error("Codex catalog repeated a hydration cursor");
      }
      if (cursor) {
        cursors.add(cursor);
      }
      await nextTurn();
    } while (cursor);
    for (const [id, row] of remaining) {
      if (isCurrent(id) && this.rows.get(id) === row) {
        this.remove(id);
      }
    }
    await this.persistence.finishHydration();
    return observedRevision;
  }

  private startCurrency(): void {
    if (this.closed || this.timer) {
      return;
    }
    const reconcile = () => {
      void this.reconcile().catch((error: unknown) => this.report(error));
    };
    this.timer = setInterval(() => {
      const run = async () => {
        await this.reconcile();
        await this.reconcileNative();
      };
      void (this.options.runBackground ? this.options.runBackground(run) : run()).catch(
        (error: unknown) => this.report(error),
      );
    }, RECONCILE_MS);
    this.timer.unref();
    if (!this.options.localSessionsRoot) {
      return;
    }
    try {
      this.watcher = watch(this.options.localSessionsRoot, { recursive: true }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(reconcile, 200);
        this.debounce.unref();
      });
      this.watcher.unref();
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Missing directories and platforms without reliable recursive watch use the stat scan.
    }
    // A persisted snapshot is immediately usable; delta reconciliation never holds its first list.
    this.debounce = setTimeout(reconcile, 0);
    this.debounce.unref();
  }

  reconcile(): Promise<void> {
    if (!this.reconciling) {
      this.reconciling = this.observe((isCurrent) => this.reconcileFiles(isCurrent)).finally(() => {
        this.reconciling = undefined;
      });
    }
    return this.reconciling;
  }

  private async reconcileFiles(isCurrent: (id: string) => boolean): Promise<void> {
    const root = this.options.localSessionsRoot;
    if (!root || !this.initialized || this.closed) {
      return;
    }
    this.assertCurrent();
    const byPath = new Map(
      [...this.rows.values()].flatMap((row) =>
        row.rolloutPath ? [[codexCatalogRolloutLogicalPath(row.rolloutPath), row] as const] : [],
      ),
    );
    const { files, present } = await scanCodexCatalogRollouts(root, new Set(byPath.keys()));
    this.assertCurrent();
    const observed = new Map(files);
    for (const [file, fingerprint] of files) {
      const previous = byPath.get(codexCatalogRolloutLogicalPath(file));
      const known = this.observedFiles.get(file) ?? previous?.fingerprint;
      if (known?.mtimeMs === fingerprint.mtimeMs && known.size === fingerprint.size) {
        continue;
      }
      // Publish a new fingerprint only after its projection survives concurrent native updates.
      observed.delete(file);
      if (known) {
        observed.set(file, known);
      }
      let thread: CodexThread | undefined;
      try {
        thread = await readCodexCatalogRollout(root, file);
      } catch (error) {
        this.assertCurrent();
        this.report(error);
        continue;
      }
      this.assertCurrent();
      if (!thread) {
        observed.set(file, fingerprint);
        continue;
      }
      if (!isCurrent(thread.id)) {
        continue;
      }
      const existing = this.rows.get(thread.id);
      if (!existing && !thread.preview) {
        observed.set(file, fingerprint);
        continue;
      }
      const projected = await projectCodexCatalogPage(
        { data: [thread] },
        { localSessionsRoot: root, sanitize: sanitizeTerminalText },
      );
      this.assertCurrent();
      if (!isCurrent(thread.id)) {
        continue;
      }
      observed.set(file, fingerprint);
      const row = projected.rows[0];
      if (!row) {
        continue;
      }
      const recencyAt =
        row.recencyAt === null
          ? (existing?.recencyAt ?? null)
          : Math.max(row.recencyAt, existing?.recencyAt ?? row.recencyAt);
      if (existing?.page.sessions[0] && row.page.sessions[0]) {
        row.page.sessions[0] = {
          ...existing.page.sessions[0],
          ...row.page.sessions[0],
          ...(existing.page.sessions[0].name !== undefined
            ? { name: existing.page.sessions[0].name }
            : {}),
          ...(recencyAt !== null ? { recencyAt } : {}),
        };
      }
      this.markMutation(row.threadId);
      this.put({ ...row, recencyAt, fingerprint });
      await nextTurn();
    }
    for (const row of byPath.values()) {
      if (
        row.rolloutPath &&
        isCodexCatalogRolloutPathCovered(root, row.rolloutPath) &&
        !present.has(codexCatalogRolloutLogicalPath(row.rolloutPath)) &&
        this.rows.get(row.threadId) === row
      ) {
        this.remove(row.threadId);
      }
    }
    this.observedFiles = observed;
  }

  async upsertThread(thread: CodexThread): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      this.assertCurrent();
    } catch {
      // Retiring a view must not turn an acknowledged native mutation into failure.
      return;
    }
    this.markMutation(thread.id);
    const fieldRevision = this.captureFields();
    await this.observe(async (isCurrent) => this.projectThread(thread, isCurrent, fieldRevision));
  }

  private async refreshThread(
    id: string,
    readThread: (id: string) => Promise<CodexThread>,
  ): Promise<void> {
    this.assertCurrent();
    this.markMutation(id);
    const fieldRevision = this.captureFields();
    await this.observe(async (isCurrent) => {
      const thread = await readThread(id);
      if (thread.id !== id) {
        throw new Error("Codex catalog refresh returned a different thread");
      }
      if (!this.closed) {
        await this.projectThread(thread, isCurrent, fieldRevision);
      }
    });
  }

  private async projectThread(
    thread: CodexThread,
    isCurrent: (id: string) => boolean,
    fieldRevision: FieldRevision,
  ): Promise<void> {
    // Notifications and mutation results still belong to their native consumers.
    const projected = await projectCodexCatalogPage(
      { data: [{ ...thread }] },
      {
        localSessionsRoot: this.options.localSessionsRoot,
        sanitize: sanitizeTerminalText,
      },
    );
    if (this.closed) {
      return;
    }
    const row = projected.rows[0];
    if (row) {
      this.observeFields(row, fieldRevision);
      if (!isCurrent(thread.id)) {
        return;
      }
      const previous = this.rows.get(thread.id);
      const fingerprint =
        previous?.rolloutPath &&
        row.rolloutPath &&
        codexCatalogRolloutLogicalPath(previous.rolloutPath) ===
          codexCatalogRolloutLogicalPath(row.rolloutPath)
          ? previous.fingerprint
          : undefined;
      this.markMutation(thread.id);
      this.put({ ...row, ...(fingerprint ? { fingerprint } : {}) });
    }
  }

  archive(threadId: string): void {
    // A native acknowledgement is a fact about the captured home even if its
    // serving configuration changed while the pinned action was running.
    if (this.closed) {
      return;
    }
    this.markMutation(threadId);
    this.liveStatus.delete(threadId);
    this.names.delete(threadId);
    const row = this.rows.get(threadId);
    if (row) {
      this.put({ ...row, archived: true });
    }
  }

  get(threadId: string): CodexCatalogIndexRow | undefined {
    return this.rows.get(threadId);
  }

  async list(params: CodexSessionCatalogPageParams): Promise<CodexSessionCatalogPage> {
    const query = prepareCodexCatalogQuery(this.options.homeId, params);
    await this.restore();
    this.assertCurrent();
    this.scheduleHydration();
    if (this.failure && this.rows.size === 0) {
      throw this.failure.error;
    }
    this.ordered ??= [...this.rows.values()].toSorted(order);
    return query(this.ordered, this.liveStatus);
  }

  /** Fence future publications before a replacement opens the same persisted home. */
  retire(): Promise<void> {
    this.closed = true;
    this.liveStatus.invalidate();
    this.unsubscribe();
    clearInterval(this.timer);
    clearImmediate(this.background);
    clearTimeout(this.debounce);
    this.watcher?.close();
    return this.persistence.retire();
  }

  async close(): Promise<void> {
    const writes = this.retire();
    await Promise.allSettled([
      this.initializing,
      this.restoring,
      this.reconciling,
      this.reconcilingNative,
      writes,
      this.events.close(),
    ]);
    this.rows.clear();
    this.observedFiles.clear();
    this.ordered = undefined;
  }
}
