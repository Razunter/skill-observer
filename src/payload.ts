/**
 * The observation payload: the evidence-gated instruction text `/observe`
 * sends, cut from `observer.md` by its gate markers, and the payload estimate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ObserverRule } from "./amendments.js";
import type { SessionDigest } from "./digest.js";
import type { SkillRulesInForce } from "./rules-in-force.js";

export const INSTRUCTIONS_PATH = fileURLToPath(new URL("../observer.md", import.meta.url));

/**
 * Gates name the evidence that makes a fragment relevant; a fragment with no
 * gate is always on. `tool-result` fragments never enter the payload: they
 * ride in the tool result that reports their condition.
 */
export type Gate = "stale" | "compaction" | "project" | "withdrawal" | "ranking" | "note" | "tool-result";

const GATE_NAMES: Record<Gate, true> = { stale: true, compaction: true, project: true, withdrawal: true, ranking: true, note: true, "tool-result": true };

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

/** What the extension knows at `/observe` time that decides which gated fragments the pass gets. */
export interface GateInput {
  digest: SessionDigest;
  stale: readonly ObserverRule[];
  rulesInForce: readonly SkillRulesInForce[];
  note: string;
  rankingAvailable: boolean;
  /** Whether the skill has an on-read amendment in the amendments directory. */
  onReadAmendmentFor(skill: string): boolean;
}

const GATE_EVIDENCE: Record<Exclude<Gate, "tool-result">, (input: GateInput) => boolean> = {
  stale: ({ stale }) => stale.length > 0,
  compaction: ({ digest, onReadAmendmentFor }) =>
    digest.skills.some((skill) => (skill.kind === "upstream" || skill.kind === "plugin") && onReadAmendmentFor(skill.name)),
  project: ({ digest }) => digest.signals.some((signal) => signal.kind === "workflow" || signal.kind === "tool-error"),
  withdrawal: ({ rulesInForce, note }) =>
    note !== "" || rulesInForce.some(({ rules, edits }) => edits.length > 0 || rules.some(({ fixes }) => fixes.length > 0)),
  ranking: ({ rankingAvailable }) => rankingAvailable,
  note: ({ note }) => note !== "",
};

/** The gates whose evidence is present; never `tool-result`. */
export function activeGates(input: GateInput): ReadonlySet<Gate> {
  return new Set(Object.entries(GATE_EVIDENCE).filter(([, present]) => present(input)).map(([gate]) => gate as Gate));
}

/** The always-on fragments of `observer.md` and those of the active gates, in document order; read on every call, so an edit applies to the next pass. */
export function instructionText(gates: ReadonlySet<Gate>): string {
  return joinFragments(observerFragments().filter(({ gate }) => gate === undefined || (gate !== "tool-result" && gates.has(gate))));
}

export type ToolResultCondition = "changed-target" | "ledger-append-failed" | "cleanup-failed" | "apply-note";

const TOOL_RESULT_TITLES: Record<ToolResultCondition, string> = {
  "changed-target": "A changed target.",
  "ledger-append-failed": "A failed ledger append.",
  "cleanup-failed": "A failed cleanup.",
  "apply-note": "A note on Apply.",
};

/** The `tool-result` fragment of `observer.md` for `condition`, found by its bold lead title. */
export function toolResultGuidance(condition: ToolResultCondition): string {
  const lead = `**${TOOL_RESULT_TITLES[condition]}**`;
  const fragment = observerFragments().find(({ gate, text }) => gate === "tool-result" && text.startsWith(lead));
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

export type PayloadSectionName = "instructions" | "note" | "digest" | "ledger" | "outcomes" | "rules-in-force" | "project" | "retro" | "stale";

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
