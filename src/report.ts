import { mkdir, writeFile } from "node:fs/promises";
import type { RecordPayload } from "./schema";

export const ARTIFACTS_DIR = "artifacts";

export interface Flag {
  code: string;
  detail: string;
}

export type Stage = "extract" | "parse" | "normalize" | "ground" | "submit" | "confirm";

export type Outcome =
  | { emailId: string; status: "confirmed"; recordId: string; payload: RecordPayload; flags: Flag[] }
  | { emailId: string; status: "failed"; stage: Stage; reason: string; details?: unknown; flags: Flag[] }
  | { emailId: string; status: "skipped_duplicate"; duplicateOf: string; flags: Flag[] };

export interface Reconciliation {
  storedCount: number;
  confirmedCount: number;
  /** recordIds present in the AMS but not confirmed by this run — silent loss running in reverse */
  orphans: string[];
  /** recordIds this run confirmed that the final AMS listing does NOT contain — data loss */
  missing: string[];
  /** groups of stored recordIds that share a logical identity (insured + LOB + effective date) */
  duplicateGroups: string[][];
}

export const reconciliationClean = (r: Reconciliation): boolean =>
  r.orphans.length === 0 && r.missing.length === 0 && r.duplicateGroups.length === 0;

export function printSummary(outcomes: Outcome[], recon: Reconciliation | null): void {
  const line = "=".repeat(72);
  console.log(`\n${line}\nRUN SUMMARY\n${line}`);
  for (const o of outcomes) {
    if (o.status === "confirmed") {
      console.log(
        `${o.emailId}  CONFIRMED  ${o.recordId}  ${o.payload.insuredName} (${o.payload.lineOfBusiness}, eff ${o.payload.effectiveDate})`,
      );
    } else if (o.status === "failed") {
      console.log(`${o.emailId}  FAILED     at ${o.stage}: ${o.reason}`);
      if (o.details !== undefined) console.log(`           details: ${JSON.stringify(o.details)}`);
    } else {
      console.log(`${o.emailId}  SKIPPED    resolves to the same logical record as ${o.duplicateOf}`);
    }
    for (const f of o.flags) console.log(`           [flag] ${f.code}: ${f.detail}`);
  }
  if (recon) {
    console.log("-".repeat(72));
    console.log(`AMS reconciliation: ${recon.storedCount} stored / ${recon.confirmedCount} confirmed by this run`);
    if (recon.orphans.length > 0) {
      console.log(
        `  WARNING orphaned records in AMS (stored but not confirmed by this run — stale state from a previous run without a stub restart, or a write this run lost track of): ${recon.orphans.join(", ")}`,
      );
    }
    if (recon.missing.length > 0) {
      console.log(
        `  WARNING confirmed records MISSING from the AMS listing — treat as data loss until explained: ${recon.missing.join(", ")}`,
      );
    }
    if (recon.duplicateGroups.length > 0) {
      console.log(
        `  WARNING duplicate logical records in AMS: ${recon.duplicateGroups.map((g) => g.join(" & ")).join("; ")}`,
      );
    }
    if (reconciliationClean(recon)) {
      console.log("  OK: AMS contents exactly match this run's confirmed set — no duplicates, no orphans, nothing missing");
    }
  } else {
    console.log("-".repeat(72));
    console.log("  WARNING could not list AMS records — reconciliation skipped");
  }
}

export async function writeRunReport(outcomes: Outcome[], recon: Reconciliation | null): Promise<string> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const path = `${ARTIFACTS_DIR}/run-report.json`;
  await writeFile(
    path,
    JSON.stringify({ generatedAt: new Date().toISOString(), outcomes, reconciliation: recon }, null, 2),
  );
  return path;
}
