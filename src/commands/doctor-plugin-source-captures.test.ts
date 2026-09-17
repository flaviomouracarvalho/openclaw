import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runDoctor(args: string[]): Promise<number> {
  const program = new Command();
  registerMaintenanceCommands(program);
  const originalArgv = process.argv;
  process.argv = [process.execPath, "openclaw", "doctor", ...args];
  try {
    await program.parseAsync(["doctor", ...args], { from: "user" });
  } catch (error) {
    if (error instanceof ExitError) {
      return error.code;
    }
    throw error;
  } finally {
    process.argv = originalArgv;
  }
  throw new Error("Doctor did not report an exit code");
}

function fixture() {
  const root = tempDirs.make("openclaw-doctor-capture-test-");
  const temporaryDirectory = path.join(root, "tmp");
  fs.mkdirSync(temporaryDirectory);
  const old = path.join(temporaryDirectory, "openclaw-plugin-build-legacy");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "capture.js"), "export const captured = true;\n");
  const timestamp = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  fs.utimesSync(old, timestamp, timestamp);
  for (const variable of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(variable, temporaryDirectory);
  }
  const stateDirectory = path.join(root, "state");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDirectory);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "state", "openclaw.json"));
  return {
    stateDirectory,
    temporaryDirectory,
    old,
    runtimeDirectory: path.join(root, "coordinators"),
  };
}

describe("registered Doctor legacy plugin capture cleanup", () => {
  beforeEach(() => {
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "runs the explicit cleanup through the registered command (JSON: %s)",
    async (json) => {
      const f = fixture();
      const recent = path.join(f.temporaryDirectory, "openclaw-plugin-build-recent");
      fs.mkdirSync(recent);

      const code = await withStateDatabaseCoordinatorRuntimeDirectory(f.runtimeDirectory, () =>
        runDoctor(["--cleanup-legacy-plugin-captures", ...(json ? ["--json"] : [])]),
      );

      expect(code).toBe(0);
      expect(fs.existsSync(f.old)).toBe(false);
      expect(fs.existsSync(recent)).toBe(true);
      expect(fs.existsSync(f.stateDirectory)).toBe(false);
      if (json) {
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          { directory: f.temporaryDirectory, removed: [f.old], preserved: [recent], failures: [] },
          2,
        );
        expect(defaultRuntime.log).not.toHaveBeenCalled();
      } else {
        expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("removed=1"));
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["--fix"],
    ["--yes"],
    ["--non-interactive"],
    ["--lint"],
    ["--post-upgrade"],
    ["--state-sqlite", "compact"],
    ["--session-sqlite", "inspect"],
  ])("rejects another Doctor operation before cleanup: %j", async (...other) => {
    const f = fixture();

    expect(await runDoctor(["--cleanup-legacy-plugin-captures", "--json", ...other])).toBe(2);

    expect(fs.existsSync(f.old)).toBe(true);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: {
        type: "cli_error",
        message: expect.stringContaining("can only be combined with --json"),
      },
    });
  });

  it("preserves legacy captures while a peer owns Gateway lifecycle and cleans after its exit", async () => {
    const f = fixture();
    const peer = spawn(
      process.execPath,
      [
        "--import",
        new URL("../../scripts/tsx.mjs", import.meta.url).href,
        "--input-type=module",
        "--eval",
        `
          const { acquireGatewayLifecycleCoordinator } = await import(process.argv[1]);
          const owner = acquireGatewayLifecycleCoordinator(JSON.parse(process.argv[2]));
          process.send("ready");
          process.once("message", () => { owner.release(); process.disconnect(); });
        `,
        new URL("../infra/state-database-coordinator.ts", import.meta.url).href,
        JSON.stringify({
          databasePath: resolveOpenClawStateSqlitePath(),
          runtimeDirectory: f.runtimeDirectory,
        }),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    try {
      const [message] = await once(peer, "message", { signal: AbortSignal.timeout(5_000) });
      expect(message).toBe("ready");
      const code = await withStateDatabaseCoordinatorRuntimeDirectory(f.runtimeDirectory, () =>
        runDoctor(["--cleanup-legacy-plugin-captures", "--json"]),
      );
      expect(code).toBe(2);
      expect(fs.readFileSync(path.join(f.old, "capture.js"), "utf8")).toContain("captured");
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
        ok: false,
        error: { type: "cli_error", message: expect.stringContaining("owns this state directory") },
      });
      const exited = once(peer, "exit");
      peer.send("release");
      await exited;

      expect(
        await withStateDatabaseCoordinatorRuntimeDirectory(f.runtimeDirectory, () =>
          runDoctor(["--cleanup-legacy-plugin-captures", "--json"]),
        ),
      ).toBe(0);
      expect(fs.existsSync(f.old)).toBe(false);
    } finally {
      await stopChildProcess(peer, 5_000);
    }
  });
});
