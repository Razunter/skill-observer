/**
 * Skill catalog observations (ADR 0020): the skills the system prompt's
 * `<skills>` block listed, in the host's standard or bundled custom-prompt
 * form, when `before_agent_start` saw it, kept in non-model custom entries for
 * missed-trigger diagnosis. A definition holds each distinct catalog once per
 * session; a binding marks where a branch observed it. Lookup applies OMP's
 * own persisted skill notices on top without copying them. An observation is
 * the hook's view, never proof of what the model received: a later handler or
 * provider hook may change the request.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "./omp.js";

export const CATALOG_DEFINITION_TYPE = "skill-observer-catalog";
export const CATALOG_BINDING_TYPE = "skill-observer-catalog-binding";
/** OMP's hidden message announcing skills gained, changed or lost since the system prompt and earlier notices. */
const SKILL_NOTICE_TYPE = "skill-notice";

export interface CatalogSkill { name: string; description: string }

/** `standard`: `- name: description` lines; `custom`: the bundled custom-prompt template's `<skill name="…">` elements. */
export type CatalogFormat = "standard" | "custom";

export type SkillsBlock =
  | { status: "listed"; format: CatalogFormat | "unknown"; skills: CatalogSkill[]; unrecognizedLines: number }
  | { status: "no-block" }
  | { status: "unsupported" };

const COVERAGES = ["observed", "partial", "no-block", "unsupported"] as const;
export type CatalogCoverage = (typeof COVERAGES)[number];

export interface CatalogDefinition {
  catalogId: string;
  format: CatalogFormat | "unknown";
  coverage: CatalogCoverage;
  entries: CatalogSkill[];
  limitations: string[];
}

export interface CatalogBinding {
  catalogId: string;
  /** The entry ID of the user message whose prompt the hook prepared. */
  observedAt: string;
  boundary: "before_agent_start";
  /** A capture failure since the previous observation on the branch, so what was listed in between is unknown. */
  afterGap?: string;
}

const STANDARD_ENTRY = /^- ([^\s:]+): (.*)$/;
const CUSTOM_ENTRY = /^<skill name="([^"\n]+)">\n([^\n]*)\n<\/skill>$/gm;
const CUSTOM_ENTRY_LINES = 3;

export function parseSkillsBlock(systemPrompt: readonly string[]): SkillsBlock {
  // The lazy optional body lets `<skills>\n</skills>` match as an empty block before any later closing tag.
  const match = /<skills>\n(?:([\s\S]*?)\n)??<\/skills>/.exec(systemPrompt.join("\n"));
  if (!match) return { status: "no-block" };
  const block = match[1] ?? "";
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  // An empty block, which neither host template renders, still lists no skill.
  if (lines.length === 0) return { status: "listed", format: "unknown", skills: [], unrecognizedLines: 0 };
  const standard = lines.flatMap((line) => {
    const entry = STANDARD_ENTRY.exec(line);
    return entry ? [{ name: entry[1]!, description: entry[2]! }] : [];
  });
  const custom = [...block.matchAll(CUSTOM_ENTRY)].map(([, name, description]) => ({ name: name!, description: description! }));
  const parsed = custom.length > standard.length
    ? { format: "custom" as const, skills: custom, lines: custom.length * CUSTOM_ENTRY_LINES }
    : { format: "standard" as const, skills: standard, lines: standard.length };
  if (parsed.skills.length === 0) return { status: "unsupported" };
  return { status: "listed", format: parsed.format, skills: parsed.skills, unrecognizedLines: lines.length - parsed.lines };
}

const HOOK_LIMITATION = "seen at before_agent_start: a later hook may replace the system prompt or the provider request, so this is not proof of what the model received";

function coverageLimitation(block: SkillsBlock): string | undefined {
  if (block.status === "no-block") return "the system prompt had no skills block in the standard or bundled custom-prompt form: a different prompt or no listed skills, so which skills were listed is unknown";
  if (block.status === "unsupported") return "the skills block had no entry in the standard or bundled custom-prompt form, so which skills were listed is unknown";
  if (block.unrecognizedLines > 0) {
    return `${block.unrecognizedLines} line${block.unrecognizedLines === 1 ? "" : "s"} of the skills block matched neither form: a skill outside the recognized entries is unknown, and a recognized description may continue there`;
  }
  return undefined;
}

function catalogDefinition(systemPrompt: readonly string[]): CatalogDefinition {
  const block = parseSkillsBlock(systemPrompt);
  const format = block.status === "listed" ? block.format : "unknown";
  const coverage: CatalogCoverage = block.status !== "listed" ? block.status : block.unrecognizedLines > 0 ? "partial" : "observed";
  const entries = block.status === "listed" ? block.skills : [];
  const catalogId = digest([format === "unknown" ? "standard" : format, coverage, entries]);
  const limitation = coverageLimitation(block);
  return { catalogId, format, coverage, entries, limitations: [HOOK_LIMITATION, ...(limitation ? [limitation] : [])] };
}

/** A user message's text as OMP joins it into the `before_agent_start` prompt. */
function userText(entry: SessionEntry): string | undefined {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  return content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

/** Whether `entry` is the staged prompt's user message: the prompt itself, or the first message of a batch OMP joined with blank lines. */
function isPromptMessage(entry: SessionEntry, prompt: string): boolean {
  if (entry.type !== "message" || entry.message?.role !== "user") return false;
  const text = userText(entry);
  return text !== undefined && (text === prompt || prompt.startsWith(`${text}\n\n`));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Stages the main agent's catalog at `before_agent_start` and records it once
 * that prompt's user message is on the branch: OMP may discard or re-run a
 * preparation, and a re-run replaces the staged one. Never changes the prompt,
 * returns a result or lets a failure reach the user's work. Returns, for a
 * branch, the observable capture failure since its last recorded observation,
 * which the next observation there records and is bound for even when
 * unchanged.
 */
export function registerCatalogCapture(pi: ExtensionAPI, isObservable: (ctx: ExtensionContext) => boolean): (branch: readonly SessionEntry[]) => string | undefined {
  let staged: { definition: CatalogDefinition; prompt: string; after: string | undefined } | undefined;
  // Each failure applies to the branches holding its anchor: the failed prompt's entry, else the branch tip when it failed.
  let gaps: Array<{ anchor: string | undefined; text: string }> = [];
  const gapsOn = (branch: readonly SessionEntry[]) => {
    const ids = new Set(branch.map(({ id }) => id));
    return gaps.filter(({ anchor }) => anchor === undefined || ids.has(anchor));
  };
  pi.on("before_agent_start", (event, ctx) => {
    staged = undefined;
    let after: string | undefined;
    try {
      // A revived subagent fires this hook too; its catalog is not the main agent's.
      if (event.reason === "revive" || !event.systemPrompt || !isObservable(ctx)) return;
      after = ctx.sessionManager.getBranch().at(-1)?.id;
      staged = { definition: catalogDefinition(event.systemPrompt), prompt: event.prompt, after };
    } catch (error) {
      // shortcut: anchored before the prompt's user message exists, so a sibling forked at that tip shares the gap; anchor it to the prompt's entry if that misleads.
      gaps.push({ anchor: after, text: `capture failed while staging a prompt's catalog: ${errorText(error)}` });
      console.error("skill-observer: staging the skill catalog failed:", error);
    }
  });
  pi.on("message_end", (_event, ctx) => {
    if (!staged) return;
    let anchor: string | undefined;
    let observedAt: string | undefined;
    try {
      const branch = ctx.sessionManager.getBranch();
      anchor = branch.at(-1)?.id;
      const afterIndex = staged.after === undefined ? -1 : branch.findIndex((entry) => entry.id === staged!.after);
      if (staged.after !== undefined && afterIndex < 0) {
        staged = undefined;
        return;
      }
      // Tied to its prompt's text, so a user message from another attempt never takes a discarded preparation.
      const prompt = branch.slice(afterIndex + 1).find((entry) => isPromptMessage(entry, staged!.prompt));
      if (!prompt?.id) return;
      observedAt = anchor = prompt.id;
      const { definition } = staged;
      staged = undefined;
      const { bound, definitions } = catalogBindings(branch, ctx.sessionManager.getEntries());
      const latest = bound.at(-1);
      const recovered = gapsOn(branch);
      const gap = recovered.at(-1)?.text;
      // After a /clear OMP rebuilds the system prompt, so the next observation is bound again even when unchanged.
      const cleared = branch.findLastIndex((entry) => entry.type === "reset_boundary") > (latest?.index ?? -1);
      if (!gap && !cleared && latest?.binding.catalogId === definition.catalogId) return;
      if (!definitions.has(definition.catalogId)) pi.appendEntry(CATALOG_DEFINITION_TYPE, definition);
      pi.appendEntry(CATALOG_BINDING_TYPE, { catalogId: definition.catalogId, observedAt, boundary: "before_agent_start", ...(gap && { afterGap: gap }) } satisfies CatalogBinding);
      gaps = gaps.filter((pending) => !recovered.includes(pending));
    } catch (error) {
      staged = undefined;
      gaps.push({ anchor, text: `capture failed while recording the catalog${observedAt ? ` for the prompt at entry \`${observedAt}\`` : ""}: ${errorText(error)}` });
      console.error("skill-observer: recording the skill catalog failed:", error);
    }
  });
  for (const event of ["session_branch", "session_tree"] as const) pi.on(event, () => { staged = undefined; });
  pi.on("session_switch", () => {
    staged = undefined;
    gaps = [];
  });
  return (branch) => gapsOn(branch).at(-1)?.text;
}

/**
 * `promptIndex` is where the observation was made: its prompt's user message, or the binding itself when that message isn't on the branch.
 * `noticesFrom` is where its skill notices may start: OMP saves the notices delivered with a prompt just before its user message.
 */
interface BoundCatalog { index: number; promptIndex: number; noticesFrom: number; bindingId: string; binding: CatalogBinding; definitionId: string; definition: CatalogDefinition }

interface CatalogHistory { bound: BoundCatalog[]; definitions: Map<string, { id: string; definition: CatalogDefinition }>; unavailable: Array<{ index: number; text: string }> }

/** The active branch's bindings, each resolved against a definition anywhere in `session`: content is stored once per session, but only a binding on the branch shows that the branch observed it. */
function catalogBindings(branch: readonly SessionEntry[], session: readonly SessionEntry[]): CatalogHistory {
  const definitions: CatalogHistory["definitions"] = new Map();
  for (const entry of session) {
    if (entry.type !== "custom" || entry.customType !== CATALOG_DEFINITION_TYPE || !entry.id || !isCatalogDefinition(entry.data)) continue;
    if (!definitions.has(entry.data.catalogId)) definitions.set(entry.data.catalogId, { id: entry.id, definition: entry.data });
  }
  const bound: BoundCatalog[] = [];
  const unavailable: CatalogHistory["unavailable"] = [];
  const positions = new Map<string, number>();
  for (const [index, entry] of branch.entries()) {
    if (entry.id) positions.set(entry.id, index);
    if (entry.type !== "custom" || !entry.id) continue;
    if (entry.customType === CATALOG_DEFINITION_TYPE) {
      if (!isCatalogDefinition(entry.data)) unavailable.push({ index, text: `the catalog definition at entry \`${entry.id}\` is malformed, so an observation bound to it is unavailable` });
    } else if (entry.customType === CATALOG_BINDING_TYPE) {
      const binding = entry.data;
      if (!isCatalogBinding(binding)) {
        unavailable.push({ index, text: `the catalog binding at entry \`${entry.id}\` is malformed, so what the system prompt listed there is unknown` });
        continue;
      }
      const found = definitions.get(binding.catalogId);
      if (!found) {
        unavailable.push({ index, text: `the observation at entry \`${binding.observedAt}\` (binding \`${entry.id}\`) refers to catalog \`${binding.catalogId}\`, whose definition is not in this session, so that observation is unavailable` });
        continue;
      }
      const promptIndex = positions.get(binding.observedAt);
      let noticesFrom = promptIndex ?? index;
      while (promptIndex !== undefined && noticesFrom > 0 && branch[noticesFrom - 1]!.type === "custom_message") noticesFrom--;
      bound.push({ index, promptIndex: promptIndex ?? index, noticesFrom, bindingId: entry.id, binding, definitionId: found.id, definition: found.definition });
    }
  }
  return { bound, definitions, unavailable };
}

const isCatalogDefinition = (data: unknown): data is CatalogDefinition =>
  isRecord(data) && typeof data.catalogId === "string" && COVERAGES.includes(data.coverage as CatalogCoverage) &&
  Array.isArray(data.entries) && data.entries.every((entry) => isRecord(entry) && typeof entry.name === "string" && typeof entry.description === "string") &&
  Array.isArray(data.limitations) && data.limitations.every((limitation) => typeof limitation === "string");

const isCatalogBinding = (data: unknown): data is CatalogBinding =>
  isRecord(data) && typeof data.catalogId === "string" && typeof data.observedAt === "string" && (data.afterGap === undefined || typeof data.afterGap === "string");

/** A known gap and the branch indexes it may cover. */
interface KnownGap { text: string; after: number; through: number }

/** The known gaps: unavailable entries, each capture failure recorded before a later observation, then one not yet followed by an observation. */
function captureGaps({ bound, unavailable }: CatalogHistory, pending: string | undefined): KnownGap[] {
  return [
    ...unavailable.map(({ index, text }) => ({ text, after: index - 1, through: index })),
    ...bound.flatMap(({ binding, index }, at) => binding.afterGap
      ? [{ text: `${binding.afterGap}; what the system prompt listed before the observation at entry \`${binding.observedAt}\` is unknown back to the previous one`, after: bound[at - 1]?.index ?? -1, through: index }]
      : []),
    ...(pending ? [{ text: `${pending}; what the system prompt listed since the latest observation is unknown until the next one`, after: bound.at(-1)?.index ?? -1, through: Infinity }] : []),
  ];
}

export interface CatalogSummary {
  observations: number;
  latest?: { observedAt: string; skills?: number };
  gaps: string[];
}

export function catalogSummary(branch: readonly SessionEntry[], session: readonly SessionEntry[], pendingGap?: string): CatalogSummary {
  const history = catalogBindings(branch, session);
  const latest = history.bound.at(-1);
  return {
    observations: history.bound.length,
    ...(latest && { latest: { observedAt: latest.binding.observedAt, ...(latest.definition.coverage === "observed" && { skills: latest.definition.entries.length }) } }),
    gaps: captureGaps(history, pendingGap).map(({ text }) => text),
  };
}

const describeLatest = ({ observedAt, skills }: NonNullable<CatalogSummary["latest"]>) =>
  `the latest, at entry \`${observedAt}\`, ${skills === undefined ? "left the listed skills unknown" : `listed ${skills} skill${skills === 1 ? "" : "s"}`}`;

export function renderCatalogSummary(summary: CatalogSummary): string {
  if (!summary.latest && summary.gaps.length === 0) return "";
  return [
    "## Skill catalog observations",
    "",
    `${summary.latest ? `${summary.observations} skill catalog observation${summary.observations === 1 ? "" : "s"} on this branch; ${describeLatest(summary.latest)}.` : "No skill catalog observation on this branch."} ` +
      "Look a skill up with `observer_review` `action: \"catalog\"`: by its exact name in `skill`, or by words its description must all contain in `terms`; `at` narrows it to the latest observation at or before an entry, and results come in pages with a `cursor`. An observation is what the system prompt listed when the `before_agent_start` hook ran, with OMP's later skill notices applied while they stayed in context, not proof of what the model received.",
    ...summary.gaps.map(gapLine),
  ].join("\n");
}

const gapLine = (gap: string) => `- Known gap: ${gap}.`;

export function describeCatalogSummary(summary: CatalogSummary): string {
  const observed = summary.latest ? `${summary.observations} on this branch; ${describeLatest(summary.latest)}` : "none on this branch (unknown)";
  return [observed, ...summary.gaps].join("; ");
}

interface SkillState {
  status: "listed" | "not-listed" | "unknown";
  description?: string;
  reason?: string;
}

export interface CatalogMatch {
  skill: string;
  observedAt: string;
  bindingId: string;
  definitionId: string;
  coverage: CatalogCoverage;
  at: string;
  via: "catalog" | "skill-notice" | "compaction" | "reset";
  status: SkillState["status"];
  description?: string;
  reason?: string;
  limitations: string[];
}

export interface CatalogQuery { skill?: string; terms?: string[]; at?: string; limit?: number; cursor?: string }

export interface CatalogLookup { skill?: string; terms?: string[]; at?: string; matches: CatalogMatch[]; gaps: string[]; total: number; next?: string }

const PAGE_SIZE = 20;

export function lookupCatalog(query: CatalogQuery, branch: readonly SessionEntry[], session: readonly SessionEntry[], pendingGap?: string): { lookup: CatalogLookup; text: string } {
  const name = query.skill?.trim() ?? "";
  const terms = (query.terms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean);
  if (!name && terms.length === 0) throw new Error("A catalog lookup needs the exact skill name in `skill` or non-blank description words in `terms`; it never lists the whole catalog");
  if (name && query.terms !== undefined) throw new Error("A catalog lookup takes either the exact skill name in `skill` or description words in `terms`, not both");
  const limit = query.limit ?? PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("`limit` is the page size, a whole number of at least 1");
  const history = catalogBindings(branch, session);
  let gaps = captureGaps(history, pendingGap);
  let scope = history.bound.map((catalog, at) => ({ catalog, end: history.bound[at + 1]?.noticesFrom ?? branch.length }));
  if (query.at !== undefined) {
    const point = branch.findIndex((entry) => entry.id === query.at);
    if (point < 0) throw new Error(`Entry \`${query.at}\` is not on the active branch; \`at\` takes the exact ID of an entry on this branch`);
    const latest = scope.findLast(({ catalog }) => catalog.promptIndex <= point);
    const latestIndex = latest?.catalog.index ?? -1;
    gaps = gaps.filter(({ after, through }) => after < point && through > latestIndex);
    scope = latest ? [{ catalog: latest.catalog, end: Math.min(latest.end, point + 1) }] : [];
  }
  const describes = (match: CatalogMatch) => terms.every((term) => match.description?.toLowerCase().includes(term));
  const all = scope.flatMap(({ catalog, end }) => (name ? [name] : skillNames(branch, catalog, end))
    .flatMap((skill) => skillHistory(skill, branch, catalog, end))
    .filter((match) => name || describes(match)));

  const queryKey = digest([name, terms, query.at ?? null]);
  // A definition saved on another branch can resolve a binding here, so the resolved definitions are evidence too.
  const revision = digest([pendingGap ?? null, branch.filter(isCatalogEvidence), history.bound.map(({ definitionId }) => definitionId)]);
  const offset = query.cursor === undefined ? 0 : cursorOffset(query.cursor, queryKey, revision, all.length);
  const matches = all.slice(offset, offset + limit);
  const remaining = all.length - offset - matches.length;
  const next = remaining > 0 ? `${offset + matches.length}.${queryKey}.${revision}` : undefined;
  const lookup: CatalogLookup = { ...(name ? { skill: name } : { terms }), ...(query.at !== undefined && { at: query.at }), matches, gaps: gaps.map(({ text }) => text), total: all.length, ...(next && { next }) };

  const gapLines = lookup.gaps.map(gapLine);
  const where = query.at === undefined ? "on this branch" : `on this branch at or before entry \`${query.at}\``;
  const wanted = terms.map((term) => `"${term}"`).join(", ");
  if (all.length === 0) {
    const miss = name ? `No skill catalog observation ${where}: whether \`${name}\` was listed is unknown, not absent.`
      : `No skill catalog observation ${where} lists or announces a skill whose description contains every one of ${wanted}. That is not evidence no such skill existed: only the descriptions the hook observed on this branch are searched, coverage may be partial or unknown, a gap may hide one, and other wording would not match.`;
    return { lookup, text: [miss, ...gapLines].join("\n") };
  }
  const resolved = scope[0]?.catalog.binding.observedAt;
  return {
    lookup,
    text: [
      `${name ? `Skill catalog observations of \`${name}\`` : `Skill catalog entries whose rendered description contains every one of ${wanted}, case-insensitively,`} ${where}, ordered by observation then skill name, each followed by what OMP's later skill notices, compactions and \`/clear\` resets changed${name ? "" : " while it still matched; look a skill up by its exact name for its whole history"}. Each observation is what the system prompt listed when the \`before_agent_start\` hook ran for the prompt at that entry, not proof of what the model received; descriptions are as rendered then, not as installed now.`,
      ...(query.at === undefined ? [] : [`The latest observation at or before entry \`${query.at}\` is at entry \`${resolved}\`. It observed that one prompt, not each request up to \`${query.at}\`: an unchanged catalog records no new observation, and a capture gap leaves a request unobserved.`]),
      ...matches.map(describeMatch),
      ...(all.length > matches.length ? [`Results ${offset + 1}–${offset + matches.length} of ${all.length}.${next ? ` ${remaining} more: repeat this query with \`cursor: "${next}"\`.` : ""}`] : []),
      ...gapLines,
    ].join("\n"),
  };
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const isCatalogEvidence = (entry: SessionEntry) =>
  (entry.type === "custom" && (entry.customType === CATALOG_DEFINITION_TYPE || entry.customType === CATALOG_BINDING_TYPE)) ||
  (entry.type === "custom_message" && entry.customType === SKILL_NOTICE_TYPE) || entry.type === "compaction" || entry.type === "reset_boundary";

function cursorOffset(cursor: string, queryKey: string, revision: string, total: number): number {
  const [offset, key, at] = cursor.split(".");
  if (key !== queryKey) throw new Error("This `cursor` continues a different catalog query; repeat that query's `skill`, `terms` and `at` exactly, or search again without `cursor`");
  if (at !== revision) throw new Error("The branch's catalog evidence changed since this search began (an observation, skill notice, compaction, `/clear` reset or capture gap), so continuing could skip or repeat results; search again without `cursor`");
  const start = Number(offset);
  if (!Number.isInteger(start) || start < 1 || start >= total) throw new Error("This `cursor` is malformed; search again without `cursor`");
  return start;
}

function skillNames(branch: readonly SessionEntry[], catalog: BoundCatalog, end: number): string[] {
  const names = new Set(catalog.definition.entries.map(({ name }) => name));
  for (const entry of branch.slice(catalog.noticesFrom, end)) {
    if (entry.type !== "custom_message" || entry.customType !== SKILL_NOTICE_TYPE) continue;
    const notice = parseNotice(entry);
    if ("states" in notice) for (const skill of notice.states.keys()) names.add(skill);
  }
  return [...names].sort();
}

function describeMatch(match: CatalogMatch): string {
  const where = match.via === "catalog" ? `at entry \`${match.observedAt}\` (binding \`${match.bindingId}\`, catalog \`${match.definitionId}\`)`
    : match.via === "skill-notice" ? `at entry \`${match.at}\`, a skill notice after the observation at \`${match.observedAt}\``
    : match.via === "compaction" ? `at compaction \`${match.at}\`, after the observation at \`${match.observedAt}\``
    : `at reset boundary \`${match.at}\` (\`/clear\`), after the observation at \`${match.observedAt}\``;
  const state = match.status === "listed" ? `listed as "${match.description}"`
    : match.status === "not-listed" ? `not listed (${match.reason ?? "not in that observed skills block; another advertisement may still have named it"})`
    : `unknown (${match.reason})${match.description === undefined ? "" : `; its rendered description reads "${match.description}"`}`;
  return `- \`${match.skill}\` ${where}: ${state}`;
}

function skillHistory(name: string, branch: readonly SessionEntry[], catalog: BoundCatalog, end: number): CatalogMatch[] {
  const { binding, bindingId, definitionId, definition } = catalog;
  const match = (at: string, via: CatalogMatch["via"], state: SkillState): CatalogMatch =>
    ({ skill: name, observedAt: binding.observedAt, bindingId, definitionId, coverage: definition.coverage, at, via, ...state, limitations: definition.limitations });
  let base = catalogState(definition, name);
  const history = [match(binding.observedAt, "catalog", base)];
  const notices: Array<{ index: number; id: string; state: SkillState }> = [];
  let current = base;
  for (let index = catalog.noticesFrom; index < end; index++) {
    const entry = branch[index]!;
    const id = entry.id ?? "(no id)";
    if (entry.type === "custom_message" && entry.customType === SKILL_NOTICE_TYPE) {
      const state = noticeState(entry, name);
      if (!state) continue;
      notices.push({ index, id, state });
      current = state;
      history.push(match(id, "skill-notice", state));
    } else if (entry.type === "reset_boundary") {
      // OMP's context build starts after the latest /clear boundary and the system prompt is rebuilt, so earlier notices are gone.
      notices.length = 0;
      base = { status: "unknown", reason: "a `/clear` dropped the context and OMP rebuilt the system prompt, so what it lists is unknown until the next observation" };
      current = base;
      history.push(match(id, "reset", base));
    } else if (entry.type === "compaction") {
      const next = stateAfterCompaction(base, notices, { index, entry }, branch);
      if (!sameState(next, current)) history.push(match(id, "compaction", next));
      current = next;
    }
  }
  return history;
}

function catalogState(definition: CatalogDefinition, name: string): SkillState {
  const listed = definition.entries.filter((entry) => entry.name === name);
  if (listed.length > 1) return { status: "unknown", reason: "the observed skills block lists it more than once" };
  if (listed[0]) return { status: "listed", description: listed[0].description };
  if (definition.coverage === "observed") return { status: "not-listed" };
  return { status: "unknown", reason: definition.limitations.at(-1) };
}

const sameState = (a: SkillState, b: SkillState) => a.status === b.status && a.description === b.description && a.reason === b.reason;

/**
 * The skill's state once the latest compaction applies, mirroring OMP's
 * context build: a notice before it stays only inside its kept range (from
 * `firstKeptEntryId` up to the compaction); one a provider payload or a
 * context rollover may hold leaves the state unknown.
 */
function stateAfterCompaction(
  base: SkillState,
  notices: ReadonlyArray<{ index: number; id: string; state: SkillState }>,
  compaction: { index: number; entry: SessionEntry },
  branch: readonly SessionEntry[],
): SkillState {
  const { held, keptFrom } = compactionRetention(compaction, branch);
  let state = base;
  let dropped: string | undefined;
  for (const notice of notices) {
    if (notice.index > compaction.index || notice.index >= keptFrom) state = notice.state;
    else if (held) state = { status: "unknown", reason: `notice coverage is unknown after this compaction: ${held}, so whether the skill notice at entry \`${notice.id}\` stayed in context is unknown until a later notice names the skill` };
    else dropped = notice.id;
  }
  if (!dropped || state !== base) return state;
  return {
    ...base,
    reason: `the skill notice at entry \`${dropped}\` is out of context after this compaction, and OMP announces changed skills again only with the next user-queued message, so until then the context shows ${base.status === "listed" ? "the observed catalog's description" : base.status === "not-listed" ? "no listing" : "only the observed catalog"}${base.reason ? `; ${base.reason}` : ""}`,
  };
}

/** Which notices before a compaction OMP keeps in context: those from `keptFrom`, or, when `held` says why, those a provider payload or rollover may hold. */
function compactionRetention({ index, entry }: { index: number; entry: SessionEntry }, branch: readonly SessionEntry[]): { held?: string; keptFrom: number } {
  if (entry.details?.kind === "experimental-context-rollover") return { held: "a context rollover keeps only the latest request", keptFrom: index };
  if (isRecord(entry.preserveData?.openaiRemoteCompaction)) return { held: "the provider replays the kept turns from its own payload", keptFrom: index };
  const before = (id: string | undefined) => (id ? branch.findIndex((candidate, at) => at < index && candidate.id === id) : -1);
  if (!entry.firstKeptEntryId && isRecord(entry.preserveData?.anthropicCompaction)) {
    const replayedThrough = before(entry.providerReplayThroughEntryId);
    return { held: "the provider replays the earlier turns from its own payload", keptFrom: replayedThrough < 0 ? index : replayedThrough + 1 };
  }
  const firstKept = before(entry.firstKeptEntryId);
  return { keptFrom: firstKept < 0 ? index : firstKept };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const NOTICE_SECTIONS: Record<string, "announced" | "removed"> = {
  "Now available:": "announced",
  "Updated (this description replaces the earlier one):": "announced",
  "No longer available:": "removed",
};
const REMOVED_ENTRY = /^- `([^`]+)`$/;

function noticeState(entry: SessionEntry, name: string): SkillState | undefined {
  const notice = parseNotice(entry);
  if ("opaque" in notice) return { status: "unknown", reason: `the skill notice ${notice.opaque}, so whether it named the skill is unknown` };
  return notice.states.get(name);
}

function parseNotice(entry: SessionEntry): { states: Map<string, SkillState> } | { opaque: string } {
  const content: unknown = entry.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("")
    : undefined;
  if (text === undefined) return { opaque: "has no text" };
  const lines = text.trim().split("\n");
  if (lines[0] !== "<system-notice id=\"skills\">" || !lines[1]?.startsWith("Skills changed this session.") || lines.at(-1) !== "</system-notice>") {
    return { opaque: "is not in OMP's skill notice form" };
  }
  const rendered = new Map<string, { removed: boolean; description?: string; ambiguous?: string }>();
  let section: "announced" | "removed" | undefined;
  let last: string | undefined;
  for (const line of lines.slice(2, -1)) {
    if (NOTICE_SECTIONS[line]) {
      section = NOTICE_SECTIONS[line];
      last = undefined;
      continue;
    }
    const announced = section === "announced" ? STANDARD_ENTRY.exec(line) : null;
    const removed = section === "removed" ? REMOVED_ENTRY.exec(line) : null;
    const listed = announced?.[1] ?? removed?.[1];
    if (listed) {
      const earlier = rendered.get(listed);
      rendered.set(listed, earlier ? { ...earlier, ambiguous: "the skill notice names it more than once" } : { removed: !announced, ...(announced && { description: announced[2]! }) });
      last = listed;
      continue;
    }
    if (last === undefined) return { opaque: "has a line outside OMP's skill notice form" };
    rendered.set(last, { ...rendered.get(last)!, ambiguous: "a line after it in the skill notice is outside OMP's form, so its description may continue there" });
  }
  const structured = structuredNotice(entry.details);
  const conflict = "its rendered text and structured details disagree, so the attribution is unknown";
  const states = new Map<string, SkillState>();
  for (const [skill, shown] of rendered) {
    const recorded = structured?.get(skill);
    const disagrees = structured !== undefined && (recorded === undefined || recorded.removed !== shown.removed || recorded.description !== shown.description);
    const reason = shown.ambiguous ?? (disagrees ? conflict : undefined);
    states.set(skill, reason ? { status: "unknown", ...(shown.description !== undefined && { description: shown.description }), reason }
      : shown.removed ? { status: "not-listed", reason: "the skill notice lists it as no longer available" }
      : { status: "listed", description: shown.description! });
  }
  for (const skill of structured?.keys() ?? []) {
    if (!rendered.has(skill)) states.set(skill, { status: "unknown", reason: conflict });
  }
  return { states };
}

/** A notice's `announced`/`removed` details by skill, read as OMP reads them; `undefined` when they aren't in that shape. */
function structuredNotice(details: unknown): Map<string, { removed: boolean; description?: string }> | undefined {
  if (!isRecord(details) || !Array.isArray(details.announced) || !Array.isArray(details.removed)) return undefined;
  const skills = new Map<string, { removed: boolean; description?: string }>();
  for (const entry of details.announced) {
    if (isRecord(entry) && typeof entry.name === "string" && typeof entry.description === "string") skills.set(entry.name, { removed: false, description: entry.description });
  }
  for (const skill of details.removed) if (typeof skill === "string") skills.set(skill, { removed: true });
  return skills;
}
