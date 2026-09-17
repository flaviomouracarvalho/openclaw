import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let projection: SessionRowProjection | undefined;

afterEach(() => {
  projection?.dispose();
  projection = undefined;
  resetConfigRuntimeState();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it("selects delivery aliases across agents without narrowing provider planning", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("catalog-delivery-selection-"));
  const cfg = { agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  for (const agentId of ["main", "work"]) {
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (const name of ["main", "unused"]) {
          writeSessionEntry(database, `agent:${agentId}:${name}`, {
            sessionId: `${agentId}-${name}`,
            updatedAt: 1,
          });
        }
        if (agentId === "main") {
          writeSessionEntry(database, "global", { sessionId: "main-global", updatedAt: 1 });
        }
      },
      { agentId },
    );
  }
  const hosts = [["main", "global"], ["agent:work:main"]].map((sessionKeys, index) => ({
    hostId: `gateway:${index}`,
    label: `Host ${index}`,
    kind: "gateway" as const,
    connected: true,
    sessions: sessionKeys.map((sessionKey) => ({
      sessionKey,
      threadId: `thread-${sessionKey}`,
      status: "stored" as const,
      archived: false,
      canContinue: true,
      canArchive: false,
    })),
  }));
  projection = await createSessionRowProjection({ cfg });
  const planning = createSessionCatalogRequestEntrySnapshot({
    cfg,
    fallbackAgentId: "main",
    projection,
  });
  planning.freeze();
  expect(planning.sessionEntries.entriesForCatalog?.()).toHaveLength(5);
  const instances = new Map();
  for (const host of hosts) {
    planning.captureHostInstances(host, instances);
  }
  const delivery = createSessionCatalogRequestEntrySnapshot({
    cfg,
    fallbackAgentId: "main",
    projection,
    sessionKeys: hosts.flatMap((host) => host.sessions.map((session) => session.sessionKey)),
  });
  expect(hosts.map((host) => delivery.projectHostSessions(host, instances))).toEqual(hosts);
  expect(
    delivery.sessionEntries.entriesForAgent("main").map(({ sessionKey }) => sessionKey),
  ).toEqual(["agent:main:main", "global"]);
  expect(
    delivery.sessionEntries.entriesForAgent("work").map(({ sessionKey }) => sessionKey),
  ).toEqual(["agent:work:main"]);
});
