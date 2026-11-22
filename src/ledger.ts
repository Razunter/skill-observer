/**
 * The proposal ledger: the user's answers to observation-pass proposals, kept
 * across sessions and projects so declines stick and deferrals come back. It
 * keeps the latest answer per fingerprint in answer order.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { readObserverStore } from "./observer-store.js";
import { ompAgentDir } from "./provenance.js";

export const PROPOSAL_KINDS = ["local", "managed", "upstream", "plugin", "new"] as const;
export const PROPOSAL_OUTCOMES = ["applied", "later", "declined"] as const;
/** Answers the pass sends: the user's answer to a proposal, or `withdrawn` to take back an earlier applied fix. */
export const ANSWER_OUTCOMES = [...PROPOSAL_OUTCOMES, "withdrawn"] as const;
/** Answers to a stale amendment's keep / update / delete question, and the ledger outcome each records. */
export const STALE_OUTCOMES = { keep: "kept", update: "updated", delete: "deleted" } as const;
export const STALE_ACTIONS = Object.keys(STALE_OUTCOMES) as [StaleAction, ...StaleAction[]];

/** The target's provenance, or `new` for a proposed new skill. */
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export type ProposalOutcome = (typeof PROPOSAL_OUTCOMES)[number];
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];
export type StaleAction = keyof typeof STALE_OUTCOMES;
/**
 * A stale answer is recorded under the fingerprint of the proposal that wrote
 * the rule; `withdrawn` under the fingerprint of the applied fix it takes back.
 * `merged` is only read: passes before ADR 0003 recorded it for an on-read
 * amendment they folded into another, and it leaves no fix in force.
 */
export type LedgerOutcome = AnswerOutcome | (typeof STALE_OUTCOMES)[StaleAction] | "merged";

/** A quote of the decisive words behind a proposal, with how often the signal it quotes occurred. */
export interface Evidence {
  quote: string;
  /** The signal's repeat count, the `(×N)` in the digest; 1 for a single occurrence. */
  count: number;
  /** Stable digest occurrences supporting this quote, not duplicate descriptions. */
  occurrenceIds?: string[];
}

export function isRedactedExcerpt(quote: string): boolean {
  return quote.startsWith("[redacted excerpt] ");
}

interface LedgerEntry {
  type?: never;
  fingerprint: string;
  /** The proposal's general form in one sentence. */
  gist: string;
  outcome: LedgerOutcome;
  /** The rule file the answer wrote, rewrote or deleted. */
  rule?: string;
  /** Set on a compaction's record: it rewrote a skill's on-read amendment and is never a fix of its own. */
  compaction?: true;
  /** What the proposal rests on, as cited in its question. */
  evidence?: Evidence[];
  /** On a `later` only: which observation would change the decision, when it could arrive, and whether the deferred action is still possible. */
  reoffer?: string;
  timestamp: string;
  experimentResult?: { requestId: string; reference: string; hash: string };
  sessionId: string;
}

export interface SkillLedgerRecord extends LedgerEntry {
  skill: string;
  kind: ProposalKind;
  target?: never;
  publication?: never;
}

export interface ProjectTarget {
  scope: "project";
  root: string;
  path: string;
  mechanism: string;
}

export interface ProfileTarget extends Omit<ProjectTarget, "scope"> {
  scope: "profile";
}

export interface ProjectPublication {
  writeToolCallId: string;
  checkToolCallIds: string[];
  afterHash: string | null;
}

export interface ProjectLedgerRecord extends LedgerEntry {
  kind: "project";
  target: ProjectTarget;
  publication?: ProjectPublication;
  skill?: never;
  rule?: never;
  compaction?: never;
}

export interface ProfileLedgerRecord extends LedgerEntry {
  kind: "profile";
  target: ProfileTarget;
  publication?: { writeToolCallId: string; afterHash: string; verification: string };
  skill?: never;
  rule?: never;
  compaction?: never;
}

/**
 * Hooks are named by file, or by their proposal fingerprint for a new hook.
 * Extensions are named by source directory so one change can touch multiple files.
 */
export type HarnessTarget =
  | {
    scope: "harness"; root: "project-hooks";
    /** The canonical project root whose hooks directory holds the hook. */
    project: string;
    path?: string; mechanism: string;
  }
  | { scope: "harness"; root: "global-hooks"; path?: string; mechanism: string }
  | { scope: "harness"; root: "companion"; path?: never; mechanism: string }
  | { scope: "harness"; root: "extension"; source: string; checkout?: string; path?: never; mechanism: string };
export type HarnessRoot = HarnessTarget["root"];
export const HARNESS_ROOTS = ["project-hooks", "global-hooks", "companion", "extension"] as const satisfies readonly HarnessRoot[];

/** Observed write and check calls, plus the result for each root-relative file. */
export interface HarnessPublication {
  writeToolCallIds: string[];
  checkToolCallIds: string[];
  files: Array<{ path: string; afterHash: string | null }>;
}

/** One root-relative file; absent text means removal. */
export interface HarnessFile { path: string; text?: string }

export interface HarnessLedgerRecord extends LedgerEntry {
  kind: "harness";
  target: HarnessTarget;
  publication?: HarnessPublication;
  skill?: never;
  rule?: never;
  compaction?: never;
}

export type LedgerRecord = SkillLedgerRecord | ProjectLedgerRecord | ProfileLedgerRecord | HarnessLedgerRecord;

/** What a proposal or record targets: a skill, a project file or a harness root. */
export type TargetScope =
  | { kind: ProposalKind; skill: string; target?: never }
  | { kind: "project"; target: ProjectTarget; skill?: never }
  | { kind: "profile"; target: ProfileTarget; skill?: never }
  | { kind: "harness"; target: HarnessTarget; skill?: never };

export const HARNESS_ROOT_NAMES: Record<HarnessRoot, string> = { "project-hooks": "project hook", "global-hooks": "global hook", companion: "companion extension", extension: "extension source" };
const COMPANION_DIR = "skill-observer-companion";

/** How the form, the ledger section and the resolver name a target: `` `name` (kind) ``. */
export function targetLabel(entry: TargetScope & { fingerprint: string }): string {
  switch (entry.kind) {
    case "project":
    case "profile":
      return `\`${entry.target.path}\` (${entry.kind})`;
    case "harness": {
      const { target } = entry;
      const name = target.root === "extension" ? target.source : target.root === "companion" ? COMPANION_DIR : hookPath(target, entry.fingerprint);
      return `\`${name}\` (${HARNESS_ROOT_NAMES[target.root]})`;
    }
    default:
      return `\`${entry.skill}\` (${entry.kind})`;
  }
}

/** The directory each harness root names: hooks only load from a `pre` or `post` folder, and observer hooks go in `pre`. */
export function harnessRootDirs(cwd: string, agentDir: string): Record<Exclude<HarnessRoot, "extension">, string> {
  return {
    "project-hooks": join(realpathSync(cwd), ".omp", "hooks", "pre"),
    "global-hooks": join(agentDir, "hooks", "pre"),
    companion: join(agentDir, "extensions", COMPANION_DIR),
  };
}

/** A new hook's file name: a fixed prefix and its fingerprint, so a project hook and a global hook never share a name and hide one another. */
export const hookFileName = (fingerprint: string) => `skill-observer-${fingerprint}.ts`;

/** The root-relative file a hook target names: its `path`, or the new hook's file name. */
export const hookPath = (target: HarnessTarget, fingerprint: string) => target.path ?? hookFileName(fingerprint);

/** The launch directory defines project scope; symlink aliases share one identity. */
export function canonicalProjectTarget(cwd: string, target: ProjectTarget): ProjectTarget {
  if (!target || target.scope !== "project" || typeof target.root !== "string" || typeof target.path !== "string" ||
      typeof target.mechanism !== "string" || !target.mechanism.trim()) throw new Error("a project target needs root, path and mechanism");
  const root = realpathSync(cwd);
  if (!statSync(root).isDirectory() || realpathSync(target.root) !== root) throw new Error("project root must be the current working project");
  const path = canonicalPathIn(root, target.path, "project target");
  // These roots keep their existing owner even when nested inside a checkout.
  const harness = harnessRootDirs(root, ompAgentDir());
  const destination = join(root, path);
  const inside = ([
    [dirname(harness["project-hooks"]), "the project's hooks directory", "as a project hook"],
    [dirname(harness["global-hooks"]), "the global hooks directory", "as a global hook"],
    [harness.companion, "the companion extension directory", "as a companion change"],
  ] as const).find(([dir]) => withinRoot(canonicalMissingPath(dir), destination));
  if (inside) throw new Error(`\`${path}\` lies in ${inside[1]}: propose it with the \`harness\` target scope, ${inside[2]}`);
  return { scope: "project", root, path, mechanism: target.mechanism.trim() };
}

/** Prepare only. Older decisions keep their original identity and visibility. */
export function requireCheckedExecutableTarget(target: ProjectTarget): void {
  const file = join(target.root, target.path);
  const native = join(target.root, ".omp", "extensions");
  if (withinRoot(native, file) || withinRoot(canonicalMissingPath(native), file)) throw checkedExtensionRequired(target.path);
  const runtimeFile = basename(file) === "package.json" || /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file);
  for (let dir = dirname(file); withinRoot(target.root, dir); dir = dirname(dir)) {
    const entries = extensionEntries(dir);
    if (entries.length && (runtimeFile || entries.some((entry) => typeof entry === "string" && entry.trim() &&
        withinRoot(resolve(dir, entry), file)))) throw checkedExtensionRequired(target.path);
    if (dir === target.root) break;
  }
}

function checkedExtensionRequired(path: string): Error {
  return new Error(`\`${path}\` belongs to OMP extension runtime source; prepare a checked extension change`);
}

/** Canonicalize a draft only after its owner is known. */
export function canonicalHarnessTarget(cwd: string, agentDir: string, target: HarnessTarget, projectRoot?: (root: string) => string): HarnessTarget {
  if (!target || target.scope !== "harness" || !HARNESS_ROOTS.includes(target.root) || typeof target.mechanism !== "string" || !target.mechanism.trim()) {
    throw new Error(`a harness target needs a root (${HARNESS_ROOTS.join(", ")}) and a mechanism`);
  }
  const mechanism = target.mechanism.trim();
  if (target.root === "extension") {
    if (target.path !== undefined || !absoluteCanonicalSpelling(target.source) ||
        (target.checkout !== undefined && !absoluteCanonicalSpelling(target.checkout))) {
      throw new Error("an extension target needs an absolute canonical source directory and optional checkout, not a file path");
    }
    const project = realpathSync(cwd);
    const profile = canonicalMissingPath(agentDir);
    const checkout = target.checkout === undefined
      ? (withinRoot(profile, target.source) ? undefined : project)
      : (projectRoot ? projectRoot(target.checkout) : target.checkout === project ? project : undefined);
    if (target.checkout !== undefined && checkout === undefined) throw new Error("the extension checkout is not in the user's project scope");
    const canonical: HarnessTarget = { scope: "harness", root: "extension", source: target.source, mechanism,
      ...(checkout !== undefined && { checkout }) };
    const source = extensionDestinationRoot(canonical, profile);
    const entries = extensionEntries(source);
    if (entries.length ? !entries.every((entry) => isOwnedExtensionEntry(source, entry)) :
      !nativeExtensionDirectory(source, checkout, profile) ||
      !["index.ts", "index.js"].some((index) => lstatSync(join(source, index), { throwIfNoEntry: false })?.isFile())) {
      throw new Error("the source must declare owned OMP extension entries in package.json or be a native extension directory with an index");
    }
    return canonical;
  }
  if (target.root === "companion") {
    if (target.path !== undefined) throw new Error("a companion change is identified by the companion root and its mechanism, not by a file");
    return { scope: "harness", root: "companion", mechanism };
  }
  if (target.path !== undefined && typeof target.path !== "string") throw new Error("a hook target's path is a root-relative file path");
  const project = realpathSync(cwd);
  const root = harnessDestinationRoot(target, project, agentDir);
  const path = target.path === undefined ? undefined : canonicalPathIn(root, target.path, "hook target");
  const named = target.root === "project-hooks" ? { root: target.root, project, mechanism } : { root: target.root, mechanism };
  const canonical: HarnessTarget = { scope: "harness", ...named, ...(path !== undefined && { path }) };
  // A new hook named by its own file stays the identity it was proposed under.
  return path !== undefined && path === hookFileName(harnessFingerprint({ ...canonical, path: undefined })) ? { scope: "harness", ...named } : canonical;
}

/** Recheck a prepared destination without relying on a manifest that the approved edit may remove. */
export function harnessDestinationRoot(target: HarnessTarget, cwd: string, agentDir: string): string {
  if (target.root !== "extension") return canonicalMissingPath(harnessRootDirs(cwd, agentDir)[target.root]);
  return extensionDestinationRoot(target, canonicalMissingPath(agentDir));
}

function extensionDestinationRoot({ source, checkout }: Extract<HarnessTarget, { root: "extension" }>, profile: string): string {
  if (!absoluteCanonicalSpelling(source)) throw new Error("the extension source must name an absolute canonical directory");
  const native = nativeExtensionDirectory(source, checkout, profile);
  const ompHome = join(homedir(), ".omp");
  const xdgData = process.env.XDG_DATA_HOME;
  const protectedSource = source.split(sep).some((part) => part === ".git" || part === "node_modules");
  const storedOwner = ["agent", "profiles", "plugins"].some((name) => withinRoot(join(ompHome, name), source)) ||
    (xdgData && isAbsolute(xdgData) && ["profiles", "plugins"].some((name) => withinRoot(join(xdgData, "omp", name), source)));
  if (protectedSource || (checkout === undefined ? !native || source === join(profile, "extensions", COMPANION_DIR) :
        !absoluteCanonicalSpelling(checkout) || !withinRoot(checkout, source) || withinRoot(profile, source) || storedOwner ||
        (withinRoot(join(checkout, ".omp"), source) && !native))) {
    throw new Error("the extension source is not an owned extension directory in its scoped checkout or active profile");
  }
  if ((checkout !== undefined && realpathSync(checkout) !== checkout) || realpathSync(source) !== source || !statSync(source).isDirectory()) {
    throw new Error("the extension source must remain an exact canonical directory");
  }
  return source;
}

function absoluteCanonicalSpelling(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && normalize(path) === path && !path.includes("\0") && !path.includes("\\");
}

function withinRoot(root: string, path: string): boolean {
  const within = relative(root, path);
  return within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
}

function nativeExtensionDirectory(source: string, checkout: string | undefined, profile: string): boolean {
  const parent = checkout === undefined ? join(profile, "extensions") : join(checkout, ".omp", "extensions");
  return dirname(source) === parent;
}

function isOwnedExtensionEntry(dir: string, entry: unknown): boolean {
  if (typeof entry !== "string" || !entry.trim() || isAbsolute(entry) || entry.includes("\0") || entry.includes("\\")) return false;
  const candidate = resolve(dir, entry);
  return withinRoot(dir, candidate) && withinRoot(dir, canonicalMissingPath(candidate));
}

function extensionEntries(dir: string): unknown[] {
  const file = join(dir, "package.json");
  const manifest = lstatSync(file, { throwIfNoEntry: false });
  if (!manifest) return [];
  const path = manifest.isSymbolicLink() ? canonicalMissingPath(file) : file;
  if (!withinRoot(dir, path) || !(path === file ? manifest : statSync(path)).isFile()) return [];
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    const entries: unknown = (pkg?.omp ?? pkg?.pi)?.extensions;
    return Array.isArray(entries) ? entries : [];
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return [];
  }
}

/** `path` canonical and relative to `root`; throws unless it is a plain root-relative file path that no symlink leads out of the root. */
export function canonicalPathIn(root: string, path: string, label: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} must be a plain root-relative file path`);
  const base = canonicalMissingPath(root);
  const canonical = relative(base, canonicalMissingPath(join(base, path)));
  if (!canonical || canonical === ".." || canonical.startsWith(`..${sep}`) || isAbsolute(canonical)) throw new Error(`${label} escapes its root`);
  const file = join(base, canonical);
  if (existsSync(file) && !statSync(file).isFile()) throw new Error(`${label} must name a file`);
  return canonical;
}

/** `path` through its symlinks, its missing tail kept as written. */
export function canonicalMissingPath(path: string): string {
  try {
    lstatSync(path);
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    // A dangling symlink exists but has no canonical destination; never treat it as a missing leaf.
    try { lstatSync(path); } catch (missing) {
      if (!(missing instanceof Error) || !("code" in missing) || missing.code !== "ENOENT") throw missing;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(canonicalMissingPath(parent), basename(path));
    }
    throw new Error("project target contains a dangling symlink");
  }
}

export function projectFingerprint(target: ProjectTarget): string {
  const mechanism = normaliseText(target.mechanism);
  if (!mechanism) throw new Error("project mechanism must contain letters or digits");
  return createHash("sha256").update(JSON.stringify(["project", target.root, target.path, mechanism])).digest("hex").slice(0, 12);
}

function activeProfileRoot(target: ProfileTarget): string {
  if (target?.scope !== "profile" || typeof target.root !== "string" ||
      typeof target.mechanism !== "string" || !target.mechanism.trim()) throw new Error("a profile target needs root, path and mechanism");
  const root = realpathSync(ompAgentDir());
  if (!statSync(root).isDirectory() || realpathSync(target.root) !== root) throw new Error("profile root must be the active OMP agent directory");
  return root;
}

export function canonicalProfileTarget(target: ProfileTarget): ProfileTarget {
  const root = activeProfileRoot(target);
  const path = canonicalPathIn(root, target.path, "profile target");
  if (path !== target.path) throw new Error("use the exact canonical profile path; inspect the symlink before proposing a change");
  return { scope: "profile", root, path, mechanism: target.mechanism.trim() };
}

/** Validates the spelling of an installed-copy target, not authority to write it. */
export function canonicalInstalledCopyTarget(target: ProfileTarget, inspectedFile: string): ProfileTarget {
  const root = activeProfileRoot(target);
  const path = isAbsolute(target.path) ? target.path : canonicalProfileTarget(target).path;
  const file = isAbsolute(path) ? path : join(root, path);
  const home = homedir();
  const skills = join(home, ".agents", "skills");
  const plugins = join(home, ".omp", "plugins");
  const pluginParts = relative(plugins, file).split(sep);
  const ordinarySkill = dirname(dirname(file)) === skills;
  const pluginSkill = withinRoot(plugins, file) && pluginParts.length >= 4 && pluginParts.at(-3) === "skills";
  if (file !== inspectedFile || !absoluteCanonicalSpelling(file) || basename(file) !== "SKILL.md" ||
      (!ordinarySkill && !pluginSkill) || canonicalMissingPath(file) !== file ||
      (isAbsolute(path) && withinRoot(root, file))) {
    throw new Error("name the exact inspected SKILL.md of the installed copy without aliases; otherwise use its owner or report the finding");
  }
  return { scope: "profile", root, path, mechanism: target.mechanism.trim() };
}

export function profileFingerprint(target: ProfileTarget): string {
  const mechanism = normaliseText(target.mechanism);
  if (!mechanism) throw new Error("profile mechanism must contain letters or digits");
  return createHash("sha256").update(JSON.stringify(["profile", target.root, target.path, mechanism])).digest("hex").slice(0, 12);
}

/** A harness proposal's identity: root kind, the project for a project hook, root-relative path (none for a new hook or the companion) and mechanism. */
export function harnessFingerprint(target: HarnessTarget): string {
  const mechanism = normaliseText(target.mechanism);
  if (!mechanism) throw new Error("harness mechanism must contain letters or digits");
  if (target.root === "extension") {
    return createHash("sha256").update(JSON.stringify(["harness", "extension", target.checkout ?? null, target.source, mechanism])).digest("hex").slice(0, 12);
  }
  const project = target.root === "project-hooks" ? target.project : null;
  return createHash("sha256").update(JSON.stringify(["harness", target.root, project, target.path ?? null, mechanism])).digest("hex").slice(0, 12);
}

/** The hook file a harness target names, as a key; extensions do not own a hook key. */
export function hookFileKey(target: HarnessTarget, fingerprint: string): string | undefined {
  if (target.root === "companion" || target.root === "extension") return undefined;
  return JSON.stringify([target.root, target.root === "project-hooks" ? target.project : null, hookPath(target, fingerprint)]);
}

/** A hook removal's identity is its file alone, so a declined removal stays declined however it is worded and never suppresses a change to that hook. */
export const removalFingerprint = (fileKey: string) => createHash("sha256").update(JSON.stringify(["harness-removal", fileKey])).digest("hex").slice(0, 12);

/** Shared storage does not make another project's decisions visible in this pass; global hook and companion decisions apply in every project. */
export function ledgerForProject(records: readonly LedgerRecord[], cwd: string): LedgerRecord[] {
  const root = realpathSync(cwd);
  return records.filter((record) => ledgerDecisionInProject(record, root));
}

export function ledgerProjectRoot(record: LedgerRecord): string | undefined {
  if (record.kind === "project") return record.target.root;
  if (record.kind !== "harness") return undefined;
  const { target } = record;
  if (target.root === "project-hooks") return target.project;
  if (target.root === "extension") return target.checkout;
}

export function ledgerDecisionInProject(record: LedgerRecord, canonicalRoot: string): boolean {
  const project = ledgerProjectRoot(record);
  if (project !== undefined && project !== canonicalRoot) return false;
  switch (record.kind) {
    case "project":
      try {
        return projectFingerprint(canonicalProjectTarget(canonicalRoot, record.target)) === record.fingerprint;
      } catch { return false; }
    case "profile":
      try {
        const target = isAbsolute(record.target.path)
          ? canonicalInstalledCopyTarget(record.target, record.target.path)
          : canonicalProfileTarget(record.target);
        return profileFingerprint(target) === record.fingerprint;
      } catch { return false; }
    case "harness":
      if (record.target.root === "extension" && project === undefined) {
        try { return nativeExtensionDirectory(record.target.source, undefined, canonicalMissingPath(ompAgentDir())); }
        catch { return false; }
      }
      return true;
    default:
      return record.target === undefined;
  }
}

/**
 * `text` with case, punctuation and spacing normalised away. Separators are
 * dropped, not collapsed, so "re-run" and "rerun" match.
 */
export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A proposal's identity across sessions: the target skill plus the normalised gist, hashed to a short token. */
export function proposalFingerprint(skill: string, gist: string): string {
  return createHash("sha256").update(`${skill.trim()}\n${normaliseText(gist)}`).digest("hex").slice(0, 12);
}

/** The latest record per fingerprint, oldest answer first. */
export function readLedger(file: string): LedgerRecord[] {
  return readObserverStore(file, readLedgerRows) ?? [];
}

export function readLedgerRows(db: Database): LedgerRecord[] {
  return db.query<{ record: string }, []>("SELECT record FROM proposals ORDER BY answer_order").all()
    .map(({ record }) => JSON.parse(record) as LedgerRecord);
}

export function readLedgerDecision(db: Database, fingerprint: string): LedgerRecord | undefined {
  const row = db.query<{ record: string }, [string]>("SELECT record FROM proposals WHERE fingerprint = ?").get(fingerprint);
  return row === null ? undefined : JSON.parse(row.record) as LedgerRecord;
}

/** Replace each decision and move it to the end of the answer order within the caller's transaction. */
export function putLedgerRecords(db: Database, records: readonly LedgerRecord[]): void {
  const put = db.query(`
    INSERT INTO proposals (fingerprint, rule_name, hook_file_key, record) VALUES (?, ?, ?, ?)
    ON CONFLICT (fingerprint) DO UPDATE SET
      answer_order = excluded.answer_order, rule_name = excluded.rule_name,
      hook_file_key = excluded.hook_file_key, record = excluded.record
  `);
  for (const record of records) {
    put.run(record.fingerprint, record.rule === undefined ? null : basename(record.rule, ".md"),
      record.kind === "harness" ? hookFileKey(record.target, record.fingerprint) ?? null : null, JSON.stringify(record));
  }
}

/** Outcomes that leave a fix applied: applied, or its amendment kept or re-pinned at a stale check. */
export const IN_FORCE_OUTCOMES: ReadonlySet<LedgerOutcome> = new Set(["applied", "kept", "updated"]);

/** An answer's `reoffer` as its record keeps it: only on `later`, and refused when blank. */
export function laterReoffer({ outcome, reoffer }: { outcome: string; reoffer?: string }): { reoffer?: string } {
  if (outcome !== "later" || reoffer === undefined) return {};
  if (!reoffer.trim()) throw new Error("`reoffer` is blank: name the observation that would change the decision, or leave `reoffer` out");
  return { reoffer };
}

const entryLine = (record: LedgerRecord) =>
  `- ${targetLabel(record)}, fingerprint \`${record.fingerprint}\`${record.target ? `, mechanism ${JSON.stringify(record.target.mechanism)}` : ""}: ${record.gist}` +
  (record.reoffer ? ` Re-offer when: ${record.reoffer}` : "");

/**
 * The ledger part of the `/observe` message: deferred proposals to re-offer.
 * Declines are left out because Prepare already drops a scoped decline;
 * compactions too, as an amendment over the size limit is offered again from
 * Rules in force.
 */
export function renderLedger(records: readonly LedgerRecord[]): string {
  const later = records.filter((record) => record.outcome === "later" && !record.compaction).map(entryLine);
  return ["## Proposal ledger", "", "### Later", "", later.length > 0 ? later.join("\n") : "None."].join("\n");
}
