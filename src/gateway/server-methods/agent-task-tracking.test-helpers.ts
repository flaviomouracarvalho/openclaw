import { vi } from "vitest";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";
import { getAgentTestMocks } from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

// Shared by every spawn control plane whose child turn reaches the gateway as a
// plain `agent` run: ACP manual spawns, plugin subagents, and native subagents.
export function mockSpawnedChildSessionEntry(
  childSessionKey: string,
  storePath = "/tmp/sessions.json",
) {
  mocks.userTurnStorePath = storePath;
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath,
    entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
    canonicalKey: childSessionKey,
  });
  mocks.updateSessionStore.mockResolvedValue(undefined);
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

export function spyDetachedCreateRunningTaskRun() {
  const defaultRuntime = getDetachedTaskLifecycleRuntime();
  const createRunningTaskRunSpy = vi.fn(
    (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
      defaultRuntime.createRunningTaskRun(...args),
  );
  setDetachedTaskLifecycleRuntime({
    ...defaultRuntime,
    createRunningTaskRun: createRunningTaskRunSpy,
  });
  return createRunningTaskRunSpy;
}
