import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";
import { isChannelPostCoreScenario } from "../../../lib/upgrade-survivor-policy.mjs";

const TRIGGERS = ["survivor-doctor-only"];
const SOURCE_NAME = "voicewake.json";
const STAGES = new Set(["startup", "doctor", "restarted"]);
const NODE_HOST_CONFIG = {
  version: 1,
  nodeId: "survivor-doctor-only-node",
  displayName: "Published updater state specimen",
  gateway: {
    host: "survivor-node.invalid",
    port: 18789,
    tls: false,
    contextPath: "/survivor-node",
  },
};

function within(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function context() {
  assert(isChannelPostCoreScenario(process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO));
  const directory = (name) => {
    const value = process.env[name];
    assert(value && path.isAbsolute(value), `${name} must be an isolated absolute path`);
    assert(fs.lstatSync(value).isDirectory(), `${name} must be a regular directory`);
    return fs.realpathSync(value);
  };
  const runtimeRoot = directory("OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT");
  const stateDir = directory("OPENCLAW_STATE_DIR");
  const artifacts = directory("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT");
  assert(within(runtimeRoot, stateDir), "Fixture state must belong to the scenario runtime");
  return { runtimeRoot, stateDir, artifacts };
}

function ownedPath(root, file) {
  assert(within(root, file), `Fixture path must belong to ${root}`);
  const parts = path.relative(root, file).split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      break;
    }
    assert(!stat.isSymbolicLink(), `Fixture path must not be a symlink: ${current}`);
    if (index < parts.length - 1) {
      assert(stat.isDirectory(), `Fixture parent must be a directory: ${current}`);
    }
  }
  return file;
}

function fileSnapshot(root, file) {
  ownedPath(root, file);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    return null;
  }
  assert(stat.isFile(), `Expected a regular fixture file: ${file}`);
  const bytes = fs.readFileSync(file);
  return {
    path: file,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytesBase64: bytes.toString("base64"),
  };
}

function nodeSourceFacts(ctx, name) {
  const file = ownedPath(ctx.stateDir, path.join(ctx.stateDir, name));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    return null;
  }
  assert(stat.isFile() && stat.size <= 64 * 1024, "Invalid node-host fixture source");
  return {
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  };
}

function nodeDatabaseFamily(ctx) {
  return ["", "-wal", "-shm", "-journal"].map((suffix) => {
    const file = ownedPath(
      ctx.stateDir,
      path.join(ctx.stateDir, "state", `openclaw.sqlite${suffix}`),
    );
    const before = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!before) {
      return { suffix, bytes: null, facts: null };
    }
    assert(
      before.isFile() && before.size <= 64 * 1024 * 1024,
      "Invalid node-host database artifact",
    );
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs],
      [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs],
      "Node-host database artifact changed while copying",
    );
    return {
      suffix,
      bytes,
      facts: {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  });
}

/** Observe only the isolated specimen; native SQLite never opens its live database family. */
export function captureChannelPostCoreNodeHost(label) {
  assert(/^[a-z0-9-]+$/u.test(label), "Invalid node-host observation label");
  const ctx = context();
  const observed = { label, source: null, claim: null, canonicalRows: [] };
  try {
    observed.source = nodeSourceFacts(ctx, "node.json");
    observed.claim = nodeSourceFacts(ctx, "node.json.doctor-importing");
    const family = nodeDatabaseFamily(ctx);
    observed.databaseFamily = family.map(({ suffix, facts }) => Object.assign({ suffix }, facts));
    if (family[0].bytes) {
      const copyDir = ownedPath(
        ctx.artifacts,
        path.join(ctx.artifacts, `channel-post-core-node-${label}`),
      );
      fs.mkdirSync(copyDir, { mode: 0o700 });
      for (const { suffix, bytes } of family) {
        // SQLite derives SHM from the copied WAL; it must never reuse live read marks.
        if (bytes && suffix !== "-shm") {
          fs.writeFileSync(path.join(copyDir, `openclaw.sqlite${suffix}`), bytes, {
            flag: "wx",
            mode: 0o600,
          });
        }
      }
      assert.deepEqual(
        nodeDatabaseFamily(ctx).map(({ suffix, facts }) => Object.assign({ suffix }, facts)),
        observed.databaseFamily,
        "Node-host database family changed during observation",
      );
      const db = new DatabaseSync(path.join(copyDir, "openclaw.sqlite"), { readOnly: true });
      try {
        const table = db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'config_machine_state'",
          )
          .get();
        observed.canonicalRows = table
          ? db
              .prepare("SELECT * FROM config_machine_state WHERE state_key = 'nodeHost.config'")
              .all()
              .map((row) => Object.assign({}, row))
          : [];
      } finally {
        db.close();
      }
    } else {
      assert(
        family.every(({ bytes }) => bytes === null),
        "Node-host database has orphan sidecars",
      );
    }
  } catch (error) {
    observed.observationError = String(error);
  }
  fs.writeFileSync(
    path.join(ctx.artifacts, `channel-post-core-node-${label}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  assert(!observed.observationError, observed.observationError);
  return observed;
}

export function projectChannelPostCoreNodeHost(observed) {
  return {
    source: observed.source,
    claim: observed.claim,
    canonicalRows: observed.canonicalRows.map((row) => ({
      stateKey: row.state_key,
      valueSha256: createHash("sha256").update(row.value_json).digest("hex"),
      updatedAtMs: row.updated_at_ms,
    })),
  };
}

export function seedChannelPostCoreNodeHost() {
  const ctx = context();
  const before = captureChannelPostCoreNodeHost("before-seed");
  assert.equal(before.source, null, "Node-host source already exists");
  assert.equal(before.claim, null, "Node-host migration claim already exists");
  assert.deepEqual(before.canonicalRows, [], "Node-host canonical state already exists");
  const bytes = `${JSON.stringify(NODE_HOST_CONFIG, null, 2)}\n`;
  fs.writeFileSync(ownedPath(ctx.stateDir, path.join(ctx.stateDir, "node.json")), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  // The node owner removes its retired source after verification; this is proof, not a runtime archive.
  fs.writeFileSync(path.join(ctx.artifacts, "channel-post-core-node-original.json"), bytes, {
    flag: "wx",
    mode: 0o400,
  });
  captureChannelPostCoreNodeHost("before-update");
}

export function assertChannelPostCoreNodeHostImported(observed, before) {
  assert.equal(observed.source, null, "Post-core Doctor left the legacy node-host source");
  assert.equal(observed.claim, null, "Post-core Doctor left its node-host claim");
  assert.equal(observed.canonicalRows.length, 1, "Post-core Doctor did not import node-host state");
  assert.deepEqual(JSON.parse(observed.canonicalRows[0].value_json), {
    ...NODE_HOST_CONFIG,
    installedAppsSharing: false,
  });
  assert.equal(
    observed.canonicalRows[0].updated_at_ms,
    before.source.mtimeMs,
    "Doctor changed the node-host source timestamp",
  );
}

function snapshotPath(ctx, stage) {
  return path.join(ctx.artifacts, `channel-post-core-voicewake-${stage}.json`);
}

function snapshot(ctx, stage) {
  const observed = { stage, runtimeRoot: ctx.runtimeRoot, stateDir: ctx.stateDir };
  try {
    const settings = ownedPath(ctx.stateDir, path.join(ctx.stateDir, "settings"));
    observed.source = fileSnapshot(ctx.stateDir, path.join(settings, SOURCE_NAME));
    observed.archives = (fs.existsSync(settings) ? fs.readdirSync(settings) : [])
      .filter(
        (name) => name === `${SOURCE_NAME}.migrated` || name.startsWith(`${SOURCE_NAME}.migrated.`),
      )
      .toSorted()
      .map((name) => fileSnapshot(ctx.stateDir, path.join(settings, name)));
    const database = ownedPath(ctx.stateDir, path.join(ctx.stateDir, "state", "openclaw.sqlite"));
    assert(fs.lstatSync(database).isFile(), "Voice wake canonical database must already exist");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      ownedPath(ctx.stateDir, `${database}${suffix}`);
    }
    // Existing-only, read-only observation must never initialize or migrate runtime state.
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      db.exec("BEGIN");
      const rows = (sql) =>
        db
          .prepare(sql)
          .all()
          .map((row) => Object.assign({}, row));
      observed.canonicalRows = rows(
        "SELECT * FROM config_machine_state WHERE state_key = 'voicewake.triggers' ORDER BY state_key",
      );
      observed.migrationRuns = rows("SELECT * FROM migration_runs ORDER BY id");
      observed.migrationSources = rows("SELECT * FROM migration_sources ORDER BY source_key");
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    if (stage === "doctor") {
      const log = fileSnapshot(ctx.artifacts, path.join(ctx.artifacts, "doctor.log"));
      const text = log
        ? stripVTControlCharacters(Buffer.from(log.bytesBase64, "base64").toString("utf8"))
            .replace(/[│┃|]/gu, " ")
            .replace(/\s+/gu, " ")
        : "";
      observed.doctorLog = {
        path: path.join(ctx.artifacts, "doctor.log"),
        sha256: log?.sha256 ?? null,
        migrationMessage:
          text.match(/Migrated 1 voice wake trigger → shared SQLite state/u)?.[0] ?? null,
        archiveMessage: text.match(/Archived voice wake triggers legacy source →/u)?.[0] ?? null,
      };
    }
  } catch (error) {
    observed.observationError = String(error);
  }
  // Publish measured state before checking it, including incomplete observations.
  fs.writeFileSync(snapshotPath(ctx, stage), `${JSON.stringify(observed, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  assert(!observed.observationError, observed.observationError);
  return observed;
}

function priorSnapshot(ctx, stage) {
  const file = ownedPath(ctx.artifacts, snapshotPath(ctx, stage));
  assert(fs.lstatSync(file).isFile(), `Missing regular ${stage} snapshot`);
  const prior = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(prior.runtimeRoot, ctx.runtimeRoot, "Voice wake fixture belongs to another runtime");
  assert.equal(
    prior.stateDir,
    ctx.stateDir,
    "Voice wake fixture belongs to another state directory",
  );
  assert(!prior.observationError, `Prior ${stage} observation failed`);
  return prior;
}

export function seedChannelPostCoreVoiceWake() {
  const ctx = context();
  const before = snapshot(ctx, "before-seed");
  assert.equal(before.source, null, "Voice wake source must be absent before seeding");
  assert.deepEqual(before.archives, [], "Voice wake archives must be absent before seeding");
  assert.deepEqual(
    before.canonicalRows,
    [],
    "Voice wake canonical row must be absent before seeding",
  );
  const settings = ownedPath(ctx.stateDir, path.join(ctx.stateDir, "settings"));
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(
    ownedPath(ctx.stateDir, path.join(settings, SOURCE_NAME)),
    `${JSON.stringify({ triggers: TRIGGERS }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  snapshot(ctx, "before-startup");
}

export function assertChannelPostCoreVoiceWake(stage) {
  assert(STAGES.has(stage), `Unknown voice wake assertion stage: ${stage}`);
  const ctx = context();
  const observed = snapshot(ctx, stage);
  const before = priorSnapshot(ctx, "before-startup");
  assert(before.source, "Voice wake fixture was not seeded");
  if (stage === "startup") {
    assert.deepEqual(
      observed.source,
      before.source,
      "Ordinary startup changed legacy voice wake bytes",
    );
    assert.deepEqual(
      observed.archives,
      before.archives,
      "Ordinary startup archived voice wake state",
    );
    assert.deepEqual(observed.canonicalRows, [], "Ordinary startup imported voice wake state");
    assert.deepEqual(
      observed.migrationRuns,
      before.migrationRuns,
      "Ordinary startup changed migration runs",
    );
    assert.deepEqual(
      observed.migrationSources,
      before.migrationSources,
      "Ordinary startup changed migration sources",
    );
    return;
  }
  assert.equal(observed.source, null, "Doctor left the active voice wake source");
  assert.equal(observed.archives.length, 1, "Doctor must preserve exactly one voice wake archive");
  assert.deepEqual(
    observed.archives[0],
    { ...before.source, path: observed.archives[0].path },
    "Doctor changed archived voice wake bytes",
  );
  assert.equal(observed.canonicalRows.length, 1, "Doctor did not import voice wake triggers");
  assert.deepEqual(
    JSON.parse(observed.canonicalRows[0].value_json),
    TRIGGERS,
    "Doctor imported different voice wake triggers",
  );
  if (stage === "doctor") {
    assert(observed.doctorLog.migrationMessage, "Doctor log omitted voice wake migration evidence");
    assert(observed.doctorLog.archiveMessage, "Doctor log omitted voice wake archive evidence");
    return;
  }
  const doctor = priorSnapshot(ctx, "doctor");
  assert.deepEqual(observed.archives, doctor.archives, "Restart changed the voice wake archive");
  assert.deepEqual(
    observed.canonicalRows,
    doctor.canonicalRows,
    "Restart changed canonical voice wake state",
  );
  assert.deepEqual(observed.migrationRuns, doctor.migrationRuns, "Restart changed migration runs");
  assert.deepEqual(
    observed.migrationSources,
    doctor.migrationSources,
    "Restart changed migration sources",
  );
}
