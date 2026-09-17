import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertChannelPostCoreNodeHostImported,
  assertChannelPostCoreVoiceWake,
  captureChannelPostCoreNodeHost,
  projectChannelPostCoreNodeHost,
  seedChannelPostCoreNodeHost,
  seedChannelPostCoreVoiceWake,
} from "../../scripts/e2e/lib/upgrade-survivor/channel-post-core-state.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

const run = {
  id: "prior-update",
  started_at: 1700000000000,
  finished_at: null,
  status: "completed",
  report_json: '{"retained":"東京","zero":0}',
};
const receipt = {
  source_key: "prior-source",
  migration_kind: "synthetic-prior-import",
  source_path: "/synthetic/prior-source.json",
  target_table: "synthetic_prior_table",
  source_sha256: null,
  source_size_bytes: 0,
  source_record_count: 1,
  last_run_id: run.id,
  status: "completed",
  imported_at: 1700000000001,
  removed_source: 1,
  report_json: '{"retained":true}',
};

function changeDatabase(file: string, change: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  try {
    change(db);
  } finally {
    db.close();
  }
}

function fixture() {
  const root = realpathSync(dirs.make("survivor-voicewake-"));
  const state = join(root, "operator");
  const artifacts = join(root, "artifacts");
  mkdirSync(join(state, "state"), { recursive: true });
  mkdirSync(artifacts);
  for (const [name, value] of Object.entries({
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "channel-post-core-restore",
    OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
    OPENCLAW_STATE_DIR: state,
  })) {
    vi.stubEnv(name, value);
  }
  const database = join(state, "state", "openclaw.sqlite");
  changeDatabase(database, (db) => {
    db.exec(`
      CREATE TABLE config_machine_state (
        state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER
      );
      CREATE TABLE migration_runs (
        id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER, status TEXT, report_json TEXT
      );
      CREATE TABLE migration_sources (
        source_key TEXT PRIMARY KEY, migration_kind TEXT, source_path TEXT, target_table TEXT,
        source_sha256 TEXT, source_size_bytes INTEGER, source_record_count INTEGER,
        last_run_id TEXT, status TEXT, imported_at INTEGER, removed_source INTEGER, report_json TEXT
      );
    `);
    const insertRun = db.prepare("INSERT INTO migration_runs VALUES (?, ?, ?, ?, ?)");
    insertRun.run(...Object.values(run));
    insertRun.run(...Object.values({ ...run, id: "earlier-update" }));
    const insertSource = db.prepare(
      "INSERT INTO migration_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertSource.run(...Object.values(receipt));
    insertSource.run(...Object.values({ ...receipt, source_key: "earlier-source" }));
  });
  return { root, state, artifacts, database, source: join(state, "settings", "voicewake.json") };
}

type Fixture = ReturnType<typeof fixture>;
type FileSnapshot = { path: string; sha256: string; bytesBase64: string; size: number };
type Snapshot = {
  source: FileSnapshot | null;
  archives: FileSnapshot[];
  canonicalRows: { state_key: string; value_json: string; updated_at_ms: number }[];
  migrationRuns: (typeof run)[];
  migrationSources: (typeof receipt)[];
  observationError?: string;
};

function observed(f: Fixture, stage: string): Snapshot {
  return JSON.parse(
    readFileSync(join(f.artifacts, `channel-post-core-voicewake-${stage}.json`), "utf8"),
  );
}

function doctorEvidence(f: Fixture, omittedMessage = "") {
  changeDatabase(f.database, (db) => {
    db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
      "voicewake.triggers",
      '["survivor-doctor-only"]',
      1700000000002,
    );
  });
  const archive = `${f.source}.migrated`;
  renameSync(f.source, archive);
  const messages = {
    migration: "Migrated 1 voice wake trigger → shared SQLite state",
    archive: `Archived voice wake triggers legacy source → ${archive}`,
  };
  writeFileSync(
    join(f.artifacts, "doctor.log"),
    Object.entries(messages)
      .filter(([kind]) => kind !== omittedMessage)
      .map(([, message]) => `│  ${message}  │\n`)
      .join(""),
  );
  return archive;
}

const nodeConfig = {
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

function seedNode(f: Fixture) {
  seedChannelPostCoreNodeHost();
  const source = join(f.state, "node.json");
  const bytes = readFileSync(source);
  const before = JSON.parse(
    readFileSync(join(f.artifacts, "channel-post-core-node-before-update.json"), "utf8"),
  );
  const row = {
    state_key: "nodeHost.config",
    value_json: JSON.stringify({ ...nodeConfig, installedAppsSharing: false }),
    updated_at_ms: Math.floor(statSync(source).mtimeMs),
  };
  return { source, bytes, before, row };
}

describe("channel post-core node-host evidence", () => {
  it.each([
    "complete",
    "pending",
    "claim",
    "canonical-missing",
    "canonical-value",
    "canonical-timestamp",
  ])("requires verified import and source cleanup before startup (%s)", (fault) => {
    const f = fixture();
    const node = seedNode(f);
    expect(JSON.parse(node.bytes.toString("utf8"))).toEqual(nodeConfig);
    expect(node.before.source).toEqual({
      sha256: createHash("sha256").update(node.bytes).digest("hex"),
      size: node.bytes.length,
      mtimeMs: node.row.updated_at_ms,
    });
    expect(node.before.claim).toBeNull();
    expect(node.before.canonicalRows).toEqual([]);
    expect(projectChannelPostCoreNodeHost(captureChannelPostCoreNodeHost("no-fix-exited"))).toEqual(
      projectChannelPostCoreNodeHost(node.before),
    );
    expect(readFileSync(node.source)).toEqual(node.bytes);
    if (fault !== "pending") {
      if (fault !== "canonical-missing") {
        changeDatabase(f.database, (db) =>
          db
            .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
            .run(
              node.row.state_key,
              fault === "canonical-value"
                ? '{"version":1,"nodeId":"different-node"}'
                : node.row.value_json,
              node.row.updated_at_ms + (fault === "canonical-timestamp" ? 1 : 0),
            ),
        );
      }
      unlinkSync(node.source);
      if (fault === "claim") {
        writeFileSync(`${node.source}.doctor-importing`, node.bytes);
      }
    }
    const imported = captureChannelPostCoreNodeHost("repair-exited");
    const verify = () => assertChannelPostCoreNodeHostImported(imported, node.before);
    if (fault === "complete") {
      expect(verify).not.toThrow();
      expect(imported.canonicalRows).toEqual([node.row]);
      expect(imported.source).toBeNull();
      expect(imported.claim).toBeNull();
    } else {
      expect(verify).toThrow();
    }
    expect(
      JSON.parse(
        readFileSync(join(f.artifacts, "channel-post-core-node-repair-exited.json"), "utf8"),
      ),
    ).toEqual(imported);
    const original = join(f.artifacts, "channel-post-core-node-original.json");
    expect(readFileSync(original)).toEqual(node.bytes);
    expect(statSync(original).mode & 0o222).toBe(0);
  });

  it("captures the canonical WAL row without changing the live database family", () => {
    const f = fixture();
    const node = seedNode(f);
    const db = new DatabaseSync(f.database);
    try {
      db.exec("PRAGMA journal_mode=WAL");
      db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        ...Object.values(node.row),
      );
      unlinkSync(node.source);
      const family = () =>
        ["", "-wal", "-shm", "-journal"].map((suffix) => ({
          suffix,
          bytes: existsSync(`${f.database}${suffix}`)
            ? readFileSync(`${f.database}${suffix}`)
            : null,
        }));
      const before = family();
      expect(before.find(({ suffix }) => suffix === "-wal")?.bytes?.length).toBeGreaterThan(0);
      const imported = captureChannelPostCoreNodeHost("wal-repair-exited");
      expect(imported.canonicalRows).toEqual([node.row]);
      expect(() => assertChannelPostCoreNodeHostImported(imported, node.before)).not.toThrow();
      expect(family()).toEqual(before);
      expect(readFileSync(join(f.artifacts, "channel-post-core-node-original.json"))).toEqual(
        node.bytes,
      );
    } finally {
      db.close();
    }
  });

  it.each(["source", "claim", "canonical"])(
    "does not seed over existing node-host %s",
    (existing) => {
      const f = fixture();
      const source = join(f.state, "node.json");
      if (existing === "canonical") {
        changeDatabase(f.database, (db) =>
          db.exec(
            "INSERT INTO config_machine_state VALUES ('nodeHost.config', '{\"nodeId\":\"retained\"}', 123)",
          ),
        );
      } else {
        writeFileSync(existing === "claim" ? `${source}.doctor-importing` : source, "retained");
      }
      expect(() => seedChannelPostCoreNodeHost()).toThrow();
      expect(existsSync(join(f.artifacts, "channel-post-core-node-original.json"))).toBe(false);
      if (existing !== "canonical") {
        expect(
          readFileSync(existing === "claim" ? `${source}.doctor-importing` : source, "utf8"),
        ).toBe("retained");
      }
    },
  );
});

describe("channel post-core voice wake evidence", () => {
  it("accepts unchanged startup and a logged Doctor import without inventing SQL receipts", () => {
    const f = fixture();
    seedChannelPostCoreVoiceWake();
    const before = observed(f, "before-startup");
    expect(before.migrationRuns).toEqual([{ ...run, id: "earlier-update" }, run]);
    expect(before.migrationSources).toEqual([
      { ...receipt, source_key: "earlier-source" },
      receipt,
    ]);
    expect(before.source?.bytesBase64).toBe(readFileSync(f.source).toString("base64"));
    // The assertion compares fresh node:sqlite rows against JSON-deserialized plain records.
    expect(() => assertChannelPostCoreVoiceWake("startup")).not.toThrow();
    const archive = doctorEvidence(f);
    expect(() => assertChannelPostCoreVoiceWake("doctor")).not.toThrow();
    expect(observed(f, "doctor").migrationRuns).toEqual(before.migrationRuns);
    expect(observed(f, "doctor").migrationSources).toEqual(before.migrationSources);
    expect(observed(f, "doctor").archives).toEqual([
      expect.objectContaining({
        sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      }),
    ]);
    expect(() => assertChannelPostCoreVoiceWake("restarted")).not.toThrow();
  });

  it.each(["source", "canonical", "run", "receipt"])(
    "exports the failed startup observation when %s changes",
    (fault) => {
      const f = fixture();
      seedChannelPostCoreVoiceWake();
      if (fault === "source") {
        writeFileSync(f.source, "changed legacy bytes\n");
      } else {
        changeDatabase(f.database, (db) => {
          if (fault === "canonical") {
            db.exec("INSERT INTO config_machine_state VALUES ('voicewake.triggers', '[]', 123)");
          } else if (fault === "run") {
            db.exec("UPDATE migration_runs SET finished_at = 123 WHERE id = 'prior-update'");
          } else {
            db.exec(
              "UPDATE migration_sources SET report_json = '{}' WHERE source_key = 'prior-source'",
            );
          }
        });
      }
      expect(() => assertChannelPostCoreVoiceWake("startup")).toThrow(/Ordinary startup/u);
      const actual = observed(f, "startup");
      if (fault === "source") {
        expect(actual.source?.bytesBase64).toBe(
          Buffer.from("changed legacy bytes\n").toString("base64"),
        );
      } else if (fault === "canonical") {
        expect(actual.canonicalRows).toEqual([
          { state_key: "voicewake.triggers", value_json: "[]", updated_at_ms: 123 },
        ]);
      } else if (fault === "run") {
        expect(actual.migrationRuns).toContainEqual({ ...run, finished_at: 123 });
      } else {
        expect(actual.migrationSources).toContainEqual({ ...receipt, report_json: "{}" });
      }
    },
  );

  it.each(["migration", "archive", "archive bytes", "triggers"])(
    "rejects incomplete Doctor evidence: %s",
    (fault) => {
      const f = fixture();
      seedChannelPostCoreVoiceWake();
      assertChannelPostCoreVoiceWake("startup");
      const archive = doctorEvidence(f, fault);
      if (fault === "archive bytes") {
        writeFileSync(archive, "{}\n");
      } else if (fault === "triggers") {
        changeDatabase(f.database, (db) =>
          db.exec("UPDATE config_machine_state SET value_json = '[]'"),
        );
      }
      expect(() => assertChannelPostCoreVoiceWake("doctor")).toThrow(/Doctor/u);
      expect(observed(f, "doctor").source).toBeNull();
      expect(observed(f, "doctor").archives).toHaveLength(1);
    },
  );

  it("compares the complete canonical row on restart, including its timestamp", () => {
    const f = fixture();
    seedChannelPostCoreVoiceWake();
    assertChannelPostCoreVoiceWake("startup");
    doctorEvidence(f);
    assertChannelPostCoreVoiceWake("doctor");
    changeDatabase(f.database, (db) =>
      db.exec("UPDATE config_machine_state SET updated_at_ms = 456"),
    );
    expect(() => assertChannelPostCoreVoiceWake("restarted")).toThrow(
      "Restart changed canonical voice wake state",
    );
    expect(observed(f, "restarted").canonicalRows).toEqual([
      expect.objectContaining({ updated_at_ms: 456 }),
    ]);
  });

  it.each(["source", "archive", "canonical", "symlink"])(
    "refuses to seed over preexisting %s state",
    (existing) => {
      const f = fixture();
      mkdirSync(join(f.state, "settings"));
      const sentinel = join(f.root, "untouched.json");
      writeFileSync(sentinel, "untouched");
      if (existing === "source" || existing === "archive") {
        writeFileSync(existing === "source" ? f.source : `${f.source}.migrated`, "untouched");
      } else if (existing === "canonical") {
        changeDatabase(f.database, (db) =>
          db.exec("INSERT INTO config_machine_state VALUES ('voicewake.triggers', '[]', 123)"),
        );
      } else {
        symlinkSync(sentinel, f.source);
      }
      expect(() => seedChannelPostCoreVoiceWake()).toThrow();
      expect(existsSync(join(f.artifacts, "channel-post-core-voicewake-before-seed.json"))).toBe(
        true,
      );
      expect(readFileSync(sentinel, "utf8")).toBe("untouched");
      if (existing === "source" || existing === "archive") {
        expect(
          readFileSync(existing === "source" ? f.source : `${f.source}.migrated`, "utf8"),
        ).toBe("untouched");
      }
      if (existing === "symlink") {
        expect(observed(f, "before-seed").observationError).toContain("must not be a symlink");
      }
    },
  );

  it("exports an observation failure without creating a missing canonical database", () => {
    const f = fixture();
    renameSync(f.database, `${f.database}.retained`);
    expect(() => seedChannelPostCoreVoiceWake()).toThrow();
    expect(existsSync(f.database)).toBe(false);
    expect(existsSync(f.source)).toBe(false);
    expect(observed(f, "before-seed").observationError).toContain("ENOENT");
  });
});
