import { basename } from "node:path";
import { type SessionDigest, type ToolExercise, toolErrorText } from "./digest.js";
import type { LedgerRecord } from "./ledger.js";

export interface RemedyOutcome {
  fingerprint: string;
  status: "delivered" | "exercised-clean" | "recurrence" | "inconclusive";
  evidence: string[];
}

/**
 * Report only what delivery receipts and explicit behavior evidence establish.
 * A skill fix counts exercises made after its amendment was delivered; a
 * project fix has no amendment and counts exercises saved after its record.
 */
export function remedyOutcomes(records: readonly LedgerRecord[], digest: SessionDigest): RemedyOutcome[] {
  const latest = new Map(records.map((record) => [record.fingerprint, record]));
  const outcomes: RemedyOutcome[] = [];
  for (const record of latest.values()) {
    if (!["applied", "updated", "kept"].includes(record.outcome) || record.compaction) continue;
    const isProject = record.kind === "project";
    // The ledger keeps the rule file's path; deliveries name the rule.
    const rule = record.rule && basename(record.rule, ".md");
    const delivered = !isProject && rule && digest.skills.some((skill) =>
      skill.name === record.skill && skill.amendmentsDelivered?.includes(rule));
    const isAfterFix = (exercise: ToolExercise) => isProject
      ? exercise.at !== undefined && exercise.at > record.timestamp
      : rule ? exercise.deliveredRules.includes(rule) : false;
    const receipts = (digest.toolExercises ?? []).filter((exercise) => {
      if (!isAfterFix(exercise) || !exercise.args || exercise.args.includes("…")) return false;
      return record.evidence?.some((prior) => prior.quote.includes(toolErrorText(exercise.tool, exercise.args)));
    });
    const recurrence = receipts.find((exercise) => exercise.failed && exercise.error &&
      !exercise.error.includes("…") && record.evidence?.some((prior) =>
        prior.quote.includes(toolErrorText(exercise.tool, exercise.args, exercise.error))));
    const clean = (delivered || isProject) && receipts.find((exercise) => !exercise.failed);
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
