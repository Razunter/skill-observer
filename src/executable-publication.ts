import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { checkPublishedExecutableInputs, type ExecutableCheck, prepareExecutableCheck } from "./executable-check.js";
import { canonicalMissingPath, canonicalPathIn, type HarnessFile, harnessDestinationRoot, harnessRootDirs, type HarnessTarget } from "./ledger.js";
import { checkScalarFileState, fileId, prepareScalarFile, type ScalarFileEdit } from "./project-publication.js";
import type { SessionToolEvidence } from "./session-tool-evidence.js";

export interface ExecutableEdit {
  operation: "harness";
  stage: "checked";
  root: string;
  rootId: string | null;
  files: Array<ScalarFileEdit & { path: string }>;
  check: ExecutableCheck;
}

export function prepareExecutableEdit(target: HarnessTarget, hookPath: string | undefined,
    draft: { files: HarnessFile[]; checkToolCallId: string; lowerRungs: string },
    { cwd, agentDir, evidence, passStart }: { cwd: string; agentDir: string; evidence: SessionToolEvidence; passStart: number | undefined }):
    { change: ExecutableEdit; preview: string } {
  if (typeof draft.lowerRungs !== "string" || !draft.lowerRungs.trim() || typeof draft.checkToolCallId !== "string" || !draft.checkToolCallId) {
    throw new Error("explain why simpler remedies do not fit and cite the observed scratch check");
  }
  const { files } = draft;
  if (!Array.isArray(files) || files.length === 0 || new Set(files.map((file) => file?.path)).size !== files.length ||
      files.some((file) => !file || typeof file.path !== "string" || file.text !== undefined && typeof file.text !== "string")) {
    throw new Error("list every changed executable file once, with its exact text or a removal");
  }
  if (hookPath !== undefined && (files.length !== 1 || files[0]?.path !== hookPath || !/\.[jt]s$/.test(hookPath))) {
    throw new Error("a hook edit names its one exact TypeScript or JavaScript file");
  }
  const root = harnessDestinationRoot(target, cwd, agentDir);
  const hookRoots = harnessRootDirs(cwd, agentDir);
  const reserved = [dirname(hookRoots["project-hooks"]), dirname(hookRoots["global-hooks"]), hookRoots.companion];
  if (target.root === "extension" && target.checkout !== undefined) {
    reserved.push(agentDir, join(target.checkout, ".omp/hooks"));
  }
  const previews: string[] = [];
  const changes = files.map(({ path, text }) => {
    if (canonicalPathIn(root, path, "executable target") !== path || path.split("/").some((part) => [".git", "node_modules"].includes(part))) {
      throw new Error("an executable target must be an ordinary file at its exact canonical path");
    }
    if (target.root === "extension" && reserved.some((dir) => inside(canonicalMissingPath(dir), join(root, path)))) {
      throw new Error("this executable file belongs to another owner scope");
    }
    const prepared = prepareScalarFile({ root, path }, text);
    previews.push(prepared.preview);
    return { path, ...prepared.edit };
  });
  if (target.root === "companion" && !existsSync(root)) {
    const manifest = files.find(({ path }) => path === "package.json")?.text;
    const entries = manifest && JSON.parse(manifest)?.omp?.extensions;
    if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string")) {
      throw new Error("a new companion needs a package.json that declares its OMP extension entries");
    }
  }
  const check = prepareExecutableCheck(hookPath === undefined ? "extension" : "hook", files, root, draft.checkToolCallId, evidence, passStart);
  const change: ExecutableEdit = { operation: "harness", stage: "checked", root, rootId: existsSync(root) ? fileId(lstatSync(root)) : null, files: changes, check };
  const blast = target.root === "project-hooks" || target.root === "extension" && target.checkout !== undefined
    ? `Affects sessions loading this code from ${target.root === "project-hooks" ? cwd : target.checkout}.` : `Affects sessions loading this code from the active profile at ${agentDir}.`;
  return { change, preview: [
    ...previews, `Why not a simpler remedy: ${JSON.stringify(draft.lowerRungs)}`,
    `Scratch check in ${check.scratch}: ${check.command}`, "Observed result:", check.output.replace(/\r\n?/g, "\n"),
    `Verify after publishing in ${root}: ${check.command}`, blast,
    "The change takes effect the next time OMP loads this code. Apply does not activate or restart OMP or deploy anything.",
  ].join("\n\n") };
}

export function checkExecutableState(change: ExecutableEdit, pending: readonly string[] = []): void {
  if (canonicalMissingPath(change.root) !== change.root || change.rootId !== null && fileId(lstatSync(change.root)) !== change.rootId) {
    throw new Error("the reviewed executable root changed; prepare and ask again");
  }
  for (const file of change.files) checkScalarFileState(file, pending.includes(file.path));
  checkPublishedExecutableInputs(change.check, change.root, pending);
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
