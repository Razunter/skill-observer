/**
 * Rules this extension writes. Amendment rules (ADR 0002) carry approved fixes
 * to upstream and plugin skills, never edits to the skill; each is pinned to a
 * hash of the skill's folder when it was written, so a later change to the
 * skill's files shows up as a stale amendment. A skill's on-read fixes are
 * sections of its one on-read amendment, `<skill>-amendment` (ADR 0003), which
 * lives in the amendments directory and reaches the model through this
 * extension (ADR 0009); pattern amendments keep a file each in the user rules
 * directory, where OMP fires them. Barrier rules for local and managed skills
 * carry no pin and never go stale. A rule name is unique across both directories.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompAgentDir, type ProvenanceResolver, type SkillProvenance, skillHash } from "./provenance.js";

/** The `generatedBy` value that marks a rule as this extension's to rewrite or delete. */
const MARKER = "skill-observer";
const RULE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** OMP translates a leading PCRE-style flag group like `(?i)` itself; plain `RegExp` rejects it. */
const INLINE_FLAGS = /^\(\?[ims]+\)/;

/** A rule this extension wrote: an amendment rule for an upstream or plugin skill, or a barrier rule for a local or managed one. */
export interface ObserverRule {
  /** The rule file's name without `.md`; OMP names the rule after it. */
  name: string;
  path: string;
  /** The proposal's gist. */
  description: string;
  /** The TTSR pattern; empty for an on-read amendment, which has none. */
  condition: string;
  /** The TTSR scope as written, `text` or `tool:<name>`; empty for an on-read amendment. */
  scope: string;
  /** The skill the rule fixes. */
  amends: string;
  /**
   * The skill folder's content hash when the rule was last written or
   * confirmed; empty when the skill was no longer an upstream or plugin skill.
   * Only amendment rules carry it.
   */
  skillHash?: string;
  /** The ledger fingerprint of the proposal the rule came from. */
  fingerprint: string;
  body: string;
}

export function userRulesDir(): string {
  return join(ompAgentDir(), "rules");
}

/** Beside the ledger and outside the rules directory, so OMP never loads an on-read amendment as a TTSR rule. */
export function amendmentsDir(): string {
  return join(ompAgentDir(), "skill-observer", "amendments");
}

/** Where this extension's rules live. */
export interface RuleDirs {
  /** Barrier rules and pattern amendments, which OMP fires as TTSR rules. */
  rulesDir: string;
  /** On-read amendments, which this extension delivers. */
  amendmentsDir: string;
}

/** Throws when `pattern` is not a regex OMP can compile. */
export function checkPattern(pattern: string): void {
  try {
    new RegExp(pattern.replace(INLINE_FLAGS, ""));
  } catch (error) {
    throw new Error(`the pattern is not a valid regex: ${(error as Error).message}`);
  }
}

export function rulePath(rulesDir: string, name: string): string {
  if (!RULE_NAME.test(name)) throw new Error(`rule name \`${name}\` must be lowercase words joined by hyphens`);
  return join(rulesDir, `${name}.md`);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const foreignRule = (path: string) => new Error(`\`${path}\` was not written by skill-observer, so it was left untouched`);

/** Frontmatter as `key: value` lines; double-quoted values are YAML/JSON strings. */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z]\w*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!field?.[1]) continue;
    const value = field[2] ?? "";
    try {
      frontmatter[field[1]] = value.startsWith('"') ? JSON.parse(value) : value.replace(/^'(.*)'$/, "$1");
    } catch {
      frontmatter[field[1]] = value;
    }
  }
  return { frontmatter, body: (match[2] ?? "").trim() };
}

/** Reads the rule at `path` when this extension wrote it; `undefined` for a missing or foreign file. */
function readOwnRule(path: string, name: string): ObserverRule | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = parseFrontmatter(readFileSync(path, "utf8"));
  if (!parsed || parsed.frontmatter.generatedBy !== MARKER) return undefined;
  const { frontmatter: fm, body } = parsed;
  return {
    name,
    path,
    description: fm.description ?? "",
    condition: fm.condition ?? "",
    scope: fm.scope ?? "",
    amends: fm.amends ?? "",
    ...(fm.skillHash !== undefined && { skillHash: fm.skillHash }),
    fingerprint: fm.fingerprint ?? "",
    body,
  };
}

/**
 * The rule named `name` that this extension wrote, from the amendments
 * directory, else the rules directory; throws when it is missing or another
 * author's. A ledger record names its rule by the file's basename this way,
 * wherever the file lived when the record was written.
 */
export function readObserverRule(dirs: RuleDirs, name: string): ObserverRule {
  const path = ruleFile(dirs, name);
  if (!path) throw new Error(`no rule named \`${name}\``);
  const rule = readOwnRule(path, name);
  if (!rule) throw foreignRule(path);
  return rule;
}

/** The file named for rule `name`, in the amendments directory, else the rules directory; `undefined` when neither has one. */
export function ruleFile(dirs: RuleDirs, name: string): string | undefined {
  return [dirs.amendmentsDir, dirs.rulesDir].map((dir) => rulePath(dir, name)).find((path) => existsSync(path));
}

/** Throws when `dir` holds a file named for rule `name`: a rule name is unique across the rules and amendments directories. */
export function checkNameFree(dir: string, name: string): void {
  const path = rulePath(dir, name);
  if (existsSync(path)) throw new Error(`rule name \`${name}\` is taken by \`${path}\`; pick another name`);
}

/** The directory's `.md` files, by name. */
function ruleFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

/** Every rule this extension wrote in `dir`, by file name. */
function rulesIn(dir: string): ObserverRule[] {
  return ruleFiles(dir)
    .map((file) => readOwnRule(join(dir, file), file.slice(0, -".md".length)))
    .filter((rule): rule is ObserverRule => rule !== undefined);
}

/** Every rule this extension wrote, in both directories. */
export function readObserverRules(dirs: RuleDirs): ObserverRule[] {
  return [...rulesIn(dirs.rulesDir), ...rulesIn(dirs.amendmentsDir)];
}

/** A rule the user wrote by hand: a rule file without this extension's marker. */
export interface HandWrittenRule {
  name: string;
  description: string;
}

/** Every rule in the rules directory this extension didn't write, by file name. */
export function readHandWrittenRules(rulesDir: string): HandWrittenRule[] {
  return ruleFiles(rulesDir).flatMap((file) => {
    const parsed = parseFrontmatter(readFileSync(join(rulesDir, file), "utf8"));
    if (parsed?.frontmatter.generatedBy === MARKER) return [];
    return [{ name: file.slice(0, -".md".length), description: parsed?.frontmatter.description ?? "" }];
  });
}

/** Whether a rule this extension wrote is an on-read amendment: one without a pattern, which adds to its skill whenever the skill is loaded. */
export const isOnReadAmendment = (rule: ObserverRule): boolean => rule.condition === "";

/** This extension's on-read amendments, from the amendments directory. */
export function readOnReadAmendments(amendmentsDir: string): ObserverRule[] {
  return rulesIn(amendmentsDir).filter(isOnReadAmendment);
}

/** The name of an upstream or plugin skill's one on-read amendment (ADR 0003). */
export const skillAmendmentName = (skill: string): string => `${skill}-amendment`;

/**
 * The fingerprint the skill's on-read amendment carries in its frontmatter.
 * The amendment holds many fixes, each recorded in the ledger under its own
 * fingerprint, so this one names the file: a stale answer about it is
 * recorded under it, and it is never a fix of its own.
 */
export function skillAmendmentFingerprint(skill: string): string {
  return createHash("sha256").update(`on-read amendment\n${skill}`).digest("hex").slice(0, 12);
}

/** The skill's on-read amendment's frontmatter description. */
export const skillAmendmentDescription = (skill: string): string => `Approved fixes to the ${skill} skill, added whenever it is read.`;

/** About 1k tokens, estimated as 4 characters per token: an on-read amendment whose body is longer is offered for compaction. */
export const COMPACTION_LIMIT = 4000;

/**
 * A compaction's ledger fingerprint: the skill plus a hash of the amendment's
 * body as it stands before the compaction. A decline suppresses that version
 * of the body only; any change to it brings the offer back.
 */
export function compactionFingerprint(skill: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHash("sha256").update(`compaction\n${skill}\n${bodyHash}`).digest("hex").slice(0, 12);
}

/** A section of an on-read amendment starts with a `##` heading line. */
const SECTION_HEADING = /^## +(\S.*?)[ \t]*$/gm;

/** The `##` headings of an amendment's body, in order. */
export const sectionHeadings = (body: string): string[] => Array.from(body.matchAll(SECTION_HEADING), (match) => match[1] ?? "");

/**
 * The on-read amendment a new on-read fix for `skill` is added to: its one
 * on-read amendment in `amendmentsDir`, whatever its name, or `undefined` when
 * it has none and `<skill>-amendment` is free to create. Throws when the skill
 * has two or more, or when another file there already holds that name.
 */
export function skillAmendment(amendmentsDir: string, skill: string): ObserverRule | undefined {
  const own = readOnReadAmendments(amendmentsDir).filter((rule) => rule.amends === skill);
  if (own.length > 1) {
    const names = own.map((rule) => `\`${rule.name}\``).join(", ");
    throw new Error(`\`${skill}\` has ${own.length} on-read amendments (${names}); join them into one by hand before adding a fix`);
  }
  if (own[0]) return own[0];
  const name = skillAmendmentName(skill);
  const path = rulePath(amendmentsDir, name);
  if (!existsSync(path)) return undefined;
  if (!readOwnRule(path, name)) throw foreignRule(path);
  throw new Error(`rule \`${name}\` is not the on-read amendment of \`${skill}\`, so it was left untouched`);
}

/**
 * Adds an on-read fix's section to its skill's amendment: appended after the
 * text already there, which stays byte for byte, or, when the skill has none,
 * written as `created`, whose body is the section. Returns the file and whether
 * it was written. A section the body already holds verbatim — a pass answered
 * the same applied fix again — is not appended twice: the answer records, the
 * file stays as it is.
 */
export function addToSkillAmendment(created: ObserverRule): { path: string; written: boolean } {
  const existing = skillAmendment(dirname(created.path), created.amends);
  if (!existing) {
    writeObserverRule(created);
    return { path: created.path, written: true };
  }
  const current = readFileSync(existing.path, "utf8");
  const section = created.body.trim();
  if (current.includes(section)) return { path: existing.path, written: false };
  replaceFile(existing.path, `${current.trimEnd()}\n\n${section}\n`);
  return { path: existing.path, written: true };
}

/** One frontmatter line; values are written as JSON strings, which YAML reads unchanged. */
export const frontmatterField = (key: string, value: string) => `${key}: ${JSON.stringify(value)}`;

/**
 * Throws when writing `rule` would overwrite a file this extension didn't
 * write, or its own rule for another proposal.
 */
export function checkRuleWritable(rule: Pick<ObserverRule, "name" | "path" | "fingerprint">): void {
  if (!existsSync(rule.path)) return;
  const existing = readOwnRule(rule.path, rule.name);
  if (!existing) throw foreignRule(rule.path);
  if (existing.fingerprint !== rule.fingerprint) {
    throw new Error(`rule \`${rule.name}\` already holds another proposal's fix; pick another name`);
  }
}

/** Writes a new rule, or rewrites the one an earlier pass wrote for the same proposal. */
export function writeObserverRule(rule: ObserverRule): void {
  checkRuleWritable(rule);
  const text = [
    "---",
    frontmatterField("name", rule.name),
    frontmatterField("description", rule.description),
    ...(isOnReadAmendment(rule) ? [] : [frontmatterField("condition", rule.condition), frontmatterField("scope", rule.scope)]),
    frontmatterField("amends", rule.amends),
    ...(rule.skillHash === undefined ? [] : [frontmatterField("skillHash", rule.skillHash)]),
    frontmatterField("fingerprint", rule.fingerprint),
    frontmatterField("generatedBy", MARKER),
    "---",
    "",
    rule.body.trim(),
    "",
  ].join("\n");
  mkdirSync(dirname(rule.path), { recursive: true });
  replaceFile(rule.path, text);
}

/** The rule file's frontmatter as it stands on disk, keys added by hand included. */
function frontmatterText(rule: ObserverRule): string {
  const match = FRONTMATTER.exec(readFileSync(rule.path, "utf8"));
  if (!match) throw foreignRule(rule.path);
  return match[1] ?? "";
}

/**
 * Re-pins the amendment rule to its skill as installed now and, given a body,
 * replaces it. The rest of the frontmatter stays as it is on disk, so keys the
 * user added by hand survive; without a body every byte outside the pin line
 * stays too, so a Keep never normalizes the body's whitespace or line ends.
 */
export function repinAmendmentRule(rule: ObserverRule, provenance: ProvenanceResolver, body?: string): void {
  const text = readFileSync(rule.path, "utf8");
  const head = FRONTMATTER.exec(text)?.[1];
  if (head === undefined) throw foreignRule(rule.path);
  const pinned = frontmatterField("skillHash", skillHash(provenance.byName(rule.amends)));
  const line = /^skillHash:.*$/m;
  const repinned = line.test(head) ? head.replace(line, () => pinned) : `${head}\n${pinned}`;
  if (body !== undefined) return rewriteRuleBody(rule, body, repinned);
  // The frontmatter starts right after the opening `---` line.
  const start = text.indexOf("\n") + 1;
  replaceFile(rule.path, text.slice(0, start) + repinned + text.slice(start + head.length));
}

/** Replaces the rule's body under frontmatter `head`, by default the frontmatter as it is on disk, pin included. */
export function rewriteRuleBody(rule: ObserverRule, body: string, head = frontmatterText(rule)): void {
  replaceFile(rule.path, `---\n${head}\n---\n\n${body.trim()}\n`);
}

/** Stages the text beside `path` and renames it over, so a failed write leaves the old file whole. A symlinked rule keeps its link. */
function replaceFile(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const staged = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, text, { mode: existsSync(target) ? statSync(target).mode : 0o666, flag: "wx" });
    renameSync(staged, target);
  } finally {
    if (existsSync(staged)) rmSync(staged, { force: true });
  }
}

export function deleteObserverRule(rule: ObserverRule): void {
  rmSync(rule.path, { force: true });
}

/** The provenance kinds whose skills take amendment rules, pinned to the skill's content. */
export type PinKind = "upstream" | "plugin";

/** Whether a skill of provenance `kind` takes amendment rules, pinned to it, rather than edits. */
export const isPinKind = (kind: string): kind is PinKind => kind === "upstream" || kind === "plugin";

/** Whether the rule is an amendment rule, pinned to its skill; a barrier rule carries no pin. */
export const isPinned = (rule: ObserverRule): boolean => rule.skillHash !== undefined;

/** The pin a new amendment rule for `skill` carries: the content hash of an upstream or plugin skill's folder. */
export function skillPin(skill: SkillProvenance): Pick<ObserverRule, "skillHash"> {
  return isPinKind(skill.kind) ? { skillHash: skillHash(skill) } : {};
}

/**
 * Amendment rules whose skill's files changed, or that left the upstream and
 * plugin kinds, since the rule was pinned. A rule whose skill folder can't be
 * hashed is logged and skipped: neither stale nor re-pinned.
 */
export function findStaleAmendments(dirs: RuleDirs, provenance: ProvenanceResolver): ObserverRule[] {
  return readObserverRules(dirs).filter((rule) => {
    if (!isPinned(rule)) return false;
    try {
      return rule.skillHash !== skillHash(provenance.byName(rule.amends));
    } catch (error) {
      console.error(`skill-observer: hashing the skill \`${rule.amends}\` of ${rule.path} failed; skipped in the stale check:`, error);
      return false;
    }
  });
}

/** The `/observe` message section that asks for a keep / update / delete answer per stale amendment. */
export function renderStaleAmendments(stale: readonly ObserverRule[], provenance: ProvenanceResolver): string {
  const lines = stale.map((rule) => {
    const skill = provenance.byName(rule.amends);
    const change = skill.kind === "upstream" || skill.kind === "plugin"
      ? `a ${skill.kind} skill whose files changed since the rule was pinned. Skill file: \`${skill.path}\``
      : skill.kind === "unknown"
        ? "which is no longer installed"
        : `which is now a ${skill.kind} skill, not an upstream or plugin one`;
    return `- \`${rule.name}\` amends \`${rule.amends}\`, ${change}. Rule file: \`${rule.path}\`.`;
  });
  return ["## Stale amendments", "", lines.length > 0 ? lines.join("\n") : "None."].join("\n");
}

const LEGACY_PIN = /^(?:skillFolderHash|plugin|pluginVersion|skillHash):.*(?:\r?\n|$)/gm;
const TTSR_FIELDS = /^(?:condition|scope):.*(?:\r?\n|$)/gm;

/**
 * Creates `path` holding `text` all at once, or returns false when it already
 * exists: the text is staged beside it and hard-linked in, and `link` neither
 * overwrites nor exposes a half-written file.
 */
function createFile(path: string, text: string): boolean {
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, text, { flag: "wx" });
    linkSync(staged, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && existsSync(path)) return false;
    throw error;
  } finally {
    rmSync(staged, { force: true });
  }
}

/**
 * Converges marked rules on the current layout; a second run changes nothing.
 * First, rules still carrying the legacy pins (`skillFolderHash`, or `plugin`
 * and `pluginVersion`) get `skillHash`: the skill's current content hash when
 * the legacy pin still matches its provenance, else `""` so the next
 * `/observe` reviews it. Then each marked rule in the rules directory with
 * scope `tool:read` — an on-read amendment from before ADR 0009, the only rule
 * that scope was ever drafted for — moves to the amendments directory without
 * its `condition` and `scope`. The new file is created whole and never over
 * an existing one; when one is already there, the old file is deleted only if
 * the new one is this extension's on-read amendment of the same skill with the
 * same body, else both stay and the conflict is logged. Body and other
 * frontmatter stay as they are. A file that fails is logged and left as it
 * is; the rest still migrate. Returns the names of the rules it rewrote or moved.
 */
export function migrateObserverRules(dirs: RuleDirs, provenance: ProvenanceResolver): string[] {
  const migrated: string[] = [];
  const failed = new Set<string>();
  for (const file of ruleFiles(dirs.rulesDir)) {
    const name = file.slice(0, -".md".length);
    const path = join(dirs.rulesDir, file);
    try {
      const parsed = parseFrontmatter(readFileSync(path, "utf8"));
      if (parsed?.frontmatter.generatedBy !== MARKER) continue;
      const fm = parsed.frontmatter;
      if (fm.skillFolderHash === undefined && fm.plugin === undefined) continue;
      const skill = provenance.byName(fm.amends ?? "");
      const matches = fm.plugin !== undefined
        ? skill.kind === "plugin" && skill.plugin === fm.plugin && skill.version === fm.pluginVersion
        : skill.kind === "upstream" && skill.skillFolderHash === fm.skillFolderHash;
      const rule = readOwnRule(path, name) as ObserverRule;
      const head = frontmatterText(rule).replace(LEGACY_PIN, "").replace(/\r?\n$/, "");
      rewriteRuleBody(rule, parsed.body, `${head}\n${frontmatterField("skillHash", matches ? skillHash(skill) : "")}`);
      migrated.push(name);
    } catch (error) {
      failed.add(file);
      console.error(`skill-observer: converting the pin of ${path} failed; left as it is:`, error);
    }
  }
  for (const file of ruleFiles(dirs.rulesDir).filter((file) => !failed.has(file))) {
    const name = file.slice(0, -".md".length);
    const path = join(dirs.rulesDir, file);
    try {
      const rule = readOwnRule(path, name);
      if (rule?.scope !== "tool:read") continue;
      const target = rulePath(dirs.amendmentsDir, name);
      mkdirSync(dirs.amendmentsDir, { recursive: true });
      const head = frontmatterText(rule).replace(TTSR_FIELDS, "").replace(/\r?\n$/, "");
      if (!createFile(target, `---\n${head}\n---\n\n${rule.body}\n`)) {
        const existing = readOwnRule(target, name);
        const same = existing !== undefined && isOnReadAmendment(existing) && existing.amends === rule.amends && existing.body === rule.body;
        if (!same) {
          console.error(`skill-observer: not moving ${path}: ${target} already exists with other content; both left as they are`);
          continue;
        }
      }
      rmSync(path, { force: true });
      if (!migrated.includes(name)) migrated.push(name);
    } catch (error) {
      console.error(`skill-observer: moving ${path} to the amendments directory failed; left as it is:`, error);
    }
  }
  return migrated;
}
