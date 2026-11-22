/**
 * `observer_resolve`: the observation pass's last call. It records the user's
 * answer to each proposal in the proposal ledger, writes the rule of each
 * applied answer from the prepared proposal the user approved (a section
 * appended to the skill's one on-read amendment or a pattern amendment, for an
 * upstream or plugin skill; a barrier rule for a local or managed one), takes
 * back each withdrawn fix, carries out each stale Update or Delete and writes
 * each applied compaction of an on-read amendment with its reference files,
 * all as their approved proposals prepared them, and re-pins each stale Keep.
 * A rule with a pattern is replayed first and written only when it passes.
 * What those changes do to rules, on-read amendments and their reference
 * files, and in what order, is `on-read-amendment-transitions.ts`'s.
 * Other edits to local and managed skills, and project files, are made by the
 * model with the normal tools; this tool only records them.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { isPinKind, type RuleDirs } from "./amendments.js";
import {
  ANSWER_OUTCOMES,
  type AnswerOutcome,
  type Evidence,
  type LedgerRecord,
  canonicalPathIn,
  canonicalProjectTarget,
  projectFingerprint,
  type ProjectTarget,
  type ProjectPublication,
  type ProjectLedgerRecord,
  type SkillLedgerRecord,
  type HarnessLedgerRecord,
  hookFileKey,
  canonicalMissingPath,
  normaliseText,
  removalFingerprint,
  type HarnessPublication,
  targetLabel,
  IN_FORCE_OUTCOMES,
  laterReoffer,
  PROPOSAL_KINDS,
  PROPOSAL_OUTCOMES,
  type ProposalOutcome,
  proposalFingerprint,
  putLedgerRecords,
  readLedgerDecision,
  STALE_ACTIONS,
  type StaleAction,
} from "./ledger.js";
import { ObserverCommitUnknownError, readObserverStore, writeObserverStore } from "./observer-store.js";
import type { ExtensionAPI, SessionEntry } from "./omp.js";
import { onReadAmendmentTransitions, type Publication, type ValidatedAnswer } from "./on-read-amendment-transitions.js";
import { createProvenanceResolver, defaultSkillRoots, type ProvenanceResolver } from "./provenance.js";
import { readReferenceFiles, referenceFilesSentence } from "./references.js";
import { replay } from "./replay.js";
import { type FixDraft, fixRule } from "./publication.js";
import { checkHarnessPublication, checkProjectPublication, checkSkillEditPublication, type SkillEditPublication } from "./project-publication.js";
import { type AnswerApproval, type ApprovalEvidence, approvalShape, approvedChange, type ApprovedChange, approvedDirectEdit, approvedHarness, laterNote, latestPrepared, observationPassStart, preparedInPass, type ProposalAnswerRef, TargetChangedError } from "./proposal-approval.js";
import { loadInstructionStage, type ToolResultCondition, whatToDoNow } from "./payload.js";
import { isProposalRef, overflowDeferral, type PreparedProposal, type PreparedProposalRef, proposalRefSchema } from "./review.js";
import { type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";

export const RESOLVE_TOOL_NAME = "observer_resolve";

const REOFFER_DESCRIPTION =
  "`later` only, ignored otherwise; never blank. For a `later` this pass records itself: which observation would change the decision, when it could arrive, and whether the deferred action is still possible. For the user's **Later**: only the user's own words.";

/** Where the tool writes; the extension entry resolves them from OMP's agent dir. */
export interface ObserverFiles {
  storeFile(): string;
  rulesDir(): string;
  amendmentsDir(): string;
  /** Holds one folder of reference files per skill, outside the rules directory. */
  referencesDir(): string;
}

export interface ProposalAnswer extends Pick<SkillLedgerRecord, "skill" | "kind" | "gist" | "reoffer"> {
  outcome: AnswerOutcome;
  fingerprint?: string;
  /** For an applied on-read fix, pattern amendment, barrier rule or direct edit, or a withdrawal: where the user's approval of its prepared proposal is saved on the branch, and for a fix, the reconciliation whose content is written instead, if any. */
  approval?: AnswerApproval;
  /** For an applied local, managed or new skill direct edit only: the call that made it after the user's Apply. */
  publication?: SkillEditPublication;
  evidence?: Evidence[];
}

/** A skill answer as the pass sends it: one that cites its prepared proposal, through `approval` or `proposal`, leaves out what that proposal holds. */
type CitingAnswer = Omit<ProposalAnswer, "skill" | "kind" | "gist"> & Partial<Pick<ProposalAnswer, "skill" | "kind" | "gist">> & { proposal?: PreparedProposalRef };

interface ProjectAnswer {
  kind: "project";
  target: ProjectTarget;
  gist: string;
  outcome: ProposalOutcome;
  fingerprint?: string;
  evidence?: Evidence[];
  reoffer?: string;
  publication?: ProjectPublication;
  rule?: never;
}
/**
 * The answer to an observer hook or companion proposal: a Later or Decline of
 * any stage cites the prepared proposal; an applied one cites the user's
 * Apply of its code stage and the receipts of its publication, or the Apply
 * of a hook removal, recorded once the file is gone.
 */
interface HarnessAnswer {
  kind: "harness";
  proposal?: PreparedProposalRef;
  approval?: ProposalAnswerRef;
  publication?: HarnessPublication;
  outcome: ProposalOutcome;
  reoffer?: string;
}
export interface StaleAnswer {
  rule: string;
  action: StaleAction;
  /** For `update` and `delete`: where the user's selection of that alternative of the stale proposal is saved on the branch. */
  approval?: ProposalAnswerRef;
}

/** The user's answer to a compaction of a skill's on-read amendment. */
export interface CompactionAnswer {
  skill: string;
  outcome: ProposalOutcome;
  /** For `applied`: where the user's approval of the prepared compaction is saved on the branch; its body, `includes` and reference files are what is written. */
  approval?: ProposalAnswerRef;
}

interface ResolveParams {
  outcomes: (CitingAnswer | ProjectAnswer | HarnessAnswer)[];
  compactions?: CompactionAnswer[];
  stale?: StaleAnswer[];
}

interface ResolveDetails {
  ledger: string;
  records: LedgerRecord[];
  /** Whether the transaction recorded each of `records`, in order. */
  recording: { rows: Recording[]; error?: string };
  /** Answers that wrote nothing, each with the reason. */
  failures: string[];
  /** Deletions carried out and recorded whose reference cleanup failed afterwards, each with what is left. */
  cleanup: string[];
  /** Applied answers recorded as `later` because their rule failed the replay check or it couldn't run, each with the reason. */
  deferred: string[];
  /** What each change carried out from a prepared proposal rests on: the user's approval, with the main agent's reconciliation kept apart from it. */
  approvals: ApprovalEvidence[];
  /** The rule, amendment and reference file changes the call made, in the order made. */
  publications: Publication[];
}

type Recording = "recorded" | "unrecorded" | "unknown";

/** What `fixRule` builds the rule from: an on-read append's section, or a rule's name, body, pattern, scope and samples. */
function fixDraft(change: ApprovedChange): FixDraft {
  if (change.operation === "on-read-append") return { body: change.section };
  if (change.operation !== "rule") throw new Error(`a ${change.operation} change writes no fix`);
  const { rule: { name, condition, scope }, body, matches, spares } = change;
  return { name, body, pattern: condition, scope, matches, spares };
}

function projectRecord(answer: ProjectAnswer, cwd: string, branch: SessionEntry[], timestamp: string, sessionId: string): ProjectLedgerRecord {
  const target = canonicalProjectTarget(cwd, answer.target);
  const fingerprint = projectFingerprint(target);
  if (answer.fingerprint !== undefined && answer.fingerprint !== fingerprint) throw new Error("project fingerprint does not match its scoped identity");
  if (!PROPOSAL_OUTCOMES.includes(answer.outcome) || typeof answer.gist !== "string" || !answer.gist.trim() ||
      answer.rule !== undefined || "skill" in answer) throw new Error("project answers need a gist and Apply/Later/Decline; they are not skill amendments");
  if (answer.outcome === "applied") checkProjectPublication(target, answer.publication, branch);
  return { kind: "project", target, fingerprint, gist: answer.gist, outcome: answer.outcome,
    ...(answer.evidence && { evidence: answer.evidence }), ...laterReoffer(answer),
    ...(answer.outcome === "applied" && { publication: answer.publication }), timestamp, sessionId };
}

interface HarnessRemoval { root: string; file: string }
interface PreparedRecord {
  record: LedgerRecord;
  publishedFiles?: string[];
  removal?: HarnessRemoval & { approval: ProposalAnswerRef };
}

/** A hook or companion answer keeps its prepared identity. An applied removal expands to all affected fixes at recording time. */
function harnessRecord(answer: HarnessAnswer, cwd: string, branch: readonly SessionEntry[], timestamp: string, sessionId: string): PreparedRecord {
  if (!PROPOSAL_OUTCOMES.includes(answer.outcome)) throw new Error("a harness answer is `applied`, `later` or `declined`");
  if (answer.outcome === "applied") {
    if (answer.approval === undefined || answer.proposal !== undefined) {
      throw new Error("an applied hook or companion change cites the user's Apply of its code stage or removal through `approval`; an intent Apply authorises drafting only: record it as `later` until its code is approved");
    }
    const { proposal, change, answeredAt } = approvedHarness(answer.approval, ["code", "removal"], branch);
    const identity = harnessIdentity(proposal);
    if (change.stage === "removal") {
      checkRemovedHook(change);
      return {
        record: { ...identity, outcome: "withdrawn", timestamp, sessionId },
        removal: { ...change, approval: answer.approval },
      };
    }
    checkHarnessPublication(change, answer.publication, cwd, branch, answeredAt);
    return {
      record: { ...identity, outcome: "applied", publication: answer.publication!, timestamp, sessionId },
      publishedFiles: change.files.map(({ path }) => join(change.root, path)),
    };
  }
  if (!isProposalRef(answer.proposal) || answer.approval !== undefined) {
    throw new Error("a Later or Decline of a hook or companion change cites its prepared proposal through `proposal`, its `reference` exactly as Prepare returned it");
  }
  const evidence = sessionToolEvidence(branch);
  const { proposal } = preparedInPass(answer.proposal, evidence, branch);
  requireLatestReference(answer.proposal, evidence);
  const note = answer.outcome === "later" && answer.reoffer === undefined ? laterNote(answer.proposal, evidence) : undefined;
  const reoffer = answer.reoffer ?? note;
  const drafted = "change" in proposal && proposal.change.operation === "harness" && proposal.change.stage === "code";
  return { record: {
    ...harnessIdentity(proposal), outcome: answer.outcome,
    ...laterReoffer({ outcome: answer.outcome, reoffer: drafted ? `A draft existed: its code was shown and answered Later; ask the intent again before drafting anew.${reoffer === undefined ? "" : ` ${reoffer}`}` : reoffer }),
    timestamp, sessionId,
  } };
}

function checkRemovedHook({ root, file }: HarnessRemoval): void {
  // A folder replaced by a symlink since Prepare would let another file's absence pass for this hook's.
  const path = relative(root, file);
  if (canonicalMissingPath(root) !== root) throw new Error(`\`${root}\` no longer resolves to the hooks directory where the user approved removing \`${file}\``);
  if (canonicalPathIn(root, path, `\`${file}\``) !== path) throw new Error(`\`${file}\` now resolves to another file in its hooks directory than the one the user approved removing`);
  if (existsSync(file)) throw new Error(`\`${file}\` is still there: after the user's Apply, delete it with your own tools, then record its removal; this tool deletes nothing`);
}

/** A removed hook withdraws every fix for its scoped file, or uses its own identity if it held none. */
function removalRecords(db: Database, record: HarnessLedgerRecord): HarnessLedgerRecord[] {
  const at = hookFileKey(record.target, record.fingerprint);
  if (at === undefined) return [record];
  const inForce = db.query<{ record: string }, [string]>(
    "SELECT record FROM proposals WHERE hook_file_key = ? ORDER BY answer_order",
  ).all(at).map(({ record }) => JSON.parse(record) as LedgerRecord).filter((candidate): candidate is HarnessLedgerRecord =>
    candidate.kind === "harness" && IN_FORCE_OUTCOMES.has(candidate.outcome) && hookFileKey(candidate.target, candidate.fingerprint) === at);
  return inForce.length > 0 ? inForce.map(({ target, fingerprint, gist }) => ({ ...record, target, fingerprint, gist })) : [record];
}

type HarnessIdentity = Pick<HarnessLedgerRecord, "kind" | "target" | "fingerprint" | "gist" | "evidence">;
function harnessIdentity(proposal: PreparedProposal): HarnessIdentity {
  if (proposal.kind !== "harness") throw new Error(`the cited proposal is a ${proposal.kind} proposal, not an observer hook or companion change`);
  return {
    kind: "harness", target: proposal.target, fingerprint: proposal.fingerprint, gist: proposal.gist,
    ...(proposal.evidence.length > 0 && { evidence: proposal.evidence.map(({ source: _, ...item }) => item) }),
  };
}

type FingerprintOwner = { fingerprint: string; skill: string; target?: never } | ProjectLedgerRecord | HarnessLedgerRecord;

function sameOwner(a: FingerprintOwner, b: FingerprintOwner): boolean {
  const left = a.target;
  const right = b.target;
  if (!left || !right) return !left && !right && a.skill === b.skill;
  if (left.scope === "project" && right.scope === "project") {
    return left.root === right.root && left.path === right.path && normaliseText(left.mechanism) === normaliseText(right.mechanism);
  }
  if (left.scope !== "harness" || right.scope !== "harness" || left.root !== right.root) return false;
  if (left.root === "project-hooks" && (right.root !== "project-hooks" || left.project !== right.project)) return false;
  const file = hookFileKey(left, a.fingerprint);
  if (file !== undefined && removalFingerprint(file) === a.fingerprint) {
    return file === hookFileKey(right, b.fingerprint);
  }
  return left.path === right.path && normaliseText(left.mechanism) === normaliseText(right.mechanism);
}

export function registerResolveTool(pi: ExtensionAPI, files: ObserverFiles): void {
  const z = pi.zod;
  pi.registerTool<ResolveParams, ResolveDetails>({
    name: RESOLVE_TOOL_NAME,
    label: "Observer Resolve",
    description:
      "Record observation-pass outcomes and carry out the approved rule and amendment changes. Cite the prepared proposal and native Ask approval for changes this tool makes. For direct edits already made through the owner tool, include the publication receipt.",
    parameters: z.object({
      outcomes: z
        .array(
          z.union([z.object({
            skill: z.string().optional().describe("Target skill name; for a new skill, its proposed name. Required unless the answer cites its prepared proposal."),
            kind: z.enum(PROPOSAL_KINDS).optional().describe("The target's provenance from the digest, or `new` for a new skill. Required unless the answer cites its prepared proposal."),
            gist: z.string().optional().describe("The proposal's general form in one sentence; an amendment rule's description. Required unless the answer cites its prepared proposal."),
            outcome: z
              .enum(ANSWER_OUTCOMES)
              .describe("The user's answer, or `withdrawn` to take back an earlier applied fix the user retracted or moved to another skill."),
            fingerprint: z
              .string()
              .optional()
              .describe(
                "The ledger fingerprint of a re-offered Later entry, or of the applied fix a `withdrawn` answer takes back; omit it for a new proposal or one the answer cites.",
              ),
            approval: z
              .object({
                ...approvalShape(z),
                revision: proposalRefSchema(z)
                  .optional()
                  .describe("When the user attached a note to Apply, or the amendment or rule file changed after Prepare: the `reference` of the reconciliation that cites this approval, exactly as Prepare returned it."),
              })
              .optional()
              .describe("Applied on-read fix, pattern amendment, barrier rule or direct edit, or withdrawal only, and required for one: where the user's approval of its prepared proposal is saved. The section, rule or withdrawal carried out is the prepared one, or for a fix its reconciliation's; skill, kind, gist, fingerprint and evidence are the prepared proposal's."),
            publication: z
              .object({ writeToolCallId: z.string() })
              .optional()
              .describe("Applied local, managed or new skill direct edit only, and required for one: the `observerToolCallId` of the successful call that made the approved edit after the user's Apply, the `edit` or `write` of a local skill's SKILL.md, or the `manage_skill` `update` of a managed skill or `create` of a new one. This tool writes no skill."),
            proposal: proposalRefSchema(z)
              .optional()
              .describe("Any other answer to a prepared on-read fix, rule or direct edit (Later, Decline, deferred by Select), or a Decline of a withdrawal: its `reference` from the pass's latest Prepare holding it, exactly as Prepare returned it. Skill, kind, gist, fingerprint and evidence are the prepared proposal's; a Later without `reoffer` takes the note the user attached to Later."),
            evidence: z
              .array(
                z.object({
                  quote: z.string().describe("The decisive words, quoted exactly from the signal or User note."),
                  count: z.number().describe("The quoted signal's `(×N)` count from the digest; 1 without one."),
                  occurrenceIds: z.array(z.string()).optional(),
                }),
              )
              .optional()
              .describe("What the proposal rests on, as cited in its question; a cited prepared proposal's evidence is recorded instead."),
            reoffer: z
              .string()
              .optional()
              .describe(REOFFER_DESCRIPTION),
          }),
          z.object({
            kind: z.enum(["project"]),
            target: z.object({
              scope: z.enum(["project"]),
              root: z.string().describe("Current working project root; symlink aliases are canonicalized."),
              path: z.string().describe("Root-relative file path, including safe missing leaves."),
              mechanism: z.string().describe("One mechanism; identity normalizes case, punctuation and whitespace."),
            }),
            gist: z.string(),
            outcome: z.enum(PROPOSAL_OUTCOMES),
            fingerprint: z.string().optional(),
            evidence: z.array(z.object({ quote: z.string(), count: z.number(), occurrenceIds: z.array(z.string()).optional() })).optional(),
            reoffer: z.string().optional().describe(REOFFER_DESCRIPTION),
            publication: z.object({
              writeToolCallId: z.string(),
              checkToolCallIds: z.array(z.string()),
              afterHash: z.string(),
            }).optional().describe("Applied only: actual successful normal write/edit and subsequent foreground bash check IDs from this session branch, and current target SHA-256. Checks use explicit project cwd. This tool does not write project files."),
          }),
          z.object({
            kind: z.enum(["harness"]),
            proposal: proposalRefSchema(z).optional().describe("`later` or `declined` only: the `reference` of the intent, code or removal proposal answered, from the pass's latest Prepare holding it, exactly as Prepare returned it."),
            approval: z.object(approvalShape(z)).optional().describe("`applied` only, and required for it: where the user's Apply of the code stage, or of a hook removal, is saved."),
            publication: z.object({
              writeToolCallIds: z.array(z.string()), checkToolCallIds: z.array(z.string()),
              files: z.array(z.object({ path: z.string().describe("Root-relative, as the code stage named it."), afterHash: z.string() })),
            }).optional().describe("`applied` code only: the successful normal write of each approved file, the foreground checks after them with the target root as `cwd`, and each file's SHA-256 now. This tool does not write the files."),
            outcome: z.enum(PROPOSAL_OUTCOMES).describe("One answer per hook or companion identity: `applied` when its approved code was written and checked, or its approved removal deleted the hook file (recorded as `withdrawn`); `declined` when either stage or the removal was declined; otherwise `later`."),
            reoffer: z.string().optional().describe(REOFFER_DESCRIPTION),
          })]),
        )
        .describe("One entry per proposal of this pass."),
      compactions: z
        .array(
          z.object({
            skill: z.string().describe("The upstream or plugin skill whose on-read amendment the compaction rewrites."),
            outcome: z.enum(PROPOSAL_OUTCOMES).describe("The user's answer."),
            approval: z
              .object(approvalShape(z))
              .optional()
              .describe("For `applied` only, and required for it: where the user's approval of the prepared compaction is saved. The body, covered on-read fixes and reference files written are the prepared ones."),
          }),
        )
        .optional()
        .describe("One entry per compaction asked about in this pass."),
      stale: z
        .array(
          z.object({
            rule: z.string().describe("The rule name from Stale amendments."),
            action: z.enum(STALE_ACTIONS),
            approval: z
              .object(approvalShape(z))
              .optional()
              .describe("For `update` and `delete` only, and required for them: where the user's selection of that option of the stale proposal's question is saved. The body, reference files and deletion carried out are the selected alternative's."),
          }),
        )
        .optional()
        .describe("One entry per answered stale amendment."),
    }),
    approval: "write",
    // Top-level so the pass calls it like `ask`. It joins the active tools at the session's first `/observe`, so sessions that never observe pay nothing for it.
    loadMode: "essential",
    defaultInactive: true,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const now = new Date();
      const timestamp = now.toISOString();
      const sessionId = ctx.sessionManager.getSessionId();
      const provenance = createProvenanceResolver(defaultSkillRoots(ctx.cwd));
      const dirs: RuleDirs = { rulesDir: files.rulesDir(), amendmentsDir: files.amendmentsDir() };
      const referencesDir = files.referencesDir();
      const ledger = files.storeFile();
      const records: LedgerRecord[] = [];
      const outsideAmendments: PreparedRecord[] = [];
      const failures: string[] = [];
      const external = new Map<LedgerRecord, readonly string[]>();
      const refusedPublications = new Map<LedgerRecord, string>();
      const refuseRecord = (record: LedgerRecord, reason: string) => {
        if (external.has(record)) refusedPublications.set(record, reason);
        else failures.push(reason);
      };
      const kept: string[] = [];
      let targetChanged = false;
      const label = (answer: CitingAnswer | ProjectAnswer | HarnessAnswer) => answer.kind === "project" ? `\`${answer.target?.path}\` (${answer.gist})`
        : answer.kind === "harness" || answer.gist === undefined ? `proposal \`${(answer.approval?.proposal ?? answer.proposal)?.candidateId}\`` : `\`${answer.skill}\` (${answer.gist})`;
      // Fail visibly on an unreadable or unmigrated store without making any internal publication.
      let openError: string | undefined;
      let storeExists = false;
      try {
        storeExists = readObserverStore(ledger, () => true) === true;
      } catch (error) {
        openError = error instanceof Error ? error.message : String(error);
      }
      const notAttempted = "not attempted because the observer store could not start recording";

      const validated = params.outcomes.flatMap((sent): ValidatedAnswer[] => {
        if (openError !== undefined && (sent.outcome !== "applied" ||
          (sent.kind !== "project" && sent.kind !== "harness" && sent.publication === undefined))) {
          failures.push(`${label(sent)}: ${notAttempted}`);
          return [];
        }
        if (sent.kind === "project") {
          try {
            const record = projectRecord(sent, ctx.cwd, ctx.sessionManager.getBranch(), timestamp, sessionId);
            outsideAmendments.push({ record });
            if (record.publication) external.set(record, [join(record.target.root, record.target.path)]);
          }
          catch (error) { failures.push(`${label(sent)}: ${(error as Error).message}`); }
          return [];
        }
        if (sent.kind === "harness") {
          try {
            const prepared = harnessRecord(sent, ctx.cwd, ctx.sessionManager.getBranch(), timestamp, sessionId);
            outsideAmendments.push(prepared);
            if (prepared.publishedFiles) external.set(prepared.record, prepared.publishedFiles);
          } catch (error) { failures.push(`${label(sent)}: ${(error as Error).message}`); }
          return [];
        }
        let shown: CitingAnswer = sent;
        try {
          const answer = citedAnswer(sent, ctx.sessionManager.getBranch());
          shown = answer;
          if ("target" in answer) {
            throw new Error("a project or harness identity cannot be submitted as a global skill answer");
          }
          const installed = sent.proposal === undefined && sent.approval === undefined && answer.kind !== "new" ? provenance.byName(answer.skill).kind : "unknown";
          if (installed !== "unknown" && installed !== answer.kind) {
            throw new Error(`\`${answer.skill}\` is installed as ${installed === "upstream" ? "an" : "a"} ${installed} skill, not ${answer.kind}: answer it as the ${installed} skill it is`);
          }
          const withdraws = answer.outcome === "withdrawn";
          laterReoffer(answer); // refuses a blank `reoffer` before anything is written
          if ((answer.outcome === "applied" || withdraws) && "rule" in answer) {
            throw new Error("an applied or withdrawn answer carries `approval`, not a `rule`: what it writes or takes back is what its approved proposal holds");
          }
          // An upstream or plugin fix is always a rule; a local, managed or new one is a barrier rule when it cites only the approval of its prepared rule, else an edit the model made.
          const isDirectEdit = answer.outcome === "applied" && !isPinKind(answer.kind) && (answer.approval === undefined || answer.publication !== undefined);
          if (openError !== undefined && !isDirectEdit) {
            failures.push(`${label(answer)}: ${notAttempted}`);
            return [];
          }
          const published = isDirectEdit ? checkDirectEdit(answer, provenance, ctx.cwd, ctx.sessionManager.getBranch()) : undefined;
          if (!isDirectEdit && answer.publication !== undefined) throw new Error("`publication` comes only with an applied local, managed or new skill direct edit");
          const writesRule = answer.outcome === "applied" && !isDirectEdit;
          if (answer.approval !== undefined && !writesRule && !withdraws && !isDirectEdit) {
            throw new Error("`approval` comes only with an applied on-read fix, pattern amendment, barrier rule or direct edit, or a withdrawal");
          }
          const approved = writesRule || withdraws ? approvedChange(answer, ctx.sessionManager.getBranch()) : undefined;
          const fingerprint = approved?.evidence.fingerprint ?? (answer.fingerprint || proposalFingerprint(answer.skill, answer.gist));
          const change = approved?.change;
          if (published !== undefined) {
            const { skill, kind, gist, outcome, evidence } = answer;
            const directEdit: SkillLedgerRecord = { skill, kind, gist, fingerprint, outcome, ...(evidence?.length && { evidence }), timestamp, sessionId };
            external.set(directEdit, [published]);
            return [{ answer, fingerprint, directEdit }];
          }
          const checked: ValidatedAnswer = change?.operation === "withdrawal" ? { answer, fingerprint, withdrawal: change }
            : { answer, fingerprint, fix: change && fixRule({ ...answer, rule: fixDraft(change) }, fingerprint, dirs, provenance) };
          return [checked];
        } catch (error) {
          targetChanged ||= error instanceof TargetChangedError;
          const message = (error as Error).message;
          // A cited proposal's own refusals already name it.
          failures.push(message.startsWith(`${label(shown)} `) ? message : `${label(shown)}: ${message}`);
          return [];
        }
      });
      const stale = openError === undefined ? params.stale ?? [] : [];
      const compactions = openError === undefined ? params.compactions ?? [] : [];
      const transitions = onReadAmendmentTransitions(
        { answers: validated, stale, compactions },
        { dirs, referencesDir, provenance, branch: ctx.sessionManager.getBranch(), timestamp, sessionId },
      );
      const verdicts = await Promise.all(transitions.replays.map((check) => (check ? replay(check, signal) : undefined)));
      // A cancelled call turns every replay into `unchecked`; nothing after this point waits, so stop before anything is written.
      signal?.throwIfAborted();
      // Do not initialize a fresh profile for retracted or invalid approvals.
      const branch = ctx.sessionManager.getBranch();
      const fresh = openError === undefined && !storeExists && !existsSync(ledger);
      let settled = fresh ? transitions.settle(verdicts, branch, true) : undefined;
      const hasAmendmentWork = settled
        ? settled.answers.length + settled.stale.length + settled.compactions.length > 0
        : validated.length + stale.length + compactions.length > 0;
      const recording: ResolveDetails["recording"] = { rows: [] };
      let status: Recording = "recorded";
      let started = false;
      if (openError !== undefined) {
        status = "unrecorded";
        recording.error = `Could not read the observer store: ${openError}`;
      } else if (outsideAmendments.length > 0 || hasAmendmentWork) {
        try {
          if (observationPassStart(branch) !== undefined) {
            const applies = params.outcomes.some(({ outcome }) => outcome === "applied" || outcome === "withdrawn")
              || stale.some(({ action }) => action !== "keep") || compactions.some(({ outcome }) => outcome === "applied");
            loadInstructionStage(applies ? "publish" : "record");
          }
          writeObserverStore(ledger, now, (db) => {
            // Recheck approval targets after taking the writer lock too: a process could change them while it is busy.
            const approved = transitions.settle(verdicts, branch);
            settled = approved;
            const decisions = new Map<string, LedgerRecord | undefined>();
            const byRule = new Map<string, LedgerRecord[]>();
            const latest = {
              get(fingerprint: string) {
                if (!decisions.has(fingerprint)) decisions.set(fingerprint, readLedgerDecision(db, fingerprint));
                return decisions.get(fingerprint);
              },
              forRule(name: string) {
                let current = byRule.get(name);
                if (!current) {
                  current = db.query<{ record: string }, [string]>(
                    "SELECT record FROM proposals WHERE rule_name = ? ORDER BY answer_order",
                  ).all(name).map(({ record }) => JSON.parse(record) as LedgerRecord);
                  byRule.set(name, current);
                }
                return current;
              },
            };
            const claimed = new Map<string, FingerprintOwner>();
            const inheritedEvidence = new Map<string, Evidence[]>();
            const claim = (owners: readonly FingerprintOwner[]): string | undefined => {
              for (const owner of owners) {
                const historical = latest.get(owner.fingerprint);
                const other = claimed.get(owner.fingerprint);
                if ((historical && !sameOwner(owner, historical)) || (other && !sameOwner(owner, other))) {
                  return owner.target === undefined && historical?.target !== undefined
                    ? "a project or harness identity cannot be submitted as a global skill answer"
                    : `proposal fingerprint \`${owner.fingerprint}\` belongs to another ${owner.target === undefined ? "skill" : "target"}`;
                }
              }
              for (const owner of owners) {
                claimed.set(owner.fingerprint, owner);
                const evidence = decisions.get(owner.fingerprint)?.evidence;
                if (evidence) inheritedEvidence.set(owner.fingerprint, evidence);
              }
            };
            const refuseAnswer = ({ answer, directEdit }: ValidatedAnswer, reason: string) => {
              const message = `${label(answer)}: ${reason}`;
              if (directEdit) refuseRecord(directEdit, message);
              else failures.push(message);
            };
            const eligible = new Set<ValidatedAnswer>();
            for (const entry of approved.answers) {
              const { answer, fingerprint, fix, directEdit } = entry;
              if (directEdit) {
                try {
                  approvedDirectEdit(answer.approval, branch);
                } catch (error) {
                  refuseAnswer(entry, (error as Error).message);
                  continue;
                }
              }
              const historical = latest.get(fingerprint);
              if (answer.outcome === "declined" && historical && sameOwner({ fingerprint, skill: answer.skill }, historical)
                  && IN_FORCE_OUTCOMES.has(historical.outcome)) {
                kept.push(`${label(answer)}, fingerprint \`${fingerprint}\``);
                continue;
              }
              const owners = [{ fingerprint, skill: answer.skill }];
              if (fix?.replaces) owners.push({ fingerprint: fix.replaces.fingerprint, skill: answer.skill });
              const refusal = claim(owners);
              if (refusal) refuseAnswer(entry, refusal);
              else eligible.add(entry);
            }
            const harnessAnswered = new Set<string>();
            for (const { record: first, removal } of outsideAmendments) {
              if (removal) {
                try {
                  approvedHarness(removal.approval, ["removal"], branch);
                  checkRemovedHook(removal);
                } catch (error) {
                  failures.push(`${targetLabel(first)}: ${(error as Error).message}`);
                  continue;
                }
              }
              const current = removal && first.kind === "harness" ? removalRecords(db, first) : [first];
              const repeated = current.find((record) => record.kind === "harness" && harnessAnswered.has(record.fingerprint));
              if (repeated) {
                refuseRecord(first, `${targetLabel(first)}: this call already answers \`${repeated.fingerprint}\`: send one answer per hook or companion identity`);
                continue;
              }
              const refusal = claim(current.includes(first) ? current : [first, ...current]);
              if (refusal) {
                refuseRecord(first, `${targetLabel(first)}: ${refusal}`);
                continue;
              }
              records.push(...current);
              for (const record of current) if (record.kind === "harness") harnessAnswered.add(record.fingerprint);
            }
            // Only filesystem effects and writes remain once all affected decisions have been read.
            const publish = approved.prepare(eligible, latest, claim);
            started = true;
            try {
              publish();
            } finally {
              records.push(...approved.result.records);
            }
            for (const record of records) {
              const carried = record.evidence ? undefined : inheritedEvidence.get(record.fingerprint);
              if (carried) record.evidence = carried;
            }
            if (records.length > 0) putLedgerRecords(db, records);
          });
        } catch (error) {
          status = error instanceof ObserverCommitUnknownError ? "unknown" : "unrecorded";
          recording.error = error instanceof Error ? error.message : String(error);
        }
      }
      const approved = settled ?? transitions.settle(verdicts, branch);
      const { publications: internal, cleanup, deferred, approvals } = approved.result;
      if (recording.error !== undefined && !started) {
        records.length = 0;
        for (const record of external.keys()) if (!refusedPublications.has(record)) records.push(record);
        for (const { rule, action } of params.stale ?? []) failures.push(`stale \`${rule}\` (${action}): ${notAttempted}`);
        for (const { skill } of params.compactions ?? []) failures.push(`compaction of \`${skill}\`: ${notAttempted}`);
        for (const { record } of outsideAmendments) {
          if (!external.has(record) && openError === undefined) records.push(record);
        }
        for (const { answer, directEdit } of approved.answers) {
          if (directEdit === undefined) failures.push(`${label(answer)}: ${notAttempted}`);
        }
      }
      if (external.size > 0) {
        const attempted = new Set(records);
        for (const record of external.keys()) {
          if (!attempted.has(record) && !refusedPublications.has(record)) {
            refusedPublications.set(record, recording.error ?? "the outcome was not accepted for recording");
          }
        }
      }
      failures.push(...approved.result.failures);
      targetChanged ||= approved.result.targetChanged;
      recording.rows = records.map(() => status);
      const line = (record: LedgerRecord, rule = record.rule) => {
        const written = record.kind !== "project" && record.compaction && rule ? readReferenceFiles(referencesDir, record.skill) : [];
        return (
          `- ${record.outcome} ${targetLabel(record)}, fingerprint \`${record.fingerprint}\`: ${record.gist}` +
          (rule ? ` Rule file: \`${rule}\`.` : "") +
          referenceFilesSentence(written)
        );
      };
      const publicationLine = (record: LedgerRecord) => {
        const paths = external.get(record);
        if (!paths) return line(record, record.kind === "project" || record.kind === "harness" ? undefined : internal.get(record)?.rule);
        const receipt = record.kind === "project" || record.kind === "harness"
          ? `Published files: ${paths.map((path) => `\`${path}\``).join(", ")}`
          : `Publication: \`${paths[0]}\``;
        return `${line(record)} ${receipt}.`;
      };
      const recorded = status === "recorded" ? records.map((record) => line(record)) : [];
      const text = [`Recorded ${recorded.length} outcome(s) in \`${ledger}\`:`, ...recorded];
      const unsettled = recording.error !== undefined;
      if (unsettled) {
        text.push(
          "",
          `Recording in the proposal ledger failed: ${recording.error}. No publication was undone. Don't call \`observer_resolve\` again for the outcomes below or redo their changes.`,
        );
        if (!started) text.push("Resolve stopped before making any rule or amendment changes.");
        if (status === "unknown") {
          text.push(`Recording unknown, ${records.length} outcome(s). Inspect the ledger to determine whether the batch committed:`, ...records.map(publicationLine));
        } else {
          const unrecorded: string[] = [];
          const noPublication: string[] = [];
          for (const record of records) {
            if (external.has(record) || (record.kind !== "project" && record.kind !== "harness" && internal.has(record))) {
              unrecorded.push(publicationLine(record));
            } else {
              noPublication.push(line(record));
            }
          }
          if (unrecorded.length > 0) {
            text.push(`Carried out, not in the ledger, ${unrecorded.length} outcome(s). Report each as an Unrecorded publication with its target and this error:`, ...unrecorded);
          }
          if (noPublication.length > 0) {
            text.push(`Wrote nothing, not in the ledger, ${noPublication.length} outcome(s). These are record-only answers, no-ops or records generated by another outcome:`, ...noPublication);
          }
        }
      }
      if (refusedPublications.size > 0) {
        text.push("", "Unrecorded publications refused by the proposal ledger. Don't call `observer_resolve` again for these outcomes or redo their changes:");
        for (const [record, reason] of refusedPublications) text.push(`${publicationLine(record)} ${reason}.`);
      }
      if (approvals.length > 0) {
        text.push("", "The rule and reference changes carried out from prepared proposals rest on:");
        text.push(...approvals.map(({ fingerprint, approval: { proposal, selectionToolCallId, askToolCallId }, selected, note, reconciliation }) =>
          `- \`${fingerprint}\`: the user selected ${selected}${note === undefined ? "" : ` with the note ${JSON.stringify(note)}`} in Ask \`${askToolCallId}\` for proposal \`${proposal.candidateId}\` of review \`${proposal.reviewToolCallId}\`, selected by \`${selectionToolCallId}\`` +
          (reconciliation
            ? `; the content written was reconciled by the main agent in revision \`${reconciliation.revision.candidateId}\` of review \`${reconciliation.revision.reviewToolCallId}\`, not approved by the user.` +
              `${reconciliation.changedTarget === undefined ? "" : ` Changed target: ${reconciliation.changedTarget}`} Reason: ${reconciliation.reason} Preserved: ${reconciliation.preserved}`
            : "") +
          (note !== undefined && reconciliation ? `\n  Written under the note:\n\n${reconciliation.preview}\n` : "")));
      }
      if (deferred.length > 0) {
        text.push(
          "",
          `Deferred as \`later\` without writing their rule, ${deferred.length} answer(s); report each in the summary with its reason, and don't redraft it in this pass:`,
        );
        text.push(...deferred.map((reason) => `- ${reason}`));
      }
      if (kept.length > 0) {
        text.push("", `Recorded nothing for ${kept.length} Decline(s) of a fix in force. Each fix stays in force: report that, and don't call again for it:`);
        text.push(...kept.map((answer) => `- ${answer}`));
      }
      if (cleanup.length > 0) {
        text.push("", `Carried out as listed, but cleaning up after them failed, ${cleanup.length} deletion(s): don't call \`observer_resolve\` again for them; inspect what is left and report it to the user with the error:`);
        text.push(...cleanup.map((failure) => `- ${failure}`));
      }
      if (failures.length > 0) {
        text.push("", unsettled ? `Other refusals, ${failures.length} answer(s):` : `Not recorded, ${failures.length} answer(s); fix each and call again with only these:`);
        text.push(...failures.map((failure) => `- ${failure}`));
      }
      const guidance: ToolResultCondition[] = [];
      if (unsettled) guidance.push("ledger-recording-failed");
      if (cleanup.length > 0) guidance.push("cleanup-failed");
      if (targetChanged && !unsettled) guidance.push("changed-target");
      if (guidance.length > 0) text.push("", whatToDoNow(guidance));
      return {
        content: [{ type: "text", text: text.join("\n") }],
        details: { ledger, records, recording, failures: [...failures, ...refusedPublications.values()], cleanup, deferred, approvals, publications: [...internal.values()] },
        isError: failures.length > 0 || refusedPublications.size > 0 || cleanup.length > 0 || unsettled,
      };
    },
  });
}

/**
 * Throws unless the applied local, managed or new skill edit `answer` cites
 * the user's Apply of its prepared direct edit and the observed owner-tool
 * call that made the edit after that Apply: the main agent makes the edit, so
 * the ledger records it applied only once the branch shows it was made.
 */
function checkDirectEdit(answer: ProposalAnswer, provenance: ProvenanceResolver, cwd: string, branch: readonly SessionEntry[]): string {
  if (answer.approval === undefined) {
    throw new Error("an applied local, managed or new skill edit cites the user's Apply of its prepared proposal through `approval` and the call that made the edit through `publication`");
  }
  const { proposal, answeredAt } = approvedDirectEdit(answer.approval, branch);
  const isThisAnswer = proposal.skill === answer.skill && proposal.kind === answer.kind && proposal.gist === answer.gist &&
    (answer.fingerprint === undefined || answer.fingerprint === proposal.fingerprint);
  if (!isThisAnswer) throw new Error(`the approved proposal is \`${proposal.skill}\` (${proposal.kind}) "${proposal.gist}" under fingerprint \`${proposal.fingerprint}\`, not this answer`);
  const installed = provenance.byName(proposal.skill);
  const path = installed.kind === "local" ? installed.path : undefined;
  checkSkillEditPublication({ name: proposal.skill, kind: proposal.kind, ...(path !== undefined && { path }) }, answer.publication, cwd, branch, answeredAt);
  return installed.kind === "unknown" ? `tool receipt ${answer.publication!.writeToolCallId}` : installed.path;
}

/** Operations whose proposal a skill answer cites through `proposal`. A withdrawal is answered through its approval, and only its Decline cites it through `proposal`; a stale amendment and a compaction are answered in their own lists. */
const CITABLE = ["on-read-append", "rule", "direct-edit"];

/**
 * `answer` filled from the prepared proposal it cites. The proposal's evidence
 * takes precedence over evidence the answer carries. Supplied values must
 * equal the proposal's: the approval check compares an approved answer's,
 * this function every other answer's.
 */
function citedAnswer(answer: CitingAnswer, branch: readonly SessionEntry[]): ProposalAnswer {
  const { proposal: reference, skill, kind, gist, ...rest } = answer;
  if (reference !== undefined && answer.approval !== undefined) {
    throw new Error("an answer cites its proposal once: an approved one through `approval`, any other through `proposal`");
  }
  const cited = answer.approval?.proposal ?? reference;
  if (cited === undefined) {
    if (![skill, kind, gist].every((value) => typeof value === "string" && value.trim())) {
      throw new Error("an answer citing no prepared proposal needs its `skill`, `kind` and `gist`");
    }
    return { ...rest, skill: skill!, kind: kind!, gist: gist! };
  }
  if (!isProposalRef(cited)) throw new Error("a cited proposal is its `reference`, exactly as Prepare returned it");
  const evidence = sessionToolEvidence(branch);
  const { proposal } = preparedInPass(cited, evidence, branch);
  if (proposal.kind === "project" || proposal.kind === "harness") throw new Error(`the cited proposal is a ${proposal.kind} proposal, answered as a ${proposal.kind} outcome`);
  const operation = "change" in proposal ? proposal.change.operation : "stale amendment";
  const citable = CITABLE.includes(operation) || (operation === "withdrawal" && answer.outcome === "declined");
  if (reference !== undefined && !citable) throw new Error(`the cited proposal is a ${operation}, which \`proposal\` does not answer`);
  if (reference !== undefined) requireLatestReference(cited, evidence);
  const filled = { skill: skill ?? proposal.skill, kind: kind ?? proposal.kind, gist: gist ?? proposal.gist, fingerprint: answer.fingerprint ?? proposal.fingerprint };
  const isThisAnswer = filled.skill === proposal.skill && filled.kind === proposal.kind && filled.gist === proposal.gist && filled.fingerprint === proposal.fingerprint;
  if (reference !== undefined && !isThisAnswer) {
    throw new Error(`the cited proposal is \`${proposal.skill}\` (${proposal.kind}) "${proposal.gist}" under fingerprint \`${proposal.fingerprint}\`, not this answer`);
  }
  const quoted = proposal.evidence.length > 0 ? proposal.evidence.map(({ source: _, ...item }) => item) : answer.evidence;
  const deferral = reference !== undefined && answer.outcome !== "applied" ? overflowDeferral(reference, evidence) : undefined;
  if (deferral && answer.outcome !== "later") throw new Error("a proposal deferred past the Ask cap was not answered; record it as Later, not Decline");
  const reoffer = deferral
    ? (answer.reoffer && answer.reoffer !== deferral ? `${deferral} ${answer.reoffer}` : deferral)
    : (reference !== undefined && answer.outcome === "later" && answer.reoffer === undefined ? laterNote(reference, evidence) : undefined);
  return { ...rest, ...filled, ...(quoted && { evidence: quoted }), ...(reoffer !== undefined && { reoffer }) };
}

/** Throws unless `ref` is the reference the branch's last Prepare holding its candidate returned. */
function requireLatestReference(ref: PreparedProposalRef, evidence: SessionToolEvidence): void {
  const newer = latestPrepared(ref.candidateId, evidence);
  if (newer !== undefined && newer.reviewToolCallId !== ref.reviewToolCallId) {
    throw new Error(`a later Prepare of this pass holds this proposal again: cite its reference ${JSON.stringify(newer)}`);
  }
}
