import { setImmediate as nextTurn } from "node:timers/promises";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-state.js";
import { readControlCursor } from "./session-catalog-parsing.js";

export type CodexCatalogNamesRead = (params: CodexThreadListParams) => Promise<{
  names: Array<{ threadId: string; name: string | null }>;
  nextCursor?: string;
}>;

export function applyCodexCatalogName(
  row: CodexCatalogIndexRow,
  name: string | null | undefined,
): CodexCatalogIndexRow {
  if (name === undefined) {
    return row;
  }
  return {
    ...row,
    page: {
      sessions: row.page.sessions.map(({ fallbackName: _fallback, ...session }) => ({
        ...session,
        name,
        ...(!name && row.preview ? { fallbackName: row.preview } : {}),
      })),
    },
  };
}

/** Native renames do not change rollout fingerprints or activity timestamps. */
export async function reconcileCodexCatalogNames(options: {
  read: CodexCatalogNamesRead;
  assertCurrent: () => void;
  publish: (threadId: string, name: string | null) => void;
}): Promise<void> {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    options.assertCurrent();
    const page = await options.read({
      archived: false,
      modelProviders: [],
      useStateDbOnly: true,
      limit: 64,
      ...(cursor ? { cursor } : {}),
    });
    options.assertCurrent();
    for (const { threadId, name } of page.names) {
      options.publish(threadId, name);
    }
    cursor = readControlCursor(page.nextCursor, "name reconciliation response");
    if (cursor && cursors.has(cursor)) {
      throw new Error("Codex catalog repeated a name reconciliation cursor");
    }
    if (cursor) {
      cursors.add(cursor);
    }
    await nextTurn();
  } while (cursor);
}
