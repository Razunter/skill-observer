import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { canonicalProjectTarget, type ProjectPublication, type ProjectTarget } from "./ledger.js";
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
  for (const id of publication.checkToolCallIds) {
    const check = successfulCall(evidence, id);
    const checkArgs = check.call.args;
    if (check.call.name !== "bash" || check.call.position <= write.result.position || typeof checkArgs.cwd !== "string" ||
        realpathSync(checkArgs.cwd) !== target.root || typeof checkArgs.command !== "string" || !checkArgs.command.trim() ||
        checkArgs.async === true || checkArgs.name != null) throw new Error("project verification must be a completed foreground check in this project after its write");
    const details = check.result.details;
    if (!details || typeof details !== "object" ||
        !(details.exitCode === 0 || typeof details.wallTimeMs === "number" && Number.isFinite(details.wallTimeMs) && details.wallTimeMs >= 0) ||
        ("exitCode" in details && details.exitCode !== 0) ||
        ("timedOut" in details && details.timedOut) || "async" in details || "service" in details ||
        ("terminalId" in details && !("wallTimeMs" in details))) throw new Error("project check did not complete successfully");
  }
  const file = resolvePath(target.root, target.path);
  if (!statSync(file).isFile() || createHash("sha256").update(readFileSync(file)).digest("hex") !== publication.afterHash) {
    throw new Error("project target no longer matches the observed publication hash");
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
