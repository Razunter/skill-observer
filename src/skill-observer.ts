/**
 * skill-observer: end-of-session skill feedback for OMP.
 * Adapted from task-observer by Eoghan Henn / rebelytics.com (CC BY 4.0),
 * https://github.com/rebelytics/one-skill-to-rule-them-all
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  amendmentsDir,
  findStaleAmendments,
  migrateObserverRules,
  type ObserverRule,
  parseFrontmatter,
  readHandWrittenRules,
  readObserverRules,
  readOnReadAmendments,
  renderStaleAmendments,
  type RuleDirs,
  userRulesDir,
} from "./amendments.js";
import {
  buildDigest,
  isEmptyDigest,
  OBSERVATION_MESSAGE_TYPE,
  renderDigest,
  type SessionDigest,
  type SkillSignal,
} from "./digest.js";
import { type CatalogSummary, catalogSummary, registerCatalogCapture, renderCatalogSummary } from "./catalog.js";
import { registerAmendmentDelivery } from "./delivery.js";
import { harnessRootDirs, type LedgerRecord, ledgerForProject, readLedgerRows, renderLedger } from "./ledger.js";
import type { AskDetails, ExtensionAPI, ExtensionContext } from "./omp.js";
import {
  createProvenanceResolver,
  defaultSkillRoots,
  ompAgentDir,
  type ProvenanceResolver,
  type SkillRoots,
} from "./provenance.js";
import {
  activeGates, describePayloadEstimate, HOOK_CHECK_PATH, HOOKS_AND_COMPANION_PATH, INSTRUCTIONS_PATH, instructionText, type PayloadSection, payloadEstimate, type ToolResultCondition, whatToDoNow,
} from "./payload.js";
import { CHECK_TOOL_NAME, registerCheckTool } from "./replay.js";
import { RESOLVE_TOOL_NAME, registerResolveTool } from "./resolve.js";
import { rankingModelUnavailable, registerReviewTool, REVIEW_TOOL_NAME } from "./review.js";
import { renderRulesInForce, rulesInForce } from "./rules-in-force.js";
import { remedyOutcomes, renderRemedyOutcomes } from "./outcomes.js";
import { evidenceReport, isEmptyEvidenceReport, renderEvidenceReport } from "./report.js";
import { recordHookCall, recordHookResult } from "./session-tool-evidence.js";
import { countPendingObservations, markObservationsShown, type Observation, readPendingObservations, recordObservation, renderObservations } from "./observations.js";
import { ObserverCommitUnknownError, observerStorePath, readObserverStore } from "./observer-store.js";
import { hasApprovalNote, hasCustomInput, observationPassStart } from "./proposal-approval.js";

const STATUS_KEY = "skill-observer";
/** Global skills and scoped project state share one database per profile. */
const storeFile = () => observerStorePath(ompAgentDir());
/** Next to the ledger, outside the rules directory, so OMP never loads a reference file as a rule. */
const referencesDir = () => join(ompAgentDir(), "skill-observer", "references");
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

/** The evidence `/observe` gathered before it decided to start a pass. */
interface PassEvidence {
  note: string;
  digest: SessionDigest;
  stale: readonly ObserverRule[];
  /** The project's pending observations. */
  observations: readonly Observation[];
  ledger: readonly LedgerRecord[];
  roots: SkillRoots;
  provenance: ProvenanceResolver;
  catalog: CatalogSummary;
}

/** The message that starts an observation pass, by section; sections without text are left out. */
interface ObservationPayload {
  sections: PayloadSection[];
  content: string;
  /** The project gate is on and no installed `retro` could be read. */
  retroUnavailable: boolean;
}

/**
 * Assembles the observation payload: the instructions the evidence can reach,
 * then the note, digest, ledger, remedy outcomes, rules in force and the
 * sections their gates allow. `observer.md` is parsed on every run, so an
 * approved edit to it applies to the next pass. The directories it names are
 * resolved here, so profile overrides carry through. Throws when a gate
 * marker in `observer.md` is malformed.
 */
async function observationPayload(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  { note, digest, stale, observations, ledger, roots, provenance, catalog }: PassEvidence,
): Promise<ObservationPayload> {
  const hookDirs = harnessRootDirs(ctx.cwd, ompAgentDir());
  const inForce = rulesInForce(ledger, readObserverRules(ruleDirs()), digest, referencesDir());
  const onReadAmendments = readOnReadAmendments(amendmentsDir());
  const gates = activeGates({
    digest,
    stale,
    rulesInForce: inForce,
    note,
    observations,
    rankingAvailable: (await rankingModelUnavailable(pi, ctx).catch(() => "unreadable")) === undefined,
    onReadAmendmentFor: (skill) => onReadAmendments.some((rule) => rule.amends === skill),
    catalog,
  });
  const retro = gates.has("project") ? retroReference(provenance) : undefined;
  const sections: PayloadSection[] = [
    {
      name: "instructions",
      text: [
        instructionText(gates),
        "",
        `These observer instructions live in \`${INSTRUCTIONS_PATH}\`. Hook and companion procedure file: \`${HOOKS_AND_COMPANION_PATH}\`. Hook check script: \`${HOOK_CHECK_PATH}\`.`,
        `Skills directory: \`${roots.skillsDir}\`. Managed-skills directory: \`${roots.managedDir}\`. User rules directory: \`${userRulesDir()}\`. On-read amendments directory: \`${amendmentsDir()}\`. Reference files directory: \`${referencesDir()}\`. ` +
          `Project hooks directory: \`${hookDirs["project-hooks"]}\`. Global hooks directory: \`${hookDirs["global-hooks"]}\`. Companion extension directory: \`${hookDirs.companion}\`.`,
      ].join("\n"),
    },
    { name: "note", text: note && `## User note\n\n${note}` },
    { name: "digest", text: `## Session digest\n\n${renderDigest(digest)}` },
    { name: "observations", text: renderObservations(observations) },
    { name: "catalog", text: renderCatalogSummary(catalog) },
    { name: "ledger", text: renderLedger(ledger) },
    { name: "outcomes", text: renderRemedyOutcomes(remedyOutcomes(ledger, digest), ledger, digest) },
    { name: "rules-in-force", text: renderRulesInForce(inForce, readHandWrittenRules(userRulesDir())) },
    { name: "project", text: gates.has("project") ? projectSections(ctx.cwd, provenance) : "" },
    { name: "retro", text: retro?.text ?? "" },
    { name: "stale", text: stale.length > 0 ? renderStaleAmendments(stale, provenance) : "" },
  ];
  const present = sections.filter(({ text }) => text !== "");
  return { sections: present, content: present.map(({ text }) => text).join("\n\n"), retroUnavailable: retro?.available === false };
}

/** Project scope and the `correct` offer, which only a project-environment pass needs. */
function projectSections(cwd: string, provenance: ProvenanceResolver): string {
  const correct = provenance.byName("correct");
  return [
    `## Project scope\n\nCurrent project root: \`${realpathSync(cwd)}\`. Project proposals and check working directories stay under this root; a User note does not change it.`,
    `## Recurring mistake workflow\n\n${correct.kind !== "unknown" ? `The existing user-only skill is available at \`${correct.path}\`. If at least two distinct occurrences demonstrate the same mistake class, explain that class with its occurrence IDs and decisive evidence, and offer the user /skill:correct as a separate next action. Its remedy order is architecture, types/enforceable checks, tests, then docs. Read its instructions only as reference; disable-model-invocation: true means only the user may invoke it. Observer approval never authorizes invocation, remediation or commits. Merge evidence and offer each mechanism once; do not duplicate an ordinary proposal for that mechanism. Different mistakes or repeated descriptions of one event are not recurrence. With insufficient evidence or a non-fitting purpose, continue ordinary observation without an offer.` : "The correct skill is unavailable. Continue ordinary observation without offering it or emitting a skill reference."}`,
  ].join("\n\n");
}

/** The installed `retro` skill's body inline, framed for this pass, or the sentence saying it is unavailable. */
function retroReference(provenance: ProvenanceResolver): { text: string; available: boolean } {
  const retro = provenance.byName("retro");
  if (retro.kind !== "unknown") {
    try {
      const text = readFileSync(retro.path, "utf8");
      const body = parseFrontmatter(text)?.body ?? text.trim();
      return {
        available: true,
        text: `## Retrospective reference\n\nUse its candidate categories for project-environment findings; its own steps and Files section describe a standalone retrospective and do not apply.\n\n${body}`,
      };
    } catch (error) {
      console.error(`skill-observer: reading the retro skill at ${retro.path} failed:`, error);
    }
  }
  return {
    available: false,
    text: "## Retrospective reference\n\nRetro reference unavailable. Disclose this limitation; continue ordinary skill observation and evidence-backed project review using the remedy guidance above.",
  };
}

export default function skillObserver(pi: ExtensionAPI): void {
  try {
    migrateObserverRules(ruleDirs(), createProvenanceResolver(defaultSkillRoots(process.cwd())));
  } catch (error) {
    console.error("skill-observer: migrating amendment rules failed:", error);
  }
  registerAmendmentDelivery(pi, amendmentsDir);
  const catalogGap = registerCatalogCapture(pi, isObservable);
  pi.on("tool_call", async (event) => {
    try {
      recordHookCall(pi, event);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.on("tool_result", (event, ctx) => {
    const isReceiptTool = ["write", "edit", "bash", "manage_skill", "ask", REVIEW_TOOL_NAME].includes(event.toolName);
    recordHookResult(pi, event, ctx.sessionManager.getBranch());
    if (event.isError || !isReceiptTool || observationPassStart(ctx.sessionManager.getBranch()) === undefined) return;
    const details = event.toolName === "ask" ? event.details as AskDetails | undefined : undefined;
    const conditions: ToolResultCondition[] = [];
    if (hasCustomInput(details)) conditions.push("custom-input");
    if (hasApprovalNote(details)) conditions.push("approval-note");
    const guidance = conditions.length > 0 ? [{ type: "text", text: whatToDoNow(conditions) }] : [];
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
    if (observationPassStart(ctx.sessionManager.getBranch()) !== undefined) await activatePassTools();
  };
  pi.on("session_start", restorePass);
  pi.on("session_switch", restorePass);
  pi.on("session_branch", restorePass);
  pi.on("session_tree", restorePass);

  async function activatePassTools(): Promise<void> {
    const activeTools = pi.getActiveTools();
    const passTools = [RESOLVE_TOOL_NAME, CHECK_TOOL_NAME, REVIEW_TOOL_NAME].filter((name) => !activeTools.includes(name));
    if (passTools.length > 0) await pi.setActiveTools([...activeTools, ...passTools]);
  }

  registerResolveTool(pi, { storeFile, rulesDir: userRulesDir, amendmentsDir, referencesDir });
  registerCheckTool(pi);
  registerReviewTool(pi, { storeFile, rulesDir: userRulesDir, amendmentsDir, referencesDir }, catalogGap);

  pi.registerTool<{ text: string }, undefined>({
    name: "observe",
    label: "Observe",
    description:
      "Record an observation for the user's next `/observe` pass: something a skill, a rule or the project setup got wrong, or that cost you a detour. It fixes nothing now; record it and continue.",
    parameters: pi.zod.object({
      text: pi.zod.string().describe("One problem, up to 500 characters: what happened, where, and the fix you want."),
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
    description: "Review session evidence for skill improvements and project-environment fixes; text after the command adds a note",
    handler: async (args, ctx) => {
      if (!isObservable(ctx)) return;
      const note = args.trim();
      const roots = defaultSkillRoots(ctx.cwd);
      const provenance = createProvenanceResolver(roots);
      const branch = ctx.sessionManager.getBranch();
      const digest = buildDigest(branch, { provenance });
      const stale = findStaleAmendments(ruleDirs(), provenance);
      let observations: readonly Observation[];
      let payload: ObservationPayload;
      try {
        const state = readPassState(ctx.cwd, new Date());
        observations = state.observations;
        if (!note && isEmptyDigest(digest) && stale.length === 0 && observations.length === 0) {
          ctx.ui.notify("Nothing to observe: no skill signals, stale amendments or pending observations, and no note.", "info");
          return;
        }
        payload = await observationPayload(pi, ctx, { note, digest, stale, ...state, roots, provenance, catalog: catalogSummary(branch, ctx.sessionManager.getEntries(), catalogGap(branch)) });
      } catch (error) {
        ctx.ui.notify(`Observation pass not started: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (payload.retroUnavailable) ctx.ui.notify("Retro reference unavailable; ordinary skill observation remains usable.", "warning");
      await activatePassTools();
      pi.sendMessage(
        { customType: OBSERVATION_MESSAGE_TYPE, content: payload.content, display: false, attribution: "user" },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      try {
        markObservationsShown(storeFile(), observations, new Date());
      } catch (error) {
        ctx.ui.notify(`Observations not marked as shown: ${error instanceof Error ? error.message : String(error)}. They may appear in the next /observe.`, "warning");
      }
      refreshHint(undefined, ctx);
      ctx.ui.notify(
        `Observation pass started: ${note ? "your note, " : ""}${digest.signals.length} signal(s), ${digest.skills.length} loaded skill(s), ${stale.length} stale amendment(s), ${observations.length} observation(s); payload ${describePayloadEstimate(payloadEstimate(payload.sections))}.`,
        "info",
      );
    },
  });

  pi.registerCommand("observe-report", {
    description: "Show this branch's skill evidence and remedy outcomes without starting an observation pass",
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
        if (!isEmptyEvidenceReport(report)) {
          report.payload = payloadEstimate((await observationPayload(pi, ctx, { note: "", digest, stale, observations, ledger, roots, provenance, catalog })).sections);
        }
        ctx.ui.notify(renderEvidenceReport(report), "info");
      } catch (error) {
        ctx.ui.notify(`Evidence report not shown: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
