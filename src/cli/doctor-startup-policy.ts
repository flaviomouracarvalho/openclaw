const OFFLINE_MAINTENANCE_OPTIONS = ["--state-sqlite", "--cleanup-legacy-plugin-captures"];

/** Offline maintenance must acquire custody before proxy startup can observe state. */
export function resolveDoctorNetworkProxyPolicy({
  argv,
}: {
  argv: readonly string[];
}): "default" | "bypass" {
  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      break;
    }
    if (OFFLINE_MAINTENANCE_OPTIONS.some((name) => arg === name || arg.startsWith(`${name}=`))) {
      return "bypass";
    }
  }
  return "default";
}
