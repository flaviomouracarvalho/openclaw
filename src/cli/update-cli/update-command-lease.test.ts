import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { stageBundledPluginRuntime } from "../../../scripts/stage-bundled-plugin-runtime.mts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import {
  createUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { VERSION } from "../../version.js";
import {
  entrypoint,
  events,
  expectDoctorDiagnostics,
  expectSuccess,
  installUpdateLeaseHarness,
  invoke,
  invokeReportedFailure,
  mocks,
  pluginResult,
  reportedResult,
  state,
  writeScenario,
} from "./update-command-lease.test-harness.js";
import type { ProducedPluginUpdateResult } from "./update-command-plugins-internals.js";

const { registerUpdateCli } = await import("../update-cli.js");
const { convergeUpdatePlugins } = await import("./update-command-convergence.js");
const { updateFinalizeCommand } = await import("./update-command-finalize.js");

installUpdateLeaseHarness();

it("passes standalone repair ownership to both fresh Doctor phases through the public command", async () => {
  await writeScenario("repair", { verifyRepairOwner: true });

  await runRegisteredCli({
    register: registerUpdateCli,
    argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
  });

  expect(
    defaultRuntime.exit,
    vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n"),
  ).not.toHaveBeenCalledWith(1);
  expectSuccess("repair");
  expect(listUpdateRuns()).toEqual([
    expect.objectContaining({
      status: "succeeded",
      steps: expect.arrayContaining([
        expect.objectContaining({ step: "finalize:repair-continuation", status: "completed" }),
      ]),
    }),
  ]);
  expect(process.env.OPENCLAW_UPDATE_RUN_ID).toBeUndefined();
});

function seedInterruptedPostCoreRun(): UpdateRunRecord {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 2 * ABANDONED_UPDATE_RUN_MS);
  try {
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    return recordUpdateRunPhase(run.runId, "verifying", {
      step: { step: "post-update verification", status: "in_progress" },
    });
  } finally {
    clock.mockRestore();
  }
}

function expectRecoveredRun(run: UpdateRunRecord | undefined): void {
  expect(run).toMatchObject({
    status: "failed",
    reason: "abandoned",
    steps: expect.arrayContaining([
      expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
    ]),
  });
}

async function prepareIncompleteSourceRuntime() {
  await runExec("git", ["init", "--quiet", state.root], { timeoutMs: 15_000 });
  await fs.symlink(
    fileURLToPath(new URL("../../../scripts", import.meta.url)),
    state.path("scripts"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const files = {
    "tsconfig.json": JSON.stringify({
      extends: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
    }),
    "package.json": JSON.stringify({
      name: "openclaw",
      version: VERSION,
      type: "module",
      exports: { "./plugin-sdk/demo": "./dist/plugin-sdk/demo.js" },
    }),
    "dist/plugin-sdk/demo.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/index.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/package.json": JSON.stringify({
      name: "demo",
      type: "module",
      generation: "candidate",
    }),
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = state.path(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  stageBundledPluginRuntime({ repoRoot: state.root });
  const aliasRoot = state.path("dist/extensions/node_modules/openclaw");
  const runtimeEntry = state.path("dist-runtime/extensions/demo/index.js");
  const runtimeMetadata = state.path("dist-runtime/extensions/demo/package.json");
  await fs.unlink(runtimeEntry);
  await fs.writeFile(runtimeMetadata, '{"name":"demo","generation":"stale"}\n');
  return { aliasRoot, runtimeEntry, runtimeMetadata, aliasBefore: await fs.stat(aliasRoot) };
}

describe("update orchestration lifecycle ownership", () => {
  it.each([
    { shape: "legacy-mjs", version: "2026.4.27", source: undefined, failure: undefined },
    {
      shape: "legacy-mts",
      version: VERSION,
      source:
        "export function stageBundledPluginRuntime() { throw new Error('legacy stager ran'); }",
      failure: undefined,
    },
    {
      shape: "malformed-prepare",
      version: VERSION,
      source: "export const prepareBundledPluginRuntime = 1;",
      failure: /cannot complete its runtime artifacts/,
    },
    {
      shape: "missing-dependency",
      version: VERSION,
      source: "import './missing-dependency.mjs'; export function prepareBundledPluginRuntime() {}",
      failure: /missing-dependency/,
    },
    {
      shape: "missing-ownership",
      version: VERSION,
      source:
        "export function prepareBundledPluginRuntime() { throw new Error('stager ran without ownership'); }",
      failure: /dist-artifact-ownership/,
    },
  ])(
    "converges target-owned source completion contracts: $shape",
    async ({ version, source, failure }) => {
      await writeScenario("current-process");
      const { runtimeEntry } = await prepareIncompleteSourceRuntime();
      stageBundledPluginRuntime({ repoRoot: state.root });
      const original = await fs.stat(runtimeEntry);
      const packageJson = JSON.parse(await fs.readFile(state.path("package.json"), "utf8"));
      await fs.writeFile(state.path("package.json"), JSON.stringify({ ...packageJson, version }));
      await fs.unlink(state.path("scripts"));
      await fs.mkdir(state.path("scripts"));
      await fs.writeFile(
        state.path("scripts/stage-bundled-plugin-runtime.mjs"),
        "throw new Error('legacy CLI shim imported');",
      );
      if (source) {
        await fs.writeFile(state.path("scripts/stage-bundled-plugin-runtime.mts"), source);
      }
      mocks.plugins.mockResolvedValue({ ...pluginResult, changed: false });
      const current = version === VERSION;
      const result = convergeUpdatePlugins({
        coreAlreadyCurrent: current,
        result: {
          status: current ? "skipped" : "ok",
          mode: "git",
          root: state.root,
          before: { version: VERSION },
          after: { version },
          steps: [],
          durationMs: 1,
        },
        root: state.root,
        installKindChanged: false,
        configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: !current,
        opts: { json: true, yes: true },
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 15_000,
      });
      if (failure) {
        await expect(result).rejects.toThrow(failure);
        expect(mocks.plugins).not.toHaveBeenCalled();
      } else {
        expect((await result).resultWithPostUpdate.status).toBe(current ? "skipped" : "ok");
        expect(mocks.plugins).toHaveBeenCalledOnce();
      }
      expect(mocks.publication).not.toHaveBeenCalled();
      expect(await fs.stat(runtimeEntry)).toMatchObject({
        ino: original.ino,
        mtimeMs: original.mtimeMs,
      });
    },
  );

  it.each(["resume", "repair"] as const)(
    "%s completes missing source artifacts before consumers and leaves an exact online retry untouched",
    async (lane) => {
      await writeScenario(lane, { runtimeRoot: state.root });
      const { aliasRoot, runtimeEntry, runtimeMetadata, aliasBefore } =
        await prepareIncompleteSourceRuntime();
      mocks.plugins.mockImplementation(async () => {
        await runExec(process.execPath, [entrypoint, "runtime-proof"], { timeoutMs: 15_000 });
        return pluginResult;
      });

      await invoke(lane);
      expectSuccess(lane, lane === "repair");
      expect(mocks.publication).toHaveBeenCalledOnce();
      expect((await fs.stat(aliasRoot)).ino).toBe(aliasBefore.ino);
      expect(JSON.parse(await fs.readFile(runtimeMetadata, "utf8")).generation).toBe("candidate");
      const firstEvents = await events();
      expect(firstEvents).toContain("runtime-proof:runtime-proof");
      if (lane === "repair") {
        expect(firstEvents.indexOf("runtime-proof:doctor")).toBeLessThan(
          firstEvents.indexOf("pre-attempt"),
        );
      }

      const beforeRetry = await fs.stat(runtimeEntry);
      mocks.publication.mockImplementationOnce(async () => {
        throw new Error("A running Gateway cannot publish changed artifacts.");
      });
      await invoke(lane);
      expectSuccess(lane, lane === "repair");
      expect(mocks.publication).toHaveBeenCalledOnce();
      expect(await fs.stat(runtimeEntry)).toMatchObject({
        ino: beforeRetry.ino,
        mtimeMs: beforeRetry.mtimeMs,
      });
      expect((await fs.stat(aliasRoot)).ino).toBe(aliasBefore.ino);
    },
  );

  it("resume preserves publication failure details when staging cleanup also fails", async () => {
    await writeScenario("resume", { runtimeRoot: state.root });
    await prepareIncompleteSourceRuntime();
    const resultPath = state.path("post-core-result.json");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
    mocks.publication.mockRejectedValueOnce(new Error("publication authority revoked"));
    const remove = fsSync.rmSync.bind(fsSync);
    const cleanup = vi.spyOn(fsSync, "rmSync").mockImplementation((target, options) => {
      if (String(target).startsWith(state.root) && String(target).includes(".openclaw-runtime-")) {
        throw new Error("staging cleanup unavailable");
      }
      return remove(target, options);
    });
    try {
      await expect(invoke("resume")).rejects.toThrow(
        "Runtime completion and staging cleanup failed",
      );
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("publication authority revoked");
      expect(result.error).toContain("staging cleanup unavailable");
      expect(mocks.plugins).not.toHaveBeenCalled();
    } finally {
      cleanup.mockRestore();
    }
  });

  it.each(["fresh-process", "current-process", "repair"] as const)(
    "%s releases plugin ownership for fresh doctor without delegating Gateway activation",
    async (lane) => {
      const recovery = lane === "repair" ? seedInterruptedPostCoreRun() : undefined;
      let recoveredAtOutput: UpdateRunRecord | undefined;
      if (recovery) {
        vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
          recoveredAtOutput = getUpdateRun(recovery.runId);
        });
      }
      await writeScenario(lane, {
        hostVersion: lane === "current-process" ? "1.0.0" : undefined,
      });
      if (lane === "current-process") {
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", "1");
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR", "1");
      }
      mocks.plugins.mockImplementationOnce(async () => {
        const result = await runExec(process.execPath, [entrypoint, "probe"], {
          timeoutMs: 15_000,
        });
        expect(result.stdout).toBe("excluded");
        return pluginResult;
      });
      await invoke(lane, recovery ? [recovery.runId] : []);
      expectSuccess(lane);
      if (recovery) {
        expectRecoveredRun(recoveredAtOutput);
        expect(reportedResult(lane)).toMatchObject({ reconciledRuns: [recovery.runId] });
        expectRecoveredRun(getUpdateRun(recovery.runId));
        expect(listUpdateRuns({ active: true })).toEqual([]);
        expect(listUpdateRuns({ limit: 1 })[0]?.origin.driver?.pid).toBe(process.pid);
      }
      expect(process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe(
        lane === "current-process" ? "1" : undefined,
      );
      expect(await events()).toEqual([
        ...(lane === "repair" ? ["pre-attempt", "pre-acquired"] : []),
        ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
      if (lane === "current-process") {
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ shouldRestart: false }),
        );
      }
      if (lane === "fresh-process") {
        expect(mocks.plugins).not.toHaveBeenCalled();
      } else {
        expect(mocks.plugins).toHaveBeenCalledOnce();
      }
      const after = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
      expect(after.stdout).toBe("acquired");
    },
  );

  it.each(["current-process", "repair"] as const)(
    "%s reloads config and records after a competing writer commits",
    async (lane) => {
      await seedInstalledPluginIndex({ old: { source: "path" } });
      expect(await loadInstalledPluginIndexInstallRecords()).toHaveProperty("old");
      const writerRecords: Record<string, PluginInstallRecord> = {
        current: { source: "path", sourcePath: state.path("current") },
      };
      await writeScenario(lane, {
        writerConfig: {
          plugins: { enabled: false },
          update: { channel: "beta" },
          gateway: { port: 19002 },
        },
        writerRecords,
      });
      const acquired = createDeferred();
      const completed = createDeferred();
      const child = spawn(process.execPath, [entrypoint, "writer"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      if (!child.stderr) {
        throw new Error("writer stderr pipe was not created");
      }
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("message", () => acquired.resolve());
      child.once("error", (error) => {
        acquired.reject(error);
        completed.reject(error);
      });
      child.once("close", (code) => {
        if (code === 0) {
          completed.resolve();
        } else {
          const error = new Error(`writer exited ${code}: ${stderr}`);
          acquired.reject(error);
          completed.reject(error);
        }
      });
      void completed.promise.catch(() => {});
      const beforeDoctor = createDeferred();
      if (lane === "repair") {
        // Enter with the old config, then release the foreign writer before the
        // fixture's zero-retry Doctor acquisition. This still detects a parent
        // retaining its own lease without racing the deliberately competing one.
        mocks.entrypoint.mockImplementationOnce(async () => {
          beforeDoctor.resolve();
          await completed.promise;
          return entrypoint;
        });
      }
      try {
        await acquired.promise;
        const update = invoke(lane);
        void update.catch(() => {});
        if (lane === "repair") {
          await Promise.race([beforeDoctor.promise, update]);
        }
        child.send("commit");
        await completed.promise;
        await update;
        expectSuccess(lane);
        expect(mocks.plugins).toHaveBeenCalledWith(
          expect.objectContaining({
            configSnapshot: expect.objectContaining({
              config: expect.objectContaining({
                gateway: expect.objectContaining({ port: 19002 }),
              }),
            }),
            pluginInstallRecords: writerRecords,
          }),
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await completed.promise.catch(() => {});
      }
    },
  );

  it.each(["fresh-process", "current-process", "repair"] as const)(
    "%s does not run a final doctor when no plugins changed",
    async (lane) => {
      await writeScenario(lane, { pluginUpdate: { ...pluginResult, changed: false } });
      mocks.plugins.mockResolvedValueOnce({ ...pluginResult, changed: false });
      await invoke(lane);
      expectSuccess(lane, lane === "repair");
      expect(await events()).toEqual([
        ...(lane === "repair" ? ["pre-attempt", "pre-acquired"] : []),
        ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
        "validate",
        "readiness",
      ]);
    },
  );

  it.each(["fresh-process", "current-process", "repair"] as const)(
    "%s retains strict fresh validation after releasing the lease",
    async (lane) => {
      const recovery = lane === "repair" ? seedInterruptedPostCoreRun() : undefined;
      await writeScenario(lane, { invalidConfig: true });
      await invokeReportedFailure(lane, recovery ? [recovery.runId] : []);
      if (recovery) {
        expect(getUpdateRun(recovery.runId)).toEqual(recovery);
      }
      expect(reportedResult(lane)).toMatchObject({
        status: "error",
        postUpdate: { plugins: { reason: "post-plugin-doctor-invalid-config" } },
      });
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(await events()).toContain("post-acquired");
      expect((await events()).at(-1)).toBe("validate");
    },
  );

  it("repair persists a requested channel before its fresh doctor and retains timings", async () => {
    await writeScenario("repair", { preDoctorChannel: "beta" });
    await updateFinalizeCommand({
      channel: "beta",
      json: true,
      yes: true,
      restart: false,
      deferCompletionCache: true,
    });
    expectSuccess("repair");
    expect(await events()).toContain("pre-acquired");
    expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]).toMatchObject({
      channel: "beta",
      restart: false,
      phaseTimings: [
        "preflight",
        "targetConfigValidation",
        "configSnapshot",
        "doctor",
        "plugins",
        "targetConfigConvergence",
        "completionCache",
      ].map((phase) =>
        expect.objectContaining({
          phase,
          outcome: phase === "completionCache" ? "deferred" : "completed",
        }),
      ),
    });
  });

  it.each(["resume", "repair"] as const)(
    "%s propagates its migration Doctor failure before plugin mutation",
    async (lane) => {
      const recovery = lane === "repair" ? seedInterruptedPostCoreRun() : undefined;
      const phase = lane === "resume" ? "post" : "pre";
      await writeScenario(lane, { failDoctor: phase });
      if (lane === "resume") {
        await fs.rm(state.path("handoff.json"));
      }
      await expect(invoke(lane, recovery ? [recovery.runId] : [])).rejects.toThrow(
        "doctor fixture failure",
      );
      if (recovery) {
        expect(getUpdateRun(recovery.runId)).toEqual(recovery);
      }
      expect(mocks.plugins).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expectDoctorDiagnostics();
      expect(await events()).toEqual([`${phase}-attempt`, `${phase}-acquired`]);
    },
  );

  it("repair reconciles captured runs before publishing successful convergence with warnings", async () => {
    const recovery = seedInterruptedPostCoreRun();
    const warning: ProducedPluginUpdateResult = {
      ...pluginResult,
      status: "warning",
      changed: false,
    };
    await writeScenario("repair", { pluginUpdate: warning });
    mocks.plugins.mockResolvedValueOnce(warning);
    let recoveredAtOutput: UpdateRunRecord | undefined;
    vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
      recoveredAtOutput = getUpdateRun(recovery.runId);
    });

    await invoke("repair", [recovery.runId]);

    expect(reportedResult("repair")).toMatchObject({
      status: "warning",
      reconciledRuns: [recovery.runId],
    });
    expectRecoveredRun(recoveredAtOutput);
    expect(listUpdateRuns({ active: true })).toEqual([]);
  });

  it("repair withholds success when a captured updater advances during convergence", async () => {
    const recovery = seedInterruptedPostCoreRun();
    await writeScenario("repair", { pluginUpdate: { ...pluginResult, changed: false } });
    mocks.plugins.mockImplementationOnce(async () => {
      recordUpdateRunStep(recovery.runId, {
        step: "build",
        status: "in_progress",
        startedAtMs: Date.now(),
      });
      return { ...pluginResult, changed: false };
    });

    await expect(invoke("repair", [recovery.runId])).rejects.toThrow("An update resumed");

    expect(getUpdateRun(recovery.runId)).toMatchObject({ status: "running", reason: null });
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("resume reports a plugin exception after releasing its lease", async () => {
    await writeScenario("resume");
    const resultPath = state.path("failed-post-core.json");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
    mocks.plugins.mockRejectedValueOnce(new Error("plugin fixture failure"));
    await expect(invoke("resume")).rejects.toThrow("plugin fixture failure");
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("plugin fixture failure"),
    });
    expect(result.error).not.toContain(state.root);
    const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
    expect(probe.stdout).toBe("acquired");
  });

  it("rejects restart handling after a final doctor failure despite valid config", async () => {
    await writeScenario("current-process", { failDoctor: "post", hostVersion: "1.0.0" });
    await invokeReportedFailure("current-process");
    expect(mocks.print.mock.lastCall?.[0]).toMatchObject({
      status: "error",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      postUpdate: { plugins: { reason: "post-plugin-doctor-execution-failed" } },
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    expectDoctorDiagnostics();
    expect(await events()).toEqual(["post-attempt", "post-acquired", "validate", "readiness"]);
  });

  it.each([
    ["fresh-process" as const, "finding" as const, "post-plugin-update-readiness-failed"],
    [
      "fresh-process" as const,
      "execution" as const,
      "post-plugin-update-readiness-execution-failed",
    ],
    ["current-process" as const, "finding" as const, "post-plugin-update-readiness-failed"],
    [
      "current-process" as const,
      "execution" as const,
      "post-plugin-update-readiness-execution-failed",
    ],
    ["repair" as const, "finding" as const, "post-plugin-update-readiness-failed"],
    ["repair" as const, "execution" as const, "post-plugin-update-readiness-execution-failed"],
  ])("%s leaves the Gateway stopped after a readiness %s", async (lane, failure, reason) => {
    await writeScenario(lane, {
      readinessFailure: failure,
      hostVersion: lane === "current-process" ? "1.0.0" : undefined,
    });

    await invokeReportedFailure(lane);

    expect(reportedResult(lane)).toMatchObject({
      status: "error",
      postUpdate: { plugins: { reason } },
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(await events()).toEqual([
      ...(lane === "repair" ? ["pre-attempt", "pre-acquired"] : []),
      ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
      "post-attempt",
      "post-acquired",
      "validate",
      "readiness",
    ]);
  });

  it.each([
    ["resume", true],
    ["fresh-process", true],
    ["repair", true],
    ["resume", false],
    ["fresh-process", false],
    ["repair", false],
  ] as const)("%s stamps only strictly valid downgrade config (valid=%s)", async (lane, valid) => {
    const futureVersion = "2099.1.1";
    await state.writeConfig({
      meta: { lastTouchedVersion: futureVersion },
      plugins: { enabled: false },
      update: { channel: "stable" },
      gateway: { port: valid ? 19004 : -1 },
    });
    await writeScenario(lane, { failDoctor: "post", invalidConfig: !valid });

    if (lane === "resume") {
      await invoke(lane);
      expectSuccess(lane, false);
    } else {
      await invokeReportedFailure(lane);
      expect(reportedResult(lane)).toMatchObject({
        status: "error",
        postUpdate: {
          plugins: {
            reason: valid
              ? "post-plugin-doctor-execution-failed"
              : "post-plugin-doctor-invalid-config",
          },
        },
      });
    }
    const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    expect(persisted.meta?.lastTouchedVersion).toBe(valid ? VERSION : futureVersion);
    expect(persisted.update?.channel).toBe("stable");
    const startupBlock = resolveFutureConfigActionBlock({
      action: "start gateway service",
      config: persisted,
      env: {},
    });
    expect(startupBlock === null).toBe(valid);
    expect(await events(), JSON.stringify(vi.mocked(defaultRuntime.error).mock.calls)).toEqual(
      lane === "resume"
        ? []
        : [
            ...(lane === "repair" ? ["pre-attempt", "pre-acquired"] : []),
            ...(lane === "fresh-process" ? ["packages-acquired", "packages-released"] : []),
            "post-attempt",
            "post-acquired",
            "validate",
            ...(valid ? ["readiness"] : []),
          ],
    );
  });
});
