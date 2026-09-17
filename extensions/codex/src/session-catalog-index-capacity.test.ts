import { describe, expect, it, vi } from "vitest";
import {
  readCodexCatalogSnapshot,
  type CodexCatalogIndexRow,
  type CodexCatalogState,
  type StoredCodexCatalogEntry,
} from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";

function row(threadId: string, recencyAt: number, archived = false): CodexCatalogIndexRow {
  return {
    threadId,
    updatedAt: recencyAt,
    recencyAt,
    archived,
    nativeMetadata: true,
    preview: `Investigate the original native request for ${threadId}`,
    rolloutPath: `/synthetic/sessions/2026/09/17/rollout-${threadId}.jsonl`,
    page: {
      sessions: [
        {
          threadId,
          name: `Native session ${threadId}`,
          cwd: "/workspace/project",
          source: "cli",
          status: "notLoaded",
          archived: false,
          updatedAt: recencyAt,
          recencyAt,
        },
      ],
    },
  };
}

function completeState(rows: CodexCatalogIndexRow[]): CodexCatalogState {
  const values: StoredCodexCatalogEntry[] = [
    { version: 1, kind: "complete" },
    ...rows.map((value) => ({ version: 1 as const, kind: "row" as const, row: value })),
  ];
  return {
    entries: async () =>
      values.map((value) => ({
        key: value.kind === "complete" ? "complete" : value.row.threadId,
        createdAt: 0,
        value,
      })),
    register: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
  };
}

describe("resident Codex catalog restore bounds", () => {
  it("bounds a complete snapshot by evicting archived-oldest rows before active rows", async () => {
    const active = Array.from({ length: 19_999 }, (_, index) =>
      row(`active-${index}`, 20_000 - index),
    );
    const rows = [
      row("archived-old", 50_000, true),
      ...active,
      row("archived-new", 70_000, true),
      row("archived-middle", 60_000, true),
    ];
    const readNative = vi.fn(async () => ({ rows: [] }));
    const index = new CodexCatalogIndex({
      homeId: "oversized-complete-snapshot",
      state: completeState(rows),
      readNative,
      assertCurrent: () => {},
    });
    try {
      const first = await index.list({ limit: 64 });
      expect(first.sessions.map((session) => session.threadId)).toEqual(
        active.slice(0, 64).map((entry) => entry.threadId),
      );
      expect(readNative).not.toHaveBeenCalled();
      const retained = rows.reduce(
        (count, entry) => count + Number(index.get(entry.threadId) !== undefined),
        0,
      );
      expect(retained).toBe(20_000);
      expect(index.get("archived-old")).toBeUndefined();
      expect(index.get("archived-middle")).toBeUndefined();
      expect(index.get("archived-new")?.archived).toBe(true);
      expect(index.get("active-19998")).toBeDefined();
      const admitted = rows.flatMap((entry) => {
        const value = index.get(entry.threadId);
        return value ? [value] : [];
      });
      console.info(
        "resident row payload measurements",
        JSON.stringify(
          [490, 20_000].map((count) => ({
            rows: count,
            serializedBytes: Buffer.byteLength(JSON.stringify(admitted.slice(0, count))),
          })),
        ),
      );
    } finally {
      await index.close();
    }
  });

  it("cleans a full invalid snapshot without mistaking repeated keys for overflow", async () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => row(`invalid-${index}`, index));
    rows[0]!.preview = "x".repeat(501);
    const snapshot = await readCodexCatalogSnapshot(completeState(rows));
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.cleanupIncomplete).toBe(false);
    expect(snapshot.obsolete.size).toBe(20_001);
  });

  it.each([
    { field: "preview", limit: 500 },
    { field: "rolloutPath", limit: 4_096 },
  ] as const)(
    "keeps the persisted $field within its native catalog bound",
    async ({ field, limit }) => {
      const valid = row("bounded", 100);
      valid[field] = field === "rolloutPath" ? `/${"x".repeat(limit - 1)}` : "x".repeat(limit);
      const accepted = await readCodexCatalogSnapshot(completeState([valid]));
      expect(accepted.complete).toBe(true);
      expect(accepted.rows[0]?.[field]).toHaveLength(limit);

      const oversized = { ...valid, [field]: `${valid[field]}x` };
      const rejected = await readCodexCatalogSnapshot(completeState([oversized]));
      expect(rejected.complete).toBe(false);
      expect(rejected.rows).toEqual([]);
      expect(rejected.obsolete).toEqual(new Set(["bounded", "complete"]));
    },
  );
});
