import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import type { StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import { idleThread } from "./session-catalog.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

it.each([1, 3])(
  "does not restore offline-deleted rows after %i failed snapshot enumerations",
  async (failedRestarts) => {
    const namespace = `snapshot-read-recovery-${failedRestarts}`;
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace,
        maxEntries: 20_001,
      });
    const deleted = idleThread({ id: "deleted-while-offline", source: "cli" });
    const current = idleThread({ id: "still-current", source: "cli" });
    let nativeRows: CodexThread[] = [deleted, current];
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: nativeRows }, { sanitize: sanitizeTerminalText }),
    );
    const createIndex = (failSnapshot = false) => {
      const state = openState();
      if (failSnapshot) {
        vi.spyOn(state, "entries").mockRejectedValue(new Error("snapshot enumeration unavailable"));
      }
      return new CodexCatalogIndex({
        homeId: namespace,
        state,
        readNative,
        assertCurrent: () => {},
      });
    };
    const original = createIndex();
    try {
      await original.initialize();
      expect((await original.list({})).sessions).toHaveLength(2);
    } finally {
      await original.close();
    }
    await closeOpenClawStateDatabaseAsync();
    nativeRows = [current];

    for (let restart = 0; restart < failedRestarts; restart++) {
      const recovering = createIndex(true);
      try {
        // A snapshot outage must not prevent native hydration or memory serving.
        expect((await recovering.list({})).sessions.map((row) => row.threadId)).toEqual([
          current.id,
        ]);
        await recovering.initialize();
        await recovering.upsertThread({ ...current, name: `Changed during outage ${restart}` });
      } finally {
        await recovering.close();
      }
      await closeOpenClawStateDatabaseAsync();
    }

    const recovered = createIndex();
    try {
      // Check the first list before a saved snapshot's background refresh could repair it.
      expect((await recovered.list({})).sessions.map((row) => row.threadId)).toEqual([current.id]);
      await recovered.initialize();
      const saved = await openState().entries();
      expect(
        saved.flatMap((entry) => (entry.value.kind === "row" ? [entry.value.row.threadId] : [])),
      ).toEqual([current.id]);
      expect(saved.some((entry) => entry.key === "complete")).toBe(true);
    } finally {
      await recovered.close();
    }
  },
);
