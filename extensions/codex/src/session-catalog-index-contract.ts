import type { CodexThreadListParams } from "./app-server/protocol.js";
import type { CodexCatalogIndexRow, CodexCatalogState } from "./session-catalog-index-state.js";

type CodexCatalogIndexRead = (
  params: CodexThreadListParams,
  remainingRows: number,
) => Promise<{
  rows: CodexCatalogIndexRow[];
  excludedThreadIds?: string[];
  nextCursor?: string;
}>;

export type CodexCatalogIndexOptions = {
  homeId: string;
  localSessionsRoot?: string;
  state?: CodexCatalogState;
  readNative: CodexCatalogIndexRead;
  requestTimeoutMs?: number;
  assertCurrent: () => void;
  runBackground?: (run: () => Promise<void>) => Promise<void>;
};
