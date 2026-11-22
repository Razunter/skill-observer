/**
 * skill-observer: end-of-session skill feedback for OMP.
 * Adapted from task-observer by Eoghan Henn / rebelytics.com (CC BY 4.0),
 * https://github.com/rebelytics/one-skill-to-rule-them-all
 */
import {
  amendmentsDir,
  findStaleAmendments,
  migrateObserverRules,
  type RuleDirs,
  userRulesDir,
} from "./amendments.js";
import {
  buildDigest,
  OBSERVATION_MESSAGE_TYPE,
  type SkillSignal,
} from "./digest.js";
import { catalogSummary, registerCatalogCapture } from "./catalog.js";
import { registerAmendmentDelivery } from "./delivery.js";
import { ledgerForProject, readLedgerRows } from "./ledger.js";
import type { AskDetails, ExtensionAPI, ExtensionContext, SessionEntry } from "./omp.js";
import {
  createProvenanceResolver,
  defaultSkillRoots,
  ompAgentDir,
} from "./provenance.js";
import {
  describePayloadEstimate, DRAFT_RECORD_GATES, hasPassEvidence, instructionText, loadInstructionStage, observationPayload, type ObservationPayload, type PassEvidence,
  referencesDir, type ToolResultCondition, whatToDoNow,
} from "./payload.js";
import { CHECK_TOOL_NAME, registerCheckTool } from "./replay.js";
import { RESOLVE_TOOL_NAME, registerResolveTool } from "./resolve.js";
import { hasReviewedPublication, registerReviewTool, reviewSelectionForForm, REVIEW_TOOL_NAME } from "./review.js";
import { evidenceReport, renderEvidenceReport } from "./report.js";
import { recordHookCall, recordHookResult, sessionToolEvidence, type ToolAuthorization } from "./session-tool-evidence.js";
import { projectToolAuthorization } from "./project-publication.js";
import { projectScopeNote } from "./project-scope.js";
import { countPendingObservations, markObservationsShown, type Observation, readPendingObservations, recordObservation } from "./observations.js";
import { ObserverCommitUnknownError, observerStorePath, readObserverStore } from "./observer-store.js";
import { APPLY, hasApprovalNote, hasCustomInput, observationPassStart, STALE_OPTIONS } from "./proposal-approval.js";

const STATUS_KEY = "skill-observer";
/** Global skills and scoped project state share one database per profile. */
const storeFile = () => observerStorePath(ompAgentDir());
const ruleDirs = (): RuleDirs => ({ rulesDir: userRulesDir(), amendmentsDir: amendmentsDir() });

function readPassState(cwd: string, now: Date): Pick<PassEvidence, "observations" | "ledger"> {
  const snapshot = readObserverStore(storeFile(), (db) => ({
    observations: readPendingObservations(db, cwd, now),
    ledger: readLedgerRows(db),
  }));
  return snapshot ? { observations: snapshot.observations, ledger: ledgerForProject(snapshot.ledger, cwd) } : { observations: [], ledger: [] };
}

/** Only the main agent with a UI has a user who can answer the pass's questions. */
function isObservable(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.agent?.kind !== "sub";
}

function activeSessionSource(session: ExtensionContext["sessionManager"], branch: readonly SessionEntry[]): PassEvidence["sessionSource"] {
  return {
    id: session.getSessionId(),
    leaf: branch.at(-1)?.id,
    compaction: branch.findLast((entry) => entry.type === "compaction")?.id,
  };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Shows a status-line hint while the current branch has correction-class skill
 * signals or a workflow outline, or else while the project has pending
 * observations; tool errors and skill loads alone stay quiet.
 */
function refreshHint(_event: unknown, ctx: ExtensionContext): void {
  if (!isObservable(ctx)) return;
  const { signals } = buildDigest(ctx.sessionManager.getBranch(), { provenance: createProvenanceResolver(defaultSkillRoots(ctx.cwd)) });
  const occurrences = (keep: (signal: SkillSignal) => boolean) =>
    signals.filter(keep).reduce((total, signal) => total + signal.count, 0);
  const corrections = occurrences((signal) => signal.correction);
  const workflows = occurrences((signal) => signal.kind === "workflow");
  let observations = 0;
  if (corrections === 0 && workflows === 0) {
    try {
      observations = countPendingObservations(storeFile(), ctx.cwd, new Date());
    } catch {
      // Explicit operations report storage errors; routine status refreshes stay quiet.
    }
  }
  const hint = corrections > 0 ? plural(corrections, "skill correction")
    : workflows > 0 ? `${plural(workflows, "workflow")} without a skill`
    : observations > 0 ? plural(observations, "pending observation")
    : undefined;
  ctx.ui.setStatus(STATUS_KEY, hint && `skill-observer: ${hint} → /observe`);
}

export default function skillObserver(pi: ExtensionAPI): void {
  try {
    migrateObserverRules(ruleDirs(), createProvenanceResolver(defaultSkillRoots(process.cwd())));
  } catch (error) {
    console.error("skill-observer: migrating amendment rules failed:", error);
  }
  registerAmendmentDelivery(pi, amendmentsDir);
  const catalogGap = registerCatalogCapture(pi, isObservable);
  let pendingPassToolUpdate: Promise<void> | undefined;
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === REVIEW_TOOL_NAME && event.input?.action === "source") return;
    try {
      const nativeAsk = event.toolName === "ask" && event.parentToolCallId === undefined;
      const ownerWrite = ["write", "edit", "manage_skill"].includes(event.toolName);
      let authorization: ToolAuthorization | undefined;
      if ((nativeAsk || ownerWrite || event.toolName === "bash") && isObservable(ctx)) {
        const branch = ctx.sessionManager.getBranch();
        const passStart = observationPassStart(branch);
        if (passStart !== undefined && nativeAsk && reviewSelectionForForm(sessionToolEvidence(branch), passStart, event.input.html)) {
          loadInstructionStage("approve");
        }
        if (passStart !== undefined && ownerWrite) {
          try {
            loadInstructionStage("publish");
          } catch (error) {
            // Owner tools also run outside review. Fail closed only when the pass has a reviewed publication.
            if (hasReviewedPublication(sessionToolEvidence(branch), passStart, true)) throw error;
          }
        }
        if (passStart !== undefined) authorization = projectToolAuthorization(event, ctx.cwd, branch, passStart);
      }
      recordHookCall(pi, event, authorization);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === REVIEW_TOOL_NAME && event.input?.action === "source") return;
    const isReceiptTool = ["write", "edit", "bash", "manage_skill", "ask", REVIEW_TOOL_NAME, CHECK_TOOL_NAME].includes(event.toolName);
    const branch = ctx.sessionManager.getBranch();
    recordHookResult(pi, event, branch);
    if (event.isError || !isReceiptTool || !isObservable(ctx)) return;
    const passStart = observationPassStart(branch);
    if (passStart === undefined) return;
    const details = event.toolName === "ask" ? event.details as AskDetails | undefined : undefined;
    const guidance: { type: "text"; text: string }[] = [];
    const html = event.input?.html;
    if (Array.isArray(details?.answers) && details.timedOut !== true && typeof html === "string") {
      // The native request is on the branch before its result is saved.
      const askPosition = branch.findLastIndex((entry, position) => position > passStart && entry.message?.role === "assistant"
        && Array.isArray(entry.message.content) && entry.message.content.some((call) =>
          call.type === "toolCall" && call.name === "ask" && call.id === event.toolCallId && call.arguments?.html === html));
      const selected = askPosition !== -1 && reviewSelectionForForm(sessionToolEvidence(branch), passStart, html, askPosition);
      if (selected) {
        let stage: "publish" | "record" | undefined;
        for (const choice of details.answers) {
          if (!selected.some(({ proposal }) => proposal.candidateId === choice?.name)) continue;
          const answer = choice?.answer;
          if (answer === APPLY || answer === STALE_OPTIONS["stale-update"] || answer === STALE_OPTIONS["stale-delete"]) {
            stage = "publish";
            break;
          }
          if (answer === "Later" || answer === "Decline" || answer === "Keep") stage = "record";
        }
        if (stage !== undefined) {
          try {
            const text = instructionText(stage, DRAFT_RECORD_GATES);
            await activatePassTools([RESOLVE_TOOL_NAME]);
            guidance.push({ type: "text", text });
          } catch (error) {
            guidance.push({ type: "text", text: `Publication and recording stopped: ${(error as Error).message}` });
          }
        }
      }
    }
    const conditions: ToolResultCondition[] = [];
    if (hasCustomInput(details)) conditions.push("custom-input");
    if (hasApprovalNote(details)) conditions.push("approval-note");
    if (conditions.length > 0) guidance.push({ type: "text", text: whatToDoNow(conditions) });
    // Opaque host IDs are absent from ordinary model-visible outputs; snapshot tags and commands cannot identify branch receipts.
    return {
      content: [...event.content, { type: "text", text: JSON.stringify({ observerToolCallId: event.toolCallId }) }, ...guidance],
      details: event.details,
      isError: event.isError,
    };
  });

  // Turn ends add signals; session and branch changes replace the branch the hint describes.
  pi.on("agent_end", refreshHint);
  // Active tools live only in this process, so a restored or switched branch still inside a pass needs them back to resolve its saved approvals.
  const restorePass = async (event: unknown, ctx: ExtensionContext) => {
    refreshHint(event, ctx);
    if (isObservable(ctx) && observationPassStart(ctx.sessionManager.getBranch()) !== undefined) {
      await activatePassTools([RESOLVE_TOOL_NAME, CHECK_TOOL_NAME, REVIEW_TOOL_NAME]);
    }
  };
  pi.on("session_start", restorePass);
  pi.on("session_switch", restorePass);
  pi.on("session_branch", restorePass);
  pi.on("session_tree", restorePass);

  async function activatePassTools(tools: readonly string[], discovery = false): Promise<void> {
    const update = () => {
      const activeTools = pi.getActiveTools();
      const retained = discovery ? activeTools.filter((name) => name !== CHECK_TOOL_NAME && name !== RESOLVE_TOOL_NAME) : activeTools;
      const missing = tools.filter((name) => !retained.includes(name));
      if (retained.length !== activeTools.length || missing.length > 0) return pi.setActiveTools([...retained, ...missing]);
    };
    // The host queues replacements, not the active-tool reads that feed them.
    const activation = pendingPassToolUpdate ? pendingPassToolUpdate.then(update, update) : update();
    if (!activation) return;
    const pending = activation.finally(() => {
      if (pendingPassToolUpdate === pending) pendingPassToolUpdate = undefined;
    });
    pendingPassToolUpdate = pending;
    return pending;
  }

  registerResolveTool(pi, { storeFile, rulesDir: userRulesDir, amendmentsDir, referencesDir });
  registerCheckTool(pi);
  registerReviewTool(pi, { storeFile, rulesDir: userRulesDir, amendmentsDir, referencesDir }, catalogGap,
    (action) => activatePassTools([action === "draft" ? CHECK_TOOL_NAME : RESOLVE_TOOL_NAME]));

  pi.registerTool<{ text: string }, undefined>({
    name: "observe",
    label: "Observe",
    description:
      "Before calling observe, replace private values in text with placeholders such as [redacted email]. Never send the original private value in text. The main agent records an observation for the user's next `/observe` pass: something a skill, a rule or the project setup got wrong, or that cost you a detour. It fixes nothing now; record it and continue.",
    parameters: pi.zod.object({
      text: pi.zod.string().describe("One problem, up to 500 characters: what happened, where, and the fix you want. Keep the real example and its non-sensitive details. Replace private values with clear placeholders such as [redacted email]. Start any altered excerpt with [redacted excerpt] followed by a space. If a private detail matters, leave a permitted source locator or note the gap."),
    }),
    approval: "read",
    loadMode: "essential",
    async execute(_toolCallId, { text }, _signal, _onUpdate, ctx) {
      // Only the agent the user talks to adds to the user's review queue.
      if (ctx.agent?.kind === "sub") return { content: [{ type: "text", text: "Nothing was recorded: only the main agent records observations." }], isError: true };
      let pending: number;
      try {
        pending = recordObservation(storeFile(), ctx.cwd, text, new Date());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: error instanceof ObserverCommitUnknownError ? message : `Nothing was recorded: ${message}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Observation recorded. ${plural(pending, "observation")} ${pending === 1 ? "is" : "are"} pending for this project; the user's \`/observe\` reviews them.` }],
      };
    },
  });

  pi.registerCommand("observe", {
    description: "Review completed work and session evidence for improvements; text after the command adds a note",
    handler: async (args, ctx) => {
      if (!isObservable(ctx)) return;
      const note = args.trim();
      const cwd = ctx.cwd;
      const roots = defaultSkillRoots(cwd);
      const provenance = createProvenanceResolver(roots);
      const branch = ctx.sessionManager.getBranch();
      const sessionSource = activeSessionSource(ctx.sessionManager, branch);
      const digest = buildDigest(branch, { provenance });
      const stale = findStaleAmendments(ruleDirs(), provenance);
      let observations: readonly Observation[];
      let payload: ObservationPayload;
      try {
        const state = readPassState(cwd, new Date());
        observations = state.observations;
        if (!hasPassEvidence({ note, digest, stale, observations })) {
          ctx.ui.notify("Nothing to observe: no skill signals, loaded skills, completed work, stale amendments, pending observations or User note.", "info");
          return;
        }
        payload = observationPayload(cwd, { note, digest, stale, ...state, roots, provenance,
          sessionSource,
          catalog: catalogSummary(branch, ctx.sessionManager.getEntries(), catalogGap(branch)) });
      } catch (error) {
        ctx.ui.notify(`Observation pass not started: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (payload.retroUnavailable) ctx.ui.notify("Retro reference unavailable; evidence-backed discovery can continue.", "warning");
      await activatePassTools([REVIEW_TOOL_NAME], true);
      pi.sendMessage(
        {
          customType: OBSERVATION_MESSAGE_TYPE, content: payload.content, display: false, attribution: "user",
          details: { observationLeads: { cwd, sessionId: sessionSource.id, leads: payload.leads }, projectScope: projectScopeNote(note, branch) },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      try {
        markObservationsShown(storeFile(), observations, new Date());
      } catch (error) {
        ctx.ui.notify(`Observations not marked as shown: ${error instanceof Error ? error.message : String(error)}. They may appear in the next /observe.`, "warning");
      }
      refreshHint(undefined, ctx);
      ctx.ui.notify(
        `Observation pass started: ${note ? "your note, " : ""}${digest.signals.length} signal(s), ${digest.skills.length} loaded skill(s), ${stale.length} stale amendment(s), ${observations.length} observation(s); payload ${describePayloadEstimate(payload.estimate)}.`,
        "info",
      );
    },
  });

  pi.registerCommand("observe-report", {
    description: "Show this branch's evidence and initial payload estimate without starting an observation pass",
    handler: async (_args, ctx) => {
      if (!isObservable(ctx)) return;
      const roots = defaultSkillRoots(ctx.cwd);
      const provenance = createProvenanceResolver(roots);
      const branch = ctx.sessionManager.getBranch();
      const digest = buildDigest(branch, { provenance });
      const stale = findStaleAmendments(ruleDirs(), provenance);
      try {
        const { observations, ledger } = readPassState(ctx.cwd, new Date());
        const catalog = catalogSummary(branch, ctx.sessionManager.getEntries(), catalogGap(branch));
        const report = evidenceReport({
          digest, ledger, stale, observations: observations.length, catalog,
        });
        if (hasPassEvidence({ note: "", digest, stale, observations })) {
          report.payload = observationPayload(ctx.cwd, { note: "", digest, stale, observations, ledger, roots, provenance, catalog,
            sessionSource: activeSessionSource(ctx.sessionManager, branch) }).estimate;
        }
        ctx.ui.notify(renderEvidenceReport(report), "info");
      } catch (error) {
        ctx.ui.notify(`Evidence report not shown: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
