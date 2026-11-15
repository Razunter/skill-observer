/**
 * The proposal ledger: the user's answers to observation-pass proposals, kept
 * across sessions and projects so declines stick and deferrals come back. It is
 * an append-only JSONL file; the latest record per fingerprint wins.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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

export interface ProjectPublication {
  writeToolCallId: string;
  checkToolCallIds: string[];
  afterHash: string;
}

export interface ProjectLedgerRecord extends LedgerEntry {
  kind: "project";
  target: ProjectTarget;
  publication?: ProjectPublication;
  skill?: never;
  rule?: never;
  compaction?: never;
}

/**
 * A target in one of the three roots an observer hook or the companion
 * extension lives in. A hook is named by its root-relative `path`, or, for a
 * new one, by its proposal fingerprint (see {@link hookFileName}); a companion
 * change by the companion root alone, since it may touch several files.
 */
export type HarnessTarget =
  | {
    scope: "harness"; root: "project-hooks";
    /** The canonical project root whose hooks directory holds the hook. */
    project: string;
    path?: string; mechanism: string;
  }
  | { scope: "harness"; root: "global-hooks"; path?: string; mechanism: string }
  | { scope: "harness"; root: "companion"; path?: never; mechanism: string };
export type HarnessRoot = HarnessTarget["root"];
export const HARNESS_ROOTS = ["project-hooks", "global-hooks", "companion"] as const satisfies readonly HarnessRoot[];

/** What an applied hook or companion change rests on: the pass's write and check calls, and each written file's hash, root-relative. */
export interface HarnessPublication {
  writeToolCallIds: string[];
  checkToolCallIds: string[];
  files: Array<{ path: string; afterHash: string }>;
}

/** One file of drafted hook or companion code: its path relative to the target root and its exact text. */
export interface HarnessFile { path: string; text: string }

export interface HarnessLedgerRecord extends LedgerEntry {
  kind: "harness";
  target: HarnessTarget;
  publication?: HarnessPublication;
  skill?: never;
  rule?: never;
  compaction?: never;
}

export type LedgerRecord = SkillLedgerRecord | ProjectLedgerRecord | HarnessLedgerRecord;

/** What a proposal or record targets: a skill, a project file or a harness root. */
export type TargetScope =
  | { kind: ProposalKind; skill: string; target?: never }
  | { kind: "project"; target: ProjectTarget; skill?: never }
  | { kind: "harness"; target: HarnessTarget; skill?: never };

export const HARNESS_ROOT_NAMES: Record<HarnessRoot, string> = { "project-hooks": "project hook", "global-hooks": "global hook", companion: "companion extension" };
const COMPANION_DIR = "skill-observer-companion";

/** How the form, the ledger section and the resolver name a target: `` `name` (kind) ``. */
export function targetLabel(entry: TargetScope & { fingerprint: string }): string {
  switch (entry.kind) {
    case "project":
      return `\`${entry.target.path}\` (project)`;
    case "harness": {
      const { target } = entry;
      return `\`${target.root === "companion" ? COMPANION_DIR : hookPath(target, entry.fingerprint)}\` (${HARNESS_ROOT_NAMES[target.root]})`;
    }
    default:
      return `\`${entry.skill}\` (${entry.kind})`;
  }
}

/** The directory each harness root names: hooks only load from a `pre` or `post` folder, and observer hooks go in `pre`. */
export function harnessRootDirs(cwd: string, agentDir: string): Record<HarnessRoot, string> {
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
  // A hook or companion file written as a project fix would run after one approval; the harness scope asks for the description and then the code.
  const harness = harnessRootDirs(root, ompAgentDir());
  const destination = join(root, path);
  const inside = ([
    [dirname(harness["project-hooks"]), "the project's hooks directory", "as a project hook"],
    [dirname(harness["global-hooks"]), "the global hooks directory", "as a global hook"],
    [harness.companion, "the companion extension directory", "as a companion change"],
  ] as const).find(([dir]) => {
    const within = relative(canonicalMissingPath(dir), destination);
    return within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
  });
  if (inside) throw new Error(`\`${path}\` lies in ${inside[1]}: propose it with the \`harness\` target scope, ${inside[2]}`);
  return { scope: "project", root, path, mechanism: target.mechanism.trim() };
}

/** The harness target as identity takes it: its root kind, the current project for a project hook, and a path that stays in its root. */
export function canonicalHarnessTarget(cwd: string, agentDir: string, target: HarnessTarget): HarnessTarget {
  if (!target || target.scope !== "harness" || !HARNESS_ROOTS.includes(target.root) || typeof target.mechanism !== "string" || !target.mechanism.trim()) {
    throw new Error(`a harness target needs a root (${HARNESS_ROOTS.join(", ")}) and a mechanism`);
  }
  const mechanism = target.mechanism.trim();
  if (target.root === "companion") {
    if (target.path !== undefined) throw new Error("a companion change is identified by the companion root and its mechanism, not by a file");
    return { scope: "harness", root: "companion", mechanism };
  }
  if (target.path !== undefined && typeof target.path !== "string") throw new Error("a hook target's path is a root-relative file path");
  const project = realpathSync(cwd);
  const root = canonicalMissingPath(harnessRootDirs(project, agentDir)[target.root]);
  const path = target.path === undefined ? undefined : canonicalPathIn(root, target.path, "hook target");
  const named = target.root === "project-hooks" ? { root: target.root, project, mechanism } : { root: target.root, mechanism };
  const canonical: HarnessTarget = { scope: "harness", ...named, ...(path !== undefined && { path }) };
  // A new hook named by its own file stays the identity it was proposed under.
  return path !== undefined && path === hookFileName(harnessFingerprint({ ...canonical, path: undefined })) ? { scope: "harness", ...named } : canonical;
}

/** `path` canonical and relative to `root`: a plain root-relative file path, through no symlink out of the root. */
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

function canonicalMissingPath(path: string): string {
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

/** A harness proposal's identity: root kind, the project for a project hook, root-relative path (none for a new hook or the companion) and mechanism. */
export function harnessFingerprint(target: HarnessTarget): string {
  const mechanism = normaliseText(target.mechanism);
  if (!mechanism) throw new Error("harness mechanism must contain letters or digits");
  const project = target.root === "project-hooks" ? target.project : null;
  return createHash("sha256").update(JSON.stringify(["harness", target.root, project, target.path ?? null, mechanism])).digest("hex").slice(0, 12);
}

/** The hook file a harness target names, as a key: root kind, the project for a project hook, and file name; none for the companion. */
export function hookFileKey(target: HarnessTarget, fingerprint: string): string | undefined {
  if (target.root === "companion") return undefined;
  return JSON.stringify([target.root, target.root === "project-hooks" ? target.project : null, hookPath(target, fingerprint)]);
}

/** A hook removal's identity is its file alone, so a declined removal stays declined however it is worded and never suppresses a change to that hook. */
export const removalFingerprint = (fileKey: string) => createHash("sha256").update(JSON.stringify(["harness-removal", fileKey])).digest("hex").slice(0, 12);

/** Shared storage does not make another project's decisions visible in this pass; global hook and companion decisions apply in every project. */
export function ledgerForProject(records: readonly LedgerRecord[], cwd: string): LedgerRecord[] {
  const root = realpathSync(cwd);
  return records.filter((record) => {
    switch (record.kind) {
      case "project":
        try {
          return projectFingerprint(canonicalProjectTarget(root, record.target)) === record.fingerprint;
        } catch { return false; }
      case "harness":
        return record.target.root !== "project-hooks" || record.target.project === root;
      default:
        return record.target === undefined;
    }
  });
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

/** Whether a record reached the ledger, as the file's bytes show; `unknown` when a failed append left bytes that can't settle it. */
export type Recording = "recorded" | "unrecorded" | "unknown";

export interface LedgerAppend {
  /** One per record, in order. */
  rows: Recording[];
  /** Why the append failed. */
  error?: string;
}

/**
 * Appends `records`. When the append fails, one read of the file shows which
 * of them it wrote whole: an exception does not prove that nothing was
 * written. Nothing is retried.
 */
export function appendLedger(file: string, records: readonly object[]): LedgerAppend {
  const lines = records.map((record) => Buffer.from(`${JSON.stringify(record)}\n`));
  let existing: Buffer;
  try {
    mkdirSync(dirname(file), { recursive: true });
    existing = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  } catch (error) {
    // Nothing reached `appendFileSync`, so no row was written.
    return { rows: lines.map(() => "unrecorded"), error: (error as Error).message };
  }
  // After an interrupted append, start on a fresh line so the torn one doesn't swallow the first new record.
  const separator = Buffer.from(existing.length === 0 || existing.at(-1) === 0x0a ? "" : "\n");
  const appended = Buffer.concat([separator, ...lines]);
  try {
    appendFileSync(file, appended);
    return { rows: lines.map(() => "recorded") };
  } catch (error) {
    return { rows: writtenRows(file, existing, separator, lines), error: (error as Error).message };
  }
}

/**
 * Which of `lines` the file holds whole after a failed append of them after
 * `separator` to `existing`: it must still start with `existing` and go on
 * with a prefix of what was appended. A line whose JSON is complete reads as
 * a record even without its newline.
 */
function writtenRows(file: string, existing: Buffer, separator: Buffer, lines: readonly Buffer[]): Recording[] {
  let now: Buffer;
  try {
    now = readFileSync(file);
  } catch (error) {
    // A file that isn't there holds no record; one that can't be read settles nothing.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return lines.map(() => "unknown");
    now = Buffer.alloc(0);
  }
  const tail = now.subarray(existing.length);
  const appended = Buffer.concat([separator, ...lines]);
  if (!now.subarray(0, existing.length).equals(existing) || !appended.subarray(0, tail.length).equals(tail)) return lines.map(() => "unknown");
  let end = separator.length;
  return lines.map((line) => {
    end += line.length;
    return tail.length >= end - 1 ? "recorded" : "unrecorded";
  });
}

/** The latest record per fingerprint, oldest answer first. */
export function readLedger(file: string): LedgerRecord[] {
  return readLatestRows<LedgerRecord>(file, (record) => record.fingerprint);
}

/** The latest row per key of an append-only JSONL file, in file order of those rows. */
export function readLatestRows<T extends object>(file: string, keyOf: (row: T) => string): T[] {
  if (!existsSync(file)) return [];
  const latest = new Map<string, T>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: T;
    try {
      row = JSON.parse(line);
    } catch {
      // A line cut short by an interrupted append carries no row; the rest of the file still holds.
      continue;
    }
    if (!row || typeof row !== "object") continue;
    latest.delete(keyOf(row));
    latest.set(keyOf(row), row);
  }
  return [...latest.values()];
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
  `- ${targetLabel(record)}, fingerprint \`${record.fingerprint}\`${record.kind === "project" || record.kind === "harness" ? `, mechanism ${JSON.stringify(record.target.mechanism)}` : ""}: ${record.gist}` +
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
