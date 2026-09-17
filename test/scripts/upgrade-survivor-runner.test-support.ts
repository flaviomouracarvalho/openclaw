export function sharedSurvivorDoctorFlowIndex(source: string): number {
  return (
    /^if \[ "\$SCENARIO" != "sqlite-volume" \][^\n]*\n {2}phase doctor run_doctor\nfi$/mu.exec(
      source,
    )?.index ?? -1
  );
}
