import { tmpdir } from "node:os";
import {
  acquireGatewayMaintenanceCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "../infra/state-database-coordinator.js";
import { cleanupLegacyPluginSourceCaptures } from "../plugins/plugin-source-capture-legacy.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

/** The explicit CLI flag attests that every producer sharing tmp has stopped. */
export async function runDoctorLegacyPluginCaptureCleanup() {
  let maintenance: ReturnType<typeof acquireGatewayMaintenanceCoordinator>;
  try {
    maintenance = acquireGatewayMaintenanceCoordinator({
      databasePath: resolveOpenClawStateSqlitePath(),
      busyTimeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof StateDatabaseCoordinatorContentionError) {
      throw new Error(
        "Cannot clean legacy plugin captures while a Gateway or maintenance command owns this state directory. Stop it through its owner and retry after all Gateways, CLI processes, and workers sharing the temporary directory have stopped.",
        { cause: error },
      );
    }
    throw error;
  }
  try {
    // This owner excludes the selected state only; legacy paths cannot identify
    // other profiles, users, or containers sharing the temporary directory.
    return await cleanupLegacyPluginSourceCaptures(tmpdir());
  } finally {
    maintenance.release();
  }
}
