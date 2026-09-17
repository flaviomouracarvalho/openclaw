import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexThread, CodexThreadListResponse } from "./app-server/protocol.js";
import type { CodexCatalogPageDiagnostics } from "./session-catalog-diagnostics.js";
import { applyCodexCatalogName } from "./session-catalog-index-names.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-state.js";
import {
  boundedCatalogString,
  codexCatalogThreadName,
  codexCatalogThreadStatus,
  MAX_CWD_LENGTH,
  readControlCursor,
  selectCodexCatalogPreviewInput,
  toCatalogSession,
  truncateCodexCatalogPreview,
} from "./session-catalog-parsing.js";
import { isOpenClawManagedCodexThread } from "./session-catalog-provenance.js";
import { codexCatalogRolloutLogicalPath } from "./session-catalog-rollouts.js";
import {
  copyCodexCatalogSource,
  getCodexCatalogSource,
  setCodexCatalogSource,
  type CodexCatalogSource,
} from "./session-catalog-source.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

type CodexCatalogProjectionParams = {
  localSessionsRoot?: string;
  diagnostics?: CodexCatalogPageDiagnostics | null;
  sanitize: typeof sanitizeTerminalText;
  source?: CodexCatalogSource;
};

export async function projectCodexCatalogPage(
  response: CodexThreadListResponse,
  params: CodexCatalogProjectionParams,
) {
  const { diagnostics, sanitize } = params;
  const responseStarted = performance.now();
  const rows: CodexCatalogIndexRow[] = [];
  const excludedThreadIds: string[] = [];
  try {
    readControlCursor(response.backwardsCursor, "backwards response");
    // Also bound direct/pinned adapters before the first asynchronous provenance read.
    for (const thread of response.data) {
      if (typeof thread.preview === "string") {
        thread.preview = truncateCodexCatalogPreview(
          selectCodexCatalogPreviewInput(thread.preview),
          sanitize,
        );
      }
    }
    for (const thread of response.data) {
      if (thread.ephemeral === true) {
        excludedThreadIds.push(thread.id);
        continue;
      }
      const page: CodexSessionCatalogPage = { sessions: [] };
      if (
        await isOpenClawManagedCodexThread(
          thread,
          params.localSessionsRoot,
          diagnostics ?? undefined,
        )
      ) {
        const rolloutPath = typeof thread.path === "string" ? thread.path.trim() : "";
        page.managedThreads = [{ threadId: thread.id, ...(rolloutPath ? { rolloutPath } : {}) }];
      } else {
        const session = toCatalogSession(thread, false, sanitize);
        if (session) {
          page.sessions.push(session);
        }
      }
      rows.push(
        setCodexCatalogSource(
          {
            threadId: thread.id,
            archived: false,
            ...(thread.preview ? { preview: thread.preview } : {}),
            ...(thread.path ? { rolloutPath: thread.path } : {}),
            updatedAt: asFiniteNumber(thread.updatedAt) ?? null,
            recencyAt: asFiniteNumber(thread.recencyAt) ?? null,
            page,
          },
          params.source ?? getCodexCatalogSource(thread),
        ),
      );
    }
    return {
      rows,
      ...(excludedThreadIds.length ? { excludedThreadIds } : {}),
      nextCursor: readControlCursor(response.nextCursor, "next response"),
      backwardsCursor: readControlCursor(response.backwardsCursor, "backwards response"),
    };
  } finally {
    if (diagnostics) {
      diagnostics.fields.postResponseMs =
        (diagnostics.fields.postResponseMs ?? 0) + performance.now() - responseStarted;
    }
  }
}

/** Native activity/path changes invalidate the retained first-user preview. */
export function canReuseCodexCatalogPreview(
  row: CodexCatalogIndexRow | undefined,
  thread: Pick<CodexThread, "id" | "path" | "updatedAt" | "recencyAt">,
): boolean {
  return Boolean(
    row &&
    !row.archived &&
    row.updatedAt === (asFiniteNumber(thread.updatedAt) ?? null) &&
    row.recencyAt === (asFiniteNumber(thread.recencyAt) ?? null) &&
    (row.rolloutPath ? codexCatalogRolloutLogicalPath(row.rolloutPath) : undefined) ===
      (thread.path ? codexCatalogRolloutLogicalPath(thread.path) : undefined),
  );
}

export async function projectCodexCatalogDeltaPage(
  response: CodexThreadListResponse,
  params: CodexCatalogProjectionParams & {
    getRow: (threadId: string) => CodexCatalogIndexRow | undefined;
  },
) {
  const reusable = response.data.map((thread) => {
    const row = params.getRow(thread.id);
    if (
      thread.ephemeral === true ||
      !row ||
      !canReuseCodexCatalogPreview(row, thread) ||
      (row.page.sessions.length > 0 &&
        row.page.sessions[0]?.cwd !== boundedCatalogString(thread.cwd, MAX_CWD_LENGTH))
    ) {
      return undefined;
    }
    if (row.page.sessions.length === 0) {
      return row;
    }
    const named = applyCodexCatalogName(row, codexCatalogThreadName(thread.name));
    const status = codexCatalogThreadStatus(thread.status);
    return copyCodexCatalogSource(thread, {
      ...named,
      page: {
        ...named.page,
        sessions: named.page.sessions.map(({ activeFlags: _previous, ...session }) =>
          Object.assign(session, status),
        ),
      },
    });
  });
  const changed = await projectCodexCatalogPage(
    { ...response, data: response.data.filter((_thread, index) => !reusable[index]) },
    params,
  );
  let changedIndex = 0;
  return {
    ...changed,
    rows: reusable.flatMap((row, index) =>
      response.data[index]?.ephemeral === true ? [] : [row ?? changed.rows[changedIndex++]!],
    ),
  };
}
