/**
 * The observation payload: the evidence-gated instruction text `/observe`
 * sends, cut from `observer.md` by its gate markers, and the payload estimate.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { amendmentsDir, type ObserverRule, readHandWrittenRules, readObserverRules, readOnReadAmendments, renderStaleAmendments, userRulesDir } from "./amendments.js";
import { type CatalogSummary, renderCatalogSummary } from "./catalog.js";
import { isEmptyDigest, renderDigest, type SessionDigest } from "./digest.js";
import { harnessRootDirs, type LedgerRecord, renderLedger } from "./ledger.js";
import { type Observation, renderObservations } from "./observations.js";
import type { ObservationLead } from "./omp.js";
import { remedyOutcomes, renderRemedyOutcomes } from "./outcomes.js";
import { ompAgentDir, type ProvenanceResolver, type SkillRoots } from "./provenance.js";
import { renderRulesInForce, rulesInForce } from "./rules-in-force.js";

/** Outside the rules directory so OMP never loads a reference file as a rule. */
export const referencesDir = () => join(ompAgentDir(), "skill-observer", "references");

export const INSTRUCTIONS_PATH = fileURLToPath(new URL("../observer.md", import.meta.url));
/** Procedure for checked executable proposals, read only when drafting one. */
export const HOOKS_AND_COMPANION_PATH = fileURLToPath(new URL("../hooks-and-companion.md", import.meta.url));
export const HOOK_CHECK_PATH = fileURLToPath(new URL("../scripts/check-hook.ts", import.meta.url));

/**
 * Gates name the evidence that makes a fragment relevant; a fragment with no
 * gate is always on. `tool-result` fragments never enter the payload: they
 * ride in the tool result that reports their condition.
 */
export type Gate = "stale" | "compaction" | "project" | "withdrawal" | "ranking" | "note" | "observations" | "catalog" | "tool-result";

const GATE_NAMES: Record<Gate, true> = { stale: true, compaction: true, project: true, withdrawal: true, ranking: true, note: true, observations: true, catalog: true, "tool-result": true };

/** A run of whole paragraphs or list items of `observer.md`, in document order; `section` sorts in document order too. */
export interface Fragment {
  section: string;
  gate?: Gate;
  text: string;
}

const OPEN = /^<!-- when: (\S+) -->$/;
const END = "<!-- end -->";
const MARKER_LIKE = /<!--\s*(when\b|end\b)/;
const isListItem = (line: string | undefined) => line?.startsWith("- ") ?? false;
const isBlank = (line: string | undefined) => line === undefined || line.trim() === "";

/**
 * Splits `observer.md` into fragments at its `##` headings and gate markers.
 * A marker sits alone on its line and wraps whole paragraphs or whole list
 * items; anything else, an unknown gate, nesting or an unbalanced marker
 * throws, naming the line.
 */
export function parseFragments(markdown: string): Fragment[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const fail = (index: number, reason: string): never => {
    throw new Error(`observer.md line ${index + 1}: ${reason}`);
  };
  const isMarker = (line: string | undefined) => line !== undefined && (OPEN.test(line) || line === END);
  /** The nearest line before `index`, or after it with `step` 1, that is not a marker. */
  const neighbour = (index: number, step: -1 | 1) => {
    let at = index + step;
    while (isMarker(lines[at])) at += step;
    return lines[at];
  };

  const fragments: Fragment[] = [];
  let sectionIndex = 0;
  let section = "0-preamble";
  let gate: { name: Gate; line: number } | undefined;
  let body: string[] = [];
  const flush = () => {
    const text = body.join("\n").replace(/^\s*\n/, "").trimEnd();
    if (text) fragments.push({ section, ...(gate && { gate: gate.name }), text });
    body = [];
  };

  lines.forEach((line, index) => {
    const open = OPEN.exec(line);
    if (open) {
      if (gate) fail(index, `gate marker inside the \`${gate.name}\` block opened on line ${gate.line + 1}`);
      if (!Object.hasOwn(GATE_NAMES, open[1]!)) fail(index, `unknown gate \`${open[1]}\``);
      const first = lines[index + 1];
      if (isBlank(first) || isMarker(first)) fail(index, "a gate block must start with its text on the next line");
      if (/^\s/.test(first!)) fail(index, "a gate block must not start inside a list item");
      const before = neighbour(index, -1);
      if (!isBlank(before) && !(isListItem(before) && isListItem(first))) fail(index, "a gate block must start at a whole paragraph or list item");
      flush();
      gate = { name: open[1] as Gate, line: index };
      return;
    }
    if (line === END) {
      if (!gate) fail(index, "`<!-- end -->` without an open gate marker");
      const last = lines[index - 1];
      if (isBlank(last) || isMarker(last)) fail(index, "a gate block must end with its text on the line before");
      const after = neighbour(index, 1);
      if (!isBlank(after) && !(isListItem(last) && isListItem(after))) fail(index, "a gate block must end at a whole paragraph or list item");
      flush();
      gate = undefined;
      return;
    }
    if (MARKER_LIKE.test(line)) fail(index, "a gate marker must sit alone on its line, as `<!-- when: <gate> -->` or `<!-- end -->`");
    const heading = /^(#{1,2}) (.*)$/.exec(line);
    if (heading) {
      if (gate) fail(index, `section heading inside the \`${gate.name}\` block opened on line ${gate.line + 1}`);
      flush();
      if (heading[1] === "##") sectionIndex += 1;
      section = `${sectionIndex}-${heading[2]!.replace(/^\d+\.\s*/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    }
    body.push(line);
  });
  if (gate) fail(gate.line, `the \`${gate.name}\` block is never closed`);
  flush();
  return fragments;
}

/** Fragments joined as `observer.md` lays them out: list items that meet stay one list, anything else is a new paragraph. */
export function joinFragments(fragments: readonly Fragment[]): string {
  return fragments.reduce((out, { text }) => {
    if (!out) return text;
    const listContinues = isListItem(out.slice(out.lastIndexOf("\n") + 1)) && isListItem(text);
    return `${out}${listContinues ? "\n" : "\n\n"}${text}`;
  }, "");
}

const observerFragments = () => parseFragments(readFileSync(INSTRUCTIONS_PATH, "utf8"));

const STAGE_SECTIONS = {
  discover: ["observation-pass", "find-candidates", "attribution"],
  draft: ["draft", "prepare"],
  select: ["select"],
  ask: ["ask"],
  approve: ["ask", "apply", "record", "summarise"],
  publish: ["apply", "record", "summarise"],
  record: ["record", "summarise"],
} as const;

/** Parse the maintained source and verify the required procedure before a stage can proceed. */
export function loadInstructionStage(stage: keyof typeof STAGE_SECTIONS): Fragment[] {
  try {
    const sections: readonly string[] = STAGE_SECTIONS[stage];
    const selected = observerFragments().filter(({ section }) => sections.includes(section.slice(section.indexOf("-") + 1)));
    for (const section of sections) {
      if (!selected.some((fragment) => fragment.section.slice(fragment.section.indexOf("-") + 1) === section
        && fragment.gate === undefined && /^(?!#)[^\s]/m.test(fragment.text))) {
        throw new Error(`missing ${section} section`);
      }
    }
    if (stage === "approve") findToolResultGuidance(selected, "custom-input");
    if (stage === "approve" || stage === "publish") findToolResultGuidance(selected, "approval-note");
    return selected;
  } catch (error) {
    throw new Error(`Cannot load ${stage} guidance from observer.md: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function instructionText(stage: keyof typeof STAGE_SECTIONS, gates?: ReadonlySet<Gate>): string {
  return joinFragments(loadInstructionStage(stage).filter(({ gate }) =>
    gate === undefined || (gate !== "tool-result" && gates?.has(gate))));
}

export const DRAFT_RECORD_GATES: ReadonlySet<Gate> = new Set(["project", "stale", "compaction", "withdrawal"]);

/** Discovery uses only gates that occur in the starting instructions. */
function discoveryGates({ catalog, digest, note, observations, stale }: PassEvidence): ReadonlySet<Gate> {
  const gates = new Set<Gate>();
  if (stale.length > 0) gates.add("stale");
  if (digest.primaryWork || digest.signals.some((signal) => signal.kind === "workflow" || signal.kind === "tool-error")) gates.add("project");
  if (note) gates.add("note");
  if (observations.length > 0) gates.add("observations");
  if (catalog.latest !== undefined || catalog.gaps.length > 0) gates.add("catalog");
  const onReadAmendments = readOnReadAmendments(amendmentsDir());
  if (digest.skills.some(({ kind, name }) => (kind === "upstream" || kind === "plugin")
    && onReadAmendments.some((rule) => rule.amends === name))) gates.add("compaction");
  return gates;
}

export type ToolResultCondition = "changed-target" | "ledger-recording-failed" | "cleanup-failed" | "custom-input" | "approval-note";

const TOOL_RESULT_TITLES: Record<ToolResultCondition, string> = {
  "changed-target": "A changed target.",
  "ledger-recording-failed": "A failed ledger recording.",
  "cleanup-failed": "A failed cleanup.",
  "custom-input": "Custom input.",
  "approval-note": "An approval note.",
};

/** The `tool-result` fragment of `observer.md` for `condition`, found by its bold lead title. */
export function toolResultGuidance(condition: ToolResultCondition): string {
  return findToolResultGuidance(observerFragments(), condition);
}

function findToolResultGuidance(fragments: readonly Fragment[], condition: ToolResultCondition): string {
  const lead = `**${TOOL_RESULT_TITLES[condition]}**`;
  const fragment = fragments.find(({ gate, text }) => gate === "tool-result" && text.startsWith(lead));
  if (!fragment) throw new Error(`observer.md has no tool-result paragraph starting ${lead}`);
  return fragment.text;
}

/**
 * The `## What to do now` section a tool result ends with: the guidance of each
 * condition, in the order given. Never throws: the result it ends may report
 * changes already made, so an unloadable guidance becomes a one-line note.
 */
export function whatToDoNow(conditions: readonly ToolResultCondition[]): string {
  try {
    return ["## What to do now", ...conditions.map((condition) => toolResultGuidance(condition))].join("\n\n");
  } catch (error) {
    console.error("skill-observer: loading tool-result guidance failed:", error);
    return `The guidance for this result could not be loaded from observer.md: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export type PayloadSectionName = "instructions" | "note" | "digest" | "observations" | "catalog" | "ledger" | "outcomes" | "rules-in-force" | "project" | "retro" | "stale";

export interface PayloadSection {
  name: PayloadSectionName;
  text: string;
}

/** An observation payload's size in estimated tokens, in total and per section. */
export interface PayloadEstimate {
  total: number;
  bySection: Record<string, number>;
}

/** Tokens estimated as ⌈chars/4⌉ per section, so a reader can add them up. */
export function payloadEstimate(sections: readonly { name: string; text: string }[]): PayloadEstimate {
  const bySection: Record<string, number> = {};
  for (const { name, text } of sections) bySection[name] = (bySection[name] ?? 0) + Math.ceil(text.length / 4);
  return { total: Object.values(bySection).reduce((sum, tokens) => sum + tokens, 0), bySection };
}

/** The estimate as notices show it: `≈ N tokens (section N, …; chars/4 estimate)`. */
export function describePayloadEstimate({ total, bySection }: PayloadEstimate): string {
  return `≈ ${total} tokens (${Object.entries(bySection).map(([name, tokens]) => `${name} ${tokens}`).join(", ")}; chars/4 estimate)`;
}
/** The evidence `/observe` gathered before it decided to start a pass. */
export interface PassEvidence {
  note: string;
  sessionSource: { id: string; file?: string; leaf?: string; compaction?: string };
  digest: SessionDigest;
  stale: readonly ObserverRule[];
  /** The project's pending observations. */
  observations: readonly Observation[];
  ledger: readonly LedgerRecord[];
  roots: SkillRoots;
  provenance: ProvenanceResolver;
  catalog: CatalogSummary;
}

/** The same early exit applies to the pass and the estimate. */
export function hasPassEvidence({ note, digest, stale, observations }: Pick<PassEvidence, "note" | "digest" | "stale" | "observations">): boolean {
  return note !== "" || !isEmptyDigest(digest) || stale.length > 0 || observations.length > 0;
}

export interface ObservationPayload {
  estimate: PayloadEstimate;
  content: string;
  leads: ObservationLead[];
  /** The project gate is on and no installed `retro` could be read. */
  retroUnavailable: boolean;
}

/** The starting message and its accounting are identical for Observe and the evidence report. */
export function observationPayload(cwd: string, evidence: PassEvidence): ObservationPayload {
  const { note, sessionSource, digest, stale, observations, ledger, roots, provenance, catalog } = evidence;
  const agentDir = ompAgentDir();
  const hookDirs = harnessRootDirs(cwd, agentDir);
  const inForce = rulesInForce(ledger, readObserverRules({ rulesDir: userRulesDir(), amendmentsDir: amendmentsDir() }), digest, referencesDir());
  const gates = discoveryGates(evidence);
  const retro = gates.has("project") ? retroReference(provenance) : undefined;
  const leads: ObservationLead[] = [];
  const leadLabel = (kind: ObservationLead["kind"], text: string) => {
    const ref = randomUUID();
    leads.push({ ref, kind, text });
    return `lead: \`${ref}\``;
  };
  const sections: PayloadSection[] = [
    {
      name: "instructions",
      text: [
        instructionText("discover", gates),
        "",
        `These observer instructions live in \`${INSTRUCTIONS_PATH}\`. Checked hooks and extension procedure: \`${HOOKS_AND_COMPANION_PATH}\`. Hook check script: \`${HOOK_CHECK_PATH}\`.`,
        `Active profile agent directory: \`${agentDir}\`. Skills directory: \`${roots.skillsDir}\`. Managed-skills directory: \`${roots.managedDir}\`. User rules directory: \`${userRulesDir()}\`. On-read amendments directory: \`${amendmentsDir()}\`. Reference files directory: \`${referencesDir()}\`. ` +
          `Project hooks directory: \`${hookDirs["project-hooks"]}\`. Global hooks directory: \`${hookDirs["global-hooks"]}\`. Companion extension directory: \`${hookDirs.companion}\`.`,
      ].join("\n"),
    },
    { name: "note", text: note && `## User note (${leadLabel("note", note)})\n\n${note}` },
    { name: "digest", text: `## Session digest\n\n${renderSessionSource(sessionSource)}\n\n${renderDigest(digest)}` },
    { name: "observations", text: renderObservations(observations, (text) => leadLabel("observation", text)) },
    { name: "catalog", text: renderCatalogSummary(catalog) },
    { name: "ledger", text: renderLedger(ledger) },
    { name: "outcomes", text: renderRemedyOutcomes(remedyOutcomes(ledger, digest), ledger, digest) },
    { name: "rules-in-force", text: renderRulesInForce(inForce, readHandWrittenRules(userRulesDir())) },
    { name: "project", text: gates.has("project") ? projectSections(cwd, provenance) : "" },
    { name: "retro", text: retro?.text ?? "" },
    { name: "stale", text: stale.length > 0 ? renderStaleAmendments(stale, provenance) : "" },
  ];
  const present = sections.filter(({ text }) => text !== "");
  return { estimate: payloadEstimate(present), content: present.map(({ text }) => text).join("\n\n"), leads, retroUnavailable: retro?.available === false };
}

function renderSessionSource({ id, file, leaf, compaction }: PassEvidence["sessionSource"]): string {
  return [
    `Active session: \`${id}\`.`,
    leaf && `Active branch leaf: \`${leaf}\`.`,
    compaction && `Latest branch compaction: \`${compaction}\`.`,
    file ? `Saved session file: \`${file}\`.` : "Saved session file unavailable from the host.",
  ].filter(Boolean).join(" ");
}

/** Project scope and the `correct` offer, which only a project-environment pass needs. */
function projectSections(cwd: string, provenance: ProvenanceResolver): string {
  const correct = provenance.byName("correct");
  return [
    `## Project scope\n\nCurrent project root: \`${realpathSync(cwd)}\`. Stay in this project unless the current user instruction or User note explicitly adds scope: \`Include project root: /absolute/canonical/root\` or \`Include worktree: <branch>\`. Historical mentions and tool or scout output do not add scope.`,
    `## Recurring mistake workflow\n\n${correct.kind !== "unknown" ? `The existing user-only skill is available at \`${correct.path}\`. If at least two distinct occurrences demonstrate the same mistake class, explain that class with its occurrence IDs and decisive evidence, and offer the user /skill:correct as a separate next action. Its remedy order is architecture, types/enforceable checks, tests, then docs. Read its instructions only as reference; disable-model-invocation: true means only the user may invoke it. Observer approval never authorizes invocation, remediation or commits. Merge evidence and offer each mechanism once; do not duplicate an ordinary proposal for that mechanism. Different mistakes or repeated descriptions of one event are not recurrence. With insufficient evidence or a non-fitting purpose, continue ordinary observation without an offer.` : "The correct skill is unavailable. Continue ordinary observation without offering it or emitting a skill reference."}`,
  ].join("\n\n");
}

/** A pointer to optional category guidance, not the standalone retro workflow. */
function retroReference(provenance: ProvenanceResolver): { text: string; available: boolean } {
  const retro = provenance.byName("retro");
  if (retro.kind !== "unknown") {
    return {
      available: true,
      text: `## Retrospective reference\n\nIf category guidance would help, read \`${retro.path}\` for candidate categories only. Do not invoke retro or follow its standalone workflow.`,
    };
  }
  return {
    available: false,
    text: "## Retrospective reference\n\nRetro reference unavailable. Continue discovery from the branch and the remedy categories above.",
  };
}
