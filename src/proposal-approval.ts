/**
 * Proposal approval: whether the user explicitly approved a prepared proposal
 * in the current observation pass, established from the saved branch alone.
 * It guards every rule and reference change `observer_resolve` carries out
 * from a prepared proposal: an on-read append, a pattern amendment, a barrier
 * rule, a stale amendment's Update or Delete, a withdrawal and a compaction.
 * The approval is the chain the pass left there: the successful
 * `observer_review` Prepare holding the proposal, a successful Select that
 * selected it, and a native `ask` whose question with the proposal's candidate
 * ID shows its preview unchanged on the Apply option (for a stale amendment,
 * each alternative's on its Update or Delete option), answered by the user
 * selecting that option alone, with no note or one the main agent classified
 * as non-modifying. Caller-supplied IDs only locate that chain. Nothing is
 * cached: each check reads the branch as it is, so authority ends as soon as
 * the chain or the pass leaves the branch, or the user speaks after answering.
 *
 * A proposal reconciliation adapts an approved on-read append or rule to a
 * target that changed after its Prepare: a revised proposal, prepared later in
 * the pass, that cites the approval. A stale answer, withdrawal or compaction
 * against a changed target needs a new Prepare and Ask instead: each deletes or
 * rewrites the target without keeping its new content, and a re-pin alone is no
 * change to the instruction content it shows. Code checks its lineage, identity and the target's
 * bytes; the main agent's judgment that the revision keeps the approved intent
 * and the target's unrelated content is trusted, and reported as its
 * judgment, never as the user's approval of the revision.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { frontmatterField } from "./amendments.js";
import { OBSERVATION_MESSAGE_TYPE } from "./digest.js";
import type { AgentMessage, AskDetails, Schema, SchemaBuilder, SessionEntry } from "./omp.js";
import { isProposalRef, type PreparedChange, type PreparedProposal, type PreparedProposalRef, preparedEntry, proposalRefSchema, REVIEW_TOOL_NAME, snapshot } from "./review.js";
import { hasUnlistedReferenceEntries, readReferenceFiles } from "./references.js";
import { type CompletedToolCall, type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";

/** The main agent's classification of the note the user added on Apply: the note's exact text and why it changes nothing the proposal shows. */
export interface NonModifyingNote { note: string; reason: string }

/** Where the pass's approval of one prepared proposal is saved: its reference, the Select that selected it and the Ask the user answered. */
export interface ProposalAnswerRef {
  proposal: PreparedProposalRef;
  selectionToolCallId: string;
  askToolCallId: string;
  nonModifyingNote?: NonModifyingNote;
}

/** What a revised proposal states: the approval it reconciles, how the target changed, why, and why the revision keeps the approved intent and the target's unrelated content. */
export interface ProposalReconciliation {
  approval: ProposalAnswerRef;
  changedTarget: string;
  reason: string;
  preserved: string;
}

/** What a change carried out from a prepared proposal rests on, as `observer_resolve` reports it. */
export interface ApprovalEvidence {
  fingerprint: string;
  approval: ProposalAnswerRef;
  /** The option the user selected: Apply, or a stale amendment's Update or Delete. */
  selected: string;
  /** The main agent's reconciliation the written content comes from; the user approved the original, not this revision. */
  reconciliation?: Omit<ProposalReconciliation, "approval"> & { revision: PreparedProposalRef };
}

/** `revision`: the reference of a reconciliation of the approved proposal, whose content is written instead. */
export type AnswerApproval = ProposalAnswerRef & { revision?: PreparedProposalRef };
/** An answer that carries out an approved change, as `observer_resolve` receives it: an applied fix or a withdrawal, a stale answer, or a compaction. */
type ApprovedAnswer =
  | { skill: string; kind: string; gist: string; outcome: string; fingerprint?: string; approval?: AnswerApproval }
  | { rule: string; action: string; approval?: AnswerApproval }
  | { skill: string; outcome: string; approval?: AnswerApproval };

/** The prepared changes an approval lets `observer_resolve` carry out. */
export type ApprovedChange = Exclude<PreparedChange, { operation: "direct-edit" }>;
/** The approved changes a reconciliation may revise. */
type ReconcilableChange = Extract<PreparedChange, { operation: "on-read-append" | "rule" }>;
type AskAnswer = NonNullable<AskDetails["results"]>[number];

const APPLY = "Apply";
/** A stale amendment's question offers each prepared alternative under its own option. */
const STALE_OPTIONS = { "stale-update": "Update", "stale-delete": "Delete" } as const;

/**
 * The branch position of the message that started the current observation
 * pass, or `undefined` when no pass is current: a prompt the user typed, a
 * `/skill:` start or a `/clear` reset after it ends the pass. Steering and
 * messages the harness or agent wrote do not.
 */
export function observationPassStart(branch: readonly SessionEntry[]): number | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "custom_message" && entry.customType === OBSERVATION_MESSAGE_TYPE) return i;
    const endsPass = entry.type === "reset_boundary" || (entry.type === "custom_message" && entry.customType === "skill-prompt") ||
      (isFromUser(entry.message) && !entry.message?.steering);
    if (endsPass) return undefined;
  }
  return undefined;
}

/** Parameter schemas for an approval reference, shared by `observer_review` reconciliations and `observer_resolve`. */
export function approvalShape(z: SchemaBuilder): Record<keyof ProposalAnswerRef, Schema> {
  return {
    proposal: proposalRefSchema(z).describe("The proposal's `reference`, exactly as Prepare returned it."),
    selectionToolCallId: z.string().describe("The `observerToolCallId` of the observer_review Select that selected it."),
    askToolCallId: z.string().describe("The `observerToolCallId` of the `ask` whose question with the proposal's `candidateId` as `id` the user answered Apply."),
    nonModifyingNote: z.object({
      note: z.string().describe("The user's note, exactly as the Ask result holds it."),
      reason: z.string().describe("Why the note changes nothing the proposal shows."),
    }).optional().describe("Only for a note the user added on Apply that you judge changes nothing the proposal shows; a modifying or ambiguous note needs a new prepared proposal and Ask."),
  };
}

/**
 * The change `answer` carries out and what it rests on, read from the prepared
 * proposal the user approved, or from its reconciliation, on the branch, never
 * from the caller: an applied answer's on-read append or rule, a withdrawn
 * answer's withdrawal, the stale alternative whose option the user selected,
 * or a compaction answer's compaction. Throws with the precise reason when the branch holds no such
 * approval in the current pass, or when the target no longer holds the bytes
 * the change was prepared against; call it immediately before writing.
 */
export function approvedChange(answer: ApprovedAnswer, branch: readonly SessionEntry[]): { change: ApprovedChange; evidence: ApprovalEvidence } {
  const approval = answerRef(answer.approval);
  const evidence = sessionToolEvidence(branch);
  const { proposal, change, selected, answeredAt } = approvedProposal(approval, evidence, branch);
  checkCarriedOut(answer, proposal, change, selected);
  const { fingerprint } = proposal;
  const revision = answer.approval?.revision;
  if (revision === undefined) {
    checkTarget(change, isReconcilable(change)
      ? "Prepare read it; prepare a reconciliation that cites this approval through `observer_review`, or ask again"
      : "Prepare read it; prepare it again and ask again");
    return { change, evidence: { fingerprint, approval, selected } };
  }
  if (!isReconcilable(change)) throw new Error("only an approved on-read fix, pattern amendment or barrier rule is reconciled: prepare a changed stale answer, withdrawal or compaction again and ask again");
  if (!isProposalRef(revision)) throw new Error("`approval.revision` is the reconciliation's `reference`, exactly as Prepare returned it");
  const { proposal: revised } = preparedEntry(evidence, revision);
  if (!revised.reconciles || !isDeepStrictEqual(revised.reconciles.approval, approval)) {
    throw new Error(`proposal \`${revision.candidateId}\` of review \`${revision.reviewToolCallId}\` reconciles no approval or another one: its lineage does not lead to this answer's approval`);
  }
  const reconciled = revisedChange(proposal, change, revised);
  if (evidence.completedCall(revision.reviewToolCallId).call.position < answeredAt) throw new Error("the reconciliation was prepared before the user answered");
  checkTarget(reconciled, "the reconciliation was prepared; reconcile again or ask again");
  const { approval: _, ...judgment } = revised.reconciles;
  return { change: reconciled, evidence: { fingerprint, approval, selected, reconciliation: { revision, ...judgment } } };
}

/** Throws unless `change`, approved by selecting `selected`, is the change `answer` carries out, on its proposal's identity. */
function checkCarriedOut(answer: ApprovedAnswer, proposal: PreparedProposal, change: ApprovedChange, selected: string): void {
  const operations = "action" in answer ? [`stale-${answer.action}`] : !("gist" in answer) ? ["compaction"]
    : answer.outcome === "withdrawn" ? ["withdrawal"] : ["on-read-append", "rule"];
  if (!operations.includes(change.operation)) {
    throw new Error(`the user selected ${selected} for a ${change.operation} change, which this answer does not carry out: it carries out ${operations.join(" or ")}`);
  }
  if ("action" in answer) {
    if ("rule" in change && change.rule?.name !== answer.rule) throw new Error(`the approved proposal is the stale amendment \`${change.rule?.name}\`, not \`${answer.rule}\``);
    return;
  }
  if (!("gist" in answer)) {
    if (proposal.skill !== answer.skill) throw new Error(`the approved proposal is the compaction of \`${proposal.skill}\`, not of \`${answer.skill}\``);
    return;
  }
  const isThisAnswer = proposal.skill === answer.skill && proposal.kind === answer.kind && proposal.gist === answer.gist &&
    (answer.fingerprint === undefined || answer.fingerprint === proposal.fingerprint);
  if (!isThisAnswer) throw new Error(`the approved proposal is \`${proposal.skill}\` (${proposal.kind}) "${proposal.gist}" under fingerprint \`${proposal.fingerprint}\`, not this answer`);
}

/**
 * Checks the reconciliation a revised proposal claims, as Prepare drafts it:
 * the approval it cites holds in the current pass, the revision makes the same
 * operation on the same target for the same skill under the same ledger
 * identity, and the target changed since the approved Prepare. Returns it in
 * canonical form; throws with the reason when it doesn't hold.
 */
export function checkReconciliation(
  claim: Partial<ProposalReconciliation> | undefined, revision: Pick<PreparedProposal, "skill" | "kind" | "fingerprint"> & { change: ReconcilableChange },
  branch: readonly SessionEntry[],
): ProposalReconciliation {
  const { changedTarget, reason, preserved } = claim ?? {};
  if (![changedTarget, reason, preserved].every((text) => typeof text === "string" && text.trim())) {
    throw new Error("a reconciliation states `changedTarget`, `reason` and `preserved`: how the target changed, why the revision, and why it keeps the approved intent and the target's unrelated content");
  }
  const approval = answerRef(claim?.approval);
  const { proposal, change } = approvedProposal(approval, sessionToolEvidence(branch), branch);
  if (!isReconcilable(change)) throw new Error("only an approved on-read append or rule can be reconciled: a changed stale answer or withdrawal needs a new prepared proposal and Ask");
  revisedChange(proposal, change, revision);
  if (revision.change.target.sha256 === change.target.sha256) {
    throw new Error("the target is unchanged since the approved Prepare read it: resolve with the original approval");
  }
  return { approval, changedTarget: changedTarget!, reason: reason!, preserved: preserved! };
}

/**
 * The approved proposal `ref` locates: its prepared proposal, the change of
 * the option the user selected, that option and the branch position where the
 * user's answer was saved. Throws with the precise reason when the branch
 * holds no such approval in the current pass.
 */
function approvedProposal(ref: ProposalAnswerRef, evidence: SessionToolEvidence, branch: readonly SessionEntry[]): { proposal: PreparedProposal; change: ApprovedChange; selected: string; answeredAt: number } {
  const passStart = observationPassStart(branch);
  if (passStart === undefined) {
    throw new Error("no observation pass is current on this branch: a later prompt, `/skill:` start or `/clear` ended it, so its answers approve nothing");
  }
  const { proposal } = preparedEntry(evidence, ref.proposal);
  const options = approvingOptions(proposal);

  const prepare = evidence.completedCall(ref.proposal.reviewToolCallId);
  const selection = completed(evidence, ref.selectionToolCallId, "selection");
  const ask = completed(evidence, ref.askToolCallId, "Ask");
  if (selection.call.name !== REVIEW_TOOL_NAME || selection.call.args.action !== "select" || selection.result.isError !== false) {
    throw new Error(`\`${ref.selectionToolCallId}\` is not a successful observer_review Select`);
  }
  const details: unknown = selection.result.details;
  const chosen = details && typeof details === "object" && "selected" in details ? details.selected : undefined;
  if (!Array.isArray(chosen) || !chosen.some((entry: { reference?: unknown } | undefined) => isDeepStrictEqual(entry?.reference, ref.proposal))) {
    throw new Error(`Select \`${ref.selectionToolCallId}\` did not select this proposal`);
  }
  const selected = checkAnswer(ask, proposal.candidateId, options, ref.nonModifyingNote);
  if (prepare.call.position < passStart) throw new Error("the proposal was prepared in an earlier observation pass; prepare, select and ask again");
  if (prepare.result.position > selection.call.position || selection.result.position > ask.call.position) {
    throw new Error("the Ask must follow the Select, and the Select the Prepare, in this observation pass");
  }
  const spokeAfter = branch.slice(ask.result.position + 1).some((entry) => isFromUser(entry.message));
  if (spokeAfter) throw new Error("the user sent a message after answering, which may retract or change the approval; ask again");
  return { proposal, change: options.get(selected)!.change, selected, answeredAt: ask.result.position };
}

/** The options whose selection approves a change of `proposal`, each with that change and the preview it shows. */
function approvingOptions(proposal: PreparedProposal): Map<string, { change: ApprovedChange; preview: string }> {
  if ("alternatives" in proposal) return new Map(proposal.alternatives.map(({ change, preview }) => [STALE_OPTIONS[change.operation], { change, preview }]));
  const { change, preview } = proposal;
  if (change.operation === "direct-edit") throw new Error("the approved proposal is a direct edit, which the main agent makes itself");
  return new Map([[APPLY, { change, preview }]]);
}

export function isReconcilable(change: PreparedChange | undefined): change is ReconcilableChange {
  return change?.operation === "on-read-append" || change?.operation === "rule";
}

/** The revised change, when `revision` makes the approved proposal's operation on its own target under its ledger identity. */
function revisedChange(
  original: PreparedProposal, change: ReconcilableChange,
  revision: Pick<PreparedProposal, "skill" | "kind" | "fingerprint"> & { change?: PreparedChange },
): ReconcilableChange {
  const revised = revision.change;
  if (!isReconcilable(revised) || revised.operation !== change.operation || revision.skill !== original.skill || revision.kind !== original.kind ||
      revision.fingerprint !== original.fingerprint || revised.target.path !== change.target.path) {
    const what = change.operation === "rule" ? "rule" : "on-read append";
    throw new Error(`a reconciliation revises the approved proposal's own ${what}: \`${original.skill}\` (${original.kind}) under fingerprint \`${original.fingerprint}\` to \`${change.target.path}\``);
  }
  return revised;
}

/**
 * Throws unless the target holds the bytes `change` was prepared against and
 * its reference folder the files it read. An on-read amendment that already
 * holds the section verbatim passes, since the append writes nothing; so does
 * the rule of a stale answer, withdrawal or compaction whose only change is a
 * re-pin, which shows no instruction content the preview did not.
 */
function checkTarget(change: ApprovedChange, since: string): void {
  if (change.operation === "withdrawal" && change.effect === "record") return;
  const { target } = change;
  const bytes = existsSync(target.path) ? readFileSync(target.path) : null;
  const text = bytes?.toString("utf8");
  const pin = isReconcilable(change) ? undefined : change.rule?.skillHash;
  const holds = snapshot(target.path, bytes).sha256 === target.sha256 ||
    (change.operation === "on-read-append" && text?.includes(change.section)) ||
    (pin !== undefined && text !== undefined && sha256(text.replace(/^skillHash:.*$/m, () => frontmatterField("skillHash", pin))) === target.sha256);
  const what = change.operation === "on-read-append" || change.operation === "compaction" ? "on-read amendment" : "rule";
  if (!holds) throw new Error(`the ${what} \`${target.path}\` changed since ${since}`);
  const references = "references" in change ? change.references : undefined;
  if (!references) return;
  const [referencesDir, skill] = [dirname(references.folder), basename(references.folder)];
  if (!isDeepStrictEqual(readReferenceFiles(referencesDir, skill).map((path) => snapshot(path)), references.before) ||
      hasUnlistedReferenceEntries(referencesDir, skill)) {
    throw new Error(`the reference files in \`${references.folder}\` changed since ${since}`);
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `ref` in canonical form, so a saved reconciliation and an answer citing the same approval compare equal. */
function answerRef(ref: Partial<ProposalAnswerRef> | undefined): ProposalAnswerRef {
  const note = ref?.nonModifyingNote;
  if (typeof ref?.selectionToolCallId !== "string" || typeof ref.askToolCallId !== "string" || !isProposalRef(ref.proposal) ||
      (note !== undefined && (typeof note?.note !== "string" || typeof note.reason !== "string"))) {
    throw new Error("this answer needs `approval`: the proposal's `reference` exactly as Prepare returned it, `selectionToolCallId`, `askToolCallId` and, for a note on the selected option, `nonModifyingNote` with its `note` and `reason`");
  }
  const { reviewToolCallId, candidateId, contentHash } = ref.proposal;
  return {
    proposal: { reviewToolCallId, candidateId, contentHash }, selectionToolCallId: ref.selectionToolCallId, askToolCallId: ref.askToolCallId,
    ...(note && { nonModifyingNote: { note: note.note, reason: note.reason } }),
  };
}

/** A message the user wrote: a prompt, or steering when `steering` is set; harness- and agent-written ones are not. */
function isFromUser(message: AgentMessage | undefined): boolean {
  return message?.role === "user" && !message.synthetic && message.attribution !== "agent";
}

function completed(evidence: SessionToolEvidence, id: string, role: string): CompletedToolCall {
  try {
    return evidence.completedCall(id);
  } catch {
    throw new Error(`this branch holds no single completed ${role} call \`${id}\``);
  }
}

/**
 * Checks that the native Ask holds one question identified by `candidateId`
 * with one option per label of `approving` previewing its change exactly, and
 * that the user answered it by selecting one of them alone, without a timeout
 * default or custom input, and with no note or the one `classified` quotes.
 * Returns the selected label.
 */
function checkAnswer({ call, result }: CompletedToolCall, candidateId: string, approving: ReadonlyMap<string, { preview: string }>, classified: NonModifyingNote | undefined): string {
  if (call.name !== "ask" || call.origin !== "native" || result.origin !== "native") {
    throw new Error(`\`${call.id}\` is not an ask the model made itself: a nested or hook-only ask is no approval`);
  }
  if (result.isError !== false) throw new Error("the Ask was cancelled or failed, so the user approved nothing");
  const questions = Array.isArray(call.args.questions) ? call.args.questions : [];
  const asked = questions.filter((question) => question?.id === candidateId);
  const [question] = asked;
  if (!question || asked.length > 1) throw new Error(`the Ask holds no single question with id \`${candidateId}\``);
  for (const [label, { preview }] of approving) {
    const offered = (question.options ?? []).filter((option) => option?.label === label);
    if (offered.length !== 1 || offered[0]?.preview !== preview) throw new Error(`the question's one ${label} option does not preview the prepared proposal unchanged`);
  }

  const details = result.details;
  if (details?.chatRedirect) throw new Error("the user chose to chat instead of answering");
  // One question's answer is spread into the details without an ID; a batch's carry their question's ID.
  const answers: AskAnswer[] = Array.isArray(details?.results)
    ? details.results.filter((answer) => answer?.id === candidateId)
    : questions.length === 1 && details ? [details] : [];
  const [answer] = answers;
  if (!answer || answers.length > 1) throw new Error(`the Ask's result holds no single answer to question \`${candidateId}\``);
  const labels = (question.options ?? []).map((option) => option?.label);
  if (!isDeepStrictEqual(answer.options, labels)) throw new Error("the answer was given to other options than the question shows");
  if (answer.timedOut) throw new Error("the answer was selected by a timeout: a default, not the user's approval");
  if (answer.customInput !== undefined) {
    throw new Error("the answer carries custom input, which approves nothing; ask again with a proposal that shows what it asks for");
  }
  const picked = answer.selectedOptions ?? [];
  const [selected] = picked;
  if (picked.length !== 1 || selected === undefined || !approving.has(selected)) {
    throw new Error(picked.length === 0 ? "the user selected no option" : `the user selected ${picked.map((label) => `\`${label}\``).join(", ")}, not ${[...approving.keys()].join(" or ")} alone`);
  }
  if (!answer.note) {
    if (classified) throw new Error("`nonModifyingNote` classifies a note, but the user's answer carries no note");
    return selected;
  }
  if (answer.noteOption !== undefined && answer.noteOption !== selected) throw new Error(`the user's note is on \`${answer.noteOption}\`, not on ${selected}; ask again`);
  if (!classified) {
    throw new Error("the answer carries a note the main agent has not classified: when it changes nothing the proposal shows, send `nonModifyingNote` with the note's exact text and your reason; a modifying or ambiguous note needs a new prepared proposal and Ask");
  }
  if (classified.note !== answer.note) throw new Error("`nonModifyingNote` does not quote the user's note exactly");
  if (!classified.reason.trim()) throw new Error("`nonModifyingNote` needs the `reason` the note changes nothing approved");
  return selected;
}
