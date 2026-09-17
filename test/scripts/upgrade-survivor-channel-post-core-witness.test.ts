import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectChannelPostCoreNodeHost,
  seedChannelPostCoreNodeHost,
} from "../../scripts/e2e/lib/upgrade-survivor/channel-post-core-state.mjs";
import {
  assertChannelPostCoreWriterWitness,
  assertChannelPostCoreReadinessWitness,
  assertChannelPostCoreConfigValidation,
  captureChannelPostCoreConfig,
  prepareChannelPostCoreConfigValidation,
} from "../../scripts/e2e/lib/upgrade-survivor/channel-post-core-witness.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe.each(["changed-channel", "same-channel"])("%s handoff", (contract) => {
  const changedChannel = contract === "changed-channel";
  const candidateVersion = changedChannel ? "2026.9.5" : "2026.9.4";
  it.each([
    "complete",
    "respawn-chain",
    "missing-wrapper",
    "ambiguous-lineage",
    "first-doctor-write",
    ...(changedChannel ? ["no-old-write"] : ["unexpected-old-write"]),
    "wrong-parent",
    "failed-doctor",
    "failed-parent",
    "first-doctor-node-import",
    "receiver-without-fix",
    "missing-node-evidence",
    "malformed-node-evidence",
    "receiver-node-pending",
    "node-row-mismatch",
    "node-canonical-content",
    "node-timestamp",
    "node-original-bytes",
    "node-source-retained",
    "node-claim-retained",
  ])("binds the published handoff to observed processes (%s)", (scenario) => {
    const root = fs.realpathSync(dirs.make("channel-post-core-witness-"));
    const state = path.join(root, "operator");
    fs.mkdirSync(path.join(state, "state"), { recursive: true });
    const configPath = path.join(root, "config.json");
    const observations = path.join(root, "observations");
    const diagnostics = path.join(observations, "diagnostics");
    fs.mkdirSync(diagnostics, { recursive: true });
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT", root);
    vi.stubEnv(
      "OPENCLAW_UPGRADE_SURVIVOR_SCENARIO",
      changedChannel ? "channel-post-core-restore" : "channel-post-core-readiness",
    );
    vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    seedChannelPostCoreNodeHost();
    const nodeBefore = JSON.parse(
      fs.readFileSync(path.join(root, "channel-post-core-node-before-update.json"), "utf8"),
    );
    const originalNodePath = path.join(root, "channel-post-core-node-original.json");
    const originalNodeBytes = fs.readFileSync(originalNodePath);
    const canonicalNode = {
      state_key: "nodeHost.config",
      value_json: JSON.stringify({
        ...JSON.parse(originalNodeBytes.toString("utf8")),
        installedAppsSharing: false,
      }),
      updated_at_ms: nodeBefore.source.mtimeMs,
    };
    const pendingNode = projectChannelPostCoreNodeHost(nodeBefore);
    const importedNode = projectChannelPostCoreNodeHost({
      source: null,
      claim: null,
      canonicalRows: [canonicalNode],
    });
    const db = new DatabaseSync(path.join(state, "state", "openclaw.sqlite"));
    try {
      db.exec(
        "CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)",
      );
      db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        canonicalNode.state_key,
        scenario === "node-canonical-content" ? "{}" : canonicalNode.value_json,
        canonicalNode.updated_at_ms + (scenario === "node-timestamp" ? 1 : 0),
      );
    } finally {
      db.close();
    }
    if (scenario !== "node-source-retained") {
      fs.unlinkSync(path.join(state, "node.json"));
    }
    if (scenario === "node-claim-retained") {
      fs.writeFileSync(path.join(state, "node.json.doctor-importing"), originalNodeBytes);
    }
    if (scenario === "node-original-bytes") {
      fs.chmodSync(originalNodePath, 0o600);
      fs.writeFileSync(originalNodePath, "{}\n");
      fs.chmodSync(originalNodePath, 0o400);
    }
    const before = JSON.stringify({ update: { channel: "stable" } });
    const writer = JSON.stringify({
      update: { channel: "beta" },
      meta: { lastTouchedAt: "2026-04-15T00:00:00.000Z" },
    });
    const handoff = changedChannel ? writer : before;
    const final = JSON.stringify(
      changedChannel
        ? { update: { channel: "beta" } }
        : { update: { channel: "stable" }, plugins: { enabled: true } },
    );
    fs.writeFileSync(configPath, before);
    captureChannelPostCoreConfig();
    expect(fs.readFileSync(path.join(root, "channel-post-core-original-config.json"), "utf8")).toBe(
      before,
    );
    fs.writeFileSync(configPath, final);
    const facts = (raw: string) => ({
      sha256: createHash("sha256").update(raw).digest("hex"),
      updateChannel: JSON.parse(raw).update.channel,
      hasLastTouchedAt: Object.hasOwn(JSON.parse(raw).meta ?? {}, "lastTouchedAt"),
      hasLegacyRoster: false,
      hasLegacyPluginInstalls: false,
    });
    const record = (
      pid: number,
      parentPid: number,
      role: string,
      packageVersion: string,
      start: string,
      end: string,
      exitCode = 0,
    ) => {
      for (const event of ["started", "exited"] as const) {
        const initialDoctor = role === "doctor" && [102, 105].includes(pid);
        const nodeHost = event === "started" || initialDoctor ? pendingNode : importedNode;
        fs.writeFileSync(
          path.join(diagnostics, `process-${pid}-${event}.json`),
          JSON.stringify({
            pid,
            parentPid,
            role,
            packageVersion,
            event,
            config: facts(event === "started" ? start : end),
            repairRequested:
              role === "doctor" && !initialDoctor && scenario !== "receiver-without-fix",
            nodeHost,
            ...(event === "exited" ? { exitCode } : {}),
          }),
        );
      }
    };
    const respawned = ["respawn-chain", "missing-wrapper", "ambiguous-lineage"].includes(scenario);
    if (respawned) {
      record(100, 1, "update", "2026.4.15", before, final);
    }
    record(
      101,
      respawned ? 100 : 1,
      "update",
      "2026.4.15",
      before,
      final,
      scenario === "failed-parent" ? 1 : 0,
    );
    record(
      102,
      101,
      "doctor",
      candidateVersion,
      before,
      scenario === "first-doctor-write" ? final : before,
    );
    record(
      103,
      101,
      "post-core",
      candidateVersion,
      scenario === "no-old-write" ? before : scenario === "unexpected-old-write" ? writer : handoff,
      final,
    );
    record(
      104,
      scenario === "wrong-parent" ? 101 : 103,
      "doctor",
      candidateVersion,
      handoff,
      final,
      scenario === "failed-doctor" ? 1 : 0,
    );
    if (scenario === "respawn-chain") {
      // The published/candidate entrypoints may wrap each actual command once.
      record(102, 101, "doctor", candidateVersion, before, before);
      record(105, 102, "doctor", candidateVersion, before, before);
      record(106, 103, "post-core", candidateVersion, handoff, final);
      record(104, 106, "doctor", candidateVersion, handoff, final);
      record(107, 104, "doctor", candidateVersion, handoff, final);
    }
    if (scenario === "missing-wrapper") {
      for (const event of ["started", "exited"]) {
        fs.unlinkSync(path.join(diagnostics, `process-101-${event}.json`));
      }
    }
    if (scenario === "ambiguous-lineage") {
      record(108, 100, "update", "2026.4.15", before, final);
    }
    const changeEvent = (
      pid: number,
      event: string,
      change: (value: Record<string, unknown>) => void,
    ) => {
      const file = path.join(diagnostics, `process-${pid}-${event}.json`);
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      change(value);
      fs.writeFileSync(file, JSON.stringify(value));
    };
    if (scenario === "first-doctor-node-import") {
      changeEvent(102, "exited", (value) => {
        value.nodeHost = importedNode;
      });
    } else if (scenario === "missing-node-evidence") {
      changeEvent(104, "started", (value) => {
        delete value.nodeHost;
      });
    } else if (scenario === "malformed-node-evidence") {
      changeEvent(104, "started", (value) => {
        value.nodeHost = { ...pendingNode, source: { sha256: "invalid" } };
      });
    } else if (scenario === "receiver-node-pending") {
      changeEvent(104, "exited", (value) => {
        value.nodeHost = pendingNode;
      });
    } else if (scenario === "node-row-mismatch") {
      changeEvent(104, "exited", (value) => {
        value.nodeHost = {
          ...importedNode,
          canonicalRows: [{ ...importedNode.canonicalRows[0], valueSha256: "a".repeat(64) }],
        };
      });
    }
    const verify = changedChannel
      ? assertChannelPostCoreWriterWitness
      : assertChannelPostCoreReadinessWitness;
    const run = () =>
      verify({
        candidateVersion,
        observationRoot: observations,
        updateOutcome: "success",
        updateRepairRequired: "0",
      });
    if (scenario === "complete" || scenario === "respawn-chain") {
      expect(run).not.toThrow();
    } else {
      expect(run).toThrow();
    }
    if (scenario === "malformed-node-evidence") {
      expect(fs.existsSync(path.join(root, "channel-post-core-parent.json"))).toBe(false);
      return;
    }
    const captured = JSON.parse(
      fs.readFileSync(path.join(root, "channel-post-core-parent.json"), "utf8"),
    );
    expect(captured.observations).toHaveLength(
      scenario === "respawn-chain" ? 8 : scenario === "ambiguous-lineage" ? 6 : 4,
    );
    expect(captured.initial.sha256).toBe(facts(before).sha256);
    expect(captured.contract).toBe(contract);
    expect(captured.final.sha256).toBe(facts(final).sha256);
    if (scenario === "complete" || scenario === "respawn-chain") {
      expect(captured.nodeHost.before.source.sha256).toBe(
        createHash("sha256").update(originalNodeBytes).digest("hex"),
      );
      expect(captured.nodeHost.after.canonicalRows).toEqual([canonicalNode]);
      expect(captured.nodeHost.after.source).toBeNull();
      expect(captured.nodeHost.after.claim).toBeNull();
      expect(fs.readFileSync(originalNodePath)).toEqual(originalNodeBytes);
    }
  });
});

it.each(["valid", "wrong-path", "invalid", "copy-write", "original-write", "active-write"])(
  "binds after-handoff candidate validation to an immutable original copy (%s)",
  (scenario) => {
    const root = fs.realpathSync(dirs.make("channel-post-core-validation-"));
    const activePath = path.join(root, "active.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", activePath);
    vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT", root);
    const originalBytes = '{\n  "update": {"channel": "stable"}\n}\n\n';
    const activeBytes = '{"update":{"channel":"beta"}}\n';
    fs.writeFileSync(activePath, originalBytes);
    captureChannelPostCoreConfig();
    fs.writeFileSync(activePath, activeBytes);
    fs.writeFileSync(
      path.join(root, "channel-post-core-parent.json"),
      JSON.stringify({
        candidateVersion: "2026.9.5",
        final: { sha256: createHash("sha256").update(activeBytes).digest("hex") },
      }),
    );
    const copyPath = prepareChannelPostCoreConfigValidation();
    const originalPath = path.join(root, "channel-post-core-original-config.json");
    expect(copyPath).not.toBe(originalPath);
    expect(copyPath).not.toBe(activePath);
    expect(fs.readFileSync(copyPath, "utf8")).toBe(originalBytes);
    expect(fs.statSync(copyPath).mode & 0o222).toBe(0);
    fs.writeFileSync(
      path.join(root, "channel-post-core-config-validation.json"),
      JSON.stringify({
        valid: scenario !== "invalid",
        path: scenario === "wrong-path" ? activePath : copyPath,
      }),
    );
    const changedPath =
      scenario === "copy-write"
        ? copyPath
        : scenario === "original-write"
          ? originalPath
          : scenario === "active-write"
            ? activePath
            : undefined;
    if (changedPath) {
      fs.chmodSync(changedPath, 0o600);
      fs.writeFileSync(changedPath, '{"changed":true}\n');
      fs.chmodSync(changedPath, 0o400);
    }
    const verify = () => assertChannelPostCoreConfigValidation(scenario === "invalid" ? 1 : 0);
    if (scenario === "valid") {
      expect(verify).not.toThrow();
      expect(fs.readFileSync(activePath, "utf8")).toBe(activeBytes);
      expect(fs.readFileSync(originalPath, "utf8")).toBe(originalBytes);
    } else {
      expect(verify).toThrow();
    }
    const observed = JSON.parse(
      fs.readFileSync(path.join(root, "channel-post-core-config-validation-after.json"), "utf8"),
    );
    expect(observed.context).toBe(
      "Installed candidate validates original config after published-parent witness",
    );
    expect(observed.candidateVersion).toBe("2026.9.5");
    expect(observed.response.path).toBe(scenario === "wrong-path" ? activePath : copyPath);
    expect(observed.durationMs).toBeGreaterThanOrEqual(0);
  },
);
