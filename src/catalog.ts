/**
 * Skill catalog observations (ADR 0020): the skills the host's standard
 * `<skills>` block listed in the system prompt `before_agent_start` saw, kept
 * in non-model custom entries for missed-trigger diagnosis. A definition holds
 * each distinct catalog once per branch; a binding marks where the branch
 * observed it. An observation is the hook's view, never proof of what the
 * model received: a later handler or provider hook may change the request.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "./omp.js";

export const CATALOG_DEFINITION_TYPE = "skill-observer-catalog";
export const CATALOG_BINDING_TYPE = "skill-observer-catalog-binding";

export interface CatalogSkill { name: string; description: string }

/** What a skills block yielded: its listed skills, no block at all, or a block not in the standard `- name: description` form. */
export type SkillsBlock = { status: "listed"; skills: CatalogSkill[] } | { status: "no-block" } | { status: "unsupported" };

/** `observed`: a standard block was parsed; `no-block` and `unsupported` leave which skills were listed unknown. */
export type CatalogCoverage = "observed" | "no-block" | "unsupported";

export interface CatalogDefinition {
  catalogId: string;
  format: "standard";
  coverage: CatalogCoverage;
  /** As rendered, never re-read from skill files. */
  entries: CatalogSkill[];
  limitations: string[];
}

export interface CatalogBinding {
  catalogId: string;
  /** The entry ID of the user message whose prompt the hook prepared. */
  observedAt: string;
  boundary: "before_agent_start";
}

/** The skills the host's standard `<skills>` block lists as `- name: description`. */
export function parseSkillsBlock(systemPrompt: readonly string[]): SkillsBlock {
  const block = /<skills>\n([\s\S]*?)\n<\/skills>/.exec(systemPrompt.join("\n"))?.[1];
  if (block === undefined) return { status: "no-block" };
  const listed = block.split("\n").map((line) => /^- ([^\s:]+): (.*)$/.exec(line));
  if (listed.some((line) => !line)) return { status: "unsupported" };
  return { status: "listed", skills: listed.map((line) => ({ name: line![1]!, description: line![2]! })) };
}

const HOOK_LIMITATION = "seen at before_agent_start: a later hook may replace the system prompt or the provider request, so this is not proof of what the model received";
const COVERAGE_LIMITATION: Record<CatalogCoverage, string | undefined> = {
  observed: undefined,
  "no-block": "the system prompt had no standard skills block: a custom prompt or no listed skills, so which skills were listed is unknown",
  unsupported: "the skills block was not the standard `- name: description` list, so which skills were listed is unknown",
};

function catalogDefinition(systemPrompt: readonly string[]): CatalogDefinition {
  const block = parseSkillsBlock(systemPrompt);
  const coverage: CatalogCoverage = block.status === "listed" ? "observed" : block.status;
  const entries = block.status === "listed" ? block.skills : [];
  const catalogId = createHash("sha256").update(JSON.stringify(["standard", coverage, entries])).digest("hex").slice(0, 16);
  return { catalogId, format: "standard", coverage, entries, limitations: [HOOK_LIMITATION, ...(COVERAGE_LIMITATION[coverage] ? [COVERAGE_LIMITATION[coverage]] : [])] };
}

/**
 * Stages the main agent's catalog at `before_agent_start` and records it once
 * that prompt's user message is on the branch: OMP may discard or re-run a
 * preparation, and a re-run replaces the staged one. Never changes the prompt,
 * returns a result or lets a failure reach the user's work.
 */
export function registerCatalogCapture(pi: ExtensionAPI, isObservable: (ctx: ExtensionContext) => boolean): void {
  let staged: { definition: CatalogDefinition; after: string | undefined } | undefined;
  pi.on("before_agent_start", (event, ctx) => {
    try {
      staged = undefined;
      // A revived subagent fires this hook too; its catalog is not the main agent's.
      if (event.reason === "revive" || !event.systemPrompt || !isObservable(ctx)) return;
      staged = { definition: catalogDefinition(event.systemPrompt), after: ctx.sessionManager.getBranch().at(-1)?.id };
    } catch (error) {
      console.error("skill-observer: staging the skill catalog failed:", error);
    }
  });
  pi.on("message_end", (_event, ctx) => {
    if (!staged) return;
    try {
      const branch = ctx.sessionManager.getBranch();
      const afterIndex = staged.after === undefined ? -1 : branch.findIndex((entry) => entry.id === staged!.after);
      if (staged.after !== undefined && afterIndex < 0) {
        staged = undefined;
        return;
      }
      const prompt = branch.slice(afterIndex + 1).find((entry) => entry.type === "message" && entry.message?.role === "user");
      if (!prompt?.id) return;
      const { definition } = staged;
      staged = undefined;
      const latest = catalogBindings(branch).at(-1);
      if (latest?.binding.catalogId === definition.catalogId) return;
      const definitionReachable = branch.some((entry) => entry.type === "custom" && entry.customType === CATALOG_DEFINITION_TYPE && (entry.data as CatalogDefinition).catalogId === definition.catalogId);
      if (!definitionReachable) pi.appendEntry(CATALOG_DEFINITION_TYPE, definition);
      pi.appendEntry(CATALOG_BINDING_TYPE, { catalogId: definition.catalogId, observedAt: prompt.id, boundary: "before_agent_start" } satisfies CatalogBinding);
    } catch (error) {
      staged = undefined;
      console.error("skill-observer: recording the skill catalog failed:", error);
    }
  });
  for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
    pi.on(event, () => { staged = undefined; });
  }
}

interface BoundCatalog { bindingId: string; binding: CatalogBinding; definitionId: string; definition: CatalogDefinition }

/** The branch's bindings in order, each with the definition before it on the branch; a binding whose definition isn't there is skipped. */
function catalogBindings(branch: readonly SessionEntry[]): BoundCatalog[] {
  const definitions = new Map<string, { id: string; definition: CatalogDefinition }>();
  const bound: BoundCatalog[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || !entry.id) continue;
    if (entry.customType === CATALOG_DEFINITION_TYPE) {
      const definition = entry.data as CatalogDefinition;
      definitions.set(definition.catalogId, { id: entry.id, definition });
    } else if (entry.customType === CATALOG_BINDING_TYPE) {
      const binding = entry.data as CatalogBinding;
      const found = definitions.get(binding.catalogId);
      if (found) bound.push({ bindingId: entry.id, binding, definitionId: found.id, definition: found.definition });
    }
  }
  return bound;
}

export interface CatalogSummary {
  observations: number;
  /** The latest observation; `skills` is absent when its coverage leaves the listed skills unknown. */
  latest?: { observedAt: string; skills?: number };
}

export function catalogSummary(branch: readonly SessionEntry[]): CatalogSummary {
  const bound = catalogBindings(branch);
  const latest = bound.at(-1);
  return {
    observations: bound.length,
    ...(latest && { latest: { observedAt: latest.binding.observedAt, ...(latest.definition.coverage === "observed" && { skills: latest.definition.entries.length }) } }),
  };
}

const describeLatest = ({ observedAt, skills }: NonNullable<CatalogSummary["latest"]>) =>
  `the latest, at entry \`${observedAt}\`, ${skills === undefined ? "left the listed skills unknown" : `listed ${skills} skill${skills === 1 ? "" : "s"}`}`;

/** The payload section: availability and lookup instructions, never the entries; empty without an observation. */
export function renderCatalogSummary(summary: CatalogSummary): string {
  if (!summary.latest) return "";
  return [
    "## Skill catalog observations",
    "",
    `${summary.observations} skill catalog observation${summary.observations === 1 ? "" : "s"} on this branch; ${describeLatest(summary.latest)}. ` +
      "Look up one skill by its exact name with `observer_review` `action: \"catalog\"` and `skill`. An observation is what the system prompt listed when the `before_agent_start` hook ran, not proof of what the model received.",
  ].join("\n");
}

/** The evidence report's one line. */
export function describeCatalogSummary(summary: CatalogSummary): string {
  return summary.latest ? `${summary.observations} on this branch; ${describeLatest(summary.latest)}` : "none on this branch (unknown)";
}

export interface CatalogMatch {
  observedAt: string;
  bindingId: string;
  definitionId: string;
  coverage: CatalogCoverage;
  /** `listed` with the rendered description, `not-listed` in an observed block, or `unknown` coverage. */
  status: "listed" | "not-listed" | "unknown";
  description?: string;
  limitations: string[];
}

export interface CatalogLookup { skill: string; matches: CatalogMatch[] }

/** Every observation on the branch, in order, as it bears on the skill named exactly `skill`. */
export function lookupCatalog(skill: unknown, branch: readonly SessionEntry[]): { lookup: CatalogLookup; text: string } {
  if (typeof skill !== "string" || !skill.trim()) throw new Error("A catalog lookup needs the exact skill name in `skill`");
  const name = skill.trim();
  const matches = catalogBindings(branch).map(({ bindingId, binding, definitionId, definition }): CatalogMatch => {
    const listed = definition.entries.find((entry) => entry.name === name);
    const status = definition.coverage !== "observed" ? "unknown" : listed ? "listed" : "not-listed";
    return { observedAt: binding.observedAt, bindingId, definitionId, coverage: definition.coverage, status, ...(listed && { description: listed.description }), limitations: definition.limitations };
  });
  if (matches.length === 0) {
    return { lookup: { skill: name, matches }, text: `No skill catalog observation on this branch: whether \`${name}\` was listed is unknown, not absent.` };
  }
  const line = (match: CatalogMatch) => `- At entry \`${match.observedAt}\` (binding \`${match.bindingId}\`, catalog \`${match.definitionId}\`): ${
    match.status === "listed" ? `listed as "${match.description}"`
    : match.status === "not-listed" ? "not in that observed skills block; another advertisement, such as a skill notice, may still have named it"
    : `unknown (${match.limitations.at(-1)})`}`;
  return {
    lookup: { skill: name, matches },
    text: [
      `Skill catalog observations of \`${name}\` on this branch, oldest first. Each is what the system prompt listed when the \`before_agent_start\` hook ran for the prompt at that entry, not proof of what the model received; descriptions are as observed then, not as installed now.`,
      ...matches.map(line),
    ].join("\n"),
  };
}
