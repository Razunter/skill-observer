/**
 * Proposal approval: whether the user explicitly approved a prepared proposal
 * in the current observation pass, established from the saved branch alone.
 * It guards every rule and reference change `observer_resolve` carries out
 * from a prepared proposal: an on-read append, a pattern amendment, a barrier
 * rule, a stale amendment's Update or Delete, a withdrawal and a compaction.
 * The approval is the chain the pass left there: the successful
 * `observer_review` Prepare holding the proposal, a successful Select that
 * selected it, and a native `ask` called with exactly the form rendered from
 * that Select's proposals, answered by the user choosing the proposal's Apply
 * option (for a stale amendment, Update or Delete) before any timeout. Custom
 * input approves nothing. Caller-supplied IDs only locate that chain. Nothing is
 * cached: each check reads the branch as it is, so authority ends as soon as
 * the chain or the pass leaves the branch, or the user speaks after answering.
 *
 * A proposal reconciliation adapts an approved on-read append or rule to the
 * user's approval note on its Apply, to a target that changed after its
 * Prepare, or to both: a revised proposal, prepared later in the pass, that
 * cites the approval. An Apply with a note writes nothing without one. A stale
 * answer, withdrawal or compaction takes no note, and against a changed target
 * needs a new Prepare and Ask instead: each deletes or rewrites the target
 * without keeping its new content, and a re-pin alone is no change to the
 * instruction content it shows. Code checks its lineage, identity and the target's
 * bytes; the main agent's judgment that the revision follows the note and keeps the approved intent
 * and the target's unrelated content is trusted, and reported as its
 * judgment, never as the user's approval of the revision.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { frontmatterField } from "./amendments.js";
import { OBSERVATION_MESSAGE_TYPE } from "./digest.js";
import type { AgentMessage, AskDetails, AskOptionNote, Schema, SchemaBuilder, SessionEntry } from "./omp.js";
import { isProposalRef, type PreparedChange, type PreparedProposal, type PreparedProposalRef, preparedEntry, proposalRefSchema, renderAskHtml, REVIEW_TOOL_NAME, snapshot } from "./review.js";
import { hasUnlistedReferenceEntries, readReferenceFiles } from "./references.js";
import { type CompletedToolCall, type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";

/** Where the pass's approval of one prepared proposal is saved: its reference, the Select that selected it and the Ask the user answered. */
export interface ProposalAnswerRef {
  proposal: PreparedProposalRef;
  selectionToolCallId: string;
  askToolCallId: string;
}

/**
 * What a revised proposal states: the approval it reconciles, why the revision,
 * why it keeps the approved intent and the target's unrelated content, and,
 * when the target changed after the approved Prepare, how.
 */
export interface ProposalReconciliation {
  approval: ProposalAnswerRef;
  changedTarget?: string;
  reason: string;
  preserved: string;
}

/** What a change carried out from a prepared proposal rests on, as `observer_resolve` reports it. */
export interface ApprovalEvidence {
  fingerprint: string;
  approval: ProposalAnswerRef;
  /** The option the user selected: Apply, or a stale amendment's Update or Delete. */
  selected: string;
  /** The approval note the user attached to that option, which the reconciliation revised the proposal by. */
  note?: string;
  /** The main agent's reconciliation the written content comes from, with the preview of that content; the user approved the original, not this revision. */
  reconciliation?: Omit<ProposalReconciliation, "approval"> & { revision: PreparedProposalRef; preview: string };
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

export const APPLY = "Apply";
/** A stale amendment's fieldset offers each prepared alternative under its own option. */
export const STALE_OPTIONS = { "stale-update": "Update", "stale-delete": "Delete" } as const;

/** A target that no longer holds what its approved change was prepared against: the answer needs a reconciliation or a new Ask, not a corrected call. */
export class TargetChangedError extends Error {}

/** The host's answer for text the user typed into a group's "Other" row starts with this. */
const CUSTOM_INPUT = "Other: ";

/** Whether an answer of the Ask `details` is custom input, which approves nothing: the pass prepares a new proposal for what it asks. */
export function hasCustomInput(details: AskDetails | undefined): boolean {
  return Array.isArray(details?.answers) && details.answers.some((answer) => answer?.answer?.startsWith(CUSTOM_INPUT));
}

/** Whether the Ask `details` hold an approval note on any chosen option: what it obliges depends on that option. */
export function hasApprovalNote(details: AskDetails | undefined): boolean {
  return Array.isArray(details?.notes) && details.notes.some((note) => noteText(note) !== undefined);
}

/** An option note's text, trimmed; a blank note is none. */
function noteText(note: AskOptionNote | undefined): string | undefined {
  const text = typeof note?.text === "string" ? note.text.trim() : "";
  return text || undefined;
}

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
    askToolCallId: z.string().describe("The `observerToolCallId` of the `ask` called with that Select's `askHtml` unchanged, in which the user chose Apply (for a stale amendment, Update or Delete)."),
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
  const { proposal, change, selected, note, answeredAt } = approvedProposal(approval, evidence, branch);
  checkCarriedOut(answer, proposal, change, selected);
  const { fingerprint } = proposal;
  if (note !== undefined && !isReconcilable(change)) {
    throw new Error(`the user chose ${selected} with the note ${JSON.stringify(note)}, and a ${change.operation} takes no note: prepare the changed proposal through \`observer_review\` and ask again`);
  }
  const revision = answer.approval?.revision;
  if (revision === undefined) {
    if (note !== undefined) {
      throw new Error(`the user chose ${selected} with the note ${JSON.stringify(note)}: prepare the revision by that note through \`observer_review\`, citing this approval, and cite it as \`approval.revision\``);
    }
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
  const preview = "preview" in revised ? revised.preview : "";
  return { change: reconciled, evidence: { fingerprint, approval, selected, ...(note !== undefined && { note }), reconciliation: { revision, ...judgment, preview } } };
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
 * identity, and it rests on the user's approval note, a target changed since
 * the approved Prepare, or both. A note-based revision differs from the
 * approved instruction; a changed target is stated. Returns it in canonical
 * form; throws with the reason when it doesn't hold.
 */
export function checkReconciliation(
  claim: Partial<ProposalReconciliation> | undefined, revision: Pick<PreparedProposal, "skill" | "kind" | "fingerprint"> & { change: ReconcilableChange },
  branch: readonly SessionEntry[],
): ProposalReconciliation {
  const { changedTarget, reason, preserved } = claim ?? {};
  if (![reason, preserved].every((text) => typeof text === "string" && text.trim())) {
    throw new Error("a reconciliation states `reason` and `preserved`: why the revision, and why it keeps the approved intent and the target's unrelated content");
  }
  const approval = answerRef(claim?.approval);
  const { proposal, change, note } = approvedProposal(approval, sessionToolEvidence(branch), branch);
  if (!isReconcilable(change)) throw new Error("only an approved on-read append or rule can be reconciled: a changed stale answer or withdrawal needs a new prepared proposal and Ask");
  revisedChange(proposal, change, revision);
  const targetChanged = revision.change.target.sha256 !== change.target.sha256;
  if (!targetChanged && note === undefined) {
    throw new Error("the target is unchanged since the approved Prepare read it and the user attached no note: resolve with the original approval");
  }
  if (targetChanged && !(typeof changedTarget === "string" && changedTarget.trim())) {
    throw new Error("the target changed since the approved Prepare read it: state how in `changedTarget`");
  }
  if (note !== undefined && isDeepStrictEqual(instruction(revision.change), instruction(change))) {
    throw new Error(`the revision is the approved change unchanged, so it does not apply the note ${JSON.stringify(note)}: revise it by the note`);
  }
  return { approval, ...(targetChanged && { changedTarget }), reason: reason!, preserved: preserved! };
}

/** What a reconcilable change makes the agent read: an on-read append's section, or a rule's body, pattern, scope and samples. */
function instruction(change: ReconcilableChange): unknown {
  if (change.operation === "on-read-append") return change.section;
  const { body, rule: { condition, scope }, matches, spares } = change;
  return { body, condition, scope, matches, spares };
}

/**
 * The approved proposal `ref` locates: its prepared proposal, the change of
 * the option the user selected, that option, the user's approval note on it,
 * if any, and the branch position where the user's answer was saved. Throws
 * with the precise reason when the branch holds no such approval in the current pass.
 */
function approvedProposal(ref: ProposalAnswerRef, evidence: SessionToolEvidence, branch: readonly SessionEntry[]):
  { proposal: PreparedProposal; change: ApprovedChange; selected: string; note?: string; answeredAt: number } {
  const proposal = preparedInPass(ref.proposal, evidence, branch);
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
  const askHtml = renderAskHtml(chosen.map(({ proposal }: { proposal: PreparedProposal }) => proposal));
  const { selected, note } = checkAnswer(ask, askHtml, proposal.candidateId, options);
  if (prepare.result.position > selection.call.position || selection.result.position > ask.call.position) {
    throw new Error("the Ask must follow the Select, and the Select the Prepare, in this observation pass");
  }
  const spokeAfter = branch.slice(ask.result.position + 1).some((entry) => isFromUser(entry.message));
  if (spokeAfter) throw new Error("the user sent a message after answering, which may retract or change the approval; ask again");
  return { proposal, change: options.get(selected)!, selected, ...(note !== undefined && { note }), answeredAt: ask.result.position };
}

/**
 * The proposal `ref` locates, prepared in the current observation pass: an
 * answer of this pass, approved or not, cites only a proposal of this pass.
 * Throws with the precise reason otherwise.
 */
export function preparedInPass(ref: PreparedProposalRef, evidence: SessionToolEvidence, branch: readonly SessionEntry[]): PreparedProposal {
  const passStart = observationPassStart(branch);
  if (passStart === undefined) {
    throw new Error("no observation pass is current on this branch: a later prompt, `/skill:` start or `/clear` ended it, so its answers approve nothing");
  }
  const { proposal } = preparedEntry(evidence, ref);
  if (evidence.completedCall(ref.reviewToolCallId).call.position < passStart) throw new Error("the proposal was prepared in an earlier observation pass; prepare, select and ask again");
  return proposal;
}

/** The options whose selection approves a change of `proposal`, each with that change. */
function approvingOptions(proposal: PreparedProposal): Map<string, ApprovedChange> {
  if ("alternatives" in proposal) return new Map(proposal.alternatives.map(({ change }) => [STALE_OPTIONS[change.operation], change]));
  const { change } = proposal;
  if (change.operation === "direct-edit") throw new Error("the approved proposal is a direct edit, which the main agent makes itself");
  return new Map([[APPLY, change]]);
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
  if (!holds) throw new TargetChangedError(`the ${what} \`${target.path}\` changed since ${since}`);
  const references = "references" in change ? change.references : undefined;
  if (!references) return;
  const [referencesDir, skill] = [dirname(references.folder), basename(references.folder)];
  if (!isDeepStrictEqual(readReferenceFiles(referencesDir, skill).map((path) => snapshot(path)), references.before) ||
      hasUnlistedReferenceEntries(referencesDir, skill)) {
    throw new TargetChangedError(`the reference files in \`${references.folder}\` changed since ${since}`);
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `ref` in canonical form, so a saved reconciliation and an answer citing the same approval compare equal. */
function answerRef(ref: Partial<ProposalAnswerRef> | undefined): ProposalAnswerRef {
  if (typeof ref?.selectionToolCallId !== "string" || typeof ref.askToolCallId !== "string" || !isProposalRef(ref.proposal)) {
    throw new Error("this answer needs `approval`: the proposal's `reference` exactly as Prepare returned it, `selectionToolCallId` and `askToolCallId`");
  }
  const { reviewToolCallId, candidateId, contentHash } = ref.proposal;
  return { proposal: { reviewToolCallId, candidateId, contentHash }, selectionToolCallId: ref.selectionToolCallId, askToolCallId: ref.askToolCallId };
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
 * Checks that the native Ask showed exactly `askHtml`, the form its Select's
 * proposals render to, and that the user answered the radio group named
 * `candidateId` by choosing a label of `approving`, not by a timeout's
 * submission of the form as it stood nor with custom input. Returns the label
 * and the approval note the user attached to it, trimmed; a blank note is none.
 */
function checkAnswer({ call, result }: CompletedToolCall, askHtml: string, candidateId: string, approving: ReadonlyMap<string, unknown>): { selected: string; note?: string } {
  if (call.name !== "ask" || call.origin !== "native" || result.origin !== "native") {
    throw new Error(`\`${call.id}\` is not an ask the model made itself: a nested or hook-only ask is no approval`);
  }
  if (result.isError !== false) throw new Error("the Ask was cancelled or failed, so the user approved nothing");
  if (call.args.html !== askHtml) throw new Error("the Ask's `html` is not this Select's `askHtml` unchanged: ask again with it exactly as returned");

  const details = result.details;
  if (details?.timedOut) throw new Error("the Ask timed out, which submits the form as it stood, not the user's approval; ask again");
  const answers = Array.isArray(details?.answers) ? details.answers.filter((answer) => answer?.name === candidateId) : [];
  const [answer] = answers;
  if (!answer || answers.length > 1) throw new Error(`the Ask's result holds no single answer named \`${candidateId}\``);
  const selected = answer.answer;
  if (typeof selected !== "string" || selected === "") throw new Error("the user selected no option; ask again");
  if (selected.startsWith(CUSTOM_INPUT)) {
    throw new Error("the answer is custom input, which approves nothing; prepare a new proposal for what it asks and ask again");
  }
  if (!approving.has(selected)) throw new Error(`the user selected \`${selected}\`, not ${[...approving.keys()].join(" or ")}`);
  const note = noteText(details?.notes?.find((given) => given?.name === candidateId && given.option === selected));
  return { selected, ...(note !== undefined && { note }) };
}
