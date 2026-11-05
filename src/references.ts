/**
 * Reference files of a skill's on-read amendment: topical sections a
 * compaction moved out of the amendment's body, which keeps a one-line
 * "when X, read <path>" pointer to each. They live in the extension's own
 * references directory, outside the rules directory so OMP never loads them as
 * rules, in one folder per skill, and belong to the skill's amendment: they
 * are replaced with it and deleted with it.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A reference file as the pass drafts it: its file name within the skill's folder and its text. */
export interface ReferenceFile {
  name: string;
  body: string;
}

/** One path segment: it starts with a letter or digit and holds no separator, so neither `..` nor a nested path leaves the folder. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkSegment(segment: string, what: string): void {
  if (!SEGMENT.test(segment)) {
    throw new Error(
      `${what} \`${segment}\` must be a plain file name: a letter or digit, then letters, digits, \`.\`, \`_\` and \`-\`, with no path separator or \`..\``,
    );
  }
}

/** The folder holding `skill`'s reference files. */
export function referenceFolder(referencesDir: string, skill: string): string {
  checkSegment(skill, "skill name");
  return join(referencesDir, skill);
}

/** Throws when a reference file's name would leave its skill's folder, or two files share a name. */
export function checkReferenceFiles(files: readonly ReferenceFile[]): void {
  const names = new Set<string>();
  for (const { name } of files) {
    checkSegment(name, "reference file name");
    if (names.has(name)) throw new Error(`reference file \`${name}\` is given twice`);
    names.add(name);
  }
}

/**
 * Throws when `body` lacks the absolute path of one of `files`: each file is
 * reached only through the body's pointer line naming it by that path.
 */
export function checkPointers(referencesDir: string, skill: string, body: string, files: readonly ReferenceFile[]): void {
  const folder = referenceFolder(referencesDir, skill);
  const missing = files.map(({ name }) => join(folder, name)).filter((path) => !body.includes(path));
  if (missing.length === 0) return;
  throw new Error(
    `the body has no pointer line naming ${missing.map((path) => `\`${path}\``).join(", ")}; replace each moved section, heading included, with the one line "When <condition>, read <absolute path>." and send the answer again`,
  );
}

/** The sentence listing an on-read amendment's reference files by absolute path; empty for none. */
export const referenceFilesSentence = (paths: readonly string[]): string =>
  paths.length > 0 ? ` Reference files: ${paths.map((path) => `\`${path}\``).join(", ")}.` : "";

/** The absolute paths of `skill`'s reference files, by name; none when the folder is missing or the skill name can't name one. */
export function readReferenceFiles(referencesDir: string, skill: string): string[] {
  try {
    const folder = referenceFolder(referencesDir, skill);
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(folder, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Whether `skill`'s reference folder holds anything besides plain files, such as
 * a subfolder. Replacing the folder deletes those too, and no reference snapshot
 * shows them, so a protected change refuses to replace such a folder.
 */
export function hasUnlistedReferenceEntries(referencesDir: string, skill: string): boolean {
  try {
    return readdirSync(referenceFolder(referencesDir, skill), { withFileTypes: true }).some((entry) => !entry.isFile());
  } catch {
    return false;
  }
}

/**
 * Replaces the contents of `skill`'s reference folder with exactly `files`,
 * removing the folder when there are none. The new set is written into a
 * sibling folder and renamed into place. When supplied, the body writer runs
 * before the previous references are discarded, and a failure restores them.
 * A retained backup requires reconciliation before another replacement.
 */
export function replaceReferenceFiles(referencesDir: string, skill: string, files: readonly ReferenceFile[], writeBody?: () => void): void {
  checkReferenceFiles(files);
  const folder = referenceFolder(referencesDir, skill);
  const staged = join(referencesDir, `.${skill}.staged`);
  const old = join(referencesDir, `.${skill}.old`);
  if (existsSync(old)) throw new Error(`reference recovery is pending at ${old}; reconcile it before replacing references`);
  rmSync(staged, { recursive: true, force: true });
  try {
    if (files.length > 0) {
      mkdirSync(staged, { recursive: true });
      for (const { name, body } of files) writeFileSync(join(staged, name), `${body.trim()}\n`);
    }
    const hadOld = existsSync(folder);
    if (hadOld) renameSync(folder, old);
    try {
      if (files.length > 0) renameSync(staged, folder);
      writeBody?.();
    } catch (error) {
      try {
        rmSync(folder, { recursive: true, force: true });
        if (hadOld) renameSync(old, folder);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError],
          `reference/body publication failed and restoring the previous references failed too: \`${folder}\` may be missing or partial, and the previous reference files remain at \`${old}\`; inspect both and restore the folder before calling observer_resolve again`);
      }
      throw error;
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  // Publication committed; a cleanup failure leaves a hidden backup that requires reconciliation.
  try {
    rmSync(old, { recursive: true, force: true });
  } catch {}
}
