import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishDiagnostics,
  readChannelPostCoreProcessObservations,
} from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const observer = resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");
const scenario = "channel-post-core-restore";
const privateValue = "PRIVATE_CONFIG_VALUE";

function fixture() {
  const root = realpathSync(dirs.make("survivor-channel-process-"));
  const artifacts = join(root, "artifacts");
  const state = join(root, "state");
  mkdirSync(artifacts);
  mkdirSync(state);
  return {
    root,
    state,
    artifacts,
    configPath: join(state, "openclaw.json"),
    env: {
      PATH: process.env.PATH,
      HOME: root,
      NODE_OPTIONS: "--no-warnings",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: "2026.4.15",
    },
  };
}

function processPair() {
  const started = {
    event: "started",
    role: "doctor",
    pid: 42,
    parentPid: 41,
    packageVersion: "2026.9.5",
    repairRequested: true,
    nodeHost: {
      source: { sha256: "c".repeat(64), size: 75, mtimeMs: 1700000000000 },
      claim: null,
      canonicalRows: [],
    },
    config: {
      sha256: "a".repeat(64),
      updateChannel: "beta",
      hasLastTouchedAt: true,
      hasLegacyRoster: false,
      hasLegacyPluginInstalls: false,
    },
  };
  return {
    started,
    exited: {
      ...started,
      event: "exited",
      exitCode: 0,
      config: { ...started.config, sha256: "b".repeat(64), hasLastTouchedAt: false },
      nodeHost: {
        source: null,
        claim: null,
        canonicalRows: [
          { stateKey: "nodeHost.config", valueSha256: "d".repeat(64), updatedAtMs: 1700000000000 },
        ],
      },
    },
  };
}

describe("channel post-core process diagnostics", () => {
  it.each([
    { selectedScenario: scenario, baselineVersion: "2026.4.15", observed: true },
    {
      selectedScenario: "channel-post-core-readiness",
      baselineVersion: "2026.4.15",
      observed: true,
    },
    {
      selectedScenario: "channel-post-core-readiness",
      baselineVersion: "2026.4.29",
      observed: false,
    },
    { selectedScenario: "base", baselineVersion: "2026.4.15", observed: false },
    { selectedScenario: scenario, baselineVersion: "2026.4.29", observed: false },
  ])(
    "observes only the focused baseline while preserving $selectedScenario $baselineVersion process behavior",
    ({ selectedScenario, baselineVersion, observed }) => {
      const f = fixture();
      const original = `${JSON.stringify({
        update: { channel: "stable" },
        meta: { lastTouchedAt: privateValue },
        agents: { list: [] },
        plugins: { installs: {} },
        privateValue,
      })}\n`;
      writeFileSync(f.configPath, original);
      const nodeSource = join(f.state, "node.json");
      const nodeBytes = JSON.stringify({
        version: 1,
        nodeId: "synthetic-node",
        displayName: privateValue,
      });
      writeFileSync(nodeSource, nodeBytes);
      const nodeMtimeMs = Math.floor(statSync(nodeSource).mtimeMs);
      const pendingNode = {
        source: {
          sha256: createHash("sha256").update(nodeBytes).digest("hex"),
          size: Buffer.byteLength(nodeBytes),
          mtimeMs: nodeMtimeMs,
        },
        claim: null,
        canonicalRows: [],
      };
      const importedNode = {
        source: null,
        claim: null,
        canonicalRows: [
          {
            stateKey: "nodeHost.config",
            valueSha256: createHash("sha256")
              .update(JSON.stringify({ ...JSON.parse(nodeBytes), installedAppsSharing: false }))
              .digest("hex"),
            updatedAtMs: nodeMtimeMs,
          },
        ],
      };
      writeFileSync(
        join(f.root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.4.15" }),
      );
      const entry = join(f.root, "openclaw.mjs");
      writeFileSync(
        entry,
        `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
function run(command, args = [], postCore = false) {
  return spawnSync(process.execPath, ['--import', ${JSON.stringify(observer)}, process.argv[1], command, ...args], {
    env: {...process.env, ...(postCore ? {OPENCLAW_UPDATE_POST_CORE:'1'} : {})}, stdio:'inherit'
  }).status;
}
if (process.argv[2] === 'update') {
  fs.writeFileSync(new URL('./package.json', import.meta.url), JSON.stringify({name:'openclaw',version:'2026.9.5'}));
  if (process.env.OPENCLAW_UPDATE_POST_CORE === '1') {
    process.exitCode = run('doctor', ['--non-interactive', '--fix']);
  } else {
    const initial = run('doctor', ['--non-interactive']);
    process.exitCode = initial === 0 ? run('update', [], true) : initial;
  }
} else if (process.argv.includes('--fix')) {
  const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
  config.update.channel = 'beta';
  delete config.meta.lastTouchedAt;
  delete config.agents.list;
  delete config.plugins.installs;
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const source = path.join(process.env.OPENCLAW_STATE_DIR, 'node.json');
  const value = JSON.parse(fs.readFileSync(source, 'utf8'));
  const mtime = Math.floor(fs.statSync(source).mtimeMs);
  const databaseDir = path.join(process.env.OPENCLAW_STATE_DIR, 'state');
  fs.mkdirSync(databaseDir);
  const db = new DatabaseSync(path.join(databaseDir, 'openclaw.sqlite'));
  db.exec('CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)');
  db.prepare('INSERT INTO config_machine_state VALUES (?, ?, ?)').run('nodeHost.config', JSON.stringify({...value, installedAppsSharing:false}), mtime);
  db.close();
  fs.unlinkSync(source);
  process.stdout.write('doctor fixture finished\\n');
  process.exitCode = 7;
}
`,
      );
      const child = spawnSync(process.execPath, ["--import", observer, entry, "update"], {
        env: {
          ...f.env,
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: selectedScenario,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: baselineVersion,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.status, child.stderr).toBe(7);
      expect(child.stdout).toBe("doctor fixture finished\n");
      expect(child.stderr).toBe("");
      if (!observed) {
        const started = JSON.parse(
          readFileSync(
            join(f.artifacts, "diagnostics", `process-${child.pid}-started.json`),
            "utf8",
          ),
        );
        expect(started).not.toHaveProperty("config");
        expect(() => readChannelPostCoreProcessObservations(f.artifacts)).toThrow();
        return;
      }
      const observations = readChannelPostCoreProcessObservations(f.artifacts);
      expect(observations).toHaveLength(4);
      const parent = observations.find((pair) => pair.started.role === "update")!;
      const postCore = observations.find((pair) => pair.started.role === "post-core")!;
      const doctor = observations.find(
        (pair) => pair.started.role === "doctor" && pair.started.repairRequested,
      )!;
      const initialDoctor = observations.find(
        (pair) => pair.started.role === "doctor" && !pair.started.repairRequested,
      )!;
      expect(parent.started.packageVersion).toBe("2026.4.15");
      expect(postCore.started).toMatchObject({
        packageVersion: "2026.9.5",
        parentPid: parent.started.pid,
      });
      expect(doctor.started.parentPid).toBe(postCore.started.pid);
      expect(initialDoctor.started.parentPid).toBe(parent.started.pid);
      expect(initialDoctor.started.repairRequested).toBe(false);
      expect(doctor.started.repairRequested).toBe(true);
      for (const pair of observations) {
        expect(pair.started.config).toEqual({
          sha256: createHash("sha256").update(original).digest("hex"),
          updateChannel: "stable",
          hasLastTouchedAt: true,
          hasLegacyRoster: true,
          hasLegacyPluginInstalls: true,
        });
        expect(pair.started.nodeHost).toEqual(pendingNode);
        expect(pair.exited.nodeHost).toEqual(pair === initialDoctor ? pendingNode : importedNode);
        expect(pair.exited.exitCode).toBe(pair === initialDoctor ? 0 : 7);
        if (pair === initialDoctor) {
          expect(pair.exited.config).toEqual(pair.started.config);
          continue;
        }
        expect(pair.exited.config).toEqual({
          sha256: createHash("sha256").update(readFileSync(f.configPath)).digest("hex"),
          updateChannel: "beta",
          hasLastTouchedAt: false,
          hasLegacyRoster: false,
          hasLegacyPluginInstalls: false,
        });
        expect(pair.exited).not.toHaveProperty("doctorResult");
      }
      expect(JSON.stringify(observations)).not.toContain(privateValue);
      expect(JSON.stringify(observations)).not.toContain(f.root);
    },
  );

  it.each([
    "missing",
    "malformed",
    "wrong-pid",
    "wrong-parent",
    "missing-config",
    "invalid-config",
    "invalid-node-digest",
    "invalid-node-row",
    "invalid-node-timestamp",
    ...(process.platform === "win32" ? [] : ["symlink"]),
  ])("refuses %s process evidence without yielding a partial witness", (kind) => {
    const f = fixture();
    const pair = processPair();
    const directory = join(f.artifacts, "diagnostics");
    mkdirSync(directory);
    writeFileSync(join(directory, "process-42-started.json"), JSON.stringify(pair.started));
    const exitPath = join(directory, "process-42-exited.json");
    if (kind === "missing") {
      expect(() => readChannelPostCoreProcessObservations(f.artifacts)).toThrow();
      return;
    }
    const exited = {
      ...pair.exited,
      pid: kind === "wrong-pid" ? 43 : 42,
      parentPid: kind === "wrong-parent" ? 43 : 41,
      config:
        kind === "missing-config"
          ? null
          : {
              ...pair.exited.config,
              updateChannel: kind === "invalid-config" ? privateValue : "beta",
            },
      nodeHost: {
        ...pair.exited.nodeHost,
        canonicalRows: [
          {
            ...pair.exited.nodeHost.canonicalRows[0],
            valueSha256: kind === "invalid-node-digest" ? privateValue : "d".repeat(64),
            stateKey: kind === "invalid-node-row" ? privateValue : "nodeHost.config",
            updatedAtMs: kind === "invalid-node-timestamp" ? -1 : 1700000000000,
          },
        ],
      },
    };
    writeFileSync(exitPath, kind === "malformed" ? "{" : JSON.stringify(exited));
    if (kind === "symlink") {
      const external = join(f.root, "external.json");
      writeFileSync(external, readFileSync(exitPath));
      rmSync(exitPath);
      symlinkSync(external, exitPath);
    }
    expect(() => readChannelPostCoreProcessObservations(f.artifacts)).toThrow();
  });

  it.each(["passed", "failed"])(
    "publishes bounded %s process facts without promoting invalid evidence",
    (outcome) => {
      const f = fixture();
      const pair = processPair();
      const observations = [
        {
          started: {
            ...pair.started,
            privateValue,
            nodeHost: {
              ...pair.started.nodeHost,
              privateValue,
              source: { ...pair.started.nodeHost.source, privateValue },
            },
          },
          exited: {
            ...pair.exited,
            config: { ...pair.exited.config, privateValue },
            doctorResult: { privateValue },
            nodeHost: {
              ...pair.exited.nodeHost,
              canonicalRows: pair.exited.nodeHost.canonicalRows.map((row) => ({
                ...row,
                value_json: privateValue,
              })),
            },
          },
        },
      ];
      const snapshot = {
        status: "passed",
        phase: "update-candidate",
        exitStatus: 1,
        signal: null,
        baseline: { spec: "openclaw@2026.4.15", version: "2026.4.15" },
        candidate: { kind: "tarball", version: "2026.9.5" },
        scenario,
        installedVersion: "2026.9.5",
        candidateInstallMode: "updater",
        updateRestartMode: "manual",
        updateOutcome: "success",
        phases: [],
        channelPostCoreProcesses: { availability: "captured", observations },
      };
      mkdirSync(join(f.artifacts, "diagnostics"));
      const source = join(
        f.artifacts,
        outcome === "passed" ? "summary.json" : "diagnostics/raw.json",
      );
      writeFileSync(source, JSON.stringify(snapshot));
      const published = join(f.root, "public");
      publishDiagnostics(f.artifacts, published, (text: string) => text, outcome);
      const filename = outcome === "passed" ? "summary.json" : "failure.json";
      const publishedText = readFileSync(join(published, filename), "utf8");
      expect(publishedText).not.toContain(privateValue);
      expect(JSON.parse(publishedText).channelPostCoreProcesses).toEqual({
        availability: "captured",
        observations: [pair],
      });
      observations[0]!.exited.parentPid++;
      writeFileSync(source, JSON.stringify(snapshot));
      const invalid = join(f.root, "invalid");
      if (outcome === "passed") {
        expect(() =>
          publishDiagnostics(f.artifacts, invalid, (text: string) => text, outcome),
        ).toThrow("Missing or invalid channel post-core process evidence");
        expect(existsSync(join(invalid, filename))).toBe(false);
        return;
      }
      publishDiagnostics(f.artifacts, invalid, (text: string) => text, outcome);
      expect(existsSync(join(invalid, filename))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(invalid, filename), "utf8")).channelPostCoreProcesses,
      ).toEqual({ availability: "unknown", observations: [] });
    },
  );
});
