import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalMissingPath, type HarnessPublication, harnessRootDirs, type ProfileLedgerRecord, type ProfileTarget, type ProjectPublication, type ProjectTarget, requireCheckedExecutableTarget } from "./ledger.js";
import { type CompletedToolCall, type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";
import type { SessionEntry, ToolArguments, ToolCallEvent } from "./omp.js";
import { scratchCheckAuthorization } from "./executable-check.js";
import { checkExecutableState, type ExecutableEdit } from "./executable-publication.js";
import { ompAgentDir } from "./provenance.js";
import { preparedProjectEntries } from "./review.js";
import { findOwnerApproval, type ProposalAnswerRef } from "./proposal-approval.js";
import { checkProfileState, type ProfileEdit } from "./profile-publication.js";

export interface ScalarFileEdit {
  file: string;
  directory: string;
  directoryId: string;
  rootIdentity?: { path: string; id: string };
  fileId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  text?: string;
}

export interface ProjectEdit extends ScalarFileEdit {
  operation: "project-edit";
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
  const { edit, preview } = prepareScalarFile(target, text);
  return { change: { ...edit, operation: "project-edit", rootIdentity: { path: target.root, id: fileId(lstatSync(target.root)) }, check }, preview: `${preview}\nVerify in ${target.root}: ${check}` };
}

export function prepareScalarFile(target: Pick<ProjectTarget, "root" | "path">, text: string | undefined) {
  const file = join(target.root, target.path);
  if (/[\x00-\x1f\x7f#\]]/.test(file)) throw new Error("the destination cannot be shown and edited as a plain path");
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
  const edit: ScalarFileEdit = {
    file, directory, directoryId: fileId(parent), fileId: existing && fileId(existing),
    beforeHash: bytes && sha256(bytes), afterHash: text === undefined ? null : sha256(text), ...(text !== undefined && { text }),
  };
  const preview = [
    `${before === undefined ? "Create" : text === undefined ? "Remove" : "Replace"} ${file}`,
    ...(before === undefined ? [] : ["Before:", JSON.stringify(before)]),
    ...(text === undefined ? [] : ["After:", JSON.stringify(text)]),
  ].join("\n");
  return { edit, before, preview };
}

export function checkProjectState(change: ProjectEdit, before: boolean): void {
  const { rootIdentity } = change;
  if (rootIdentity && fileId(lstatSync(rootIdentity.path)) !== rootIdentity.id) {
    throw new Error(`the project root of ${change.file} changed; review the target again`);
  }
  checkScalarFileState(change, before);
}

export function checkScalarFileState(change: ScalarFileEdit, before: boolean): void {
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
  const absolute = (path: string) => /^file:\/\//i.test(path) ? fileURLToPath(path)
    : resolvePath(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  if (name === "write" && typeof args.path === "string") {
    const target = writeTargetPath(args.path);
    return !/^\w+:\/\//.test(target) || /^file:\/\//i.test(target) ? [absolute(target)] : [];
  }
  if (name === "edit") {
    const raw = typeof args.input === "string" ? args.input : typeof args._input === "string" ? args._input : "";
    const declared = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === "string") : [];
    const direct = typeof args.path === "string" ? args.path : typeof args._path === "string" ? args._path : undefined;
    return [...new Set([
      ...(direct ? [direct] : []), ...declared,
      ...[...raw.matchAll(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]$/gm)].map(([, path]) => path!),
      ...[...raw.matchAll(/^MV (?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\r\n]+))$/gm)].map(([, double, single, plain]) => (double ?? single ?? plain)!.trim()),
    ].map((path) => absolute(path.replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2"))))];
  }
  return [];
}

function exactOwnerCall(change: ScalarFileEdit, name: string | undefined, args: ToolArguments): boolean {
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
  for (const { reference, proposal } of entries) {
    const { change } = proposal;
    if (change.operation === "harness") {
      const file = change.files.find(({ file }) => paths.includes(file));
      const check = event.toolName === "bash" && exactCheck({ root: change.root }, change.check.command, event.input);
      if (!file && !check) continue;
      const approval = findOwnerApproval(reference, evidence, branch, passStart);
      if (!approval) {
        if (file) throw new Error("the executable destination has no current native Apply");
        continue;
      }
      const pending = change.files.filter((edit) => !successfulOwnerWrite(evidence, edit, reference.contentHash, approval.answeredAt))
        .map(({ path }) => path);
      if (file) {
        if (!pending.includes(file.path)) throw new Error("this executable file already has its approved owner write");
        if (paths.length !== 1 || !exactOwnerCall(file, event.toolName, event.input)) {
          throw new Error("use the ordinary owner tool for the exact executable path and approved bytes or removal");
        }
      } else if (pending.length > 0) {
        throw new Error("finish the approved executable writes before the exact verification check");
      }
      checkExecutableState(change, pending);
      return reference.contentHash;
    }
    if (change.operation === "profile-edit") {
      const { target } = proposal;
      if (target.scope !== "profile") throw new Error("invalid profile publication target");
      if (!paths.includes(change.file)) continue;
      if (!findOwnerApproval(reference, evidence, branch, passStart)) throw new Error("the profile destination has no current native Apply");
      if (!exactOwnerCall(change, event.toolName, event.input) || paths.length !== 1) {
        throw new Error("use the normal write tool for the exact reviewed profile destination and content");
      }
      checkProfileState(target, change, true);
      return reference.contentHash;
    }
    if (change.operation === "direct-edit") {
      if (proposal.target.scope === "project" && paths.includes(join(proposal.target.root, proposal.target.path))) {
        throw new Error("a legacy project preview needs fresh Prepare and Apply");
      }
      continue;
    }
    const edits = change.operation === "project-edits" ? change.edits : [{ target: proposal.target, change }];
    const write = event.toolName !== "bash";
    const matches = edits.filter(({ target, change }) => write ? paths.includes(change.file) : exactCheck(target, change.check, event.input));
    if (!matches.length) continue;
    const approval = findOwnerApproval(reference, evidence, branch, passStart);
    if (!approval) {
      if (write) throw new Error("the project destination has no current native Apply");
      continue;
    }
    if (write) {
      const { change: edit } = matches[0]!;
      if (!exactOwnerCall(edit, event.toolName, event.input) || paths.length !== 1) {
        throw new Error("use the ordinary owner tool for the exact reviewed destination and content");
      }
      if (change.operation === "project-edits") {
        for (const { change: member } of edits) {
          const done = successfulOwnerWrite(evidence, member, reference.contentHash, approval.answeredAt);
          if (done && member === edit) throw new Error(`\`${edit.file}\` already has a successful owner write; do not repeat it`);
          if (done) continue;
          try {
            checkProjectState(member, true);
          } catch (error) {
            throw new Error(`group scope changed at \`${member.file}\`: ${(error as Error).message}; resolve completed writes before preparing and asking about the revised scope`);
          }
        }
      } else {
        checkProjectState(edit, true);
      }
    } else {
      const checked = matches.filter(({ change }) => successfulOwnerWrite(evidence, change, reference.contentHash, approval.answeredAt));
      if (!checked.length) continue;
      if (checked.length === 1) checkProjectState(checked[0]!.change, false);
    }
    return reference.contentHash;
  }
  for (const { proposal: { change, target } } of entries) {
    if (change.operation === "harness") {
      for (const file of paths) {
        const rel = relative(change.root, canonicalMissingPath(file));
        if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ||
            change.files.some((edit) => edit.text !== undefined && edit.text === event.input.content)) {
          throw new Error("this executable destination was not reviewed; use the exact approved target");
        }
      }
      continue;
    }
    const edits = change.operation === "project-edits" ? change.edits : (change.operation === "project-edit" || change.operation === "profile-edit") ? [{ target, change }] : [];
    if (paths.length > 0 && edits.some(({ change }) => change.text !== undefined && event.input.content === change.text)) {
      throw new Error("the proposed project content cannot be published at a substituted destination");
    }
    const roots = change.operation === "project-edits" ? edits.map(edit => edit.target.root) : [target.root];
    if (paths.some(file => roots.some(root => {
      const rel = relative(root, file);
      if (target.scope === "profile") {
        const canonicalRel = relative(root, canonicalMissingPath(file));
        if (canonicalRel && canonicalRel !== ".." && !canonicalRel.startsWith(`..${sep}`) && !isAbsolute(canonicalRel)) return true;
      }
      return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    }))) throw new Error(`this ${target.scope} destination was not reviewed; keep scratch work outside the destination root`);
  }
  if (paths.length && unapprovedGroupDestination(evidence, passStart, paths)) {
    throw new Error("that project destination has no exact scope review and native Apply");
  }
  if (paths.length > 0) {
    const agentDir = ompAgentDir();
    const hooks = harnessRootDirs(cwd, agentDir);
    const reserved = [dirname(hooks["project-hooks"]), dirname(hooks["global-hooks"]), join(agentDir, "extensions")].map(canonicalMissingPath);
    const root = realpathSync(cwd);
    for (const destination of paths) {
      const file = canonicalMissingPath(destination);
      if (reserved.some((scope) => inRoot(scope, file))) throw new Error("this executable destination needs exact checked review and native Apply");
      if (inRoot(root, file)) requireCheckedExecutableTarget({ scope: "project", root, path: relative(root, file), mechanism: "publication" });
    }
  }
  return scratchCheckAuthorization(event);
}

function inRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function unapprovedGroupDestination(evidence: SessionToolEvidence, passStart: number, paths: readonly string[]): boolean {
  return evidence.completedCalls("observer_review").some(({ call }) => {
    if (call.position <= passStart || call.args.action !== "prepare" || !Array.isArray(call.args.candidates)) return false;
    return call.args.candidates.some(candidate => candidate?.kind === "project" && candidate.change?.operation === "project-edits" &&
      Array.isArray(candidate.change.edits) && candidate.change.edits.some((edit: { target?: ProjectTarget } | null) => {
        const { root, path } = edit?.target ?? {};
        return typeof root === "string" && isAbsolute(root) && typeof path === "string" && !isAbsolute(path) &&
          !path.split("/").some(part => !part || part === "." || part === "..") && paths.includes(join(root, path));
      }));
  });
}

function exactCheck(target: { root: string }, command: string, args: ToolArguments): boolean {
  return args.command === command && args.cwd === target.root && args.async !== true && args.name == null;
}

function successfulOwnerWrite(evidence: SessionToolEvidence, change: ScalarFileEdit, authorization: string, after: number): CompletedToolCall | undefined {
  const name = change.text === undefined ? "edit" : "write";
  return evidence.completedCalls(name).find(({ observed }) =>
    observed?.call.authorization === authorization && observed.call.position > after && observed.result.isError === false &&
    observed.result.supplier?.source === "builtin" && exactOwnerCall(change, observed.call.name, observed.call.args))?.observed;
}

/** Resolve all reviewed destinations, not a caller-selected subset. Each leaf still uses the scalar receipt check. */
export function observedProjectPublication(target: ProjectTarget, change: ProjectEdit, approval: ProposalAnswerRef,
    answeredAt: number, evidence: SessionToolEvidence): ProjectPublication {
  const authorization = approval.proposal.contentHash;
  const write = successfulOwnerWrite(evidence, change, authorization, answeredAt);
  if (!write) {
    const tool = change.text === undefined ? "edit" : "write";
    const failed = evidence.completedCalls(tool).some(({ observed }) => observed?.call.authorization === authorization &&
      observed.call.position > answeredAt && exactOwnerCall(change, observed.call.name, observed.call.args));
    if (failed) {
      try {
        checkProjectState(change, true);
      } catch {
        throw new Error("written but unverified: the owner tool reported failure and the before-state no longer holds");
      }
    }
    throw new Error("untouched by this pass: no successful authorized owner write");
  }
  const check = evidence.completedCalls("bash").findLast(({ observed }) => observed?.call.authorization === authorization &&
    observed.call.position > write.result.position && exactCheck(target, change.check, observed.call.args))?.observed;
  if (!check) throw new Error("written but unverified: the exact completed foreground check in this checkout is missing");
  const publication = { writeToolCallId: write.call.id, checkToolCallIds: [check.call.id], afterHash: change.afterHash };
  checkProjectPublication(target, change, approval, answeredAt, publication, evidence);
  return publication;
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
    publication: ProjectPublication | undefined, branch: readonly SessionEntry[] | SessionToolEvidence): void {
  if (!publication || publication.afterHash !== change.afterHash || typeof publication.writeToolCallId !== "string" ||
      !Array.isArray(publication.checkToolCallIds) || publication.checkToolCallIds.length !== 1) {
    throw new Error("cite the approved write, its one completed check, and the exact SHA-256 result (null for removal)");
  }
  const evidence = "completedCall" in branch ? branch : sessionToolEvidence(branch);
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

export function checkProfilePublication(target: ProfileTarget, change: ProfileEdit, approval: ProposalAnswerRef, answeredAt: number,
    publication: { writeToolCallId: string; afterHash: string } | undefined, branch: readonly SessionEntry[]): NonNullable<ProfileLedgerRecord["publication"]> {
  if (!publication || publication.afterHash !== change.afterHash || typeof publication.writeToolCallId !== "string") {
    throw new Error("cite the approved owner write and the exact SHA-256 result");
  }
  const write = approvedObservedCall(sessionToolEvidence(branch), publication.writeToolCallId, approval.proposal.contentHash, answeredAt);
  if (!exactOwnerCall(change, write.call.name, write.call.args)) throw new Error("the observed owner call is not the approved profile edit");
  const executed = write.result.input;
  if (!executed || typeof executed !== "object" || !("path" in executed) || !("content" in executed) ||
      executed.path !== change.file || executed.content !== change.text) throw new Error("the owner result did not execute the reviewed profile destination and content");
  try {
    // Matching the exact bytes is a check on the published file, not a replay claim about a different draft.
    checkProfileState(target, change, false);
  } catch (error) {
    throw new Error(`written but unverified: ${(error as Error).message}`);
  }
  return { writeToolCallId: publication.writeToolCallId, afterHash: publication.afterHash, verification: change.verification };
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

/** `command`'s words when each is plain or single-quoted and split by spaces or tabs, so the shell passes them on as they read: no expansion, redirection, line break or second command. */
function plainWords(command: string): string[] {
  if (!/^[ \t]*(?:(?:'[^'\r\n]*'|[\w@%+=:,./-]+)(?:[ \t]+|$))+$/.test(command)) return [];
  return [...command.matchAll(/'([^']*)'|(\S+)/g)].map(([, quoted, plain]) => quoted ?? plain!);
}

export interface HarnessFileFailure {
  file: string;
  status: "written but unverified" | "untouched by this pass" | "write not confirmed";
  reason: string;
}

type HarnessPublicationResult = { publication: HarnessPublication } | { files: HarnessFileFailure[] };

export function checkHarnessPublication(change: ExecutableEdit, publication: HarnessPublication | undefined, approval: ProposalAnswerRef,
    branch: readonly SessionEntry[], approvedAt: number): HarnessPublicationResult {
  const evidence = sessionToolEvidence(branch);
  const id = approval.proposal.contentHash;
  const writes = change.files.map((file) => successfulOwnerWrite(evidence, file, id, approvedAt));
  const failures = (reason: string): HarnessPublicationResult => ({
    files: change.files.map((edit, i) => {
      const { file } = edit;
      const written = writes[i] !== undefined;
      try {
        checkScalarFileState(edit, !written);
      } catch (error) {
        const state = (error as Error).message;
        return written ? { file, status: "written but unverified", reason: `${reason}; ${state}` }
          : { file, status: "write not confirmed", reason: `no successful authorized owner write was observed and ${state}` };
      }
      return written ? { file, status: "written but unverified", reason }
        : { file, status: "untouched by this pass", reason: "no successful authorized owner write was observed" };
    }),
  });
  const written = writes.filter((write) => write !== undefined);
  if (written.length !== change.files.length) return failures("the other reviewed writes are missing; the complete change was not verified");

  try {
    if (!publication) throw new Error("no exact completed foreground verification was cited");
    const writeToolCallIds = written.map(({ call }) => call.id);
    const files = change.files.map(({ path, afterHash }) => ({ path, afterHash }));
    if (!Array.isArray(publication.writeToolCallIds) || publication.writeToolCallIds.length !== files.length ||
        writeToolCallIds.some((callId) => !publication.writeToolCallIds.includes(callId)) ||
        !Array.isArray(publication.files) || publication.files.length !== files.length ||
        files.some(({ path, afterHash }) => !publication.files.some((result) => result?.path === path && result.afterHash === afterHash))) {
      throw new Error("the cited publication does not match the observed writes and reviewed result hashes");
    }
    const checkToolCallId = publication.checkToolCallIds?.[0];
    if (!Array.isArray(publication.checkToolCallIds) || publication.checkToolCallIds.length !== 1 || typeof checkToolCallId !== "string") {
      throw new Error("no exact completed foreground verification was cited");
    }
    checkExecutableState(change);
    const after = Math.max(...written.map(({ result }) => result.position));
    const { observed: check } = evidence.completedCall(checkToolCallId);
    if (!check || check.call.authorization !== id || check.call.position <= after ||
        check.call.name !== "bash" || !exactCheck(change, change.check.command, check.call.args) ||
        check.result.supplier?.source !== "builtin") {
      throw new Error("the cited verification is not an exact observed foreground check authorized after the approved writes");
    }
    if (check.result.isError !== false) throw new Error("the exact foreground verification failed");
    checkForegroundCall(check, after, change.root, change.check.command);
    return { publication: { writeToolCallIds, checkToolCallIds: [checkToolCallId], files } };
  } catch (error) {
    return failures((error as Error).message);
  }
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
