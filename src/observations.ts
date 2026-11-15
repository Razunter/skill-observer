/**
 * The observation store: remarks the main agent records with the `observe`
 * tool for a later observation pass, kept per project in one append-only
 * JSONL file. The latest row per key wins.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Observation {
  /** Project identity plus normalised text, hashed. */
  key: string;
  project: string;
  text: string;
  count: number;
  recordedAt: string;
  shownAt?: string;
}

const TEXT_LIMIT = 500;
const PENDING_MS = 30 * 86_400_000;

/**
 * Records `text` for the project of `cwd`: a text whose key is pending counts
 * once more, any other starts at count 1. Returns how many observations are
 * now pending for the project. Throws when the text breaks a rule or the
 * append fails.
 */
export function recordObservation(file: string, cwd: string, text: string, now: Date): number {
  const trimmed = text.trim();
  const length = [...trimmed].length;
  if (length === 0) throw new Error("the observation is empty");
  if (!/[\p{L}\p{N}]/u.test(trimmed)) throw new Error("the observation has no letter or digit");
  if (length > TEXT_LIMIT) throw new Error(`the observation is ${length} characters; the limit is ${TEXT_LIMIT}`);
  const project = projectIdentity(cwd);
  const key = observationKey(project, trimmed);
  const pending = readObservations(file).filter((row) => row.project === project && isPending(row, now));
  const latest = pending.find((row) => row.key === key);
  appendRows(file, [{ key, project, text: trimmed, count: latest ? latest.count + 1 : 1, recordedAt: now.toISOString() }]);
  return latest ? pending.length : pending.length + 1;
}

/** The project's pending observations, oldest last recording first. */
export function pendingObservations(file: string, cwd: string, now: Date): Observation[] {
  const project = projectIdentity(cwd);
  return readObservations(file)
    .filter((row) => row.project === project && isPending(row, now))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** Marks `observations` as shown, so no later pass lists them. Throws when the append fails. */
export function markObservationsShown(file: string, observations: readonly Observation[], now: Date): void {
  if (observations.length === 0) return;
  appendRows(file, observations.map((row) => ({ ...row, shownAt: now.toISOString() })));
}

/** Expiry is decided on read: nothing runs in the background, and the file is never rewritten. */
const isPending = (row: Observation, now: Date) => row.shownAt === undefined && now.getTime() - Date.parse(row.recordedAt) < PENDING_MS;

/** The observations section of the payload; empty when none is pending. */
export function renderObservations(observations: readonly Observation[]): string {
  if (observations.length === 0) return "";
  return [
    "## Observations",
    "",
    "The main agent recorded these remarks while working. They are its own unverified claims; a path in one may belong to another worktree of this repository.",
    "",
    ...observations.map(({ text, count, recordedAt }) => `- ${text.replace(/\s*\n\s*/g, " ")} (count ${count}, last recorded ${recordedAt.slice(0, 10)})`),
  ].join("\n");
}

const observationKey = (project: string, text: string) =>
  createHash("sha256").update(`${project}\n${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")}`).digest("hex").slice(0, 12);

/**
 * The real path of the repository's shared git directory, so every worktree
 * of a repository shares one identity; outside git, the real path of `cwd`.
 * Read from the filesystem: running git would cost a process per call.
 */
export function projectIdentity(cwd: string): string {
  const start = realpathSync(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    const shared = sharedGitDir(dir);
    if (shared) return shared;
    if (dirname(dir) === dir) return start;
  }
}

/** The shared git directory `dir` belongs to as a git directory itself or through its `.git`. */
function sharedGitDir(dir: string): string | undefined {
  if (isGitDir(dir)) return commonDir(dir);
  const dotGit = join(dir, ".git");
  if (!existsSync(dotGit)) return undefined;
  if (statSync(dotGit).isDirectory()) return commonDir(dotGit);
  const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  return pointer ? commonDir(resolve(dir, pointer)) : undefined;
}

const isGitDir = (dir: string) => existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"));

/** A linked worktree's git directory names the shared one in its `commondir` file. */
function commonDir(gitDir: string): string {
  const commondir = join(gitDir, "commondir");
  return realpathSync(existsSync(commondir) ? resolve(gitDir, readFileSync(commondir, "utf8").trim()) : gitDir);
}

function appendRows(file: string, rows: readonly Observation[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  // After an interrupted append, start on a fresh line so the torn one doesn't swallow the first new row.
  const separator = existing.length === 0 || existing.at(-1) === 0x0a ? "" : "\n";
  appendFileSync(file, separator + rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** The latest row per key, in file order of their latest rows. */
function readObservations(file: string): Observation[] {
  if (!existsSync(file)) return [];
  const latest = new Map<string, Observation>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: Observation;
    try {
      row = JSON.parse(line);
    } catch {
      // A line cut short by an interrupted append carries no observation; the rest still holds.
      continue;
    }
    if (!row || typeof row !== "object") continue;
    latest.delete(row.key);
    latest.set(row.key, row);
  }
  return [...latest.values()];
}
