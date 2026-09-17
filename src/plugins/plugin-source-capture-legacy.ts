import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";

const LEGACY_CAPTURE_PREFIX = "openclaw-plugin-build-";
const LEGACY_CAPTURE_MIN_AGE_MS = 24 * 60 * 60 * 1_000;

export type LegacyPluginSourceCaptureCleanupReport = {
  directory: string;
  removed: string[];
  preserved: string[];
  failures: { path: string; message: string }[];
};

/** Only explicit offline Doctor maintenance may retire unowned legacy captures. */
export async function cleanupLegacyPluginSourceCaptures(
  directory: string,
): Promise<LegacyPluginSourceCaptureCleanupReport> {
  const root = path.resolve(directory);
  const report: LegacyPluginSourceCaptureCleanupReport = {
    directory: root,
    removed: [],
    preserved: [],
    failures: [],
  };
  const cutoff = Date.now() - LEGACY_CAPTURE_MIN_AGE_MS;
  for (const name of await fs.readdir(root)) {
    if (!name.startsWith(LEGACY_CAPTURE_PREFIX) || name.length === LEGACY_CAPTURE_PREFIX.length) {
      continue;
    }
    const capture = path.join(root, name);
    try {
      const stat = await fs.lstat(capture);
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) {
        report.preserved.push(capture);
        continue;
      }
      await removeTemporaryArtifacts(capture, "Legacy plugin source capture");
      // The shared cleanup owner is advisory. Report retained paths instead of
      // treating its fulfilled promise as proof that deletion succeeded.
      try {
        await fs.lstat(capture);
        report.failures.push({
          path: capture,
          message:
            "Directory remains after cleanup. Check permissions and retry while all producers remain stopped.",
        });
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        report.removed.push(capture);
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        report.failures.push({ path: capture, message: formatErrorMessage(error) });
      }
    }
  }
  return report;
}
