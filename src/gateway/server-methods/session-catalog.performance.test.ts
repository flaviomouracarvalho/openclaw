import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogSession } from "../../../packages/gateway-protocol/src/index.js";
import {
  call,
  hoisted,
  provider,
  resetSessionCatalogTestState,
} from "./session-catalog.test-helpers.js";

function residentCatalogFixture(count: number): SessionCatalogSession[] {
  return Array.from({ length: count }, (_, index) => ({
    threadId: `thread-${index}`,
    sessionKey: `agent:main:thread-${index}`,
    name: `Investigate retry behavior in project ${index % 12}: preserve the pending request and report the original failure before scheduling another attempt.`,
    cwd: `/synthetic/projects/project-${index % 12}`,
    status: "stored",
    createdAt: 1_700_000_000_000 - index * 60_000,
    updatedAt: 1_700_000_030_000 - index * 60_000,
    archived: false,
    canContinue: true,
    canArchive: true,
  }));
}

describe("resident catalog Gateway performance", () => {
  beforeEach(resetSessionCatalogTestState);

  it("lists a 3,000-row resident fixture below 20 ms warm p50", async () => {
    const sessions = residentCatalogFixture(3_000);
    const entries = sessions.map((session) => ({
      sessionKey: session.sessionKey!,
      entry: {
        sessionId: session.threadId,
        updatedAt: session.updatedAt,
        pluginOwnerId: "resident-fixture",
      },
    }));
    hoisted.listSessionEntriesReadOnly.mockReturnValue(entries);
    const list = vi.fn(async ({ limitPerHost }: { limitPerHost?: number }) => [
      {
        hostId: "gateway:resident-fixture",
        label: "Resident fixture",
        kind: "gateway" as const,
        connected: true,
        sessions: sessions.slice(0, limitPerHost),
      },
    ]);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("resident-fixture", { list }) }];
    const config = {};
    const client = { connId: "resident-benchmark" };
    const request = { catalogId: "resident-fixture", limitPerHost: 100 };
    for (let index = 0; index < 10; index += 1) {
      await call("sessions.catalog.list", request, config, client);
    }
    list.mockClear();
    const durations: number[] = [];
    const cpuStart = process.threadCpuUsage();
    let response: Awaited<ReturnType<typeof call>> | undefined;
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      response = await call("sessions.catalog.list", request, config, client);
      durations.push(performance.now() - started);
    }
    const cpu = process.threadCpuUsage(cpuStart);
    durations.sort((left, right) => left - right);
    const metrics = {
      residentRows: sessions.length,
      pageSize: request.limitPerHost,
      lists: durations.length,
      p50Ms: durations[49]!,
      p95Ms: durations[94]!,
      threadCpuMsPerList: (cpu.user + cpu.system) / 1_000 / durations.length,
    };
    console.info("resident Gateway catalog fixture", metrics);
    expect(response?.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual(
      sessions.slice(0, 100),
    );
    expect(list).toHaveBeenCalledTimes(100);
    expect(metrics.p50Ms).toBeLessThan(20);
  });
});
