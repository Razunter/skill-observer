import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { canonicalMissingPath, canonicalPathIn, type HarnessFile, type HarnessPublication, type ProjectPublication, type ProjectTarget } from "./ledger.js";
import { type CompletedToolCall, type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";
import type { SessionEntry, ToolArguments, ToolCallEvent } from "./omp.js";
import { HOOK_CHECK_PATH } from "./payload.js";
import { type HarnessCheck, preparedProjectEntries } from "./review.js";
import { findProjectApproval, type ProposalAnswerRef } from "./proposal-approval.js";

export interface ProjectEdit {
  operation: "project-edit";
  file: string;
  directory: string;
  directoryId: string;
  fileId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  text?: string;
  check: string;
}

const fileId = ({ dev, ino }: { dev: number; ino: number }) => `${dev}:${ino}`;

function maybeStat(file: string) {
  try { return lstatSync(file); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function prepareProjectEdit(target: ProjectTarget, text: string | undefined, check: string): { change: ProjectEdit; preview: string } {
  const words = typeof check === "string" ? plainWords(check) : [];
  if (!words.length || /^(?:true|false|:|echo|printf|pwd|ls|cat|stat|hash|command|which|type|git|sh|bash|env|exit|sleep)$/.test(basename(words[0]!)) ||
      words.some((word) => /^(?:--(?:help|version|dry-run|list-tests|skip-tests)(?:=|$)|-[hV]$)/.test(word))) {
    throw new Error("a project edit needs one meaningful foreground check, not an informational command, a skipped check or a shell sequence");
  }
  const file = join(target.root, target.path);
  if (/[\x00-\x1f\x7f#\]]/.test(file)) throw new Error("the project destination cannot be shown and edited as a plain path");
  const existing = maybeStat(file);
  if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error("the project target must be a regular file without other links");
  let directory = dirname(file);
  while (!existsSync(directory)) directory = dirname(directory);
  const parent = lstatSync(directory);
  if (!parent.isDirectory()) throw new Error("the project target needs a plain destination directory");
  accessSync(directory, constants.W_OK);
  if (existing && text !== undefined) accessSync(file, constants.W_OK);
  const bytes = existing && readFileSync(file);
  const before = bytes?.toString("utf8");
  if (before === text) throw new Error("the project edit does not change the file");
  if ((bytes && !bytes.equals(Buffer.from(before!))) ||
      [before, text].some((body) => body !== undefined && /[\x00-\x08\x0b-\x1f\x7f]/u.test(body))) {
    throw new Error("a project edit must be UTF-8 text with visible content and LF line endings");
  }
  const change: ProjectEdit = {
    operation: "project-edit", file, directory, directoryId: fileId(parent), fileId: existing && fileId(existing),
    beforeHash: bytes && sha256(bytes), afterHash: text === undefined ? null : sha256(text), ...(text !== undefined && { text }), check,
  };
  return { change, preview: [
    `${before === undefined ? "Create" : text === undefined ? "Remove" : "Replace"} ${file}`,
    ...(before === undefined ? [] : ["Before:", JSON.stringify(before)]),
    ...(text === undefined ? [] : ["After:", JSON.stringify(text)]),
    `Verify in ${target.root}: ${check}`,
  ].join("\n") };
}

export function checkProjectState(change: ProjectEdit, before: boolean): void {
  const { file, directory, directoryId } = change;
  if (canonicalMissingPath(file) !== file || fileId(lstatSync(directory)) !== directoryId) {
    throw new Error(`the destination or parent of \`${file}\` changed; review the target again`);
  }
  const current = maybeStat(file);
  if (current && (!current.isFile() || current.nlink !== 1) ||
      before && (current && fileId(current)) !== change.fileId ||
      (current && sha256(readFileSync(file))) !== (before ? change.beforeHash : change.afterHash)) {
    throw new Error(`\`${file}\` does not hold ${before ? "the reviewed before-state; prepare and ask again" : "the approved result"}`);
  }
}

function ownerPaths(name: string, args: ToolArguments, cwd: string): string[] {
  const absolute = (path: string) => resolvePath(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  if (name === "write" && typeof args.path === "string" && !/^\w+:\/\//.test(args.path)) return [absolute(writeTargetPath(args.path))];
  if (name === "edit" && typeof args.input === "string") {
    return [...args.input.matchAll(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]$/gm)].map(([, path]) => absolute(path!));
  }
  return [];
}

function exactOwnerCall(change: ProjectEdit, name: string | undefined, args: ToolArguments): boolean {
  if (change.text !== undefined) return name === "write" && args.path === change.file && args.content === change.text;
  if (name !== "edit" || typeof args.input !== "string") return false;
  const patch = /^\*\*\* Begin Patch\n\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]\nREM\n\*\*\* End Patch\n?$/.exec(args.input);
  return patch?.[1] === change.file;
}

export function projectToolAuthorization(event: ToolCallEvent, cwd: string, branch: readonly SessionEntry[], passStart: number): string | undefined {
  if (!["write", "edit", "bash"].includes(event.toolName)) return;
  const paths = ownerPaths(event.toolName, event.input, cwd);
  if (paths.length === 0 && event.toolName !== "bash") return;
  const evidence = sessionToolEvidence(branch);
  const entries = preparedProjectEntries(evidence, passStart);
  for (const { reference, proposal: { target, change } } of entries) {
    if (change.operation === "direct-edit") {
      if (paths.includes(join(target.root, target.path))) throw new Error("a legacy project preview needs fresh Prepare and Apply");
      continue;
    }
    const write = paths.some((file) => file === change.file);
    const check = event.toolName === "bash" && event.input.command === change.check && event.input.cwd === target.root &&
      event.input.async !== true && event.input.name == null;
    if (!write && !check) continue;
    const approval = findProjectApproval(reference, evidence, branch, passStart);
    if (!approval) {
      if (write) throw new Error("the project destination has no current native Apply");
      continue;
    }
    if (write) {
      if (!exactOwnerCall(change, event.toolName, event.input) || paths.length !== 1) {
        throw new Error("use the ordinary owner tool for the exact reviewed destination and content");
      }
      checkProjectState(change, true);
    } else {
      if (!["write", "edit"].some((name) => evidence.completedCalls(name).some(({ observed }) =>
        observed?.call.authorization === reference.contentHash && observed.call.position > approval.answeredAt && observed.result.isError === false))) continue;
      checkProjectState(change, false);
    }
    return reference.contentHash;
  }
  if (paths.length > 0 && entries.some(({ proposal: { change } }) =>
      change.operation === "project-edit" && change.text !== undefined && event.input.content === change.text)) {
    throw new Error("the proposed project content cannot be published at a substituted destination");
  }
  if (paths.some((file) => entries.some(({ proposal: { target } }) => {
    const rel = relative(target.root, file);
    return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }))) throw new Error("this project destination was not reviewed; keep scratch work outside the destination checkout");
}

function approvedObservedCall(evidence: SessionToolEvidence, id: string, authorization: string, after: number): CompletedToolCall {
  const { observed } = evidence.completedCall(id);
  if (!observed || observed.call.authorization !== authorization || observed.call.position <= after ||
      observed.result.isError !== false || observed.result.supplier?.source !== "builtin") {
    throw new Error(`\`${id}\` is not a successful observed owner call authorized after Apply`);
  }
  return observed;
}

export function checkProjectPublication(target: ProjectTarget, change: ProjectEdit, approval: ProposalAnswerRef, answeredAt: number,
    publication: ProjectPublication | undefined, branch: readonly SessionEntry[]): void {
  if (!publication || publication.afterHash !== change.afterHash || typeof publication.writeToolCallId !== "string" ||
      !Array.isArray(publication.checkToolCallIds) || publication.checkToolCallIds.length !== 1) {
    throw new Error("cite the approved write, its one completed check, and the exact SHA-256 result (null for removal)");
  }
  const evidence = sessionToolEvidence(branch);
  const id = approval.proposal.contentHash;
  const write = approvedObservedCall(evidence, publication.writeToolCallId, id, answeredAt);
  if (!exactOwnerCall(change, write.call.name, write.call.args)) throw new Error("the observed owner call is not the approved change");
  try {
    checkProjectState(change, false);
    const check = approvedObservedCall(evidence, publication.checkToolCallIds[0]!, id, write.result.position);
    checkForegroundCall(check, write.result.position, target.root, change.check);
  } catch (error) {
    throw new Error(`written but unverified: ${(error as Error).message}`);
  }
}

/** What an applied local, managed or new skill direct edit rests on: the owner-tool call that made it. */
export interface SkillEditPublication {
  writeToolCallId: string;
}

/**
 * Throws unless `publication` cites a successful write of `skill` by its
 * owner, made after the user's Apply saved at `approvedAt`: `edit` or `write`
 * of a local skill's `SKILL.md` at `path`, `manage_skill` `update` of a
 * managed skill, or `manage_skill` `create` of a new one.
 */
export function checkSkillEditPublication(skill: { name: string; kind: string; path?: string }, publication: SkillEditPublication | undefined, cwd: string, branch: readonly SessionEntry[], approvedAt: number): void {
  if (typeof publication?.writeToolCallId !== "string" || !publication.writeToolCallId) {
    throw new Error("an applied local, managed or new skill edit needs `publication`: `{ writeToolCallId }`, the observerToolCallId of the edit, write or manage_skill call that made it after the user's Apply");
  }
  const write = successfulCall(sessionToolEvidence(branch), publication.writeToolCallId);
  if (write.call.position <= approvedAt) throw new Error(`\`${publication.writeToolCallId}\` was made before the user's Apply: make the approved edit after it and cite that call`);
  if (skill.kind === "local") {
    if (write.call.name !== "write" && write.call.name !== "edit") throw new Error(`the local skill \`${skill.name}\` is published with the normal edit or write tool`);
    const target = skill.path === undefined ? undefined : canonical(skill.path);
    // The native edit and write tools expand a leading `~/` before resolving against the working directory.
    const written = writtenPaths(write).map((path) => canonical(resolvePath(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path)));
    if (target === undefined || !written.includes(target)) {
      throw new Error(`\`${publication.writeToolCallId}\` does not write \`${skill.name}\`'s SKILL.md${skill.path === undefined ? "" : ` at \`${skill.path}\``}`);
    }
    return;
  }
  const action = skill.kind === "new" ? "create" : "update";
  const details = write.result.details;
  if (write.call.name !== "manage_skill" || details?.action !== action || details.name !== skill.name) {
    throw new Error(`\`${publication.writeToolCallId}\` is not the manage_skill \`${action}\` of \`${skill.name}\` that publishes this ${skill.kind} skill`);
  }
}

/** The paths a successful `edit` or `write` call names, as given: an edit's file headers, or a write's path. */
function writtenPaths({ call }: CompletedToolCall): string[] {
  const args = call.args;
  if (call.name === "edit" && typeof args.input === "string") {
    if (/^(?:REM|MV )/m.test(args.input)) throw new Error("a publication receipt does not accept delete or rename edits");
    return [...args.input.matchAll(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]$/gm)].map((match) => match[1]!);
  }
  return typeof args.path === "string" ? [call.name === "write" ? writeTargetPath(args.path) : args.path] : [];
}

/** Throws unless `command` is the companion's check, its own tests: exactly `bun test` in the companion directory, since an argument could skip them (`--help`) or run code outside the approved files (`--preload`). */
export function checkCompanionCommand(command: string): void {
  const words = plainWords(command);
  if (words.length !== 2 || words[0] !== "bun" || words[1] !== "test") throw new Error(`\`${command}\` is not the companion's check: run \`bun test\` in the companion directory`);
}

/** `command`'s words when each is plain or single-quoted and split by spaces or tabs, so the shell passes them on as they read: no expansion, redirection, line break or second command. */
function plainWords(command: string): string[] {
  if (!/^[ \t]*(?:(?:'[^'\r\n]*'|[\w@%+=:,./-]+)(?:[ \t]+|$))+$/.test(command)) return [];
  return [...command.matchAll(/'([^']*)'|(\S+)/g)].map(([, quoted, plain]) => quoted ?? plain!);
}

/**
 * Throws unless `command` is the hook check on the hook at `file` in `root`:
 * `bun --no-env-file <hook check script> <hook> <samples file>`, with the
 * hook named so that the command, rerun in `root` after the write, checks the written hook.
 */
export function checkHookCommand(command: string, root: string, file: string): void {
  const [bun, flag, script, hook, samples, ...rest] = plainWords(command);
  const isHookCheck = bun === "bun" && flag === "--no-env-file" && script !== undefined && resolvePath(root, script) === HOOK_CHECK_PATH &&
    hook !== undefined && resolvePath(root, hook) === join(root, file) && samples !== undefined && rest.length === 0;
  if (!isHookCheck) {
    throw new Error(`\`${command}\` is not the hook check on the hook it publishes: run \`bun --no-env-file ${HOOK_CHECK_PATH} ${file} <samples file>\` on the draft at that path in its temporary directory, so the same command reruns in \`${root}\` on the written hook`);
  }
}

/**
 * An applied hook or companion change's receipts: a successful normal write of
 * each approved file after the user's Apply saved at `approvedAt`, still
 * inside the target root, foreground runs of the approved check in the target
 * root after every write, and each file's stated hash equal to the hash of
 * its approved text and of the file as it is now.
 */
export function checkHarnessPublication(change: { root: string; files: readonly HarnessFile[]; check: HarnessCheck }, publication: HarnessPublication | undefined, cwd: string, branch: readonly SessionEntry[], approvedAt: number): void {
  if (!publication || !Array.isArray(publication.writeToolCallIds) || !Array.isArray(publication.checkToolCallIds) || !Array.isArray(publication.files) ||
      publication.checkToolCallIds.length === 0 || [...publication.writeToolCallIds, ...publication.checkToolCallIds].some((id) => typeof id !== "string" || !id)) {
    throw new Error("an applied hook or companion change needs `publication`: its observed write calls, foreground check calls and each written file's afterHash");
  }
  const evidence = sessionToolEvidence(branch);
  const writes = publication.writeToolCallIds.map((id) => successfulCall(evidence, id));
  if (writes.some(({ call }) => call.name !== "write")) throw new Error("hook and companion files are published with the normal write tool");
  if (writes.some(({ call }) => call.position <= approvedAt)) throw new Error("a cited write was made before the user's Apply of the code: write each file again after it, then rerun the check");
  const written = new Set(writes.map(({ call }) => typeof call.args.path === "string" ? canonical(resolvePath(cwd, writeTargetPath(call.args.path))) : ""));
  for (const { path, text } of change.files) {
    // A directory replaced by a symlink since Prepare would carry the write out of the root.
    canonicalPathIn(change.root, path, `\`${path}\``);
    const file = join(change.root, path);
    if (!written.has(canonical(file))) throw new Error(`\`${file}\`: no observed write of it`);
    const approved = sha256(text);
    if (publication.files.find((stated) => stated?.path === path)?.afterHash !== approved) throw new Error(`\`${file}\`: the stated afterHash is not the hash of its approved text`);
    if (!existsSync(file) || sha256(readFileSync(file)) !== approved) throw new Error(`\`${file}\` does not hold its approved text`);
  }
  checkForegroundChecks(evidence, publication.checkToolCallIds, Math.max(...writes.map(({ result }) => result.position)), change.root, change.check.command);
}

/** Each check is a completed, successful foreground bash call with `root` as working directory, made after branch position `after`, running the `approved` command when one is given. */
function checkForegroundChecks(evidence: SessionToolEvidence, ids: readonly string[], after: number, root: string, approved?: string): void {
  for (const id of ids) checkForegroundCall(successfulCall(evidence, id), after, root, approved);
}

function checkForegroundCall(check: CompletedToolCall, after: number, root: string, approved?: string): void {
  const checkArgs = check.call.args;
  if (check.call.name !== "bash" || check.call.position <= after || typeof checkArgs.cwd !== "string" ||
      canonical(checkArgs.cwd) !== canonical(root) || typeof checkArgs.command !== "string" || !checkArgs.command.trim() ||
      checkArgs.async === true || checkArgs.name != null) throw new Error("verification must be a completed foreground check in the target root after its write");
  if (approved !== undefined && checkArgs.command !== approved) throw new Error(`\`${checkArgs.command}\` is not the approved check \`${approved}\`: rerun it exactly`);
  const details = check.result.details;
  if (!details || typeof details !== "object" ||
      !(details.exitCode === 0 || typeof details.wallTimeMs === "number" && Number.isFinite(details.wallTimeMs) && details.wallTimeMs >= 0) ||
      ("exitCode" in details && details.exitCode !== 0) ||
      ("timedOut" in details && details.timedOut) || "async" in details || "service" in details ||
      ("terminalId" in details && !("wallTimeMs" in details))) throw new Error("the check did not complete successfully");
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
