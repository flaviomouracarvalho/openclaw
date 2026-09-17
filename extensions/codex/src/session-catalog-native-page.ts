import { withTimeout } from "./app-server/timeout.js";
import { CodexCatalogLoadingError } from "./session-catalog-availability.js";
import type { CodexCatalogIndexOptions } from "./session-catalog-index-contract.js";
import {
  encodeCodexNativeCursor,
  type CodexNativeCatalogCursor,
  type CodexResidentCatalogCursor,
} from "./session-catalog-index-cursor.js";
import {
  CatalogParamsError,
  filterCatalogPageByTitle,
  MAX_TITLE_SEARCH_CATALOG_PAGES,
  normalizeLimit,
} from "./session-catalog-parsing.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

/** The resident limit bounds storage, never authoritative discovery. */
export async function listCodexNativeCatalogPage(
  params: CodexSessionCatalogPageParams,
  prepared: CodexResidentCatalogCursor | CodexNativeCatalogCursor,
  options: Pick<CodexCatalogIndexOptions, "readNative" | "assertCurrent">,
  deadline: number,
): Promise<CodexSessionCatalogPage> {
  const limit = Math.min(normalizeLimit(params.limit, "limit"), 64);
  let position: CodexNativeCatalogCursor =
    prepared.kind === "native"
      ? prepared
      : {
          kind: "native",
          queryId: prepared.queryId,
          backwards: prepared.anchor?.backwards ?? false,
          ...(prepared.anchor ? { anchorThreadId: prepared.anchor.threadId } : {}),
        };
  const at = (
    cursor: string | undefined,
    backwards: boolean,
    anchorThreadId?: string,
  ): CodexNativeCatalogCursor => ({
    kind: "native",
    queryId: prepared.queryId,
    backwards,
    ...(cursor ? { cursor } : {}),
    ...(anchorThreadId ? { anchorThreadId } : {}),
  });
  for (let scanned = 0; scanned < MAX_TITLE_SEARCH_CATALOG_PAGES; scanned++) {
    options.assertCurrent();
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new CodexCatalogLoadingError();
    }
    // Native backwards cursors reverse sortDirection. A transition inside a page
    // instead refetches that descending page and locates its frozen thread identity.
    const ascending = position.backwards && !position.anchorThreadId;
    const pageLimit = position.anchorThreadId ? 64 : limit;
    const page = await withTimeout(
      options.readNative(
        {
          archived: false,
          modelProviders: [],
          useStateDbOnly: true,
          sortKey: "recency_at",
          sortDirection: ascending ? "asc" : "desc",
          limit: pageLimit,
          ...(params.cwd?.trim() ? { cwd: params.cwd.trim() } : {}),
          ...(position.cursor ? { cursor: position.cursor } : {}),
        },
        pageLimit,
        true,
      ),
      remaining,
      "Codex session catalog is still loading",
      () => new CodexCatalogLoadingError(),
    );
    options.assertCurrent();
    let rows = ascending ? page.rows.toReversed() : page.rows;
    let next = (ascending ? page.backwardsCursor : page.nextCursor)
      ? at(ascending ? page.backwardsCursor : page.nextCursor, false)
      : undefined;
    let previous = (ascending ? page.nextCursor : page.backwardsCursor)
      ? at(ascending ? page.nextCursor : page.backwardsCursor, true)
      : undefined;
    if (position.anchorThreadId) {
      const anchor = rows.findIndex((row) => row.threadId === position.anchorThreadId);
      if (anchor < 0) {
        if (!page.nextCursor || page.nextCursor === position.cursor) {
          throw new CatalogParamsError(
            "Codex catalog changed; refresh before continuing this page",
          );
        }
        position = at(page.nextCursor, position.backwards, position.anchorThreadId);
        continue;
      }
      const start = position.backwards ? Math.max(0, anchor - limit) : anchor + 1;
      const end = position.backwards ? anchor : Math.min(rows.length, start + limit);
      const selected = rows.slice(start, end);
      if (!selected.length) {
        const continuation = position.backwards ? previous : next;
        if (continuation) {
          position = continuation;
          continue;
        }
      }
      const first = selected[0];
      const last = selected.at(-1);
      if (first && last) {
        next = end < rows.length ? at(position.cursor, false, last.threadId) : next;
        previous = start > 0 ? at(position.cursor, true, first.threadId) : previous;
      }
      rows = selected;
    } else if (!position.cursor && !position.backwards) {
      previous = undefined;
    }
    const projected = filterCatalogPageByTitle(
      {
        sessions: rows.flatMap((row) => row.page.sessions),
      },
      params.searchTerm,
    );
    const continuation = position.backwards ? previous : next;
    if (params.searchTerm && !projected.sessions.length && continuation) {
      if (encodeCodexNativeCursor(continuation) === encodeCodexNativeCursor(position)) {
        throw new CatalogParamsError("Codex catalog repeated a native continuation");
      }
      position = continuation;
      continue;
    }
    const managedThreads = rows.flatMap((row) => row.page.managedThreads ?? []);
    return {
      ...projected,
      ...(managedThreads.length ? { managedThreads } : {}),
      ...(next ? { nextCursor: encodeCodexNativeCursor(next) } : {}),
      ...(previous ? { backwardsCursor: encodeCodexNativeCursor(previous) } : {}),
    };
  }
  const continuation = encodeCodexNativeCursor(position);
  return {
    sessions: [],
    ...(position.backwards ? { backwardsCursor: continuation } : { nextCursor: continuation }),
  };
}
