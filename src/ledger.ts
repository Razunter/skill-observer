/**
 * The proposal ledger: the user's answers to observation-pass proposals, kept
 * across sessions and projects so declines stick and deferrals come back. It is
 * an append-only JSONL file; the latest record per fingerprint wins.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

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

export type LedgerRecord = SkillLedgerRecord | ProjectLedgerRecord;

/** The launch directory defines project scope; symlink aliases share one identity. */
export function canonicalProjectTarget(cwd: string, target: ProjectTarget): ProjectTarget {
  if (!target || target.scope !== "project" || typeof target.root !== "string" || typeof target.path !== "string" ||
      typeof target.mechanism !== "string" || !target.mechanism.trim()) throw new Error("a project target needs root, path and mechanism");
  const root = realpathSync(cwd);
  if (!statSync(root).isDirectory() || realpathSync(target.root) !== root) throw new Error("project root must be the current working project");
  if (!target.path || isAbsolute(target.path) || target.path.includes("\\") || target.path.includes("\0") ||
      target.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("project target must be a plain root-relative file path");
  const path = relative(root, canonicalMissingPath(join(root, target.path)));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("project target escapes its root");
  const file = join(root, path);
  if (existsSync(file) && !statSync(file).isFile()) throw new Error("project target must name a file");
  return { scope: "project", root, path, mechanism: target.mechanism.trim() };
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
  const mechanism = target.mechanism.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!mechanism) throw new Error("project mechanism must contain letters or digits");
  return createHash("sha256").update(JSON.stringify(["project", target.root, target.path, mechanism])).digest("hex").slice(0, 12);
}

/** Shared storage does not make another project's decisions visible in this pass. */
export function ledgerForProject(records: readonly LedgerRecord[], cwd: string): LedgerRecord[] {
  const root = realpathSync(cwd);
  return records.filter((record) => {
    if (record.kind !== "project") return record.target === undefined;
    try {
      const target = canonicalProjectTarget(root, record.target);
      return projectFingerprint(target) === record.fingerprint;
    } catch { return false; }
  });
}

/**
 * A proposal's identity across sessions: the target skill plus the gist with
 * case, punctuation and spacing normalised away, hashed to a short token.
 * Separators are dropped, not collapsed, so "re-run" and "rerun" match.
 */
export function proposalFingerprint(skill: string, gist: string): string {
  const normalisedGist = gist.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return createHash("sha256").update(`${skill.trim()}\n${normalisedGist}`).digest("hex").slice(0, 12);
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
export function appendLedger(file: string, records: readonly LedgerRecord[]): LedgerAppend {
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
  if (!existsSync(file)) return [];
  const latest = new Map<string, LedgerRecord>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: LedgerRecord;
    try {
      record = JSON.parse(line);
    } catch {
      // A line cut short by an interrupted append carries no answer; the rest of the ledger still holds.
      continue;
    }
    if (!record || typeof record !== "object") continue;
    latest.delete(record.fingerprint);
    latest.set(record.fingerprint, record);
  }
  return [...latest.values()];
}

/** Outcomes that leave a fix applied: applied, or its amendment kept or re-pinned at a stale check. */
export const IN_FORCE_OUTCOMES: ReadonlySet<LedgerOutcome> = new Set(["applied", "kept", "updated"]);

const entryLine = (record: LedgerRecord) =>
  `- \`${record.kind === "project" ? record.target.path : record.skill}\` (${record.kind}), fingerprint \`${record.fingerprint}\`${record.kind === "project" ? `, mechanism ${JSON.stringify(record.target.mechanism)}` : ""}: ${record.gist}`;

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
