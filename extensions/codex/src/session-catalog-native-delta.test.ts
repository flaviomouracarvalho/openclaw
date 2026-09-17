import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  idleThread,
} from "./session-catalog.test-helpers.js";

it("reconciles remote membership without reparsing unchanged visible or hidden previews", async () => {
  const known = idleThread({
    id: "known",
    name: "Previous title",
    preview: "Retained first user request",
    path: "/remote/sessions/known.jsonl",
    updatedAt: 100,
    recencyAt: 100,
    source: "cli",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
  });
  const changed = idleThread({
    id: "changed",
    name: null,
    preview: "Previous request",
    updatedAt: 100,
    recencyAt: 100,
    source: "cli",
  });
  const hidden = idleThread({
    id: "hidden",
    source: "exec",
    preview: "Hidden native execution",
    updatedAt: 100,
    recencyAt: 100,
  });
  let native = [known, changed, idleThread({ id: "removed", source: "cli" }), hidden];
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_plugin, method, params, options) => {
      expect(method).toBe("thread/list");
      if (params.useStateDbOnly) {
        expect(options).toHaveProperty("catalogPreview", true);
      }
      return { data: native } satisfies CodexThreadListResponse;
    },
  );
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://remote-catalog.example.test/codex",
        authToken: "synthetic-remote-catalog-token",
      },
    }),
    getRuntimeConfig: () => undefined,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  expect(source.localSessionsRoot).toBeUndefined();
  const control = factory.forRequest("main", source);
  const preview = vi.fn(() => {
    throw new Error("Unchanged resident rows must not reparse native previews");
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await control.initialize();
    expect((await control.listPage({})).sessions.map((row) => row.threadId).toSorted()).toEqual([
      "changed",
      "known",
      "removed",
    ]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    Object.defineProperty(known, "preview", { get: preview });
    Object.defineProperty(hidden, "preview", { get: preview });
    known.name = null;
    known.status = { type: "idle" };
    known.path = `${known.path}.zst`;
    changed.preview = "Changed user request";
    changed.updatedAt = 200;
    changed.recencyAt = 200;
    const created = idleThread({
      id: "created",
      name: null,
      source: "cli",
      preview: "New independent native task",
      updatedAt: 300,
      recencyAt: 300,
    });
    native = [created, changed, known, hidden];
    expect((await control.listPage({})).sessions.map((row) => row.threadId).toSorted()).toEqual([
      "changed",
      "known",
      "removed",
    ]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => {
      const sessions = (await control.listPage({})).sessions;
      expect(sessions.map((row) => row.threadId).toSorted()).toEqual([
        "changed",
        "created",
        "known",
      ]);
      expect(sessions.find((row) => row.threadId === "known")).toMatchObject({
        name: null,
        fallbackName: "Retained first user request",
        status: "idle",
      });
      expect(sessions.find((row) => row.threadId === "known")).not.toHaveProperty("activeFlags");
      expect(sessions.find((row) => row.threadId === "changed")?.fallbackName).toBe(
        "Changed user request",
      );
      expect(sessions.find((row) => row.threadId === "created")?.fallbackName).toBe(
        "New independent native task",
      );
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    expect(commandRpcMocks.codexControlRequest.mock.calls[1]?.[2]).toMatchObject({
      useStateDbOnly: true,
    });
    expect(preview).not.toHaveBeenCalled();
  } finally {
    try {
      await factory.stop();
    } finally {
      vi.useRealTimers();
    }
  }
});

it("walks remote pages beyond the resident bound without projecting the uncached tail", async () => {
  const native = Array.from({ length: 20_001 }, (_, index) =>
    idleThread({
      id: `bounded-thread-${index}`,
      source: index === 20_000 ? "exec" : "cli",
      preview: `Synthetic first user request ${index}`,
      updatedAt: 100,
      recencyAt: 100,
    }),
  );
  const lastPage = createDeferred<void>();
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    expect(method).toBe("thread/list");
    const offset = Number(params.cursor ?? 0);
    const data = native.slice(offset, offset + 64);
    const nextCursor = offset + data.length < native.length ? String(offset + data.length) : null;
    if (params.useStateDbOnly && nextCursor === null) {
      lastPage.resolve();
    }
    return { data, nextCursor } satisfies CodexThreadListResponse;
  });
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://bounded-remote-catalog.example.test/codex",
        authToken: "synthetic-bounded-catalog-token",
      },
    }),
    getRuntimeConfig: () => undefined,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  const tailPreview = vi.fn(() => {
    throw new Error("Uncached native tail must not be projected on each refresh");
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await control.initialize();
    const first = await control.listPage({ limit: 64 });
    expect(first.sessions.map((row) => row.threadId)).toEqual(
      native.slice(0, 64).map((thread) => thread.id),
    );
    const pages = Math.ceil(native.length / 64);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(pages);
    Object.defineProperty(native[20_000]!, "preview", { get: tailPreview });
    await vi.advanceTimersByTimeAsync(30_000);
    await lastPage.promise;
    const refreshed = await control.listPage({ limit: 64 });
    await factory.stop();
    expect(refreshed).toEqual(first);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(pages * 2);
    expect(tailPreview).not.toHaveBeenCalled();
  } finally {
    try {
      await factory.stop();
    } finally {
      vi.useRealTimers();
    }
  }
});
