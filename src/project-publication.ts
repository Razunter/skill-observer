import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { canonicalProjectTarget, type HarnessPublication, type ProjectPublication, type ProjectTarget } from "./ledger.js";
import type { HarnessFile } from "./review.js";
import { type CompletedToolCall, type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";
import type { SessionEntry } from "./omp.js";

export function checkProjectPublication(target: ProjectTarget, publication: ProjectPublication | undefined, branch: SessionEntry[]): void {
  if (!publication || typeof publication.afterHash !== "string" || !/^[a-f0-9]{64}$/.test(publication.afterHash) ||
      typeof publication.writeToolCallId !== "string" || !Array.isArray(publication.checkToolCallIds) ||
      publication.checkToolCallIds.length === 0 || publication.checkToolCallIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("applied project answers need an observed write, checks and current SHA-256 afterHash");
  }
  const evidence = sessionToolEvidence(branch);
  const write = successfulCall(evidence, publication.writeToolCallId);
  const writeArgs = write.call.args;
  if (write.call.name !== "write" && write.call.name !== "edit") throw new Error("project publication must use normal write/edit tools");
  const paths: string[] = [];
  if (write.call.name === "edit" && typeof writeArgs.input === "string") {
    if (/^(?:REM|MV )/m.test(writeArgs.input)) throw new Error("project receipt does not accept delete or rename edits");
    paths.push(...[...writeArgs.input.matchAll(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]$/gm)].map((match) => match[1]!));
  } else if (typeof writeArgs.path === "string") paths.push(write.call.name === "write" ? writeTargetPath(writeArgs.path) : writeArgs.path);
  const targets = paths.map((path) => {
    const absolute = isAbsolute(path) ? path : resolvePath(target.root, path);
    return canonicalProjectTarget(target.root, { ...target, path: relative(target.root, absolute) });
  });
  if (!targets.some((candidate) => candidate.path === target.path)) throw new Error("observed write does not target this project file");
  checkForegroundChecks(evidence, publication.checkToolCallIds, write.result.position, target.root);
  const file = resolvePath(target.root, target.path);
  if (!statSync(file).isFile() || sha256(readFileSync(file)) !== publication.afterHash) {
    throw new Error("project target no longer matches the observed publication hash");
  }
}

/**
 * An applied hook or companion change's receipts: a successful normal write of
 * each approved file, foreground checks in the target root after every write,
 * and each file's stated hash equal to the hash of its approved text and of
 * the file as it is now.
 */
export function checkHarnessPublication(change: { root: string; files: readonly HarnessFile[] }, publication: HarnessPublication | undefined, cwd: string, branch: readonly SessionEntry[]): void {
  if (!publication || !Array.isArray(publication.writeToolCallIds) || !Array.isArray(publication.checkToolCallIds) || !Array.isArray(publication.files) ||
      publication.checkToolCallIds.length === 0 || [...publication.writeToolCallIds, ...publication.checkToolCallIds].some((id) => typeof id !== "string" || !id)) {
    throw new Error("an applied hook or companion change needs `publication`: its observed write calls, foreground check calls and each written file's afterHash");
  }
  const evidence = sessionToolEvidence(branch);
  const writes = publication.writeToolCallIds.map((id) => successfulCall(evidence, id));
  if (writes.some(({ call }) => call.name !== "write")) throw new Error("hook and companion files are published with the normal write tool");
  const written = new Set(writes.map(({ call }) => typeof call.args.path === "string" ? canonical(resolvePath(cwd, writeTargetPath(call.args.path))) : ""));
  for (const { path, text } of change.files) {
    const file = join(change.root, path);
    if (!written.has(canonical(file))) throw new Error(`\`${file}\`: no observed write of it`);
    const approved = sha256(text);
    if (publication.files.find((stated) => stated?.path === path)?.afterHash !== approved) throw new Error(`\`${file}\`: the stated afterHash is not the hash of its approved text`);
    if (!existsSync(file) || sha256(readFileSync(file)) !== approved) throw new Error(`\`${file}\` does not hold its approved text`);
  }
  checkForegroundChecks(evidence, publication.checkToolCallIds, Math.max(...writes.map(({ result }) => result.position)), change.root);
}

/** Each check is a completed, successful foreground bash call with `root` as working directory, made after branch position `after`. */
function checkForegroundChecks(evidence: SessionToolEvidence, ids: readonly string[], after: number, root: string): void {
  for (const id of ids) {
    const check = successfulCall(evidence, id);
    const checkArgs = check.call.args;
    if (check.call.name !== "bash" || check.call.position <= after || typeof checkArgs.cwd !== "string" ||
        canonical(checkArgs.cwd) !== canonical(root) || typeof checkArgs.command !== "string" || !checkArgs.command.trim() ||
        checkArgs.async === true || checkArgs.name != null) throw new Error("verification must be a completed foreground check in the target root after its write");
    const details = check.result.details;
    if (!details || typeof details !== "object" ||
        !(details.exitCode === 0 || typeof details.wallTimeMs === "number" && Number.isFinite(details.wallTimeMs) && details.wallTimeMs >= 0) ||
        ("exitCode" in details && details.exitCode !== 0) ||
        ("timedOut" in details && details.timedOut) || "async" in details || "service" in details ||
        ("terminalId" in details && !("wallTimeMs" in details))) throw new Error("the check did not complete successfully");
  }
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** `path` through its symlinks, or as given when it does not exist. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function successfulCall(evidence: SessionToolEvidence, id: string): CompletedToolCall {
  const completed = evidence.completedCall(id);
  if (completed.result.isError === true) throw new Error(`no successful observed tool call for ${id}`);
  return completed;
}

function writeTargetPath(path: string): string {
  const trimmed = path.trimEnd();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return path;
  const inner = trimmed.slice(1, -1);
  const tag = /#[0-9A-Fa-f]{4}$/.exec(inner);
  const target = tag ? inner.slice(0, tag.index) : inner;
  return target && (tag || !inner.includes("#")) ? target : path;
}
