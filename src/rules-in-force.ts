/**
 * The Rules in force section of the `/observe` message: for each skill loaded
 * in the session, every rule this extension wrote for it with the fixes in
 * force under it, then the rules the user wrote by hand. The pass checks its
 * candidates against it, so it neither proposes a rule that exists nor misses
 * a fix failing a second time. An on-read amendment's line also carries its
 * size, whether it is offered for compaction, and its reference files.
 */

import { basename } from "node:path";
import {
  COMPACTION_LIMIT,
  compactionFingerprint,
  type HandWrittenRule,
  isOnReadAmendment,
  type ObserverRule,
  isPinned,
  sectionHeadings,
  skillAmendmentFingerprint,
} from "./amendments.js";
import { type LoadedSkill, ruleViolationCounts, type SessionDigest } from "./digest.js";
import { IN_FORCE_OUTCOMES, type LedgerRecord, type SkillLedgerRecord } from "./ledger.js";
import { readReferenceFiles, referenceFilesSentence } from "./references.js";

/** A rule this extension wrote for a loaded skill, with the fixes recorded into it. */
export interface RuleInForce {
  rule: ObserverRule;
  /** Fixes in force whose `rule` is this file, most evidence first, then newest. */
  fixes: LedgerRecord[];
  /** How often the rule fired as a rule violation this session; an on-read amendment's delivery is not a firing. */
  fired: number;
  /** An on-read amendment's reference files, absolute paths. */
  references: string[];
  /** An on-read amendment whose body is over the compaction limit and whose compaction wasn't declined for this body. */
  compact: boolean;
}

/** A loaded skill's rules in force, listed in the order the pass reads them. */
export interface SkillRulesInForce {
  skill: LoadedSkill;
  /** Rules that fired this session first, then higher summed evidence counts, then newer fixes. */
  rules: RuleInForce[];
  /** Fixes in force that wrote no rule: edits to a local or managed skill's own files. */
  edits: LedgerRecord[];
}

/** A ledger record with its place in the ledger: a higher position is a newer answer. */
type Positioned = { record: LedgerRecord; position: number };

/** Higher summed evidence counts first, then the newest answer first. */
function byEvidenceThenNewest(a: readonly Positioned[], b: readonly Positioned[]): number {
  const evidence = (entries: readonly Positioned[]) =>
    entries.reduce((total, { record }) => total + (record.evidence ?? []).reduce((sum, { count }) => sum + count, 0), 0);
  const newest = (entries: readonly Positioned[]) => Math.max(-1, ...entries.map(({ position }) => position));
  return evidence(b) - evidence(a) || newest(b) - newest(a);
}

const orderedRecords = (entries: Positioned[]) =>
  entries.sort((a, b) => byEvidenceThenNewest([a], [b])).map(({ record }) => record);

/**
 * Groups the ledger's fixes in force under the rules they wrote, for each
 * skill the session loaded. A record names its rule by the file's basename,
 * whichever directory the file lived in then. A record counts as in force
 * while its latest outcome is applied, kept or updated and its rule, when it
 * has one, still exists: a rule removed by other means than observer_resolve
 * drops its fixes without a ledger write. A stale answer about a skill's
 * on-read amendment is recorded under the amendment's own fingerprint, and a
 * compaction under its own; neither is a fix.
 */
export function rulesInForce(
  records: readonly LedgerRecord[],
  rules: readonly ObserverRule[],
  digest: SessionDigest,
  referencesDir: string,
): SkillRulesInForce[] {
  const violations = ruleViolationCounts(digest);
  // `records` runs oldest answer first. A fix whose `rule` file is gone matches no rule read from disk, so it drops out.
  const inForce = records
    .filter((record): record is SkillLedgerRecord => record.kind !== "project" && record.target === undefined)
    .map((record, position) => ({ record, position }))
    .filter(
      ({ record }) =>
        IN_FORCE_OUTCOMES.has(record.outcome) && !record.compaction && record.fingerprint !== skillAmendmentFingerprint(record.skill),
    );
  // A declined compaction suppresses the body it was drafted from; any change to the body makes a new fingerprint.
  const declinedCompactions = new Set(
    records.filter((record) => record.kind !== "project" && record.compaction && record.outcome === "declined").map((record) => record.fingerprint),
  );
  return digest.skills.map((skill) => {
    const listed = rules
      .filter((rule) => rule.amends === skill.name)
      .map((rule) => ({
        rule,
        fixes: inForce.filter(({ record }) => record.rule !== undefined && basename(record.rule, ".md") === rule.name),
        fired: violations.get(rule.name) ?? 0,
      }))
      .sort((a, b) => b.fired - a.fired || byEvidenceThenNewest(a.fixes, b.fixes))
      .map(({ rule, fixes, fired }) => {
        const onRead = isOnReadAmendment(rule);
        return {
          rule,
          fixes: orderedRecords(fixes),
          fired,
          references: onRead ? readReferenceFiles(referencesDir, rule.amends) : [],
          compact:
            onRead && rule.body.length > COMPACTION_LIMIT && !declinedCompactions.has(compactionFingerprint(rule.amends, rule.body)),
        };
      });
    const edits = orderedRecords(inForce.filter(({ record }) => record.rule === undefined && record.skill === skill.name));
    return { skill, rules: listed, edits };
  });
}

function fixLine(record: LedgerRecord): string {
  const quotes = (record.evidence ?? []).map(({ quote, count }) => `${JSON.stringify(quote)} (×${count})`);
  return [
    `fingerprint \`${record.fingerprint}\`: ${record.gist}`,
    `${record.outcome[0]!.toUpperCase()}${record.outcome.slice(1)} ${record.timestamp.slice(0, 10)}.`,
    ...(quotes.length > 0 ? [`Quotes: ${quotes.join(", ")}.`] : []),
  ].join(" ");
}

/**
 * The rule's own line: what kind of rule it is; for an on-read amendment, its
 * size, the compaction mark, its section headings, which fixes are not tied
 * to, and its reference files; for a rule that watches for a mistake, its
 * scope and firings.
 */
function ruleLine({ rule, fired, references, compact }: RuleInForce): string {
  if (isOnReadAmendment(rule)) {
    const headings = sectionHeadings(rule.body).map((heading) => JSON.stringify(heading));
    const sections = headings.length > 0 ? `sections ${headings.join(", ")}` : "no section headings";
    const size = `${rule.body.length} characters of body${compact ? `, over the compaction limit of ${COMPACTION_LIMIT}` : ""}`;
    return `On-read amendment \`${rule.name}\`, ${size}, ${sections}.${referenceFilesSentence(references)}`;
  }
  const kind = isPinned(rule) ? "Pattern amendment" : "Barrier rule";
  return `${kind} \`${rule.name}\`, scope \`${rule.scope}\`, fired ${fired} ${fired === 1 ? "time" : "times"} as a rule violation this session.`;
}

function renderSkill({ skill, rules, edits }: SkillRulesInForce): string[] {
  const entries = [
    ...rules.flatMap((entry) => [
      `  - ${ruleLine(entry)}`,
      ...(entry.fixes.length > 0 ? entry.fixes.map((fix) => `    - Fix, ${fixLine(fix)}`) : ["    - No fix in force recorded for it."]),
    ]),
    ...edits.map((edit) => `  - Edit to the skill's own files, ${fixLine(edit)}`),
  ];
  return [`- \`${skill.name}\` (${skill.kind}):`, ...(entries.length > 0 ? entries : ["  - None."])];
}

/** The `/observe` message section listing the rules in force for the loaded skills, and the hand-written rules. */
export function renderRulesInForce(skills: readonly SkillRulesInForce[], handWritten: readonly HandWrittenRule[]): string {
  const handWrittenLines = handWritten.map(
    ({ name, description }) => `- \`${name}\`: ${description || "no description."}`,
  );
  return [
    "### Rules in force",
    "",
    ...(skills.length > 0 ? skills.flatMap(renderSkill) : ["No skills loaded."]),
    "",
    "Hand-written rules in the user rules directory:",
    "",
    handWrittenLines.length > 0 ? handWrittenLines.join("\n") : "None.",
  ].join("\n");
}
