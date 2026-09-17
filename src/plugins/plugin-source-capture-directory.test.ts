import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { retainGatewayPluginMetadata } from "./plugin-metadata-lifecycle.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { sweepPluginSourceCaptureDirectories } from "./plugin-source-capture-directory.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const loader = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const artifactModule = new URL("./plugin-generation-artifact.ts", import.meta.url).href;
const hour = 60 * 60 * 1_000;
const capturedSource = "module.exports = 'captured';\n";

beforeEach(() => {
  const runtimeTemp = temp.make("plugin-capture-runtime-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, runtimeTemp);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function createSource(): string {
  const source = temp.make("plugin-capture-input-");
  fs.writeFileSync(path.join(source, "index.cjs"), capturedSource);
  return source;
}

function age(directory: string): void {
  const timestamp = new Date(Date.now() - 2 * hour);
  fs.utimesSync(directory, timestamp, timestamp);
}

function capturePaths(stateDir: string, boundaryRoot: string, capturedFile: string) {
  const instanceRoot = path.dirname(path.dirname(boundaryRoot));
  // Check ownership before aging a path derived from a child or an older implementation.
  expect(path.dirname(instanceRoot)).toBe(path.join(stateDir, "tmp", "plugin-captures"));
  return {
    boundaryRoot,
    capturedFile,
    instanceRoot,
  };
}

const childCapture = `
  import fs from "node:fs";
  import path from "node:path";
  import { capturePluginGenerationArtifact } from ${JSON.stringify(artifactModule)};
  const source = process.argv[1];
  const artifact = capturePluginGenerationArtifact(source);
  const capturedFile = artifact.resolve(path.join(source, "index.cjs"));
  fs.writeSync(1, artifact.boundaryRoot + "\\n" + capturedFile + "\\n");
`;

function abandonCapture(stateDir: string, source: string) {
  const output = execFileSync(
    process.execPath,
    ["--import", loader, "--input-type=module", "-e", `${childCapture}\nprocess.exit(0);`, source],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        TMPDIR: stateDir,
        TMP: stateDir,
        TEMP: stateDir,
      },
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [boundaryRoot, capturedFile] = output.trim().split("\n");
  if (!boundaryRoot || !capturedFile) {
    throw new Error(`Capture child did not return its artifact paths: ${output}`);
  }
  const captured = capturePaths(stateDir, boundaryRoot, capturedFile);
  expect(fs.readFileSync(captured.capturedFile, "utf8")).toBe(capturedSource);
  return captured;
}

async function startCliCapture(stateDir: string, source: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      loader,
      "--input-type=module",
      "-e",
      `${childCapture}
       process.stdin.on("data", () => fs.writeSync(1, fs.readFileSync(capturedFile)));
       process.stdin.resume();`,
      source,
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        TMPDIR: stateDir,
        TMP: stateDir,
        TEMP: stateDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  void exited.catch(() => {});
  const nextLine = async () => {
    const result = await lines.next();
    if (result.done) {
      throw new Error(`Capture child exited before replying: ${stderr}`);
    }
    return result.value;
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    reader.close();
  };
  try {
    const boundaryRoot = await nextLine();
    const capturedFile = await nextLine();
    return {
      ...capturePaths(stateDir, boundaryRoot, capturedFile),
      async read() {
        child.stdin.write("read\n");
        return await nextLine();
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

it("metadata boot reclaims old abandoned artifacts and preserves recent and legacy files", async () => {
  const stateDir = temp.make("plugin-capture-boot-");
  const source = createSource();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const active = capturePluginGenerationArtifact(source);
  // Finish standalone acquisition before a Gateway joins the same process later.
  await sweepPluginSourceCaptureDirectories(stateDir);
  const old = abandonCapture(stateDir, source);
  const recent = abandonCapture(stateDir, source);
  age(old.instanceRoot);
  const legacy = path.join(temp.make("plugin-capture-legacy-"), "openclaw-plugin-build-legacy");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "sentinel"), "legacy files need explicit Doctor repair");
  age(legacy);
  vi.stubEnv("TMPDIR", path.dirname(legacy));

  const metadata = retainGatewayPluginMetadata();
  try {
    await vi.waitFor(() => expect(fs.existsSync(old.instanceRoot)).toBe(false));
    expect(fs.readFileSync(active.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    expect(fs.readFileSync(recent.capturedFile, "utf8")).toBe(capturedSource);
    expect(fs.readFileSync(path.join(legacy, "sentinel"), "utf8")).toBe(
      "legacy files need explicit Doctor repair",
    );
  } finally {
    await metadata.close();
    active.dispose();
    await sweepPluginSourceCaptureDirectories(stateDir);
  }
}, 30_000);

it("preserves an old live CLI capture, then reclaims it on a later scan after process exit", async () => {
  const stateDir = temp.make("plugin-capture-cli-");
  const child = await startCliCapture(stateDir, createSource());
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  try {
    age(child.instanceRoot);
    const metadata = retainGatewayPluginMetadata();
    try {
      await sweepPluginSourceCaptureDirectories(stateDir);
      expect(await child.read()).toBe(capturedSource.trim());
      expect(fs.readFileSync(child.capturedFile, "utf8")).toBe(capturedSource);
      await child.stop();
      expect(fs.readFileSync(child.capturedFile, "utf8")).toBe(capturedSource);
      await sweepPluginSourceCaptureDirectories(stateDir);
      expect(fs.existsSync(child.instanceRoot)).toBe(false);
    } finally {
      await metadata.close();
    }
  } finally {
    await child.stop();
  }
}, 30_000);

it("retries an abandoned instance after a partial removal failure is resolved", async () => {
  const stateDir = temp.make("plugin-capture-partial-removal-");
  const orphan = abandonCapture(stateDir, createSource());
  age(orphan.instanceRoot);
  const captures = path.dirname(orphan.boundaryRoot);
  const remove = fsPromises.rm.bind(fsPromises);
  const failure = Object.assign(new Error("Fixture payload cannot be removed"), { code: "EACCES" });
  const fault = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    if (target === captures) {
      throw failure;
    }
    if (target === orphan.instanceRoot) {
      // Recursive removal can unlink siblings before a nested payload failure.
      await remove(path.join(orphan.instanceRoot, "owner.sqlite"), { force: true });
      throw failure;
    }
    await remove(target, options);
  });
  try {
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(orphan.capturedFile, "utf8")).toBe(capturedSource);
  } finally {
    fault.mockRestore();
  }
  age(orphan.instanceRoot);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.existsSync(orphan.instanceRoot)).toBe(false);
}, 30_000);

it("retries reclamation when a long-lived metadata owner's hourly scan reaches the grace period", async () => {
  const stateDir = temp.make("plugin-capture-periodic-");
  const orphan = abandonCapture(stateDir, createSource());
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const metadata = retainGatewayPluginMetadata();
  try {
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(orphan.capturedFile, "utf8")).toBe(capturedSource);
    await vi.advanceTimersByTimeAsync(2 * hour);
    await vi.waitFor(() => expect(fs.existsSync(orphan.instanceRoot)).toBe(false));
  } finally {
    await metadata.close();
    await sweepPluginSourceCaptureDirectories(stateDir);
    vi.useRealTimers();
  }
}, 30_000);

it("retains live capture bytes until both metadata owners and the artifact release custody", async () => {
  const stateDir = temp.make("plugin-capture-shared-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const source = createSource();
  const first = retainGatewayPluginMetadata();
  let second: ReturnType<typeof retainGatewayPluginMetadata> | undefined;
  let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
  try {
    second = retainGatewayPluginMetadata();
    artifact = capturePluginGenerationArtifact(source);
    const { instanceRoot } = capturePaths(
      stateDir,
      artifact.boundaryRoot,
      artifact.resolve(path.join(source, "index.cjs")),
    );
    age(instanceRoot);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    await first.close();
    await first.close();
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    await second.close();
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    await artifact.disposeAsync();
    expect(fs.existsSync(instanceRoot)).toBe(false);
  } finally {
    try {
      await artifact?.disposeAsync();
    } finally {
      await Promise.all([first.close(), second?.close()]);
    }
  }
});

it("leaves explicit worker capture directories under their caller's custody", async () => {
  const stateDir = temp.make("plugin-capture-worker-state-");
  const workerRoot = temp.make("plugin-capture-worker-");
  const source = createSource();
  fs.writeFileSync(path.join(workerRoot, "sentinel"), "worker owns this directory");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const artifact = withPluginSourceCaptureDirectory(workerRoot, () =>
    capturePluginGenerationArtifact(source),
  );
  try {
    age(artifact.boundaryRoot);
    const metadata = retainGatewayPluginMetadata();
    try {
      await sweepPluginSourceCaptureDirectories(stateDir);
      expect(path.dirname(artifact.boundaryRoot)).toBe(workerRoot);
      expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
        capturedSource,
      );
    } finally {
      await metadata.close();
    }
  } finally {
    await artifact.disposeAsync();
  }
  expect(fs.existsSync(artifact.boundaryRoot)).toBe(false);
  expect(fs.readFileSync(path.join(workerRoot, "sentinel"), "utf8")).toBe(
    "worker owns this directory",
  );
});

it("keeps metadata boot and source capture usable when the state directory cannot contain captures", async () => {
  const parent = temp.make("plugin-capture-malformed-state-");
  const stateDir = path.join(parent, "state");
  fs.writeFileSync(stateDir, "not a directory");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const source = createSource();
  const metadata = retainGatewayPluginMetadata();
  let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
  let instanceRoot: string | undefined;
  try {
    await sweepPluginSourceCaptureDirectories(stateDir);
    artifact = capturePluginGenerationArtifact(source);
    instanceRoot = path.dirname(path.dirname(artifact.boundaryRoot));
    expect(fs.readFileSync(artifact.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      capturedSource,
    );
    expect(fs.readFileSync(stateDir, "utf8")).toBe("not a directory");
  } finally {
    try {
      await artifact?.disposeAsync();
    } finally {
      await metadata.close();
    }
  }
  expect(instanceRoot).toBeDefined();
  expect(fs.existsSync(instanceRoot!)).toBe(false);
});
