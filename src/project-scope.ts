import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { SessionEntry } from "./omp.js";

export interface ProjectScopeNote {
  roots: string[];
  worktrees: string[];
}

/** Only scope directives written by the user count; arbitrary path mentions do not. */
export function projectScopeNote(note: string | undefined, branch: readonly SessionEntry[]): ProjectScopeNote | undefined {
  let instruction: string | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "reset_boundary" || entry.customType === "skill-prompt") break;
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "user" || message.synthetic || message.attribution === "agent") continue;
    instruction = typeof message.content === "string" ? message.content : (Array.isArray(message.content) ? message.content : [])
      .flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
    break;
  }
  if (note === undefined && instruction === undefined) return;
  const roots = new Set<string>();
  const worktrees = new Set<string>();
  for (const source of [instruction, note]) {
    let fence: string | undefined;
    for (const line of (source ?? "").split(/\r?\n/)) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence !== undefined) {
        if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
        continue;
      }
      if (marker) {
        fence = marker[1]!;
        continue;
      }
      const directive = /^Include (project root|worktree):[ \t]+(.+)$/i.exec(line);
      const request = /^(?:Please )?(?:also )?apply (?:it|(?:this|the) (?:fix|change)) (?:to|in) (`[^`]+`|\/\S+)$/i.exec(line);
      const path = (directive?.[1]?.toLowerCase() === "project root" ? directive[2] : request?.[1])?.trim().replace(/^`([^`]+)`$/, "$1");
      if (path && isAbsolute(path) && normalize(path) === path) roots.add(path);
      if (directive?.[1]?.toLowerCase() === "worktree") {
        const name = directive[2]!.trim().replace(/^`([^`]+)`$/, "$1");
        if (/^[\w./-]+$/.test(name)) worktrees.add(name);
      }
    }
  }
  return { roots: [...roots], worktrees: [...worktrees] };
}

/** Resolve names only in the current repository. Never probe a model-supplied foreign root to infer permission. */
export function projectRootScope(cwd: string, note?: ProjectScopeNote): (root: string) => string {
  const current = realpathSync(cwd);
  let named: Set<string> | undefined;
  return (root) => {
    if (root === cwd || root === current) return current;
    const hasAbsoluteRoot = typeof root === "string" && isAbsolute(root);
    if (hasAbsoluteRoot && ((Array.isArray(note?.roots) && note.roots.includes(root)) ||
      (Array.isArray(note?.worktrees) && note.worktrees.length > 0 && (named ??= namedWorktrees(current, note.worktrees)).has(root)))) {
      if (realpathSync(root) === root) return root;
      throw new Error(`\`${root}\` is not a canonical project root`);
    }
    throw new Error(`\`${root}\` is not in the user's project scope; use the current working project or ask the user to include the exact project root or name a worktree`);
  };
}

function namedWorktrees(cwd: string, names: readonly string[]): Set<string> {
  let list: string;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    list = execFileSync("git", ["--no-optional-locks", "-C", cwd, "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return new Set();
  }
  const roots = new Set<string>();
  for (const record of list.split("\0\0")) {
    const fields = record.split("\0");
    const worktree = fields[0]?.startsWith("worktree ") ? fields[0].slice(9) : undefined;
    if (worktree && !fields.some(field => /^(bare|prunable)(?: |$)/.test(field)) &&
        fields.some(field => field.startsWith("branch refs/heads/") && names.includes(field.slice(18)))) roots.add(worktree);
  }
  return roots;
}
