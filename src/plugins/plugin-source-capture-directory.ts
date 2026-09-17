import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  tryAcquireExclusiveSqliteCoordinator,
  type SqliteCoordinatorLease,
} from "../infra/sqlite-coordinator.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const CAPTURE_GRACE_MS = 60 * 60 * 1_000;
const LEASE_FILE = "owner.sqlite";
type Instance = {
  references: number;
  closing?: boolean;
  timer: ReturnType<typeof setInterval>;
  root?: string;
  lease?: SqliteCoordinatorLease;
};
const { instances, ownedRoots, sweeps } = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureInstances"),
  () => ({
    instances: new Map<string, Instance>(),
    ownedRoots: new Set<string>(),
    sweeps: new Map<string, Promise<void>>(),
  }),
);

function instanceDirectory(stateDir: string): string {
  return path.join(stateDir, "tmp", "plugin-captures");
}

function warn(error: unknown) {
  process.emitWarning(`Plugin source capture cleanup: ${String(error)}`);
}

async function reclaimInstances(root: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return;
  }
  const cutoff = Date.now() - CAPTURE_GRACE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(root, entry.name);
    let lease: SqliteCoordinatorLease | null = null;
    try {
      const stat = await fsPromises.lstat(directory);
      if (!stat.isDirectory() || stat.mtimeMs > cutoff) {
        continue;
      }
      const canonical = await fsPromises.realpath(directory);
      // Opening/closing a second native connection can disturb this process's POSIX locks.
      if (ownedRoots.has(canonical)) {
        continue;
      }
      const leasePath = path.join(canonical, LEASE_FILE);
      const leaseStat = await fsPromises.lstat(leasePath);
      const captures = path.join(canonical, "captures");
      const captureStat = await fsPromises.lstat(captures);
      if (
        !leaseStat.isFile() ||
        leaseStat.nlink !== 1 ||
        !captureStat.isDirectory() ||
        ownedRoots.has(canonical)
      ) {
        continue;
      }
      lease = tryAcquireExclusiveSqliteCoordinator(leasePath);
      if (!lease) {
        continue;
      }
      ownedRoots.add(canonical);
      try {
        // The native lock proves released custody even across PID namespaces.
        await removeTemporaryArtifacts(captures, "Plugin source instance");
        try {
          await fsPromises.lstat(captures);
          // Advisory removal may retain payload. Keep its coordinator for a later retry.
          continue;
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
        }
        lease.release();
        lease = null;
        // Instance IDs are never reused. Close the lease before removing its file on Windows.
        await removeTemporaryArtifacts(canonical, "Plugin source instance");
      } finally {
        ownedRoots.delete(canonical);
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        warn(error);
      }
    } finally {
      lease?.release();
    }
  }
}

/** Coalesce only active scans; long-lived metadata owners also retry hourly. */
export function sweepPluginSourceCaptureDirectories(stateDir = resolveStateDir()): Promise<void> {
  const root = path.resolve(instanceDirectory(stateDir));
  let sweep = sweeps.get(root);
  if (!sweep) {
    sweep = reclaimInstances(root)
      .catch(warn)
      .finally(() => sweeps.delete(root));
    sweeps.set(root, sweep);
  }
  return sweep;
}

function prepareInstance(instance: Instance, stateDir: string): string {
  if (instance.root) {
    return path.join(instance.root, "captures");
  }
  let directory: string;
  try {
    const parent = instanceDirectory(stateDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    directory = path.join(parent, randomUUID());
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    // A read-only state directory must not prevent an otherwise working plugin load.
    // Fallback instances have ordinary disposal, but no cross-instance automatic sweep.
    warn(error);
    directory = fs.mkdtempSync(path.join(tmpdir(), "openclaw-plugin-captures-"));
  }
  let lease: SqliteCoordinatorLease | null = null;
  try {
    const canonical = fs.realpathSync(directory);
    lease = tryAcquireExclusiveSqliteCoordinator(path.join(canonical, LEASE_FILE));
    if (!lease) {
      throw new Error("Could not acquire new plugin source instance");
    }
    const captures = path.join(canonical, "captures");
    fs.mkdirSync(captures, { mode: 0o700 });
    instance.root = canonical;
    instance.lease = lease;
    ownedRoots.add(canonical);
    return captures;
  } catch (error) {
    lease?.release();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Metadata and its captures share custody; standalone CLI captures own their own lifetime. */
export function retainPluginSourceCaptureInstance(stateDir = resolveStateDir()) {
  const key = path.resolve(stateDir);
  let instance = instances.get(key);
  if (instance?.closing) {
    throw new Error(
      "Plugin source instance cleanup is incomplete; retry cleanup before creating captures",
    );
  }
  if (!instance) {
    const timer = setInterval(
      () => void sweepPluginSourceCaptureDirectories(key),
      CAPTURE_GRACE_MS,
    );
    timer.unref();
    instance = { references: 0, timer };
    instances.set(key, instance);
    void sweepPluginSourceCaptureDirectories(key);
  }
  instance.references += 1;
  const retained = instance;
  let released = false;
  const retire = () => {
    if (released) {
      return undefined;
    }
    if (retained.references > 1) {
      retained.references -= 1;
      released = true;
      return undefined;
    }
    retained.closing = true;
    // Keep custody and the retryable handle if native close fails.
    retained.lease?.release();
    if (retained.root) {
      ownedRoots.delete(retained.root);
    }
    released = true;
    retained.references = 0;
    instances.delete(key);
    clearInterval(retained.timer);
    return retained.root;
  };
  return {
    createDirectory() {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      return fs.mkdtempSync(path.join(prepareInstance(retained, key), "capture-"));
    },
    release() {
      const root = retire();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    async releaseAsync() {
      const root = retire();
      if (root) {
        await removeTemporaryArtifacts(root, "Plugin source instance");
      }
    },
  };
}
