import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cleanupLegacyPluginSourceCaptures } from "./plugin-source-capture-legacy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => vi.restoreAllMocks());

async function oldCapture(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "capture.js"), "export const captured = true;\n");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await fs.utimes(directory, old, old);
  return directory;
}

describe("offline legacy plugin capture cleanup", () => {
  it("removes old legacy directories while preserving recent captures, files, and symlink targets", async () => {
    const root = tempDirs.make("openclaw-legacy-capture-test-");
    const old = await oldCapture(root, "openclaw-plugin-build-old-variable-length");
    const formerPidName = await oldCapture(root, "openclaw-plugin-build-123-abcd");
    const unrelated = await oldCapture(root, "other-build-old");
    const recent = path.join(root, "openclaw-plugin-build-recent");
    await fs.mkdir(recent);
    const withinDay = new Date(Date.now() - 23 * 60 * 60 * 1_000);
    await fs.utimes(recent, withinDay, withinDay);
    const file = path.join(root, "openclaw-plugin-build-file");
    await fs.writeFile(file, "retained");
    const link = path.join(root, "openclaw-plugin-build-link");
    await fs.symlink(unrelated, link, process.platform === "win32" ? "junction" : "dir");

    const report = await cleanupLegacyPluginSourceCaptures(root);

    expect(report.removed.toSorted()).toEqual([old, formerPidName].toSorted());
    expect(report.preserved.toSorted()).toEqual([recent, file, link].toSorted());
    expect(report.failures).toEqual([]);
    expect((await fs.readdir(root)).toSorted()).toEqual(
      [
        path.basename(unrelated),
        path.basename(recent),
        path.basename(file),
        path.basename(link),
      ].toSorted(),
    );
    expect(await fs.readFile(path.join(unrelated, "capture.js"), "utf8")).toContain("captured");
    expect(await fs.readFile(file, "utf8")).toBe("retained");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("reports a failed removal and continues removing other eligible captures", async () => {
    const root = tempDirs.make("openclaw-legacy-capture-failure-");
    const retained = await oldCapture(root, "openclaw-plugin-build-retained");
    const removed = await oldCapture(root, "openclaw-plugin-build-removed");
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === retained) {
        throw Object.assign(new Error("Fixture directory cannot be removed"), { code: "EACCES" });
      }
      await remove(target, options);
    });

    const report = await cleanupLegacyPluginSourceCaptures(root);

    expect(report.removed).toEqual([removed]);
    expect(report.failures).toEqual([
      { path: retained, message: expect.stringContaining("Directory remains") },
    ]);
    expect(await fs.readFile(path.join(retained, "capture.js"), "utf8")).toContain("captured");
    expect(await fs.readdir(root)).toEqual([path.basename(retained)]);
  });
});
