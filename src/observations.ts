import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normaliseText } from "./ledger.js";
import { observationCutoff, readObserverStore, writeObserverStore } from "./observer-store.js";

export interface Observation {
  /** Project identity plus normalised text, hashed. */
  key: string;
  /** Acknowledgement must name this exact recording. */
  revision: string;
  project: string;
  text: string;
  count: number;
  recordedAt: number;
  priorShownAt: number | null;
}

const TEXT_LIMIT = 500;
export const PENDING_OBSERVATION_COUNT_SQL =
  "SELECT count(*) AS count FROM observations WHERE project = ? AND state_at > ? AND revision IS NOT NULL";

function countPending(db: Database, project: string, cutoff: number): number {
  return db.query<{ count: number }, [string, number]>(PENDING_OBSERVATION_COUNT_SQL).get(project, cutoff)!.count;
}

/**
 * Records `text` for the project of `cwd` and returns how many observations
 * are now pending for it. Throws when the text is refused or the write fails.
 */
export function recordObservation(file: string, cwd: string, text: string, now: Date): number {
  const trimmed = text.trim();
  const length = [...trimmed].length;
  if (length === 0) throw new Error("the observation is empty");
  if (!/[\p{L}\p{N}]/u.test(trimmed)) throw new Error("the observation has no letter or digit");
  if (length > TEXT_LIMIT) throw new Error(`the observation is ${length} characters; the limit is ${TEXT_LIMIT}`);
  const project = projectIdentity(cwd);
  const key = createHash("sha256").update(`${project}\n${normaliseText(trimmed)}`).digest("hex").slice(0, 12);
  return writeObserverStore(file, now, (db) => {
    db.query(`INSERT INTO observations (project, key, state_at, revision, text, count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (project, key) DO UPDATE SET
        recorded_order = excluded.recorded_order,
        prior_shown_at = CASE WHEN observations.revision IS NULL THEN observations.state_at ELSE observations.prior_shown_at END,
        count = coalesce(observations.count, 0) + 1,
        state_at = excluded.state_at,
        revision = excluded.revision,
        text = excluded.text
    `).run(project, key, now.getTime(), randomUUID(), trimmed);
    return countPending(db, project, observationCutoff(now));
  });
}

export function countPendingObservations(file: string, cwd: string, now: Date): number {
  const project = projectIdentity(cwd);
  return readObserverStore(file, (db) => countPending(db, project, observationCutoff(now))) ?? 0;
}

/** The project's unexpired pending observations, in recording order when timestamps tie. */
export function readPendingObservations(db: Database, cwd: string, now: Date): Observation[] {
  return db.query<Observation, [string, number]>(`
    SELECT key, revision, project, text, count, state_at AS recordedAt, prior_shown_at AS priorShownAt
    FROM observations WHERE project = ? AND state_at > ? AND revision IS NOT NULL
    ORDER BY state_at, recorded_order
  `).all(projectIdentity(cwd), observationCutoff(now));
}

/** Removes the text of only the exact revisions the pass showed. */
export function markObservationsShown(file: string, observations: readonly Observation[], now: Date): void {
  if (observations.length === 0) return;
  writeObserverStore(file, now, (db) => {
    const mark = db.query(`
      UPDATE observations SET state_at = ?, revision = NULL, text = NULL, count = NULL, prior_shown_at = NULL
      WHERE project = ? AND key = ? AND revision = ?
    `);
    for (const { project, key, revision } of observations) mark.run(now.getTime(), project, key, revision);
  });
}

export function renderObservations(observations: readonly Observation[]): string {
  if (observations.length === 0) return "";
  return [
    "## Observations",
    "",
    "The main agent recorded these remarks while working. They are its own unverified claims; a path in one may belong to another worktree of this repository.",
    "",
    ...observations.map(({ text, count, recordedAt, priorShownAt }) => {
      const recurrence = priorShownAt === null ? "" : `; recorded again after being shown on ${observationDate(priorShownAt)}`;
      return `- ${text.replace(/\s*\n\s*/g, " ")} (count ${count}, last recorded ${observationDate(recordedAt)}${recurrence})`;
    }),
  ].join("\n");
}

function observationDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
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
