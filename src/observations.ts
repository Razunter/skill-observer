import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appendLedger, normaliseText, readLatestRows } from "./ledger.js";

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
 * Records `text` for the project of `cwd` and returns how many observations
 * are now pending for it. Throws when the text is refused or the append fails.
 */
export function recordObservation(file: string, cwd: string, text: string, now: Date): number {
  const trimmed = text.trim();
  const length = [...trimmed].length;
  if (length === 0) throw new Error("the observation is empty");
  if (!/[\p{L}\p{N}]/u.test(trimmed)) throw new Error("the observation has no letter or digit");
  if (length > TEXT_LIMIT) throw new Error(`the observation is ${length} characters; the limit is ${TEXT_LIMIT}`);
  const project = projectIdentity(cwd);
  const key = createHash("sha256").update(`${project}\n${normaliseText(trimmed)}`).digest("hex").slice(0, 12);
  const pending = pendingRows(file, project, now);
  const latest = pending.find((row) => row.key === key);
  appendRows(file, [{ key, project, text: trimmed, count: latest ? latest.count + 1 : 1, recordedAt: now.toISOString() }]);
  return latest ? pending.length : pending.length + 1;
}

/** The pending observations of the project of `cwd`, least recently recorded first. */
export function pendingObservations(file: string, cwd: string, now: Date): Observation[] {
  return pendingRows(file, projectIdentity(cwd), now).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** Marks the listed revisions shown; a later recording of the same text stays pending, whenever it was appended. */
export function markObservationsShown(file: string, observations: readonly Observation[], now: Date): void {
  if (observations.length === 0) return;
  appendRows(file, observations.map((row) => ({ ...row, shownAt: now.toISOString() })));
}

/**
 * The latest recording per key, unless the latest shown row of that key names
 * the same revision. Expiry is decided on read: nothing runs in the
 * background, and the file is never rewritten.
 */
function pendingRows(file: string, project: string, now: Date): Observation[] {
  const rows = readLatestRows<Observation>(file, (row) => (row.shownAt === undefined ? row.key : `shown:${row.key}`));
  const shown = new Map(rows.filter((row) => row.shownAt !== undefined).map((row) => [row.key, row]));
  return rows.filter((row) => {
    const marker = shown.get(row.key);
    const wasShown = marker !== undefined && marker.recordedAt === row.recordedAt && marker.count === row.count;
    return row.shownAt === undefined && row.project === project && !wasShown && now.getTime() - Date.parse(row.recordedAt) < PENDING_MS;
  });
}

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

/**
 * The real path of the repository's shared git directory, so every worktree
 * of a repository shares one identity; outside git, the real path of `cwd`.
 * Read from the filesystem: running git would cost a process per call.
 */
function projectIdentity(cwd: string): string {
  const start = realpathSync(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    const shared = sharedGitDir(dir);
    if (shared) return shared;
    if (dirname(dir) === dir) return start;
  }
}

/** The shared git directory of `dir`, found through its `.git` directory or `gitdir:` file, or of `dir` itself as a bare git directory. */
function sharedGitDir(dir: string): string | undefined {
  const dotGit = statSync(join(dir, ".git"), { throwIfNoEntry: false });
  if (dotGit?.isDirectory()) return commonDir(join(dir, ".git"));
  if (dotGit?.isFile()) {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(dir, ".git"), "utf8"))?.[1]?.trim();
    return pointer ? commonDir(resolve(dir, pointer)) : undefined;
  }
  return isBareGitDir(dir) ? commonDir(dir) : undefined;
}

function isBareGitDir(dir: string): boolean {
  const entry = (name: string) => statSync(join(dir, name), { throwIfNoEntry: false });
  return Boolean(entry("HEAD")?.isFile() && entry("objects")?.isDirectory() && entry("refs")?.isDirectory());
}

/** A linked worktree's git directory names the shared one in its `commondir` file. */
function commonDir(gitDir: string): string {
  const commondir = join(gitDir, "commondir");
  return realpathSync(existsSync(commondir) ? resolve(gitDir, readFileSync(commondir, "utf8").trim()) : gitDir);
}

function appendRows(file: string, rows: readonly Observation[]): void {
  const { error } = appendLedger(file, rows);
  if (error) throw new Error(error);
}
