import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import { writeCatalogRollout } from "./session-catalog-resident.test-support.js";
import { idleThread } from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("resident Codex catalog SQLite durability", () => {
  it("serves a restart from SQLite before reconciling only the changed rollout", async () => {
    const root = path.join(tempDirs.make("openclaw-resident-restart-"), "sessions");
    const native = ["changed", "untouched"].map((id) =>
      idleThread({
        id,
        name: null,
        source: "cli",
        originator: "codex_cli_rs",
        preview: `Original ${id}`,
      }),
    );
    for (const thread of native) {
      thread.path = await writeCatalogRollout(root, thread);
    }
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: "resident-restart-test",
        maxEntries: 20_001,
      });
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage(
        { data: structuredClone(native) },
        { sanitize: sanitizeTerminalText },
      ),
    );
    const createIndex = () =>
      new CodexCatalogIndex({
        homeId: "restart",
        localSessionsRoot: root,
        state: openState(),
        readNative,
        readNativeNames: async () => ({
          names: native.map((thread) => ({ threadId: thread.id, name: thread.name ?? null })),
        }),
        assertCurrent: () => {},
      });
    const first = createIndex();
    let initial;
    try {
      await first.initialize();
      initial = await first.list({});
      const persisted = (await openState().entries()).map((entry) => entry.value);
      expect(persisted).toHaveLength(3);
      expect(persisted).toContainEqual({ version: 1, kind: "complete" });
      expect(
        persisted.flatMap((entry) => (entry.kind === "row" ? [entry.row.threadId] : [])).toSorted(),
      ).toEqual(["changed", "untouched"]);
    } finally {
      await first.close();
    }
    await closeOpenClawStateDatabaseAsync();
    const changedFile = await writeCatalogRollout(root, {
      ...native[0]!,
      preview: "Changed while the Gateway was stopped",
    });
    readNative.mockClear();
    const open = vi.spyOn(fs, "open");
    const readFile = vi.spyOn(fs, "readFile");
    const restarted = createIndex();
    try {
      expect(await restarted.list({})).toEqual({
        ...initial,
        sessions: initial.sessions.map((session) =>
          Object.assign({}, session, { status: "notLoaded" }),
        ),
      });
      expect(readNative).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      await restarted.reconcile();
      expect((await restarted.list({})).sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            threadId: "changed",
            fallbackName: "Changed while the Gateway was stopped",
          }),
          expect.objectContaining({ threadId: "untouched", fallbackName: "Original untouched" }),
        ]),
      );
      expect(open.mock.calls.map((call) => call[0])).toEqual([changedFile]);
      expect(readNative).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      await restarted.close();
    }
  });

  it("refreshes an offline native rename after returning the persisted list without reading unchanged rollouts", async () => {
    const root = path.join(tempDirs.make("openclaw-resident-offline-title-"), "sessions");
    const native = idleThread({
      id: "renamed",
      name: "Previous title",
      preview: "Original user request",
      source: "cli",
      originator: "codex_cli_rs",
    });
    const rollout = await writeCatalogRollout(root, native);
    native.path = rollout;
    const originalBytes = await fs.readFile(rollout);
    const originalStat = await fs.stat(rollout);
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: "resident-offline-title-test",
        maxEntries: 20_001,
      });
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage(
        { data: [structuredClone(native)] },
        { sanitize: sanitizeTerminalText },
      ),
    );
    const names = createDeferred<{ names: Array<{ threadId: string; name: string | null }> }>();
    let offline = false;
    const readNativeNames = vi.fn(async (_params: CodexThreadListParams) =>
      offline
        ? await names.promise
        : { names: [{ threadId: native.id, name: native.name ?? null }] },
    );
    const createIndex = () =>
      new CodexCatalogIndex({
        homeId: "offline-title",
        localSessionsRoot: root,
        state: openState(),
        readNative,
        readNativeNames,
        assertCurrent: () => {},
      });
    const first = createIndex();
    try {
      await first.initialize();
      expect((await first.list({})).sessions[0]?.name).toBe("Previous title");
    } finally {
      await first.close();
    }
    await closeOpenClawStateDatabaseAsync();
    offline = true;
    native.name = "Renamed while offline";
    expect(await fs.readFile(rollout)).toEqual(originalBytes);
    expect(await fs.stat(rollout)).toMatchObject({
      mtimeMs: originalStat.mtimeMs,
      size: originalStat.size,
    });
    readNative.mockClear();
    readNativeNames.mockClear();
    const open = vi.spyOn(fs, "open");
    const readFile = vi.spyOn(fs, "readFile");
    const restarted = createIndex();
    try {
      expect((await restarted.list({})).sessions[0]?.name).toBe("Previous title");
      expect(readNativeNames).not.toHaveBeenCalled();
      expect(readNative).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(readNativeNames).toHaveBeenCalledOnce());
      expect(readNativeNames.mock.calls[0]?.[0]).toMatchObject({ useStateDbOnly: true });
      expect((await restarted.list({ searchTerm: "previous" })).sessions).toHaveLength(1);
      names.resolve({ names: [{ threadId: native.id, name: native.name }] });
      await vi.waitFor(async () => {
        expect((await restarted.list({ searchTerm: "renamed" })).sessions).toMatchObject([
          { threadId: "renamed", name: "Renamed while offline" },
        ]);
      });
      expect((await restarted.list({ searchTerm: "previous" })).sessions).toEqual([]);
      expect(readNative).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      names.resolve({ names: [] });
      await restarted.close();
    }
  });

  it("drains title, status, and archive changes to SQLite before closing", async () => {
    const startOptions: CodexAppServerStartOptions = {
      transport: "websocket",
      command: "codex",
      args: ["app-server"],
      url: "wss://resident-state.example.test/codex",
      headers: {},
    };
    const homeId = await codexCatalogResidentHomeKey({ startOptions });
    const native = [
      idleThread({
        id: "visible",
        name: "Original title",
        preview: "Original request",
        source: "cli",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      }),
      idleThread({ id: "archived", name: "Archived title", source: "cli" }),
    ];
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: "resident-mutations-test",
        maxEntries: 20_001,
      });
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage(
        { data: structuredClone(native) },
        { sanitize: sanitizeTerminalText },
      ),
    );
    const createIndex = () =>
      new CodexCatalogIndex({
        homeId,
        state: openState(),
        readNative,
        readNativeNames: async () => ({
          names: native.map((thread) => ({ threadId: thread.id, name: thread.name ?? null })),
        }),
        assertCurrent: () => {},
      });
    const first = createIndex();
    const harness = createClientHarness();
    try {
      await first.initialize();
      await observeCodexCatalogClient(harness.client, { startOptions });
      harness.send({
        method: "thread/name/updated",
        params: { threadId: "visible", threadName: null },
      });
      harness.send({
        method: "thread/status/changed",
        params: { threadId: "visible", status: { type: "idle" } },
      });
      harness.send({ method: "thread/archived", params: { threadId: "archived" } });
      const page = await first.list({});
      expect(page.sessions).toHaveLength(1);
      expect(page.sessions[0]).toMatchObject({
        threadId: "visible",
        name: null,
        fallbackName: "Original request",
        status: "idle",
      });
      expect(page.sessions[0]?.activeFlags).toBeUndefined();
      expect(harness.writes).toEqual([]);
    } finally {
      await first.close();
      await harness.client.closeAndWait();
    }
    await closeOpenClawStateDatabaseAsync();
    const persisted = (await openState().entries()).flatMap((entry) =>
      entry.value.kind === "row" ? [entry.value.row] : [],
    );
    expect(persisted.find((row) => row.threadId === "archived")?.archived).toBe(true);
    expect(persisted.find((row) => row.threadId === "visible")?.page.sessions[0]).toMatchObject({
      name: null,
      fallbackName: "Original request",
      status: "notLoaded",
    });
    expect(
      persisted.find((row) => row.threadId === "visible")?.page.sessions[0],
    ).not.toHaveProperty("activeFlags");
    readNative.mockClear();
    const restarted = createIndex();
    try {
      const page = await restarted.list({});
      expect(page.sessions).toHaveLength(1);
      expect(page.sessions[0]).toMatchObject({
        threadId: "visible",
        name: null,
        fallbackName: "Original request",
        status: "notLoaded",
      });
      expect(page.sessions[0]).not.toHaveProperty("activeFlags");
      expect(readNative).not.toHaveBeenCalled();
    } finally {
      await restarted.close();
    }
  });
});
