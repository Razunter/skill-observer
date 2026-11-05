import { addToSkillAmendment, checkNameFree, checkRuleWritable, rulePath, type RuleDirs, skillAmendment, skillAmendmentDescription, skillAmendmentFingerprint, skillAmendmentName, skillPin, writeObserverRule, type ObserverRule } from "./amendments.js";
import type { ProvenanceResolver } from "./provenance.js";
import { type PatternDraft, replayCase, type ReplayCase } from "./replay.js";
import type { ProposalAnswer } from "./resolve.js";

export interface FixRule { rule: ObserverRule; replay?: ReplayCase; section?: true }

/** What a fix's rule is built from: a pattern rule's name, body, pattern and samples, or, without a pattern, an on-read fix's section. */
export interface FixDraft extends Omit<PatternDraft, "pattern" | "name"> {
  name?: string;
  body: string;
  pattern?: string;
}

/**
 * Validates the rule of an applied fix and builds it: for an upstream or
 * plugin skill, a section of its on-read amendment in the amendments
 * directory or a pattern amendment in the rules directory, pinned to the skill
 * folder's content hash; for a local or managed skill, a barrier rule. Throws
 * with the reason when the fix can't be written.
 */
export function fixRule(answer: Pick<ProposalAnswer, "skill" | "kind" | "gist"> & { rule: FixDraft }, fingerprint: string, dirs: RuleDirs, provenance: ProvenanceResolver): FixRule {
  const { rule: draft } = answer;
  if (answer.kind === "new") throw new Error("a new skill has no rule to amend; prepare its barrier rule once the skill exists");
  if (!draft.body.trim()) throw new Error(draft.pattern?.trim() ? "a rule change needs its `body`" : "an on-read append needs its `section`");
  const skill = provenance.byName(answer.skill);
  if (skill.kind === "unknown" || skill.kind !== answer.kind) {
    throw new Error(`\`${answer.skill}\` is not ${answer.kind === "upstream" ? "an upstream skill in the skills lock" : `a ${answer.kind} skill`}`);
  }
  // Models often send an empty string for an optional field; that means no pattern.
  const pattern = draft.pattern?.trim() || undefined;
  if (pattern === undefined && (skill.kind === "local" || skill.kind === "managed")) {
    throw new Error(`a barrier rule for a ${skill.kind} skill needs a \`pattern\`; make any other fix as an edit to the skill`);
  }
  const pin = skillPin(skill);
  if (pattern === undefined) {
    if (!/^## +\S/.test(draft.body.trim())) throw new Error("an on-read append's `section` is a `## ` heading line, then its text");
    // Refuses a skill split into two or more on-read amendments, and a foreign rule under the amendment's name.
    skillAmendment(dirs.amendmentsDir, skill.name);
    const name = skillAmendmentName(skill.name);
    checkNameFree(dirs.rulesDir, name);
    const rule: ObserverRule = {
      name,
      path: rulePath(dirs.amendmentsDir, name),
      description: skillAmendmentDescription(skill.name),
      condition: "",
      scope: "",
      amends: skill.name,
      ...pin,
      fingerprint: skillAmendmentFingerprint(skill.name),
      body: draft.body,
    };
    return { rule, section: true };
  }
  if (!draft.name) throw new Error("a rule with a `pattern` needs a `name`");
  if (draft.name === skillAmendmentName(skill.name)) {
    throw new Error(`\`${draft.name}\` is the name of the skill's on-read amendment; pick another name`);
  }
  checkNameFree(dirs.amendmentsDir, draft.name);
  const path = rulePath(dirs.rulesDir, draft.name);
  const check = replayCase({ ...draft, name: draft.name, pattern });
  const rule: ObserverRule = {
    name: draft.name,
    path,
    description: answer.gist,
    condition: check.condition,
    scope: check.scope,
    amends: skill.name,
    ...pin,
    fingerprint,
    body: draft.body,
  };
  checkRuleWritable(rule);
  return { rule, replay: check };
}

/** The validated rule writer for an applied answer: the file it names, and whether it changed. */
export function publishFix(fix: FixRule): { path: string; written: boolean } {
  if (fix.section) return addToSkillAmendment(fix.rule);
  writeObserverRule(fix.rule);
  return { path: fix.rule.path, written: true };
}
