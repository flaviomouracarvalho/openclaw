import { note } from "../../packages/terminal-core/src/note.js";
import { UPDATE_ACTIVATION_TIMEOUT_REASON } from "../shared/update-outcome.js";

/** Report unfinished or failed update work during Doctor diagnostics. */
export async function noteStaleUpdateRuns(): Promise<void> {
  const [
    { staleUpdateRunGuidance },
    { listUpdateRunsAsync },
    { renderUpdateRunReport },
    { updateRunWarningMessages },
  ] = await Promise.all([
    import("../infra/update-run-activity.js"),
    import("../infra/update-run-reader.js"),
    import("../infra/update-run-report.js"),
    import("../infra/update-run-step.js"),
  ]);
  for (const run of await listUpdateRunsAsync({ active: true, limit: 100 })) {
    const guidance = staleUpdateRunGuidance(run);
    if (guidance) {
      note(`Update ${run.runId}: ${guidance}`, "Update history");
    }
  }
  const [latest] = await listUpdateRunsAsync({ limit: 1 });
  if (latest) {
    if (latest.status === "failed" && latest.reason === UPDATE_ACTIVATION_TIMEOUT_REASON) {
      note(`Update ${latest.runId}: ${renderUpdateRunReport(latest).markdown}`, "Update history");
    }
    const warnings = updateRunWarningMessages(latest.steps);
    if (warnings.length) {
      note(
        `Recorded warnings from update ${latest.runId} (a later repair may have resolved them):\n${warnings.slice(-3).join("\n")}`,
        "Update history",
      );
    }
  }
}
