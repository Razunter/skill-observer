/**
 * The evidence report: what `/observe` would work from on this branch,
 * counted and named without starting a pass. It names tools, kinds, skills,
 * rule names and project target paths only; never tool arguments, error text,
 * evidence file paths or session IDs.
 */
import type { ObserverRule } from "./amendments.js";
import { droppedSignalCount, type LoadedSkill, type SessionDigest, type SkillSignal } from "./digest.js";
import type { LedgerRecord } from "./ledger.js";
import { type RemedyOutcome, remedyOutcomes } from "./outcomes.js";
import { describePayloadEstimate, type PayloadEstimate } from "./payload.js";

type SignalKind = SkillSignal["kind"];

export interface EvidenceReport {
  /** Distinct occurrences per signal kind. */
  signals: Record<SignalKind, number>;
  /** Older signals the digest cap leaves out of the pass. */
  dropped: number;
  skills: readonly LoadedSkill[];
  /** Skills a read requested that never loaded, by name. */
  attempted: string[];
  created: readonly string[];
  /** One per applied fix in force, delivered first, then exercised-clean, recurrence and inconclusive. */
  outcomes: Array<{ fingerprint: string; status: RemedyOutcome["status"]; target: string }>;
  stale: Array<{ rule: string; skill: string }>;
  later: number;
  /** The payload `/observe` would send now; absent on an empty report. */
  payload?: PayloadEstimate;
}

const STATUS_ORDER: readonly RemedyOutcome["status"][] = ["delivered", "exercised-clean", "recurrence", "inconclusive"];

/** The report of `digest` with `ledger`, the proposal ledger already scoped to this project. */
export function evidenceReport({ digest, ledger, stale }: {
  digest: SessionDigest;
  ledger: readonly LedgerRecord[];
  stale: readonly ObserverRule[];
}): EvidenceReport {
  const signals: Record<SignalKind, number> = {
    steering: 0, "rule-violation": 0, "ask-custom-input": 0, "ask-off-recommendation": 0, "tool-error": 0, workflow: 0,
  };
  for (const signal of digest.signals) signals[signal.kind] += signal.count;
  const loaded = new Set(digest.skills.map((skill) => skill.name));
  // Later records win, as in remedyOutcomes, so each outcome names its own record's target.
  const targets = new Map(ledger.map((record) => [record.fingerprint, record.kind === "project" ? record.target.path : record.skill]));
  return {
    signals,
    dropped: droppedSignalCount(digest),
    skills: digest.skills,
    attempted: [...new Set((digest.attemptedSkills ?? []).map((skill) => skill.name).filter((name) => !loaded.has(name)))],
    created: digest.createdSkills,
    outcomes: remedyOutcomes(ledger, digest)
      .map(({ fingerprint, status }) => ({ fingerprint, status, target: targets.get(fingerprint)! }))
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
    stale: stale.map((rule) => ({ rule: rule.name, skill: rule.amends })),
    later: ledger.filter((record) => record.outcome === "later" && !record.compaction).length,
  };
}

/** No signals, loaded skills, stale amendments or applied fixes: nothing `/observe` could review. */
export function isEmptyEvidenceReport(report: EvidenceReport): boolean {
  return Object.values(report.signals).every((count) => count === 0) &&
    report.skills.length === 0 && report.stale.length === 0 && report.outcomes.length === 0;
}

export function renderEvidenceReport(report: EvidenceReport): string {
  if (isEmptyEvidenceReport(report)) return "No skill evidence on this branch.";
  const list = (names: readonly string[]) => (names.length > 0 ? names.join(", ") : "none");
  const signals = Object.entries(report.signals).map(([kind, count]) => `${kind} ${count}`).join(", ");
  const skills = report.skills.map((skill) =>
    `- ${skill.name}: ${skill.kind}; ${skill.via.join(" and ")}${skill.amendmentsDelivered ? `; amendments delivered: ${skill.amendmentsDelivered.join(", ")}` : ""}`);
  return [
    "Evidence report (no observation pass started)",
    `Signals: ${signals}; ${report.dropped} older dropped by the digest cap`,
    "Skills loaded:",
    ...(skills.length > 0 ? skills : ["- none"]),
    `Attempted, not loaded: ${list(report.attempted)}`,
    `Managed skills created: ${list(report.created)}`,
    "Remedy outcomes:",
    ...(report.outcomes.length > 0 ? report.outcomes.map(({ fingerprint, status, target }) => `- ${fingerprint}: ${status} (${target})`) : ["- none"]),
    `Stale amendments: ${list(report.stale.map(({ rule, skill }) => `${rule} (${skill})`))}`,
    ...(report.payload ? [`Payload estimate for /observe now: ${describePayloadEstimate(report.payload)}`] : []),
    `Later proposals: ${report.later}`,
  ].join("\n");
}
