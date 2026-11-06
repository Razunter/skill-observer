/**
 * Writes `observer/`, one file per fragment of `observer.md`, for readers:
 * `<section>-<gate|core>-<n>.md`, where `n` is the fragment's position in its
 * section. `/observe` assembles from `observer.md` itself; a test fails when
 * the committed files drift from what this writes.
 *
 * Run: bun run generate
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUCTIONS_PATH, parseFragments } from "../src/payload.js";

export const FRAGMENTS_DIR = fileURLToPath(new URL("../observer/", import.meta.url));

/** The fragment files of `markdown`, by file name; parsing throws on a malformed marker. */
export function fragmentFiles(markdown: string): Record<string, string> {
  const files: Record<string, string> = {};
  const positions: Record<string, number> = {};
  for (const { section, gate, text } of parseFragments(markdown)) {
    const n = (positions[section] ?? 0) + 1;
    positions[section] = n;
    files[`${section}-${gate ?? "core"}-${String(n).padStart(2, "0")}.md`] = `${text}\n`;
  }
  return files;
}

if (import.meta.main) {
  const files = fragmentFiles(readFileSync(INSTRUCTIONS_PATH, "utf8"));
  rmSync(FRAGMENTS_DIR, { recursive: true, force: true });
  mkdirSync(FRAGMENTS_DIR);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(FRAGMENTS_DIR, name), text);
  console.log(`Wrote ${Object.keys(files).length} fragments to ${FRAGMENTS_DIR}`);
}
