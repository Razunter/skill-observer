import { basename } from "node:path";
import type { SessionDigest } from "./digest.js";
import type { LedgerRecord } from "./ledger.js";

export interface RemedyOutcome {
  fingerprint: string;
  status: "delivered" | "exercised-clean" | "recurrence" | "inconclusive";
  evidence: string[];
}

/** Report only what delivery receipts and explicit behavior evidence establish. */
export function remedyOutcomes(records: readonly LedgerRecord[], digest: SessionDigest): RemedyOutcome[] {
  const latest = new Map(records.map((record) => [record.fingerprint, record]));
  const outcomes: RemedyOutcome[] = [];
  for (const record of latest.values()) {
    if (!["applied", "updated", "kept"].includes(record.outcome) || record.compaction) continue;
    // The ledger keeps the rule file's path; deliveries name the rule.
    const rule = record.rule && basename(record.rule, ".md");
    const delivered = record.kind !== "project" && rule && digest.skills.some((skill) =>
      skill.name === record.skill && skill.amendmentsDelivered?.includes(rule));
    const receipts = rule ? (digest.toolExercises ?? []).filter((exercise) => {
      if (!exercise.deliveredRules.includes(rule) || !exercise.args || exercise.args.includes("…")) return false;
      const mechanism = `Tool error in \`${exercise.tool}\` ${JSON.stringify(exercise.args)}:`;
      return record.evidence?.some((prior) => prior.quote.includes(mechanism));
    }) : [];
    const recurrence = receipts.find((exercise) => exercise.failed && exercise.error &&
      !exercise.error.includes("…") && record.evidence?.some((prior) =>
        prior.quote.includes(`Tool error in \`${exercise.tool}\` ${JSON.stringify(exercise.args)}: ${JSON.stringify(exercise.error)}`)));
    const clean = delivered && receipts.find((exercise) => !exercise.failed);
    outcomes.push({ fingerprint: record.fingerprint,
      status: recurrence ? "recurrence" : clean ? "exercised-clean" : delivered ? "delivered" : "inconclusive",
      evidence: recurrence ? [recurrence.entryId] : clean ? [clean.entryId] : delivered ? [rule!] : [],
    });
  }
  return outcomes;
}

export function renderRemedyOutcomes(outcomes: readonly RemedyOutcome[]): string {
  if (!outcomes.length) return "";
  return ["### Remedy outcomes", "", ...outcomes.map((outcome) =>
    `- ${outcome.fingerprint}: ${outcome.status}${outcome.evidence.length ? ` (evidence: ${outcome.evidence.join(", ")})` : "; missing relevant delivery/exercise evidence"}.`)].join("\n");
}
