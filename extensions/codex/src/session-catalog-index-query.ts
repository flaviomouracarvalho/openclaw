import { createHash } from "node:crypto";
import type { CodexCatalogField, CodexCatalogStatus } from "./session-catalog-index-field.js";
import { codexCatalogRowRecency } from "./session-catalog-index-order.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-state.js";
import {
  CatalogParamsError,
  normalizeLimit,
  readControlCursor,
} from "./session-catalog-parsing.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

/** Keyset pagination remains valid when the anchor row is archived or deleted. */
export function prepareCodexCatalogQuery(homeId: string, params: CodexSessionCatalogPageParams) {
  const limit = Math.min(normalizeLimit(params.limit, "limit"), 64);
  const encoded = readControlCursor(params.cursor, "request");
  const cwd = params.cwd?.trim();
  const search = params.searchTerm?.trim().toLocaleLowerCase();
  const queryId = createHash("sha256")
    .update(JSON.stringify([homeId, cwd ?? "", search ?? ""]))
    .digest("hex")
    .slice(0, 16);
  let anchor: { time: number; id: string; sourceOrder: number; backwards: boolean } | undefined;
  if (encoded) {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, "base64url").toString());
    } catch {
      throw new CatalogParamsError("invalid Codex resident catalog cursor");
    }
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
      value[0] !== queryId ||
      typeof value[1] !== "number" ||
      !Number.isFinite(value[1]) ||
      typeof value[2] !== "string" ||
      value[2].length > 256 ||
      typeof value[3] !== "number" ||
      !Number.isSafeInteger(value[3]) ||
      typeof value[4] !== "boolean"
    ) {
      throw new CatalogParamsError("invalid Codex resident catalog cursor");
    }
    anchor = { time: value[1], id: value[2], sourceOrder: value[3], backwards: value[4] };
  }
  const cursor = (row: CodexCatalogIndexRow, backwards: boolean) =>
    Buffer.from(
      JSON.stringify([
        queryId,
        codexCatalogRowRecency(row),
        row.threadId,
        row.sourceOrder ?? 0,
        backwards,
      ]),
    ).toString("base64url");
  return (
    ordered: readonly CodexCatalogIndexRow[],
    liveStatus: Pick<CodexCatalogField<CodexCatalogStatus>, "get">,
  ): CodexSessionCatalogPage => {
    const selected = ordered.filter((row) => {
      const session = row.page.sessions[0];
      return (
        !row.archived &&
        session &&
        (!cwd || session.cwd === cwd) &&
        (!search || (session.name ?? session.fallbackName)?.toLocaleLowerCase().includes(search))
      );
    });
    let start = 0;
    if (anchor) {
      const after = (row: CodexCatalogIndexRow) =>
        codexCatalogRowRecency(row) < anchor.time ||
        (codexCatalogRowRecency(row) === anchor.time &&
          ((row.sourceOrder ?? 0) > anchor.sourceOrder ||
            ((row.sourceOrder ?? 0) === anchor.sourceOrder && row.threadId < anchor.id)));
      const at = selected.findIndex(
        (row) => after(row) || (anchor.backwards && row.threadId === anchor.id),
      );
      start = anchor.backwards
        ? Math.max(0, (at < 0 ? selected.length : at) - limit)
        : at < 0
          ? selected.length
          : at;
    }
    const page = selected.slice(start, start + limit);
    const first = page[0];
    const last = page.at(-1);
    return {
      sessions: page.flatMap((row) =>
        row.page.sessions.map(
          ({ status: _storedStatus, activeFlags: _storedFlags, ...session }) => {
            const live = liveStatus.get(row.threadId);
            return {
              ...session,
              status: live?.status ?? "notLoaded",
              ...(live?.activeFlags ? { activeFlags: [...live.activeFlags] } : {}),
            };
          },
        ),
      ),
      ...(last && start + page.length < selected.length ? { nextCursor: cursor(last, false) } : {}),
      ...(first && start > 0 ? { backwardsCursor: cursor(first, true) } : {}),
    };
  };
}
