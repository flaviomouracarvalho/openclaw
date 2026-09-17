import { createHash } from "node:crypto";
import type { CodexCatalogAvailability } from "./session-catalog-availability.js";
import type { CodexCatalogField, CodexCatalogStatus } from "./session-catalog-index-field.js";
import {
  codexCatalogRowRecency,
  compareCodexCatalogRows,
  type CodexCatalogOrderKey,
} from "./session-catalog-index-order.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-state.js";
import {
  CatalogParamsError,
  normalizeLimit,
  readControlCursor,
} from "./session-catalog-parsing.js";
import type { CodexCatalogSettingsIndex } from "./session-catalog-settings.js";
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
  const cursor = (row: CodexCatalogOrderKey, backwards: boolean) =>
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
    liveSettings: Pick<CodexCatalogSettingsIndex, "get">,
    availability: Pick<CodexCatalogAvailability, "complete" | "frontier">,
  ): CodexSessionCatalogPage | undefined => {
    const { complete, frontier } = availability;
    if (!complete && !frontier) {
      return undefined;
    }
    if (
      !complete &&
      frontier &&
      anchor?.backwards &&
      compareCodexCatalogRows(frontier, {
        threadId: anchor.id,
        updatedAt: anchor.time,
        recencyAt: anchor.time,
        sourceOrder: anchor.sourceOrder,
      }) < 0
    ) {
      return undefined;
    }
    const selected = ordered.filter((row) => {
      const session = row.page.sessions[0];
      return (
        !row.archived &&
        session &&
        (complete || !frontier || compareCodexCatalogRows(row, frontier) <= 0) &&
        (!cwd || (liveSettings.get(row.threadId)?.cwd ?? session.cwd) === cwd) &&
        (!search || (session.name ?? session.fallbackName)?.toLocaleLowerCase().includes(search))
      );
    });
    let start = 0;
    let end: number | undefined;
    const after = (row: CodexCatalogOrderKey) =>
      !anchor ||
      codexCatalogRowRecency(row) < anchor.time ||
      (codexCatalogRowRecency(row) === anchor.time &&
        ((row.sourceOrder ?? 0) > anchor.sourceOrder ||
          ((row.sourceOrder ?? 0) === anchor.sourceOrder && row.threadId < anchor.id)));
    if (anchor) {
      const at = selected.findIndex(
        (row) => after(row) || (anchor.backwards && row.threadId === anchor.id),
      );
      const boundary = at < 0 ? selected.length : at;
      if (anchor.backwards) {
        end = boundary;
        start = Math.max(0, boundary - limit);
      } else {
        start = boundary;
      }
    }
    const page = selected.slice(start, end ?? start + limit);
    const first = page[0];
    const last = page.at(-1);
    let continuation: CodexCatalogOrderKey | undefined =
      last && start + page.length < selected.length ? last : undefined;
    if (!complete && !anchor?.backwards && !continuation) {
      if (!last && (!frontier || !after(frontier))) {
        return undefined;
      }
      continuation =
        frontier && (!last || compareCodexCatalogRows(frontier, last) > 0) ? frontier : last;
    }
    return {
      sessions: page.flatMap((row) =>
        row.page.sessions.map(
          ({ status: _storedStatus, activeFlags: _storedFlags, ...session }) => {
            const live = liveStatus.get(row.threadId);
            return {
              ...session,
              ...liveSettings.get(row.threadId),
              status: live?.status ?? "notLoaded",
              ...(live?.activeFlags ? { activeFlags: [...live.activeFlags] } : {}),
            };
          },
        ),
      ),
      ...(continuation ? { nextCursor: cursor(continuation, false) } : {}),
      ...(first && start > 0 ? { backwardsCursor: cursor(first, true) } : {}),
    };
  };
}
