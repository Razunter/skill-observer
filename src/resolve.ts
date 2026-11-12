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

import { isPinKind, type RuleDirs } from "./amendments.js";
import {
  ANSWER_OUTCOMES,
  type AnswerOutcome,
  appendLedger,
  type LedgerAppend,
  type Recording,
  type Evidence,
  type LedgerRecord,
  canonicalProjectTarget,
  projectFingerprint,
  type ProjectTarget,
  type ProjectPublication,
  type ProjectLedgerRecord,
  type SkillLedgerRecord,
  laterReoffer,
  PROPOSAL_KINDS,
  PROPOSAL_OUTCOMES,
  type ProposalOutcome,
  proposalFingerprint,
  readLedger,
  STALE_ACTIONS,
  type StaleAction,
} from "./ledger.js";
import type { ExtensionAPI, SessionEntry } from "./omp.js";
import { onReadAmendmentTransitions, type Publication, type ValidatedAnswer } from "./on-read-amendment-transitions.js";
import { createProvenanceResolver, defaultSkillRoots } from "./provenance.js";
import { readReferenceFiles, referenceFilesSentence } from "./references.js";
import { replay } from "./replay.js";
import { type FixDraft, fixRule } from "./publication.js";
import { checkProjectPublication } from "./project-publication.js";
import { type AnswerApproval, type ApprovalEvidence, approvalShape, approvedChange, type ApprovedChange, preparedInPass, type ProposalAnswerRef, TargetChangedError } from "./proposal-approval.js";
import { type ToolResultCondition, whatToDoNow } from "./payload.js";
import { isProposalRef, type PreparedProposalRef, proposalRefSchema } from "./review.js";
import { sessionToolEvidence } from "./session-tool-evidence.js";

export const RESOLVE_TOOL_NAME = "observer_resolve";

const REOFFER_DESCRIPTION =
  "`later` only, ignored otherwise; never blank. For a `later` this pass records itself: which observation would change the decision, when it could arrive, and whether the deferred action is still possible. For the user's **Later**: only the user's own words.";

/** Where the tool writes; the extension entry resolves them from OMP's agent dir. */
export interface ObserverFiles {
  ledgerFile(): string;
  rulesDir(): string;
  amendmentsDir(): string;
  /** Holds one folder of reference files per skill, outside the rules directory. */
  referencesDir(): string;
}

export interface ProposalAnswer extends Pick<SkillLedgerRecord, "skill" | "kind" | "gist" | "reoffer"> {
  outcome: AnswerOutcome;
  fingerprint?: string;
  /** For an applied on-read fix, pattern amendment or barrier rule, or a withdrawal: where the user's approval of its prepared proposal is saved on the branch, and for a fix, the reconciliation whose content is written instead, if any. */
  approval?: AnswerApproval;
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
  outcomes: (CitingAnswer | ProjectAnswer)[];
  compactions?: CompactionAnswer[];
  stale?: StaleAnswer[];
}

interface ResolveDetails {
  ledger: string;
  records: LedgerRecord[];
  /** Whether each of `records` reached the ledger, in order, and why the append failed, if it did. */
  recording: LedgerAppend;
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

export function registerResolveTool(pi: ExtensionAPI, files: ObserverFiles): void {
  const z = pi.zod;
  pi.registerTool<ResolveParams, ResolveDetails>({
    name: RESOLVE_TOOL_NAME,
    label: "Observer Resolve",
    description:
      "Record the user's answers to an `/observe` pass in the proposal ledger, which later passes read to skip declined proposals and re-offer deferred ones. A skill outcome that cites its prepared proposal, through `approval` or `proposal`, is recorded under that proposal's skill, kind, gist, fingerprint and evidence. An applied upstream or plugin fix is written here: an on-read fix as a section appended to the skill's one on-read amendment, `<skill>-amendment`, created with that section when the skill has none; a pattern amendment as its own rule. An applied barrier for a local or managed skill is written as its barrier rule. An applied on-read fix, pattern amendment or barrier rule, a `withdrawn` answer, a stale `update` or `delete` and an applied compaction carry `approval`: the section, rule, body, reference files or deletion is the one its prepared proposal holds (for a stale answer, the alternative of the selected option), carried out only when this observation pass holds that proposal's Prepare, its Select and a native `ask` called with that Select's `askHtml` unchanged, in which the user explicitly chose the proposal's Apply option (for a stale amendment, Update or Delete) before any timeout, custom input approving nothing, and only while the amendment or rule file and its reference files hold the bytes Prepare read, a re-pin aside for a stale answer, withdrawal or compaction; when the user attached a note to an on-read fix's or rule's Apply, or its target changed, `revision` cites a reconciliation prepared through observer_review, whose content is written while the target holds the bytes that reconciliation read, and a noted or changed stale answer, withdrawal or compaction is prepared and asked again. Otherwise it writes and records nothing. A rule with a pattern is replayed as `observer_check` does and written only when it passes, else recorded as `later`; the approval is checked again after the replay, right before the write. A `withdrawn` answer takes back an earlier applied fix: it deletes the rule file the fix wrote, or, for a fix inside the skill's on-read amendment, rewrites the amendment with the body its withdrawal proposal prepared; a fix moved to another skill is a `withdrawn` answer plus an `applied` one. An applied compaction rewrites the skill's on-read amendment with its prepared body and replaces its reference files with its prepared set, after this call's additions, only when its prepared `includes` names every on-read fix this call applied for the skill and only fixes this call applied, and no stale update or delete or withdrawal in this call changed the amendment; otherwise it is recorded as `later`. Stale answers are carried out before every other answer: Keep re-pins its rule without an approval, leaving its body and reference files byte for byte, and Update and Delete rewrite or delete it, and deleting a skill's on-read amendment takes its fixes out of force and deletes its reference files. Returns the records and rule files written, what each change carried out from a prepared proposal rests on (a note and the text written under it included), the answers held back as `later`, and any answer that wrote nothing.",
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
              .describe("Applied on-read fix, pattern amendment or barrier rule, or withdrawal only, and required for one: where the user's approval of its prepared proposal is saved. The section, rule or withdrawal carried out is the prepared one, or for a fix its reconciliation's; skill, kind, gist, fingerprint and evidence are the prepared proposal's."),
            proposal: proposalRefSchema(z)
              .optional()
              .describe("Any other answer to a prepared on-read fix, rule or direct edit (Later, Decline, deferred by Select, applied direct edit): its `reference`, exactly as Prepare returned it. Skill, kind, gist, fingerprint and evidence are the prepared proposal's."),
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
      const timestamp = new Date().toISOString();
      const sessionId = ctx.sessionManager.getSessionId();
      const provenance = createProvenanceResolver(defaultSkillRoots(ctx.cwd));
      const dirs: RuleDirs = { rulesDir: files.rulesDir(), amendmentsDir: files.amendmentsDir() };
      const referencesDir = files.referencesDir();
      const ledger = files.ledgerFile();
      const records: LedgerRecord[] = [];
      const failures: string[] = [];
      let targetChanged = false;
      const label = (answer: CitingAnswer | ProjectAnswer) => answer.kind === "project" ? `\`${answer.target?.path}\` (${answer.gist})`
        : answer.gist === undefined ? `proposal \`${(answer.approval?.proposal ?? answer.proposal)?.candidateId}\`` : `\`${answer.skill}\` (${answer.gist})`;
      // The latest record per fingerprint wins: it holds the fix a withdrawal takes back, and the evidence an answer citing nothing keeps.
      const latest = new Map(readLedger(ledger).map((record) => [record.fingerprint, record]));

      // Fingerprint ownership binds across this call too: a later answer must not overwrite an earlier one's skill.
      const claimed = new Map<string, string>();
      const validated = params.outcomes.flatMap((sent): ValidatedAnswer[] => {
        if (sent.kind === "project") {
          try { records.push(projectRecord(sent, ctx.cwd, ctx.sessionManager.getBranch(), timestamp, sessionId)); }
          catch (error) { failures.push(`${label(sent)}: ${(error as Error).message}`); }
          return [];
        }
        let shown: CitingAnswer = sent;
        try {
          const answer = citedAnswer(sent, ctx.sessionManager.getBranch());
          shown = answer;
          if ("target" in answer || "publication" in answer || latest.get(answer.fingerprint ?? "")?.kind === "project") {
            throw new Error("project identity cannot be submitted as a global skill answer");
          }
          const withdraws = answer.outcome === "withdrawn";
          laterReoffer(answer); // refuses a blank `reoffer` before anything is written
          if ((answer.outcome === "applied" || withdraws) && "rule" in answer) {
            throw new Error("an applied or withdrawn answer carries `approval`, not a `rule`: what it writes or takes back is what its approved proposal holds");
          }
          // An upstream or plugin fix is always a rule; a local or managed one is a barrier rule when it cites the approval of its prepared rule, else an edit the model made.
          const writesRule = answer.outcome === "applied" && (isPinKind(answer.kind) || answer.approval !== undefined);
          if (answer.approval !== undefined && !writesRule && !withdraws) {
            throw new Error("`approval` comes only with an applied on-read fix, pattern amendment or barrier rule, or a withdrawal");
          }
          const approved = writesRule || withdraws ? approvedChange(answer, ctx.sessionManager.getBranch()) : undefined;
          const fingerprint = approved?.evidence.fingerprint ?? (answer.fingerprint || proposalFingerprint(answer.skill, answer.gist));
          const historical = latest.get(fingerprint);
          const historicalOwner = historical?.kind === "project" ? undefined : historical?.skill ?? answer.skill;
          const owner = claimed.get(fingerprint) ?? historicalOwner;
          if (owner !== answer.skill) throw new Error("proposal fingerprint belongs to another skill");
          const change = approved?.change;
          const checked = change?.operation === "withdrawal"
            ? { answer, fingerprint, withdrawal: change }
            : { answer, fingerprint, fix: change && fixRule({ ...answer, rule: fixDraft(change) }, fingerprint, dirs, provenance) };
          claimed.set(fingerprint, answer.skill);
          return [checked];
        } catch (error) {
          targetChanged ||= error instanceof TargetChangedError;
          failures.push(`${label(shown)}: ${(error as Error).message}`);
          return [];
        }
      });
      const transitions = onReadAmendmentTransitions(
        { answers: validated, stale: params.stale ?? [], compactions: params.compactions ?? [] },
        { dirs, referencesDir, latest, provenance, branch: ctx.sessionManager.getBranch(), timestamp, sessionId },
      );
      const verdicts = await Promise.all(transitions.replays.map((check) => (check ? replay(check, signal) : undefined)));
      // A cancelled call turns every replay into `unchecked`; nothing after this point waits, so stop before anything is written.
      signal?.throwIfAborted();
      // Approvals are checked again from the branch and the targets as they are now, with nothing awaited before the writes: during the replay wait the user may have spoken, the pass ended or a target changed. Any later change to a target is this call's own composition.
      const resolution = transitions.resolve(verdicts, ctx.sessionManager.getBranch());
      const { records: carriedOut, publications, failures: refused, cleanup, deferred, approvals } = resolution;
      records.push(...carriedOut);
      failures.push(...refused);
      targetChanged ||= resolution.targetChanged;

      for (const record of records) {
        const carried = record.evidence ? undefined : latest.get(record.fingerprint)?.evidence;
        if (carried) record.evidence = carried;
      }
      // A failed append leaves every change above made: the result keeps them and says which records reached the ledger.
      const recording: LedgerAppend = records.length > 0 ? appendLedger(ledger, records) : { rows: [] };
      const line = (record: LedgerRecord) => {
        const written = record.kind !== "project" && record.compaction && record.rule ? readReferenceFiles(referencesDir, record.skill) : [];
        return (
          `- ${record.outcome} \`${record.kind === "project" ? record.target.path : record.skill}\` (${record.kind}), fingerprint \`${record.fingerprint}\`: ${record.gist}` +
          (record.rule ? ` Rule file: \`${record.rule}\`.` : "") +
          referenceFilesSentence(written)
        );
      };
      const withStatus = (status: Recording) => records.filter((_, i) => recording.rows[i] === status);
      // A Later or Decline, answered or deferred by the replay or coverage check, wrote nothing, so it is no Unrecorded publication.
      const wroteNothing = (record: LedgerRecord) => record.outcome === "later" || record.outcome === "declined";
      const recorded = withStatus("recorded").map(line);
      const unrecorded = withStatus("unrecorded").filter((record) => !wroteNothing(record)).map(line);
      const unrecordedNoWrite = withStatus("unrecorded").filter(wroteNothing).map(line);
      const unknown = withStatus("unknown").map(line);
      // An append can fail after writing every record; the ledger's bytes, not the error, decide what is reported.
      const unsettled = unrecorded.length + unrecordedNoWrite.length + unknown.length > 0;
      const text = [`Recorded ${recorded.length} outcome(s) in \`${ledger}\`:`, ...recorded];
      if (unsettled) {
        text.push(
          "",
          `Appending to the proposal ledger failed: ${recording.error}. Nothing this call wrote, deleted or re-pinned was undone. Don't call \`observer_resolve\` again for the outcomes below or redo their changes; the user repairs the ledger.`,
        );
        if (unrecorded.length > 0) {
          text.push(`Carried out, not in the ledger, ${unrecorded.length} outcome(s): what each wrote, deleted or re-pinned stays, and none is \`later\`; report each that changed a file as an Unrecorded publication, with its file and this error:`, ...unrecorded);
        }
        if (unrecordedNoWrite.length > 0) {
          text.push(`Wrote nothing, not in the ledger, ${unrecordedNoWrite.length} outcome(s): each keeps the outcome listed, unrecorded; report it as that outcome with this error, not as a publication:`, ...unrecordedNoWrite);
        }
        if (unknown.length > 0) {
          text.push(`Recording unknown, ${unknown.length} outcome(s): the ledger read back after the failure can't show whether these reached it; inspect it before anything else:`, ...unknown);
        }
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
      if (cleanup.length > 0) {
        text.push("", `Carried out as listed, but cleaning up after them failed, ${cleanup.length} deletion(s): don't call \`observer_resolve\` again for them; inspect what is left and report it to the user with the error:`);
        text.push(...cleanup.map((failure) => `- ${failure}`));
      }
      if (failures.length > 0) {
        text.push("", `Not recorded, ${failures.length} answer(s); fix each and call again with only these:`);
        text.push(...failures.map((failure) => `- ${failure}`));
      }
      const guidance: ToolResultCondition[] = [];
      if (unsettled) guidance.push("ledger-append-failed");
      if (cleanup.length > 0) guidance.push("cleanup-failed");
      if (targetChanged) guidance.push("changed-target");
      if (guidance.length > 0) text.push("", whatToDoNow(guidance));
      return {
        content: [{ type: "text", text: text.join("\n") }],
        details: { ledger, records, recording, failures, cleanup, deferred, approvals, publications },
        isError: failures.length > 0 || cleanup.length > 0 || unsettled,
      };
    },
  });
}

/** Operations whose proposal a skill answer cites through `proposal`; a withdrawal is answered only through its approval, a stale amendment and a compaction in their own lists. */
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
  const proposal = preparedInPass(cited, sessionToolEvidence(branch), branch);
  if (proposal.kind === "project") throw new Error("the cited proposal is a project proposal, answered as a project outcome");
  const operation = "change" in proposal ? proposal.change.operation : "stale amendment";
  if (reference !== undefined && !CITABLE.includes(operation)) throw new Error(`the cited proposal is a ${operation}, which \`proposal\` does not answer`);
  const filled = { skill: skill ?? proposal.skill, kind: kind ?? proposal.kind, gist: gist ?? proposal.gist, fingerprint: answer.fingerprint ?? proposal.fingerprint };
  const isThisAnswer = filled.skill === proposal.skill && filled.kind === proposal.kind && filled.gist === proposal.gist && filled.fingerprint === proposal.fingerprint;
  if (reference !== undefined && !isThisAnswer) {
    throw new Error(`the cited proposal is \`${proposal.skill}\` (${proposal.kind}) "${proposal.gist}" under fingerprint \`${proposal.fingerprint}\`, not this answer`);
  }
  const evidence = proposal.evidence.length > 0 ? proposal.evidence.map(({ source: _, ...item }) => item) : answer.evidence;
  return { ...rest, ...filled, ...(evidence && { evidence }) };
}
