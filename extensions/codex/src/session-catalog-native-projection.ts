import type { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { isJsonObject, type JsonObject, type CodexThread } from "./app-server/protocol.js";
import {
  boundedCatalogString,
  MAX_CURSOR_LENGTH,
  MAX_CWD_LENGTH,
  MAX_SESSION_ID_LENGTH,
  selectCodexCatalogPreviewInput,
  truncateCodexCatalogPreview,
} from "./session-catalog-parsing.js";

export const CODEX_CATALOG_NATIVE_PAGE_LIMIT = 64;
export type CodexCatalogPreviewCache = (
  thread: Pick<CodexThread, "id" | "path" | "updatedAt" | "recencyAt">,
) => string | undefined;

const STRING_FIELDS = [
  ["sessionId", MAX_SESSION_ID_LENGTH, "omit"],
  ["projectId", MAX_SESSION_ID_LENGTH, "omit"],
  ["name", 500, "truncate"],
  ["cwd", MAX_CWD_LENGTH, "omit"],
  ["modelProvider", 500, "truncate"],
  ["cliVersion", 500, "truncate"],
] as const;

function copyString(
  value: unknown,
  limit: number,
  overflow: "omit" | "truncate" = "truncate",
): string | undefined {
  const bounded = boundedCatalogString(value, limit, overflow);
  // Preserve code units while detaching a small field from its native backing string.
  return bounded === undefined ? undefined : Buffer.from(bounded, "utf16le").toString("utf16le");
}

/** Keep only bounded catalog facts before an RPC promise can retain a native Thread. */
export function projectCodexCatalogNativeResponse(
  response: JsonObject,
  sanitize: typeof sanitizeTerminalText,
  cachedPreview?: CodexCatalogPreviewCache,
): JsonObject {
  if (!Array.isArray(response.data) || response.data.length > CODEX_CATALOG_NATIVE_PAGE_LIMIT) {
    throw new Error("Codex catalog response exceeds its native page limit");
  }
  const data = response.data.map((thread): JsonObject => {
    if (!isJsonObject(thread)) {
      throw new Error("Codex catalog response contains an invalid thread");
    }
    const id = boundedCatalogString(thread.id, MAX_SESSION_ID_LENGTH);
    if (!id) {
      throw new Error("Codex catalog response contains an invalid thread id");
    }
    const row: JsonObject = { id: Buffer.from(id, "utf16le").toString("utf16le") };
    if (thread.ephemeral === true) {
      return { ...row, ephemeral: true };
    }
    for (const [field, limit, overflow] of STRING_FIELDS) {
      const value = thread[field];
      const bounded = copyString(value, limit, overflow);
      if (value === null || bounded !== undefined) {
        row[field] = bounded ?? null;
      }
    }
    if (typeof thread.path === "string") {
      if (thread.path.length > MAX_CWD_LENGTH) {
        throw new Error("Codex catalog rollout path exceeds its length limit");
      }
      row.path = Buffer.from(thread.path, "utf16le").toString("utf16le");
    } else if (thread.path === null) {
      row.path = null;
    }
    if (typeof thread.originator === "string") {
      // Provenance tests exact native identity, unlike trimmed display metadata.
      row.originator = Buffer.from(thread.originator.slice(0, 500), "utf16le").toString("utf16le");
    }
    for (const field of ["createdAt", "updatedAt", "recencyAt"] as const) {
      const value = thread[field];
      if (value === null || (typeof value === "number" && Number.isFinite(value))) {
        row[field] = value;
      }
    }
    const preview = cachedPreview?.({
      id,
      path: typeof row.path === "string" ? row.path : null,
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
      recencyAt: typeof row.recencyAt === "number" ? row.recencyAt : null,
    });
    const rawPreview = thread.preview;
    if (
      preview !== undefined &&
      preview.length <= 500 &&
      !(typeof rawPreview === "string" && Boolean(rawPreview) !== Boolean(preview))
    ) {
      row.preview = preview;
    } else if (typeof rawPreview === "string") {
      row.preview = rawPreview
        ? truncateCodexCatalogPreview(selectCodexCatalogPreviewInput(rawPreview), sanitize)
        : "";
    } else if (rawPreview === null) {
      row.preview = null;
    }
    const source = typeof thread.source === "string" ? thread.source : undefined;
    if (source !== undefined && source.length <= 500) {
      row.source = Buffer.from(source, "utf16le").toString("utf16le");
    } else if (
      isJsonObject(thread.source) &&
      typeof thread.source.custom === "string" &&
      thread.source.custom.length <= 500
    ) {
      row.source = { custom: Buffer.from(thread.source.custom, "utf16le").toString("utf16le") };
    }
    if (isJsonObject(thread.gitInfo)) {
      const branch = copyString(thread.gitInfo.branch, 500);
      if (branch !== undefined) {
        row.gitInfo = { branch };
      }
    }
    if (isJsonObject(thread.status)) {
      const type = thread.status.type;
      if (type === "active" || type === "idle" || type === "notLoaded" || type === "systemError") {
        const status: JsonObject = { type };
        if (type === "active" && Array.isArray(thread.status.activeFlags)) {
          status.activeFlags = thread.status.activeFlags.slice(0, 16).flatMap((flag) => {
            const bounded = copyString(flag, 128, "omit");
            return bounded ? [bounded] : [];
          });
        }
        row.status = status;
      }
    }
    return row;
  });
  const page: JsonObject = { data };
  for (const field of ["nextCursor", "backwardsCursor"] as const) {
    const value = response[field];
    if (value === null) {
      page[field] = null;
    } else if (value !== undefined) {
      if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH) {
        throw new Error("Codex catalog response contains an invalid cursor");
      }
      page[field] = Buffer.from(value, "utf16le").toString("utf16le");
    }
  }
  return page;
}
