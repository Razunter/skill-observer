import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { textOf } from "./digest.js";
import type { ToolArguments, ToolCallEvent } from "./omp.js";
import { HOOK_CHECK_PATH } from "./payload.js";
import type { SessionToolEvidence, ToolResultEvidence } from "./session-tool-evidence.js";

export interface ExecutableCheck {
  readonly command: string;
  readonly output: string;
  readonly scratch: string;
  readonly proof: string;
}

type CheckPlan = { kind: "extension" } | { kind: "hook"; hook: string; samples: string; absent: boolean };
type Snapshot = Map<string, string>;
const DIRECTORY = "directory";
const EXTENSION_COMMAND = "bun --no-env-file test";
const AUTHORIZATION = "scratch-check-v1:";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const EXCLUDED = [".git", "node_modules", ".DS_Store", "Thumbs.db"];
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const isWithin = (root: string, file: string): boolean => file.startsWith(root.endsWith("/") ? root : `${root}/`) && file !== root;

/** Capture what exists before the tool runs; an uncapturable input cannot authorize a receipt. */
export function scratchCheckAuthorization(event: ToolCallEvent): string | undefined {
  if (event.toolName !== "bash" || event.parentToolCallId !== undefined || !foregroundArgs(event.input)) return undefined;
  try {
    const { proof } = scratchInputs(event.input.command, event.input.cwd);
    return authorization(event.input, proof);
  } catch {
    return undefined;
  }
}

export function prepareExecutableCheck(kind: "hook" | "extension", files: readonly { path: string; text?: string }[],
    targetRoot: string, toolCallId: string, evidence: SessionToolEvidence, passStart: number | undefined): ExecutableCheck {
  const { call, result, observed } = evidence.completedCall(toolCallId);
  if (passStart === undefined || call.origin !== "native" || result.origin !== "native" || call.name !== "bash" ||
      call.position <= passStart || !observed || observed.call.position <= passStart || observed.result.position <= call.position ||
      observed.result.supplier?.source !== "builtin" || !foregroundArgs(call.args) || !isDeepStrictEqual(call.args, observed.call.args) ||
      !isDeepStrictEqual(observed.result.input, observed.call.args) || !successful(result) || !successful(observed.result)) {
    throw new Error("cite a successful native foreground Bash check observed after this pass began");
  }
  const { plan, proof, snapshot, command, scratch } = scratchInputs(call.args.command, call.args.cwd);
  if (!observed.call.authorization || observed.call.authorization !== authorization(call.args, proof)) {
    throw new Error("the scratch check inputs changed, or the check did not have a valid starting snapshot; run it again");
  }
  if (plan.kind !== kind || !isAbsolute(targetRoot) || resolve(targetRoot) !== targetRoot ||
      targetRoot === scratch || isWithin(targetRoot, scratch) || isWithin(scratch, targetRoot)) {
    throw new Error("run the supported check in independent scratch for the reviewed executable owner");
  }
  const pending = new Set<string>();
  for (const { path, text } of files) {
    if (!plainRelative(path) || pending.has(path) || (plan.kind === "extension" && path.split("/").some(part => EXCLUDED.includes(part)))) {
      throw new Error(`unsupported or duplicate checked executable path: ${path}`);
    }
    const entry = snapshot.get(path);
    if (text === undefined ? entry !== undefined : entry?.slice(2) !== digest(text)) {
      throw new Error(`scratch does not contain the exact proposed after-state of ${path}`);
    }
    pending.add(path);
  }
  if (pending.size === 0 || (plan.kind === "hook" && (pending.size !== 1 || !pending.has(plan.hook)))) {
    throw new Error("the scratch check must cover the exact proposed executable files");
  }
  if (plan.kind === "extension") compareExtension(snapshot, targetRoot, pending);
  const output = textOf(observed.result.content);
  const plain = stripVTControlCharacters(output);
  const passed = plan.kind === "hook"
    ? /^OK: ([1-9]\d*) of \1 samples as expected$/m.test(plain)
    : Number([...plain.matchAll(/^[ \t]*(\d+) pass[ \t]*$/gm)].at(-1)?.[1]) > 0;
  if (!passed || /[\r\0]/u.test(output)) {
    throw new Error("the observed result does not show a meaningful successful check");
  }
  return { command, output, scratch, proof };
}

export function checkExecutableInputs(check: ExecutableCheck): void {
  reviewedScratch(check);
}

/** Pending paths are the approved writes still to be made. With none, require the actual complete postimage. */
export function checkPublishedExecutableInputs(check: ExecutableCheck, root: string, pendingPaths: readonly string[] = []): void {
  const { plan, snapshot } = reviewedScratch(check);
  if (plan.kind === "extension") compareExtension(snapshot, root, new Set(pendingPaths));
}

function reviewedScratch(check: ExecutableCheck) {
  const inputs = scratchInputs(check.command, check.scratch);
  if (inputs.proof !== check.proof) throw new Error("scratch check inputs changed since the reviewed run");
  return inputs;
}

function successful(result: ToolResultEvidence): boolean {
  const details = result.details;
  return result.isError === false && !!details &&
    (details.exitCode === 0 || (details.exitCode === undefined && typeof details.wallTimeMs === "number" &&
      Number.isFinite(details.wallTimeMs) && details.wallTimeMs >= 0)) &&
    !details.timedOut && !("async" in details) && !("service" in details) &&
    (details.toolCommands === undefined || (Array.isArray(details.toolCommands) && details.toolCommands.length === 0)) &&
    (details.trace?.status === undefined || details.trace.status === 0);
}

function foregroundArgs(args: ToolArguments): boolean {
  return Object.keys(args).every(key => ["command", "cwd", "timeout", "async", "pty"].includes(key)) &&
    (!("async" in args) || args.async === false) && (!("pty" in args) || args.pty === false) &&
    (!("timeout" in args) || (typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0));
}

function authorization(args: ToolArguments, proof: string): string {
  return AUTHORIZATION + digest(JSON.stringify([Object.entries(args).sort(([a], [b]) => a.localeCompare(b)), proof]));
}

function scratchInputs(command: unknown, scratch: unknown) {
  if (typeof command !== "string" || typeof scratch !== "string" ||
      !/^omp-observe-check\.[A-Za-z0-9_-]+$/.test(basename(scratch)) || dirname(scratch) !== realpathSync(tmpdir())) {
    throw new Error("run the check in a fresh private omp-observe-check.* child of the system temporary directory");
  }
  const plan = checkPlan(command, scratch);
  const root = canonicalDirectory(scratch);
  if (root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) throw new Error("the scratch directory must be private and owned by this user");
  const snapshot = snapshotTree(scratch, plan.kind === "extension");
  let checker: string | undefined;
  if (plan.kind === "hook") {
    const files = [plan.samples, ...(plan.absent ? [] : [plan.hook])];
    if (plan.samples === plan.hook || files.some(path => !snapshot.has(path) || snapshot.get(path) === DIRECTORY) ||
        (plan.absent && snapshot.has(plan.hook))) {
      throw new Error("the scratch hook check needs its own samples file and the exact hook presence or absence");
    }
    // A hook is a single file. Additional scratch source must not influence the replay.
    for (const [path, entry] of snapshot) {
      if (!files.includes(path) && !(entry === DIRECTORY && (isWithin(path, plan.hook) || isWithin(path, plan.samples)))) {
        throw new Error(`unexpected input in the scratch hook check: ${path}`);
      }
    }
    checker = fileDigest(HOOK_CHECK_PATH, { left: MAX_BYTES });
  }
  const proof = digest(JSON.stringify([command, scratch, root.dev, root.ino, root.birthtimeMs, [...snapshot].sort(), checker]));
  return { plan, proof, snapshot, command, scratch };
}

function checkPlan(command: string, scratch: string): CheckPlan {
  if (command === EXTENSION_COMMAND) return { kind: "extension" };
  // Reconstruct the full command from literal shell words so unrecognized syntax never disappears during tokenization.
  const words = command.length <= 16_384 && command.startsWith("bun --no-env-file ")
    ? command.match(/[A-Za-z0-9_./-]+|'[^'\x00-\x1f\x7f]+'/g) ?? []
    : [];
  const [bun, flag, checkerArg, ...tail] = words;
  const absent = tail[0] === "--absent";
  const [hookArg, samplesArg] = absent ? tail.slice(1) : tail;
  const unquote = (word: string | undefined) => word?.startsWith("'") ? word.slice(1, -1) : word;
  const hook = unquote(hookArg);
  const samples = unquote(samplesArg);
  if (bun !== "bun" || flag !== "--no-env-file" || unquote(checkerArg) !== HOOK_CHECK_PATH ||
      words.join(" ") !== command || tail.length !== (absent ? 3 : 2) ||
      !hook || hook.startsWith("-") || !plainRelative(hook) || !samples || !isWithin(scratch, samples)) {
    throw new Error(`unsupported executable check; use ${EXTENSION_COMMAND} or the bundled check-hook.ts with literal paths`);
  }
  const samplePath = relative(scratch, samples);
  if (!plainRelative(samplePath) || join(scratch, samplePath) !== samples) throw new Error("the samples path must be canonical and under scratch");
  return { kind: "hook", hook, samples: samplePath, absent };
}

function plainRelative(path: string): boolean {
  return !path.includes("\0") && !path.includes("\\") && !isAbsolute(path) &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function canonicalDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path) throw new Error("the executable check root must be a canonical directory without symlinks");
  return stat;
}

function compareExtension(scratch: Snapshot, root: string, pending: ReadonlySet<string>): void {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (stat || pending.size === 0) canonicalDirectory(root);
  const target = stat ? snapshotTree(root, true) : new Map<string, string>();
  for (const path of pending) {
    const next = scratch.get(path);
    const current = target.get(path);
    if (!plainRelative(path) || path.split("/").some(part => EXCLUDED.includes(part)) || next === DIRECTORY || current === DIRECTORY) {
      throw new Error(`unsupported executable file change: ${path}`);
    }
    if (next === undefined) {
      target.delete(path);
      continue;
    }
    if (next[0] !== (current?.[0] ?? "-")) throw new Error(`the executable mode will differ in the published tree: ${path}`);
    target.set(path, next);
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
      const prior = target.get(dir);
      if (prior && prior !== DIRECTORY) throw new Error(`a published parent path is not a directory: ${dir}`);
      target.set(dir, DIRECTORY);
    }
  }
  for (const [path, entry] of scratch) {
    if (target.get(path) !== entry) throw new Error(`the extension check did not run against the reviewed postimage: ${path}`);
  }
  for (const path of target.keys()) {
    if (!scratch.has(path)) throw new Error(`the scratch check omitted an extension input: ${path}`);
  }
}

function snapshotTree(root: string, extension: boolean): Snapshot {
  const entries: Snapshot = new Map();
  const budget = { left: MAX_BYTES };
  let count = 0;
  function walk(parent: string, depth: number): void {
    if (depth > 32) throw new Error("the executable check tree is too deep to inspect safely");
    const dir = opendirSync(join(root, parent));
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > MAX_ENTRIES) throw new Error("the executable check tree has too many entries");
        const path = join(parent, entry.name);
        const absolute = join(root, path);
        const stat = lstatSync(absolute);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`unsupported executable check input (symlink or special file): ${path}`);
        if (extension && EXCLUDED.includes(entry.name)) continue;
        if (stat.isDirectory()) {
          entries.set(path, DIRECTORY);
          walk(path, depth + 1);
        } else {
          entries.set(path, fileDigest(absolute, budget));
        }
      }
    } finally {
      dir.closeSync();
    }
  }
  walk("", 0);
  return entries;
}

function fileDigest(path: string, budget: { left: number }): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > budget.left) throw new Error(`cannot inspect executable check input within the file budget: ${path}`);
    budget.left -= before.size;
    const bytes = Buffer.allocUnsafe(before.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) throw new Error(`executable check input changed during inspection: ${path}`);
      read += n;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`executable check input changed during inspection: ${path}`);
    }
    return `${before.mode & 0o111 ? "x" : "-"}:${digest(bytes)}`;
  } finally {
    closeSync(fd);
  }
}
