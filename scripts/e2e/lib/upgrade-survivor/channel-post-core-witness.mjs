import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertChannelPostCoreNodeHostImported,
  captureChannelPostCoreNodeHost,
  projectChannelPostCoreNodeHost,
} from "./channel-post-core-state.mjs";
import { readChannelPostCoreProcessObservations } from "./diagnostics.mjs";

function artifact(name) {
  assert(process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT, "Missing survivor artifact root");
  return path.join(process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT, name);
}

function configFacts(raw) {
  assert(process.env.OPENCLAW_CONFIG_PATH, "Missing survivor config path");
  const bytes = raw ?? fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH);
  const config = JSON.parse(bytes.toString("utf8"));
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    updateChannel: config.update?.channel ?? null,
    hasLastTouchedAt: Object.hasOwn(config.meta ?? {}, "lastTouchedAt"),
    hasLegacyRoster: Object.hasOwn(config.agents ?? {}, "list"),
    hasLegacyPluginInstalls: Object.hasOwn(config.plugins ?? {}, "installs"),
  };
}

function assertCurrentConfig(facts) {
  assert.equal(facts.hasLastTouchedAt, false, "Retired metadata remains in config");
  assert.equal(facts.hasLegacyRoster, false, "Retired agent roster remains in config");
  assert.equal(facts.hasLegacyPluginInstalls, false, "Retired plugin records remain in config");
}

function writeObservation(name, value) {
  fs.writeFileSync(artifact(name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

export function captureChannelPostCoreConfig() {
  assert(process.env.OPENCLAW_CONFIG_PATH, "Missing survivor config path");
  const raw = fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH);
  const facts = configFacts(raw);
  fs.writeFileSync(artifact("channel-post-core-original-config.json"), raw, {
    mode: 0o400,
    flag: "wx",
  });
  writeObservation("channel-post-core-before-update.json", facts);
  assertCurrentConfig(facts);
  assert.equal(facts.updateChannel, "stable");
}

function validationFileFacts(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return {
      path: filePath,
      regularFile: stat.isFile(),
      writable: (stat.mode & 0o222) !== 0,
      sha256: stat.isFile()
        ? createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
        : null,
    };
  } catch (error) {
    return { path: filePath, error: String(error) };
  }
}

export function prepareChannelPostCoreConfigValidation() {
  const originalPath = artifact("channel-post-core-original-config.json");
  const initial = JSON.parse(
    fs.readFileSync(artifact("channel-post-core-before-update.json"), "utf8"),
  );
  const parent = JSON.parse(fs.readFileSync(artifact("channel-post-core-parent.json"), "utf8"));
  const original = validationFileFacts(originalPath);
  assert.equal(
    original.sha256,
    initial.sha256,
    "Original scenario config changed before candidate validation",
  );
  assert.equal(original.writable, false);
  const copyPath = artifact("channel-post-core-validation-input.json");
  fs.writeFileSync(copyPath, fs.readFileSync(originalPath), { mode: 0o400, flag: "wx" });
  assert(process.env.OPENCLAW_CONFIG_PATH, "Missing active scenario config path");
  const prepared = {
    context: "Installed candidate validates original config after published-parent witness",
    candidateVersion: parent.candidateVersion,
    startedAtMs: Date.now(),
    original,
    copy: validationFileFacts(copyPath),
    active: validationFileFacts(process.env.OPENCLAW_CONFIG_PATH),
  };
  writeObservation("channel-post-core-config-validation-before.json", prepared);
  assert.equal(
    prepared.copy.sha256,
    original.sha256,
    "Validation copy differs from original fixture",
  );
  assert.equal(prepared.copy.writable, false);
  assert.equal(
    prepared.active.sha256,
    parent.final.sha256,
    "Active config changed after the parent witness",
  );
  return copyPath;
}

export function assertChannelPostCoreConfigValidation(exitCode) {
  const before = JSON.parse(
    fs.readFileSync(artifact("channel-post-core-config-validation-before.json"), "utf8"),
  );
  let response = null;
  try {
    response = JSON.parse(
      fs.readFileSync(artifact("channel-post-core-config-validation.json"), "utf8"),
    );
  } catch {
    // Preserve the raw CLI output separately; it cannot establish validation.
  }
  const finishedAtMs = Date.now();
  const after = {
    context: before.context,
    candidateVersion: before.candidateVersion,
    startedAtMs: before.startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - before.startedAtMs,
    exitCode,
    response,
    original: validationFileFacts(before.original.path),
    copy: validationFileFacts(before.copy.path),
    active: validationFileFacts(before.active.path),
  };
  writeObservation("channel-post-core-config-validation-after.json", after);
  for (const name of ["original", "copy", "active"]) {
    assert.equal(after[name].regularFile, true, `${name} config is no longer a regular file`);
    assert.equal(
      after[name].sha256,
      before[name].sha256,
      `${name} config changed during candidate validation`,
    );
  }
  assert.equal(after.copy.sha256, after.original.sha256);
  assert.equal(after.original.writable, false);
  assert.equal(after.copy.writable, false);
  assert.equal(exitCode, 0, "Installed candidate rejected the original config copy");
  assert.equal(response?.valid, true, "Candidate did not report valid original config");
  assert.equal(typeof response.path, "string");
  assert.equal(
    fs.realpathSync(response.path),
    fs.realpathSync(before.copy.path),
    "Candidate validated another config path",
  );
}

/** Observe the published writer; no replay, environment override, or config repair. */
export function assertChannelPostCoreWriterWitness(params) {
  assertChannelPostCoreWitness(params, "changed-channel");
}

export function assertChannelPostCoreReadinessWitness(params) {
  assertChannelPostCoreWitness(params, "same-channel");
}

function assertChannelPostCoreWitness(
  { candidateVersion, observationRoot, updateOutcome, updateRepairRequired },
  contract,
) {
  const changedChannel = contract === "changed-channel";
  const expectedChannel = changedChannel ? "beta" : "stable";
  const observations = readChannelPostCoreProcessObservations(observationRoot);
  const initial = JSON.parse(
    fs.readFileSync(artifact("channel-post-core-before-update.json"), "utf8"),
  );
  const nodeHostBefore = JSON.parse(
    fs.readFileSync(artifact("channel-post-core-node-before-update.json"), "utf8"),
  );
  const nodeHostAfter = captureChannelPostCoreNodeHost("after-update");
  const final = configFacts();
  writeObservation("channel-post-core-parent.json", {
    contract,
    candidateVersion,
    updateOutcome,
    updateRepairRequired,
    initial,
    final,
    nodeHost: { before: nodeHostBefore, after: nodeHostAfter },
    observations,
  });
  assert.equal(updateOutcome, "success", "Published update did not succeed");
  assert.equal(updateRepairRequired, "0", "Standalone repair would hide a failed handoff");
  assert(nodeHostBefore.source, "Published update did not receive the legacy node-host specimen");
  assert.equal(nodeHostBefore.claim, null);
  assert.deepEqual(nodeHostBefore.canonicalRows, []);
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(artifact("channel-post-core-node-original.json")))
      .digest("hex"),
    nodeHostBefore.source.sha256,
    "Preserved node-host specimen differs from the updater input",
  );
  assertChannelPostCoreNodeHostImported(nodeHostAfter, nodeHostBefore);
  const pendingNodeHost = projectChannelPostCoreNodeHost(nodeHostBefore);
  const importedNodeHost = projectChannelPostCoreNodeHost(nodeHostAfter);
  const one = (pairs, label) => {
    assert.equal(pairs.length, 1, `Expected one ${label}; see captured process observations`);
    return pairs[0];
  };
  const byPid = new Map(observations.map((pair) => [pair.started.pid, pair]));
  const children = (pair) =>
    observations.filter(({ started }) => started.parentPid === pair.started.pid);
  const consumed = new Set();
  // Entry/cache wrappers may respawn the same command, but cannot hide forks or missing parents.
  const chain = (root, role) => {
    const pairs = [];
    let current = root;
    while (current) {
      assert.equal(current.started.role, role);
      assert(!consumed.has(current.started.pid), "Process lineage contains a cycle or overlap");
      consumed.add(current.started.pid);
      pairs.push(current);
      const nested = children(current).filter(({ started }) => started.role === role);
      assert(nested.length <= 1, `Ambiguous ${role} respawn lineage`);
      if (nested.length > 0) {
        assert.equal(children(current).length, 1, `A ${role} wrapper also launched unrelated work`);
      }
      current = nested[0];
    }
    return pairs;
  };
  const root = one(
    observations.filter(({ started }) => !byPid.has(started.parentPid)),
    "updater lineage root",
  );
  const updaterChain = chain(root, "update");
  const parent = updaterChain.at(-1);
  for (const pair of updaterChain) {
    assert.equal(pair.started.packageVersion, "2026.4.15");
    assert.equal(pair.started.config.sha256, initial.sha256);
    assert.deepEqual(pair.started.nodeHost, pendingNodeHost);
    assertCurrentConfig(pair.exited.config);
    assert.equal(pair.exited.config.sha256, final.sha256);
    assert.deepEqual(pair.exited.nodeHost, importedNodeHost);
  }
  assert.equal(
    children(parent).length,
    2,
    "Published updater launched unexpected observed commands",
  );
  const initialRoot = one(
    children(parent).filter(({ started }) => started.role === "doctor"),
    "initial Doctor lineage",
  );
  for (const pair of chain(initialRoot, "doctor")) {
    if (!changedChannel) {
      assertCurrentConfig(pair.started.config);
      assertCurrentConfig(pair.exited.config);
    }
    assert.equal(
      pair.started.repairRequested,
      false,
      "Published initial Doctor unexpectedly requested repair",
    );
    assert.equal(pair.started.packageVersion, candidateVersion);
    assert.equal(pair.started.config.sha256, initial.sha256);
    assert.equal(
      pair.exited.config.sha256,
      initial.sha256,
      "Initial Doctor changed config; the published writer's real CAS cannot proceed",
    );
    assert.deepEqual(pair.started.nodeHost, pendingNodeHost);
    assert.deepEqual(
      pair.exited.nodeHost,
      pendingNodeHost,
      "Initial no-fix Doctor consumed the node-host specimen",
    );
  }
  const receiverRoot = one(
    children(parent).filter(({ started }) => started.role === "post-core"),
    "post-core receiver lineage",
  );
  const receiverChain = chain(receiverRoot, "post-core");
  const writebackHash = receiverRoot.started.config.sha256;
  if (changedChannel) {
    assert.notEqual(writebackHash, initial.sha256);
  } else {
    assert.equal(
      writebackHash,
      initial.sha256,
      "Same-channel parent changed config before handoff",
    );
  }
  for (const pair of receiverChain) {
    assert.equal(pair.started.packageVersion, candidateVersion);
    assert.equal(pair.started.config.updateChannel, expectedChannel);
    if (changedChannel) {
      assert.equal(
        pair.started.config.hasLastTouchedAt,
        true,
        "The published writer did not introduce retired metadata",
      );
    } else {
      assertCurrentConfig(pair.started.config);
    }
    assert.equal(pair.started.config.sha256, writebackHash);
    assert.deepEqual(pair.started.nodeHost, pendingNodeHost);
    assertCurrentConfig(pair.exited.config);
    assert.equal(pair.exited.config.sha256, final.sha256);
    assert.deepEqual(pair.exited.nodeHost, importedNodeHost);
  }
  const receiver = receiverChain.at(-1);
  const doctorRoots = children(receiver);
  const repairingRoot = one(
    doctorRoots.filter(
      ({ started }) =>
        started.role === "doctor" &&
        (changedChannel
          ? started.config.hasLastTouchedAt
          : started.nodeHost.source?.sha256 === pendingNodeHost.source.sha256),
    ),
    changedChannel
      ? "receiver Doctor repairing published metadata"
      : "receiver Doctor importing node-host state",
  );
  assert.equal(repairingRoot.started.config.sha256, writebackHash);
  for (const doctorRoot of doctorRoots) {
    for (const pair of chain(doctorRoot, "doctor")) {
      assert.equal(pair.started.packageVersion, candidateVersion);
      if (doctorRoot === repairingRoot) {
        if (!changedChannel) {
          assertCurrentConfig(pair.started.config);
        }
        assert.equal(pair.started.repairRequested, true, "Receiver Doctor did not request repair");
        assert.equal(pair.started.config.sha256, writebackHash);
        assert.deepEqual(pair.started.nodeHost, pendingNodeHost);
      } else {
        assertCurrentConfig(pair.started.config);
        assert.deepEqual(pair.started.nodeHost, importedNodeHost);
      }
      assertCurrentConfig(pair.exited.config);
      assert.equal(pair.exited.config.updateChannel, expectedChannel);
      assert.deepEqual(
        pair.exited.nodeHost,
        importedNodeHost,
        "Receiver Doctor did not finish node-host import and cleanup",
      );
    }
  }
  assert.equal(consumed.size, observations.length, "Unrelated or missing process lineage evidence");
  assertCurrentConfig(final);
  assert.equal(final.updateChannel, expectedChannel);
  for (const { exited } of observations) {
    assert.equal(exited.exitCode, 0, `Observed ${exited.role} process ${exited.pid} failed`);
  }
}
