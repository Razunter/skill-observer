/**
 * On-read amendment transitions: what one `observer_resolve` call does to
 * skills' on-read amendments, their reference files and the other rules its
 * answers write or take back. The call's changes run in fixed phases across
 * every skill it names: stale settlements, then withdrawals, then the other
 * answers in answer order (on-read additions, with pattern amendments and
 * barrier rules where they fall among them), then compactions. A phase acts on
 * what earlier effects actually did: a body drafted before a stale change or a
 * withdrawal of its amendment is refused, a stale delete takes the fixes inside
 * the amendment out of force, and a compaction must cover exactly the additions
 * this call applied. A failed effect changes nothing a later phase relies on.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  compactionFingerprint,
  deleteObserverRule,
  isOnReadAmendment,
  isPinKind,
  isPinned,
  type ObserverRule,
  type PinKind,
  readObserverRule,
  readOnReadAmendments,
  repinAmendmentRule,
  rewriteRuleBody,
  type RuleDirs,
  ruleFile,
  skillAmendment,
  skillAmendmentFingerprint,
} from "./amendments.js";
import { IN_FORCE_OUTCOMES, type LedgerRecord, type ProposalKind, type SkillLedgerRecord, STALE_OUTCOMES } from "./ledger.js";
import type { SessionEntry } from "./omp.js";
import type { ProvenanceResolver } from "./provenance.js";
import { type ApprovalEvidence, approvedChange, type ApprovedChange, TargetChangedError } from "./proposal-approval.js";
import { type FixRule, publishFix } from "./publication.js";
import { checkPointers, checkReferenceFiles, hasUnlistedReferenceEntries, readReferenceFiles, type ReferenceFile, replaceReferenceFiles } from "./references.js";
import { describeVerdict, type ReplayCase, type Verdict } from "./replay.js";
import type { CompactionAnswer, ProposalAnswer, StaleAnswer } from "./resolve.js";

/** What one call's transitions read and write. */
export interface AmendmentContext {
  dirs: RuleDirs;
  referencesDir: string;
  /** The latest ledger record per fingerprint as the call began. */
  latest: ReadonlyMap<string, LedgerRecord>;
  /** Created for this call. */
  provenance: ProvenanceResolver;
  /** The session branch as the call began, holding the approvals its answers cite. */
  branch: readonly SessionEntry[];
  timestamp: string;
  sessionId: string;
}

type WithdrawalChange = Extract<ApprovedChange, { operation: "withdrawal" }>;

/** A skill answer that passed the resolver's checks: its ledger fingerprint and, for an applied fix, the rule it writes, or for a withdrawal, its approved change. */
export interface ValidatedAnswer {
  answer: ProposalAnswer;
  fingerprint: string;
  fix?: FixRule;
  withdrawal?: WithdrawalChange;
}

/** One call's answers that change rules and on-read amendments. */
export interface AmendmentInvocation {
  /** In answer order. */
  answers: readonly ValidatedAnswer[];
  stale: readonly StaleAnswer[];
  compactions: readonly CompactionAnswer[];
}

/** A change one call made to a rule file or on-read amendment, with its reference files. */
export interface Publication {
  operation: ApprovedChange["operation"] | "stale-keep";
  skill: string;
  /** The rule or amendment file written or deleted. */
  rule: string;
  /** The fingerprint the change's ledger record carries. */
  fingerprint: string;
}

export interface AmendmentResolution {
  /** In the order carried out. */
  records: SkillLedgerRecord[];
  /** In the order made. */
  publications: Publication[];
  /** Answers that wrote and recorded nothing, each with the reason. */
  failures: string[];
  /** Whether a failure is an approval whose target changed since it was prepared. */
  targetChanged: boolean;
  /** Deletions carried out and recorded whose reference cleanup failed afterwards, each with what is left. */
  cleanup: string[];
  /** Applied answers recorded as `later` without writing, each with the reason. */
  deferred: string[];
  approvals: ApprovalEvidence[];
}

/**
 * One call's transitions, checked before anything is written. `replays` holds
 * each answer's replay check; `resolve` takes their verdicts in that order and
 * the branch as it is after waiting for them, checks every approval again from
 * it, and carries out the phases. Nothing it does waits, so the approvals it
 * checks still hold at each write.
 */
export interface AmendmentTransitions {
  replays: readonly (ReplayCase | undefined)[];
  resolve(verdicts: readonly (Verdict | undefined)[], branch: readonly SessionEntry[]): AmendmentResolution;
}

/**
 * Checks one call's amendment changes against the ledger and the files as
 * they are when it begins: each withdrawal's write, that withdrawals of one
 * amendment agree on its new body and reference files, that no deletion
 * leaves another fix in force to come back with a new file, and each
 * compaction's identity, taken from the amendment's body before this call's
 * changes. Refused answers become failures.
 */
export function onReadAmendmentTransitions(invocation: AmendmentInvocation, context: AmendmentContext): AmendmentTransitions {
  const { dirs, referencesDir, latest, provenance } = context;
  const failures: string[] = [];
  let targetChanged = false;
  const prepared = invocation.answers.flatMap(({ answer, fingerprint, fix, withdrawal: change }): ScheduledAnswer[] => {
    if (!change) return [{ answer, fingerprint, fix }];
    try {
      return [{ answer, fingerprint, withdrawn: preparedWithdrawal(answer, change, latest, dirs, referencesDir) }];
    } catch (error) {
      failures.push(`${label(answer)}: ${(error as Error).message}`);
      return [];
    }
  });
  // A withdrawal that deletes a rule file takes back every fix in force in it: the others are withdrawn in the same call, or they would come back with a new file at that path.
  const withdrawnHere = new Set(prepared.flatMap(({ withdrawn }) => (withdrawn ? [withdrawn.record.fingerprint] : [])));
  const conflictingWithdrawals = new Set<string>();
  const withdrawalDrafts = new Map<string, { body: string | undefined; references: ReferenceFile[] | undefined }>();
  for (const { withdrawn } of prepared) {
    if (!withdrawn?.rule || !isOnReadAmendment(withdrawn.rule)) continue;
    const path = withdrawn.rule.path;
    const draft = { body: withdrawn.body, references: withdrawn.references };
    const previous = withdrawalDrafts.get(path);
    if (previous && !isDeepStrictEqual(previous, draft)) conflictingWithdrawals.add(path);
    else withdrawalDrafts.set(path, draft);
  }
  const answers = prepared.filter(({ answer, withdrawn }) => {
    if (withdrawn?.rule && conflictingWithdrawals.has(withdrawn.rule.path)) {
      failures.push(`${label(answer)}: withdrawals of the same amendment need identical final body and references`);
      return false;
    }
    if (!withdrawn?.rule || withdrawn.body?.trim()) return true;
    const others = fixesInForce(latest, withdrawn.rule.name).filter((record) => !withdrawnHere.has(record.fingerprint));
    if (others.length === 0) return true;
    const fixes = others.map((record) => `\`${record.fingerprint}\` (${record.gist})`).join(", ");
    failures.push(
      `${label(answer)}: \`${withdrawn.rule.name}\` also holds ${fixes}; prepare the withdrawal with a \`body\` without this fix, or withdraw those fixes in the same call`,
    );
    return false;
  });
  const compactions = invocation.compactions.flatMap((answer): Compaction[] => {
    try {
      return [compaction(answer, context.branch, dirs.amendmentsDir, provenance)];
    } catch (error) {
      targetChanged ||= error instanceof TargetChangedError;
      failures.push(`compaction of \`${answer.skill}\`: ${(error as Error).message}`);
      return [];
    }
  });
  return {
    replays: answers.map(({ fix }) => fix?.replay),
    resolve: (verdicts, branch) => carryOut({ answers, stale: invocation.stale, compactions, failures, targetChanged }, verdicts, branch, context),
  };
}

/** A scheduled skill answer: an applied fix's rule, or the withdrawal it carries out as checked against the ledger and the fix's rule file. */
interface ScheduledAnswer {
  answer: ProposalAnswer;
  fingerprint: string;
  fix?: FixRule;
  withdrawn?: Withdrawal;
}

interface Schedule {
  answers: readonly ScheduledAnswer[];
  stale: readonly StaleAnswer[];
  compactions: readonly Compaction[];
  /** Answers refused before anything was written. */
  failures: readonly string[];
  targetChanged: boolean;
}

/**
 * Carries out `schedule` in its phases, after checking every approval it
 * holds against `branch` as it is now: an approval that no longer holds
 * writes and records nothing.
 */
function carryOut(schedule: Schedule, verdicts: readonly (Verdict | undefined)[], branch: readonly SessionEntry[], context: AmendmentContext): AmendmentResolution {
  const { dirs, referencesDir, latest, provenance, timestamp, sessionId } = context;
  const { answers, stale, compactions } = schedule;
  const resolution: AmendmentResolution = { records: [], publications: [], failures: [...schedule.failures], targetChanged: schedule.targetChanged, cleanup: [], deferred: [], approvals: [] };
  const { records, publications, failures, cleanup, deferred, approvals } = resolution;
  // Every Error returned here becomes a failure below.
  const approvedNow = (answer: ProposalAnswer | StaleAnswer | CompactionAnswer) => {
    try {
      return approvedChange(answer, branch);
    } catch (error) {
      resolution.targetChanged ||= error instanceof TargetChangedError;
      return error as Error;
    }
  };
  const approved = answers.map(({ answer }) => (answer.approval ? approvedNow(answer) : undefined));
  const staleApproved = stale.map((answer) => (answer.action === "keep" ? undefined : approvedNow(answer)));
  const compactionApproved = compactions.map(({ answer }) => (answer.outcome === "applied" ? approvedNow(answer) : undefined));

  // Skills whose on-read amendment a stale update or delete changed in this call: a body the pass drafted from the file before that answer would undo it.
  const staleChanged = new Set<string>();
  const withdrawalChanged = new Set<string>();
  // Stale answers go first, so this call's additions land on the body they leave, and an addition after a stale delete creates the amendment again.
  for (const [i, answer] of stale.entries()) {
    try {
      const approval = staleApproved[i];
      if (approval instanceof Error) throw approval;
      const { rule, kind, cleanupFailure } = settleStale(answer, approval?.change, dirs, referencesDir, provenance);
      if (cleanupFailure) cleanup.push(`stale \`${answer.rule}\` (delete): ${cleanupFailure}`);
      if (approval) approvals.push(approval.evidence);
      publications.push({ operation: `stale-${answer.action}`, skill: rule.amends, rule: rule.path, fingerprint: rule.fingerprint });
      records.push({
        fingerprint: rule.fingerprint,
        skill: rule.amends,
        kind,
        gist: rule.description,
        outcome: STALE_OUTCOMES[answer.action],
        rule: rule.path,
        timestamp,
        sessionId,
      });
      if (!isOnReadAmendment(rule) || answer.action === "keep") continue;
      staleChanged.add(rule.amends);
      if (answer.action !== "delete") continue;
      // The fixes inside go with the file, so an amendment created again under the same name doesn't bring them back.
      for (const fix of fixesInForce(latest, rule.name)) {
        if (fix.fingerprint === rule.fingerprint) continue;
        const { fingerprint, skill, kind: fixKind, gist } = fix;
        records.push({ fingerprint, skill, kind: fixKind, gist, outcome: "deleted", rule: rule.path, timestamp, sessionId });
      }
    } catch (error) {
      failures.push(`stale \`${answer.rule}\` (${answer.action}): ${(error as Error).message}`);
    }
  }

  // On-read fixes this call applied, which a compaction of their skill has to include.
  const additions: SkillLedgerRecord[] = [];
  // Withdrawals go before additions: a new body the pass drafted from the amendment on disk must not drop a section this call adds.
  const order = [...answers.keys()].sort((a, b) => Number(!answers[a]?.withdrawn) - Number(!answers[b]?.withdrawn));
  for (const i of order) {
    const { answer, fingerprint, fix, withdrawn } = answers[i]!;
    const verdict = verdicts[i];
    let outcome = answer.outcome;
    let rule: string | undefined;
    const approval = approved[i];
    // An approval that no longer holds writes and records nothing, not even the Later a failed replay records: the user may have retracted the answer.
    if (approval instanceof Error) {
      failures.push(`${label(answer)}: ${approval.message}`);
      continue;
    }
    if (verdict && verdict.verdict !== "passed") {
      // Nothing unchecked reaches disk: the answer comes back as a Later entry at a pass where the check passes.
      deferred.push(`${label(answer)}: ${describeVerdict(verdict)}`);
      outcome = "later";
    } else if (fix) {
      let written: boolean;
      try {
        ({ path: rule, written } = publishFix(fix));
        if (approval) approvals.push(approval.evidence);
      } catch (error) {
        failures.push(`${label(answer)}: ${(error as Error).message}`);
        continue;
      }
      // A section the amendment already held changed no file, so it is no publication.
      if (written) publications.push({ operation: fix.section ? "on-read-append" : "rule", skill: answer.skill, rule, fingerprint });
    } else if (withdrawn) {
      const { rule: file, body } = withdrawn;
      try {
        if (file && body?.trim() && staleChanged.has(file.amends)) {
          throw new Error(
            `a stale answer in this call updated or deleted \`${file.name}\` after this body was drafted; read the amendment again and send this withdrawal in a call of its own`,
          );
        }
        // An earlier withdrawal in this call may have deleted the amendment already.
        if (file && existsSync(file.path)) {
          if (body?.trim()) {
            const writeBody = () => rewriteRuleBody(file, body);
            if (withdrawn.references) replaceReferenceFiles(referencesDir, file.amends, withdrawn.references, writeBody);
            else writeBody();
          } else {
            const cleanupFailure = deleteRule(file, withdrawn.released === true, dirs, referencesDir);
            if (cleanupFailure) cleanup.push(`${label(answer)}: ${cleanupFailure}`);
          }
          publications.push({ operation: "withdrawal", skill: file.amends, rule: file.path, fingerprint });
        }
        if (file && isOnReadAmendment(file)) withdrawalChanged.add(file.amends);
        if (approval) approvals.push(approval.evidence);
      } catch (error) {
        failures.push(`${label(answer)}: ${(error as Error).message}`);
        continue;
      }
      rule = withdrawn.record.rule;
    }
    // A withdrawal is recorded as the fix it takes back was, so the ledger keeps one skill, kind and gist per fingerprint.
    const { skill, kind, gist } = withdrawn?.record ?? answer;
    const { evidence } = answer;
    const record: SkillLedgerRecord = {
      fingerprint,
      skill,
      kind,
      gist,
      outcome,
      ...(rule && { rule }),
      ...(evidence && evidence.length > 0 && { evidence }),
      timestamp,
      sessionId,
    };
    records.push(record);
    if (fix?.section && outcome === "applied") additions.push(record);
  }

  // Compactions go after this call's additions, which their prepared `includes` name by fingerprint. One that includes an addition not applied here would carry a fix the user rejected, and one that leaves out an addition applied here would drop it, so either writes nothing.
  for (const [i, { answer, skill, kind, fingerprint, gist }] of compactions.entries()) {
    const approval = compactionApproved[i];
    // As for any other answer, an approval that no longer holds writes and records nothing.
    if (approval instanceof Error) {
      failures.push(`compaction of \`${skill}\`: ${approval.message}`);
      continue;
    }
    const change = approval?.change.operation === "compaction" ? approval.change : undefined;
    let outcome = answer.outcome;
    let rule: string | undefined;
    const added = additions.filter((record) => record.skill === skill);
    const notApplied = (change?.includes ?? []).filter((included) => !added.some((record) => record.fingerprint === included));
    const leftOut = added.filter((record) => !change?.includes.includes(record.fingerprint));
    let reason: string | undefined;
    if (change) {
      if (staleChanged.has(skill)) reason = "a stale answer in this call updated or deleted the amendment it was drafted from";
      else if (withdrawalChanged.has(skill)) reason = "a withdrawal in this call changed the amendment it was drafted from";
      else if (notApplied.length > 0) reason = `it includes additions this call didn't apply (${notApplied.map((included) => `\`${included}\``).join(", ")})`;
      else if (leftOut.length > 0) reason = `it leaves out on-read fixes this call applied (${leftOut.map((record) => JSON.stringify(record.gist)).join(", ")})`;
    }
    if (reason) {
      deferred.push(`compaction of \`${skill}\`: ${reason}, so it wrote nothing`);
      outcome = "later";
    } else if (approval && change) {
      try {
        const amendment = skillAmendment(dirs.amendmentsDir, skill);
        if (amendment?.path !== change.target.path) throw new Error(`\`${skill}\` has no on-read amendment at \`${change.target.path}\` to compact`);
        replaceReferenceFiles(referencesDir, skill, change.references.write, () => rewriteRuleBody(amendment, change.body));
        rule = amendment.path;
        approvals.push(approval.evidence);
      } catch (error) {
        failures.push(`compaction of \`${skill}\`: ${(error as Error).message}`);
        continue;
      }
      publications.push({ operation: "compaction", skill, rule, fingerprint });
    }
    records.push({ fingerprint, skill, kind, gist, outcome, ...(rule && { rule }), compaction: true, timestamp, sessionId });
  }
  return resolution;
}

const label = (answer: ProposalAnswer) => `\`${answer.skill}\` (${answer.gist})`;

/** The approved withdrawal `change` as a {@link Withdrawal}, checked against the ledger and the fix's rule file as they are now. */
function preparedWithdrawal(
  answer: ProposalAnswer, change: WithdrawalChange,
  latest: ReadonlyMap<string, LedgerRecord>, dirs: RuleDirs, referencesDir: string,
): Withdrawal {
  const draft = change.effect === "rewrite" ? { body: change.body, ...(change.references && { references: change.references.write }) }
    : change.effect === "delete" ? { body: "" } : undefined;
  const taken = withdrawal(answer, draft, latest, dirs, referencesDir);
  if (taken.rule?.path !== (change.effect === "record" ? undefined : change.target.path)) {
    throw new Error("the fix's rule file appeared or moved since Prepare read it; prepare the withdrawal again and ask again");
  }
  return change.effect === "delete" && change.references ? { ...taken, released: true } : taken;
}

/**
 * The applied fix a `withdrawn` answer takes back: its latest ledger record,
 * the rule file to delete unless it is already gone, and for a fix inside the
 * skill's on-read amendment the amendment's new body, which deletes it when
 * blank, with the new set of reference files when they change.
 */
interface Withdrawal {
  record: SkillLedgerRecord;
  rule?: ObserverRule;
  body?: string;
  references?: ReferenceFile[];
  /** For a deletion of the skill's last on-read amendment, that its preview showed the reference folder deleted with it. */
  released?: true;
}

/** A withdrawn fix's new body for the skill's on-read amendment, as its withdrawal proposal drafts it. */
interface WithdrawalDraft {
  /** The amendment's whole new body without the fix; empty deletes the amendment. */
  body: string;
  /** Its complete new set of reference files, when they change. */
  references?: ReferenceFile[];
}

/**
 * Checks that a withdrawal of `answer`'s fix cites a fix in force for its
 * skill whose rule, if still on disk, is this extension's and either holds
 * only that fix or is the skill's on-read amendment, for which `draft` carries
 * the new body. Throws with the reason when it doesn't.
 */
export function withdrawal(
  answer: Pick<ProposalAnswer, "skill" | "fingerprint">, draft: WithdrawalDraft | undefined,
  latest: ReadonlyMap<string, LedgerRecord>, dirs: RuleDirs, referencesDir: string,
): Withdrawal {
  if (!answer.fingerprint) throw new Error("a `withdrawn` answer needs the `fingerprint` of the applied fix it takes back");
  const record = latest.get(answer.fingerprint);
  if (!record || record.kind === "project" || record.target !== undefined || !IN_FORCE_OUTCOMES.has(record.outcome)) {
    throw new Error(`the ledger holds no applied fix under fingerprint \`${answer.fingerprint}\``);
  }
  if (record.compaction) throw new Error(`fingerprint \`${answer.fingerprint}\` is a compaction, not a fix`);
  if (record.skill !== answer.skill) {
    throw new Error(`fingerprint \`${answer.fingerprint}\` is a fix for \`${record.skill}\`, not \`${answer.skill}\``);
  }
  const name = record.rule === undefined ? undefined : basename(record.rule, ".md");
  if (name === undefined || ruleFile(dirs, name) === undefined) return { record };
  const rule = readObserverRule(dirs, name);
  const body = draft?.body;
  const references = draft?.references;
  // Any write to the skill's own on-read amendment is allowed, whatever fingerprint it carries.
  const skillsAmendment = isOnReadAmendment(rule) && rule.amends === record.skill;
  if (references !== undefined) {
    if (!skillsAmendment || !body?.trim()) throw new Error("`references` come only with a new body for the skill's on-read amendment");
    checkReferenceFiles(references);
    checkPointers(referencesDir, rule.amends, body, references);
  }
  if (skillsAmendment && body !== undefined) return { record, rule, body, ...(references && { references }) };
  if (rule.fingerprint !== answer.fingerprint) {
    throw new Error(
      skillsAmendment
        ? `\`${rule.name}\` holds other fixes too; the withdrawal needs its \`body\`: the amendment's body without this fix, empty to delete it`
        : `rule \`${rule.name}\` holds another proposal's fix, so it was left untouched`,
    );
  }
  return { record, rule };
}

/**
 * The fixes in force whose rule is the one named `rule`: latest outcome
 * applied, kept or updated, and neither a compaction nor a stale answer about
 * a skill's on-read amendment, which that amendment's own fingerprint names.
 * A record names its rule by the file's basename, whichever directory the file
 * lived in then.
 */
function fixesInForce(latest: ReadonlyMap<string, LedgerRecord>, rule: string): SkillLedgerRecord[] {
  return [...latest.values()].filter(
    (record): record is SkillLedgerRecord =>
      record.kind !== "project" && record.target === undefined && IN_FORCE_OUTCOMES.has(record.outcome) &&
      !record.compaction &&
      record.fingerprint !== skillAmendmentFingerprint(record.skill) &&
      record.rule !== undefined &&
      basename(record.rule, ".md") === rule,
  );
}

/**
 * A compaction answer checked against the skill: its ledger record's identity,
 * taken from the amendment's body as it stood when the call began, before this
 * call's additions; for an applied one, its approved proposal's.
 */
interface Compaction {
  answer: CompactionAnswer;
  skill: string;
  kind: ProposalKind;
  fingerprint: string;
  gist: string;
}

/**
 * Checks a compaction answer: its skill is an upstream or plugin skill with at
 * most one on-read amendment, and an applied one carries the approval of its
 * prepared compaction, which holds in this pass, and no draft of its own.
 * Throws with the reason when it doesn't.
 */
function compaction(answer: CompactionAnswer, branch: readonly SessionEntry[], amendmentsDir: string, provenance: ProvenanceResolver): Compaction {
  if ("body" in answer || "includes" in answer || "references" in answer) {
    throw new Error("a compaction answer carries no `body`, `includes` or `references`: an applied one carries `approval`, and what it writes is what its approved proposal holds");
  }
  if (answer.approval !== undefined && answer.outcome !== "applied") throw new Error("`approval` comes only with an applied compaction");
  const skill = provenance.byName(answer.skill);
  if (!isPinKind(skill.kind)) {
    throw new Error(`\`${answer.skill}\` is not an upstream or plugin skill, so it has no on-read amendment to compact`);
  }
  const current = skillAmendment(amendmentsDir, skill.name);
  return {
    answer,
    skill: skill.name,
    kind: skill.kind,
    fingerprint: answer.outcome === "applied" ? approvedChange(answer, branch).evidence.fingerprint : compactionFingerprint(skill.name, current?.body ?? ""),
    gist: `Compact the on-read amendment of \`${skill.name}\`.`,
  };
}

/**
 * Re-pins a stale amendment rule, or rewrites or deletes it as `change`, the
 * alternative the user approved, prepared it, and returns the rule as it was,
 * with what it is pinned to. Deleting a skill's on-read amendment deletes its
 * reference files, and a failure to, once the rule is gone, comes back as
 * `cleanupFailure`; an update of it that carries reference files replaces them.
 */
function settleStale(
  answer: StaleAnswer,
  change: ApprovedChange | undefined,
  dirs: RuleDirs,
  referencesDir: string,
  provenance: ProvenanceResolver,
): { rule: ObserverRule; kind: PinKind; cleanupFailure?: string } {
  if ("body" in answer || "references" in answer || (answer.action === "keep" && answer.approval !== undefined)) {
    throw new Error("a stale answer carries no `body` or `references`: Keep only re-pins the amendment, leaving its body and reference files byte for byte, with no `approval`; an Update or Delete carries out the alternative its `approval` cites");
  }
  const rule = readObserverRule(dirs, answer.rule);
  if (!isPinned(rule)) {
    throw new Error(`\`${rule.name}\` is a barrier rule for a local or managed skill, so it never goes stale`);
  }
  const { kind: current } = provenance.byName(rule.amends);
  // shortcut: a skill that left the upstream and plugin kinds is recorded as upstream; read the ledger's kind if that ever matters.
  const kind: PinKind = isPinKind(current) ? current : "upstream";
  if (change?.operation === "stale-delete") {
    const cleanupFailure = deleteRule(rule, change.references !== undefined, dirs, referencesDir);
    return { rule, kind, ...(cleanupFailure && { cleanupFailure }) };
  }
  const body = change?.operation === "stale-update" ? change.body : undefined;
  const references = change?.operation === "stale-update" ? change.references : undefined;
  const writeBody = () => repinAmendmentRule(rule, provenance, body);
  if (references) replaceReferenceFiles(referencesDir, rule.amends, references.write, writeBody);
  else writeBody();
  return { rule, kind };
}

/**
 * Deletes `rule`. Deleting a skill's last on-read amendment deletes its
 * reference files too, which only a deletion whose preview showed that folder
 * (`released`) may do while it holds files. Returns why deleting them failed,
 * once the rule is gone.
 */
function deleteRule(rule: ObserverRule, released: boolean, dirs: RuleDirs, referencesDir: string): string | undefined {
  const releases = isOnReadAmendment(rule) &&
    !readOnReadAmendments(dirs.amendmentsDir).some((other) => other.amends === rule.amends && other.path !== rule.path);
  if (releases && !released && (readReferenceFiles(referencesDir, rule.amends).length > 0 || hasUnlistedReferenceEntries(referencesDir, rule.amends))) {
    throw new Error(`deleting \`${rule.name}\` now deletes the reference files of \`${rule.amends}\` too, which its preview didn't show; prepare it again and ask again`);
  }
  deleteObserverRule(rule);
  if (!releases) return undefined;
  try {
    replaceReferenceFiles(referencesDir, rule.amends, []);
    return undefined;
  } catch (error) {
    return `deleted \`${rule.path}\`, but deleting the reference files of \`${rule.amends}\` under \`${referencesDir}\` failed: ${(error as Error).message}`;
  }
}
