import {
  CODEX_CATALOG_MAX_ROWS,
  type CodexCatalogIndexRow,
} from "./session-catalog-index-state.js";

export function codexCatalogRowRecency(row: CodexCatalogIndexRow): number {
  return row.recencyAt ?? row.updatedAt ?? 0;
}

export function compareCodexCatalogRows(a: CodexCatalogIndexRow, b: CodexCatalogIndexRow): number {
  return (
    codexCatalogRowRecency(b) - codexCatalogRowRecency(a) ||
    (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0) ||
    (a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0)
  );
}

/** Stable positions keep issued cursors independent of later native page offsets. */
export class CodexCatalogOrdering {
  private nextEventOrder = -1;

  restore(row: CodexCatalogIndexRow): void {
    this.nextEventOrder = Math.min(this.nextEventOrder, (row.sourceOrder ?? 0) - 1);
  }

  private unchangedPosition(row: CodexCatalogIndexRow, previous?: CodexCatalogIndexRow) {
    return previous && codexCatalogRowRecency(row) <= codexCatalogRowRecency(previous)
      ? previous.sourceOrder
      : undefined;
  }

  position(row: CodexCatalogIndexRow, previous?: CodexCatalogIndexRow): number {
    return row.sourceOrder ?? this.unchangedPosition(row, previous) ?? this.nextEventOrder--;
  }

  captureBatch(hasRows: boolean) {
    // Each walk admits at most MAX_ROWS; new rows retain their native order within this block.
    const base = hasRows ? this.nextEventOrder - CODEX_CATALOG_MAX_ROWS : 0;
    if (hasRows) {
      this.nextEventOrder = base - 1;
    }
    return (
      row: CodexCatalogIndexRow,
      previous: CodexCatalogIndexRow | undefined,
      position: number,
    ) => this.unchangedPosition(row, previous) ?? base + position;
  }
}
