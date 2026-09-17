import { assertNoLegacyDeviceAuth } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { assertNoPendingLegacyExecApprovals } from "../infra/exec-approvals-migration-gate.js";
import { initializeNativeOpenClawStateDatabase } from "../state/openclaw-state-db.js";

export function ensureNodeHostStateReady(): void {
  // Native clients can create version-zero tables before this node starts.
  // Complete their canonical bootstrap before read-only readiness checks.
  initializeNativeOpenClawStateDatabase();
  assertNoLegacyDeviceAuth(process.env);
  assertNoPendingLegacyExecApprovals();
  loadDeviceIdentityIfPresent();
}
