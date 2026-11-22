import { YAML } from "bun";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalInstalledCopyTarget, canonicalMissingPath, canonicalProfileTarget, type ProfileTarget } from "./ledger.js";
import { checkScalarFileState, fileId, prepareScalarFile, type ScalarFileEdit } from "./project-publication.js";
import { createProvenanceResolver, defaultSkillRoots, type SkillProvenance } from "./provenance.js";
import { CHECK_TOOL_NAME, replayCase, type PatternDraft } from "./replay.js";
import type { SessionToolEvidence } from "./session-tool-evidence.js";

export type ProfileCheck =
  | { kind: "content"; contains: string; excludes?: string; installedCopy?: { skill: string; why: string } }
  | { kind: "pattern"; replayToolCallId: string }
  | { kind: "skill-control"; skill: string; mode: "manual-only" | "disable" };

export interface ProfileEdit extends ScalarFileEdit {
  operation: "profile-edit";
  profileRootId: string;
  text: string;
  afterHash: string;
  verification: string;
  installedCopy?: Extract<SkillProvenance, { kind: "upstream" | "plugin" }>;
}

export function prepareProfileEdit(requestedTarget: ProfileTarget, text: string, check: ProfileCheck, evidence: SessionToolEvidence,
    passStart: number | undefined, inspection?: { installed: SkillProvenance; source?: { path: string; sha256: string } }):
    { target: ProfileTarget; change: ProfileEdit; preview: string } {
  if (typeof text !== "string" || !check || typeof check !== "object") throw new Error("supply exact replacement text and a meaningful target-bound inspection or replay");
  const installedCopy = check.kind === "content" ? check.installedCopy : undefined;
  let source: ProfileEdit["installedCopy"];
  if (installedCopy !== undefined) {
    if (!installedCopy || typeof installedCopy.skill !== "string" || !installedCopy.skill.trim() ||
        typeof installedCopy.why !== "string" || !installedCopy.why.trim()) {
      throw new Error("name the installed skill and explain why its controls, amendment and owned source do not fit");
    }
    const installed = inspection?.installed;
    if ((installed?.kind !== "upstream" && installed?.kind !== "plugin") ||
        installed.name !== installedCopy.skill || installed.path !== inspection?.source?.path) {
      throw new Error("inspect the named installed copy in this pass and cite its exact current skill source");
    }
    source = installed;
  }
  const target = source ? canonicalInstalledCopyTarget(requestedTarget, source.path) : canonicalProfileTarget(requestedTarget);
  const settings = /^config\.ya?ml$/.test(target.path);
  const rule = /^rules\/(?:[^/]+\/)*[^/]+\.mdc?$/.test(target.path);
  const skillEntry = basename(target.path) === "SKILL.md";
  const guidance = !skillEntry && /^(?:(?:AGENTS|RULES|SYSTEM|APPEND_SYSTEM)\.md|(?:docs|guides|instructions|prompts)\/.+\.md)$/.test(target.path);
  if (!settings && !rule && !guidance && !source) throw new Error("the destination is not profile guidance, a rule or a supported host setting; use its normal owner or report the blocker");
  if (settings && check.kind !== "skill-control") throw new Error("verify the exact host skill control, not arbitrary config content");
  const { edit, before, preview } = prepareScalarFile(isAbsolute(target.path)
    ? { root: dirname(target.path), path: basename(target.path) }
    : target, text);
  if (source && (edit.beforeHash === null || edit.beforeHash !== inspection?.source?.sha256)) {
    throw new Error("the installed copy changed since the current-pass inspection; inspect again before proposing an edit");
  }
  const beforeRule = rule ? ruleFrontmatter(before) : {};
  const afterRule = rule ? ruleFrontmatter(text) : {};
  if (rule && (before === undefined || "generatedBy" in beforeRule || "generatedBy" in afterRule)) {
    throw new Error("this path edits only an existing hand-written rule and does not touch ownership markers; use the amendment workflow for Observer-owned rules");
  }
  const metadataChanged = rule && !isDeepStrictEqual(beforeRule, afterRule);
  if (metadataChanged && check.kind !== "pattern") {
    throw new Error("replay the exact rule against the observed mistake and a legitimate counterpart with observer_check");
  }
  let verification: string;
  let activation: string;
  switch (check.kind) {
    case "skill-control":
      if (!settings) throw new Error("a host skill control must name the active profile config file");
      verifySkillControl(target, before, text, check);
      verification = check.mode === "manual-only" ? `skills.manualSkills contains ${JSON.stringify(check.skill)}; keep manual invocation`
        : `disabledExtensions contains ${JSON.stringify(`skill:${check.skill}`)}; remove the skill from discovery`;
      activation = "Effective on host settings reload or next session. Project settings may override profile arrays; check the affected project separately.";
      break;
    case "pattern":
      if (!rule) throw new Error("a pattern replay must name the hand-written rule it verifies");
      verification = checkedPattern(target, text, afterRule, check.replayToolCallId, evidence, passStart);
      activation = "Affects sessions in this profile when OMP reloads the rule. The rule remains user-owned.";
      break;
    case "content": {
      const contains = typeof check.contains === "string" && check.contains.trim();
      const excludes = check.excludes;
      if (!contains || !text.includes(contains) || (excludes !== undefined && (typeof excludes !== "string" || !excludes.trim() || text.includes(excludes))) ||
          (before?.includes(contains) && !(excludes && before.includes(excludes)))) {
        throw new Error("name a decisive passage introduced by the edit or a superseded passage it removes; the requirement must distinguish the before and after texts");
      }
      verification = `inspect exact published content for ${JSON.stringify(contains)}${excludes ? ` and absence of ${JSON.stringify(excludes)}` : ""}`;
      activation = installedCopy ? `Affects sessions that load this installed copy. Installed-copy last resort. Updates can overwrite it. Why durable alternatives do not fit: ${installedCopy.why}`
        : rule ? "Affects sessions in this profile when OMP reloads the rule. The rule remains user-owned."
        : "Takes effect when OMP or the agent next loads this guidance.";
      break;
    }
    default:
      throw new Error("supply a meaningful target-bound content, skill-control or pattern check");
  }
  const root = lstatSync(target.root);
  const change: ProfileEdit = { ...edit, operation: "profile-edit", profileRootId: fileId(root), text, afterHash: edit.afterHash!, verification,
    ...(source && { installedCopy: source }) };
  const scope = source ? "" : `Profile-wide in ${target.root}. `;
  return { target, change, preview: `${preview}\n${scope}${activation}\nVerification: ${verification}.` };
}

export function checkProfileState(target: ProfileTarget, change: ProfileEdit, before: boolean): void {
  const installed = change.installedCopy;
  const current = installed ? canonicalInstalledCopyTarget(target, installed.path) : canonicalProfileTarget(target);
  const file = isAbsolute(current.path) ? current.path : join(current.root, current.path);
  const root = lstatSync(current.root);
  if (current.path !== target.path || file !== change.file || fileId(root) !== change.profileRootId) {
    throw new Error("the approved profile or destination changed; prepare and ask again");
  }
  requireNoCompetingConfig(current, change.beforeHash === null);
  checkScalarFileState(change, before);
  if (installed) {
    const resolver = createProvenanceResolver(defaultSkillRoots(current.root));
    const live = before ? resolver.byName(installed.name) : resolver.byPath(installed.path);
    // The approved bytes may rename the skill, but they cannot change its installation provenance.
    if (!isDeepStrictEqual(live, before ? installed : { ...installed, name: live.name })) {
      throw new Error("the selected installed copy changed ownership or destination; inspect and ask again");
    }
  }
}

function requireNoCompetingConfig({ root, path }: ProfileTarget, creating: boolean): void {
  const competitor = path === "config.yaml" ? "config.yml" : path === "config.yml" && creating ? "config.yaml" : undefined;
  if (!competitor) return;
  const file = join(root, competitor);
  if (lstatSync(file, { throwIfNoEntry: false }) || canonicalMissingPath(file) !== file) {
    throw new Error(`competing ${competitor} exists or is redirected; inspect the active config and ask again`);
  }
}

function ruleFrontmatter(text: string | undefined): Record<string, unknown> {
  if (!text || !/^\s*(?:<!--[\s\S]*?-->\s*)*---/.test(text)) return {};
  const block = /^---\n((?:[\s\S]*?\n)?)---(?:\n|$)/.exec(text)?.[1];
  if (block === undefined) throw new Error("use plain YAML rule frontmatter so its ownership and patterns can be checked");
  return mapping(YAML.parse(block.replace(/<!--[\s\S]*?-->/g, "")));
}

function checkedPattern(target: ProfileTarget, text: string, metadata: Record<string, unknown>, id: string, evidence: SessionToolEvidence, passStart: number | undefined): string {
  const refuse = "run observer_check in this pass on the exact drafted rule, with a sample of the observed mistake and a legitimate counterpart, then cite its passing call";
  let receipt;
  try { receipt = evidence.completedCall(id); } catch { throw new Error(refuse); }
  const { call, result } = receipt;
  if (passStart === undefined || call.position <= passStart || call.name !== CHECK_TOOL_NAME || result.isError !== false || !Array.isArray(call.args.drafts)) {
    throw new Error(refuse);
  }
  const details = result.details;
  const verdicts = details && "results" in details ? details.results : undefined;
  const name = basename(target.path).replace(/\.mdc?$/, "");
  const scope = Array.isArray(metadata.scope) && metadata.scope.length === 1 ? metadata.scope[0] : metadata.scope;
  const condition = Array.isArray(metadata.condition) && metadata.condition.length === 1 ? metadata.condition[0] : metadata.condition;
  if (typeof scope !== "string" || typeof condition !== "string" || !Array.isArray(verdicts)) throw new Error(`${refuse}; one explicit text or tool scope and one regex are needed for this replay`);
  const index = call.args.drafts.findIndex((item: unknown) => {
    const draft = mapping(item);
    return draft.name === name && draft.ruleText === text && draft.pattern === condition && draft.scope === scope;
  });
  const verdict = mapping(verdicts[index]);
  const draft = call.args.drafts[index] as PatternDraft | undefined;
  if (!draft || verdict.name !== name || verdict.verdict !== "passed") throw new Error(refuse);
  const { matches, spares } = replayCase(draft);
  if (matches.some((sample) => !sample.trim() || spares.includes(sample)) || spares.some((sample) => !sample.trim())) throw new Error(refuse);
  return `OMP observer_check ${id} passed; must fire on ${JSON.stringify(draft.matches)} and spare ${JSON.stringify(draft.spares)}`;
}

function verifySkillControl(target: ProfileTarget, before: string | undefined, text: string, check: Extract<ProfileCheck, { kind: "skill-control" }>): void {
  requireNoCompetingConfig(target, before === undefined);
  if (target.path === "config.yaml" && before === undefined) throw new Error("create config.yml instead of a competing config file");
  if (typeof check.skill !== "string" || !/^[\w@.-]+(?:\/[\w.@~-]+)?$/.test(check.skill) || !["manual-only", "disable"].includes(check.mode)) {
    throw new Error("name one installed skill and choose manual-only or disable");
  }
  const parse = (source: string | undefined) => {
    const value = YAML.parse(source ?? "{}");
    if (value == null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("the host config must be a YAML mapping");
    return mapping(value);
  };
  const oldConfig = parse(before);
  const newConfig = parse(text);
  const manual = check.mode === "manual-only";
  const oldSection = manual ? mapping(oldConfig.skills) : oldConfig;
  const newSection = manual ? mapping(newConfig.skills) : newConfig;
  if (manual && [oldConfig.skills, newConfig.skills].some((value) => value !== undefined && mapping(value) !== value)) {
    throw new Error("the host skills setting must already be a mapping or absent");
  }
  const key = manual ? "manualSkills" : "disabledExtensions";
  const entry = manual ? check.skill : `skill:${check.skill}`;
  const previous = oldSection[key] ?? [];
  const next = newSection[key];
  if (!Array.isArray(previous) || previous.some((value) => typeof value !== "string") || previous.includes(entry) ||
      !Array.isArray(next) || next.length !== previous.length + 1 || !isDeepStrictEqual(next.filter((value) => value !== entry), previous)) {
    throw new Error(`the check must add only ${JSON.stringify(entry)} to ${manual ? "skills.manualSkills" : key}`);
  }
  const withoutControl = (config: Record<string, unknown>, section: Record<string, unknown>) => {
    const { [key]: _, ...rest } = section;
    if (!manual) return rest;
    const { skills: _skills, ...other } = config;
    return Object.keys(rest).length ? { ...other, skills: rest } : other;
  };
  if (!isDeepStrictEqual(withoutControl(oldConfig, oldSection), withoutControl(newConfig, newSection))) {
    throw new Error("the skill-control proposal also changes unrelated settings; prepare only the exact remedy");
  }
}

function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
