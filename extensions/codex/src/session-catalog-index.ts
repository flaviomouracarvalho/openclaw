import { watch, type FSWatcher } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import type { CodexThreadListParams, CodexThread } from "./app-server/protocol.js";
import { subscribeCodexCatalogEvents } from "./session-catalog-events.js";
import { CodexCatalogIndexEvents } from "./session-catalog-index-events.js";
import { CodexCatalogField } from "./session-catalog-index-field.js";
import { applyCodexCatalogName } from "./session-catalog-index-names.js";
import { CodexCatalogObservations } from "./session-catalog-index-observations.js";
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
  type CodexCatalogRolloutFingerprint,
  CodexCatalogPersistence,
} from "./session-catalog-index-state.js";
import { CODEX_CATALOG_NATIVE_PAGE_LIMIT } from "./session-catalog-native-projection.js";
import { readControlCursor } from "./session-catalog-parsing.js";
import {
  projectCodexCatalogThread,
  mergeCodexCatalogRolloutRow,
} from "./session-catalog-projection.js";
import {
  scanCodexCatalogRollouts,
  codexCatalogRolloutLogicalPath,
  isCodexCatalogRolloutPathCovered,
  readCodexCatalogRollout,
} from "./session-catalog-rollouts.js";
import { CodexCatalogSettingsIndex } from "./session-catalog-settings.js";
import { getCodexCatalogSource, setCodexCatalogSource } from "./session-catalog-source.js";
import { CodexCatalogStatusIndex } from "./session-catalog-status.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

const RECONCILE_MS = 30_000;
type CodexCatalogIndexRead = (
  params: CodexThreadListParams,
  remainingRows: number,
) => Promise<{
  rows: CodexCatalogIndexRow[];
  excludedThreadIds?: string[];
  nextCursor?: string;
}>;
type FieldRevision = { status: number; name: number };

type IndexOptions = {
  homeId: string;
  localSessionsRoot?: string;
  state?: CodexCatalogState;
  readNative: CodexCatalogIndexRead;
  assertCurrent: () => void;
  runBackground?: (run: () => Promise<void>) => Promise<void>;
};
/** One home owns all queries. Only hydration, notifications and directory currency do I/O. */
export class CodexCatalogIndex {
  private readonly rows = new Map<string, CodexCatalogIndexRow>();
  private readonly liveStatus = new CodexCatalogStatusIndex();
  private readonly liveSettings = new CodexCatalogSettingsIndex();
  private readonly names = new CodexCatalogField<string | null>();
  private ordered: CodexCatalogIndexRow[] | undefined;
  private initializing: Promise<void> | undefined;
  private initialized = false;
  private needsNativeRefresh = false;
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
  private readonly obsoleteStoredKeys = new Set<string>();
  private sourceRevision = 0;
  private readonly ordering = new CodexCatalogOrdering();
  private readonly observations = new CodexCatalogObservations();
  private readonly events: CodexCatalogIndexEvents;

  constructor(private readonly options: IndexOptions) {
    this.persistence = new CodexCatalogPersistence(options.state, (error) => this.report(error));
    this.events = new CodexCatalogIndexEvents({
      get: (id) => this.rows.get(id),
      updateStatus: (id, status, source) => {
        this.liveStatus.update(id, status, source);
        if (status.status === "notLoaded") {
          this.liveSettings.withdraw(id, source);
        }
      },
      updateSettings: (id, settings, source) => this.liveSettings.update(id, settings, source),
      rename: (id, name) => {
        this.names.update(id, name);
        const row = this.rows.get(id);
        if (row && !this.closed) {
          this.put(row);
        }
      },
      upsert: (thread) => this.upsertThread(thread),
      reserveTurnStartOrder: () => this.ordering.reserveEvent(),
      refresh: (id, readThread, sourceOrder) => this.refreshThread(id, readThread, sourceOrder),
      archive: (id) => this.archive(id),
      remove: (id) => this.remove(id),
      report: (error) => this.report(error),
    });
    this.unsubscribe = subscribeCodexCatalogEvents(
      options.homeId,
      (event, readThread, source) => this.events.handle(event, readThread, source),
      {
        onClose: (source) => {
          this.liveStatus.invalidate(source);
          this.liveSettings.invalidate(source);
        },
        onResume: async (response, source) => {
          this.liveSettings.update(response.thread.id, response, source);
          await this.upsertThread(setCodexCatalogSource(response.thread, source));
        },
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
    const patched = this.withName({ ...candidate, ...(preview !== undefined ? { preview } : {}) });
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
    const oldest = this.ordering.evictionCandidate(this.rows);
    if (oldest?.threadId === row.threadId) {
      this.rows.delete(row.threadId);
      this.liveStatus.delete(row.threadId);
      this.liveSettings.delete(row.threadId);
      this.names.delete(row.threadId);
      return;
    }
    if (oldest) {
      this.remove(oldest.threadId);
    }
    this.persistence.put(row);
  }

  private remove(threadId: string): void {
    this.observations.mark(threadId);
    this.rows.delete(threadId);
    this.liveStatus.delete(threadId);
    this.liveSettings.delete(threadId);
    this.names.delete(threadId);
    this.ordered = undefined;
    this.persistence.remove(threadId);
  }

  async initialize(): Promise<void> {
    this.assertCurrent();
    clearImmediate(this.background);
    this.background = undefined;
    if (this.initialized && !this.needsNativeRefresh) {
      return;
    }
    if (!this.initializing) {
      const sourceRevision = this.sourceRevision;
      this.initializing = (async () => {
        await this.restore();
        await this.persistence.pruneObsolete(this.obsoleteStoredKeys, this.rows.values());
        this.obsoleteStoredKeys.clear();
        await this.reconcilingNative?.catch((error: unknown) => this.report(error));
        if (!this.initialized) {
          let observedRevision: number;
          do {
            observedRevision = await this.observations.observe((isCurrent) =>
              this.hydrate(isCurrent),
            );
          } while (observedRevision !== this.sourceRevision);
        }
        if (this.needsNativeRefresh) {
          await this.reconcile();
          await this.reconcileNative();
          this.needsNativeRefresh = false;
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
    this.restoring ??= this.observations.observe(async (isCurrent) => {
      let complete = false;
      let validSnapshot = true;
      if (this.options.state) {
        try {
          const entries = await this.options.state.entries();
          this.assertCurrent();
          for (const entry of entries) {
            if (entry.value?.version === 1 && entry.value.kind === "complete") {
              complete = true;
              continue;
            }
            const row = readStoredCodexCatalogRow(entry.value);
            if (!row) {
              validSnapshot = false;
              this.obsoleteStoredKeys.add(entry.key);
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
      if (!validSnapshot) {
        this.obsoleteStoredKeys.add("complete");
      }
      if (complete && validSnapshot && this.options.localSessionsRoot) {
        this.initialized = true;
        this.needsNativeRefresh = true;
        this.startCurrency();
      }
    });
    await this.restoring;
  }

  private scheduleHydration(): void {
    if (
      (this.initialized && !this.needsNativeRefresh) ||
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
      getCodexCatalogSource(row),
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
      const refresh = this.observations.observe(async (isCurrent) => {
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
    const files =
      this.options.localSessionsRoot && !useStateDbOnly
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
          limit: CODEX_CATALOG_NATIVE_PAGE_LIMIT,
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
      for (const id of page.excludedThreadIds ?? []) {
        if (isCurrent(id)) {
          this.remove(id);
        }
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
        const previous = this.rows.get(row.threadId);
        const fingerprint = logicalPath
          ? (files.get(logicalPath) ??
            files.get(`${logicalPath}.zst`) ??
            (useStateDbOnly &&
            previous?.rolloutPath &&
            codexCatalogRolloutLogicalPath(previous.rolloutPath) === logicalPath
              ? previous.fingerprint
              : undefined))
          : undefined;
        this.observations.mark(row.threadId);
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
    // DB-only listing can omit local files when indexing is incomplete or the
    // database is unavailable. Verified file absence and events own their removal.
    if (!useStateDbOnly || !this.options.localSessionsRoot) {
      for (const [id, row] of remaining) {
        if (isCurrent(id) && this.rows.get(id) === row) {
          this.remove(id);
        }
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
      this.reconciling = this.observations
        .observe((isCurrent) => this.reconcileFiles(isCurrent))
        .finally(() => {
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
      if (
        existing?.rolloutPath &&
        codexCatalogRolloutLogicalPath(existing.rolloutPath) !==
          codexCatalogRolloutLogicalPath(file)
      ) {
        // Reverts retain older immutable files with the same thread id. Only
        // native metadata may change which rollout the catalog considers current.
        observed.set(file, fingerprint);
        continue;
      }
      if (!existing && !thread.preview) {
        observed.set(file, fingerprint);
        continue;
      }
      thread.preview ||= existing?.preview;
      const projected = await projectCodexCatalogThread(thread, root);
      this.assertCurrent();
      if (!isCurrent(thread.id)) {
        continue;
      }
      observed.set(file, fingerprint);
      const row = projected.rows[0];
      if (!row) {
        continue;
      }
      this.observations.mark(row.threadId);
      this.put(mergeCodexCatalogRolloutRow(row, existing, fingerprint));
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
    this.observations.mark(thread.id);
    const fieldRevision = this.captureFields();
    await this.observations.observe(async (isCurrent) =>
      this.projectThread(thread, isCurrent, fieldRevision),
    );
  }

  private async refreshThread(
    id: string,
    readThread: (id: string) => Promise<CodexThread>,
    sourceOrder: number | undefined,
  ): Promise<boolean> {
    this.assertCurrent();
    this.observations.mark(id);
    const fieldRevision = this.captureFields();
    return await this.observations.observe(async (isCurrent) => {
      const thread = await readThread(id);
      if (thread.id !== id) {
        throw new Error("Codex catalog refresh returned a different thread");
      }
      if (this.closed) {
        return true;
      }
      return this.projectThread(thread, isCurrent, fieldRevision, sourceOrder);
    });
  }

  private async projectThread(
    thread: CodexThread,
    isCurrent: (id: string) => boolean,
    fieldRevision: FieldRevision,
    sourceOrder?: number,
  ): Promise<boolean> {
    const projected = await projectCodexCatalogThread(thread, this.options.localSessionsRoot);
    if (this.closed) {
      return true;
    }
    const row = projected.rows[0];
    if (row) {
      this.observeFields(row, fieldRevision);
    }
    if (!isCurrent(thread.id)) {
      return false;
    }
    if (projected.excludedThreadIds?.includes(thread.id)) {
      this.remove(thread.id);
    }
    if (row) {
      const previous = this.rows.get(thread.id);
      const fingerprint =
        previous?.rolloutPath &&
        row.rolloutPath &&
        codexCatalogRolloutLogicalPath(previous.rolloutPath) ===
          codexCatalogRolloutLogicalPath(row.rolloutPath)
          ? previous.fingerprint
          : undefined;
      this.observations.mark(thread.id);
      this.put({
        ...row,
        // Preserve notification order when tied turns' metadata reads finish out of order.
        ...(sourceOrder !== undefined ? { sourceOrder } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      });
    }
    return true;
  }

  archive(threadId: string): void {
    // A native acknowledgement is a fact about the captured home even if its
    // serving configuration changed while the pinned action was running.
    if (this.closed) {
      return;
    }
    this.observations.mark(threadId);
    this.liveStatus.delete(threadId);
    this.liveSettings.delete(threadId);
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
    return query(this.ordered, this.liveStatus, this.liveSettings);
  }

  /** Fence future publications before a replacement opens the same persisted home. */
  retire(): Promise<void> {
    this.closed = true;
    this.liveStatus.invalidate();
    this.liveSettings.invalidate();
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
