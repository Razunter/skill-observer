/** Checks an observer hook against sample events before it is published. */
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTATIONS = ["blocked", "context", "untouched"] as const;
type Expectation = (typeof EXPECTATIONS)[number];
interface Sample {
  name: string;
  role: "mistake" | "legitimate";
  event: "tool_call" | "tool_result";
  toolName: string;
  input: Record<string, unknown>;
  toolCallId?: string;
  content?: string;
  isError?: boolean;
  expect: Expectation;
}
type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

const USAGE = `usage: bun --no-env-file scripts/check-hook.ts [--absent] <hook-file> <samples-file>

Loads the hook's default-exported factory against a stand-in host with no UI
(ctx.cwd is the working directory), feeds the samples' events in file order to
the handlers it registered, and prints one PASS/FAIL line per sample, then a
verdict line. Exits 0 only when every sample's outcome is the expected one.
With --absent, the hook file must not exist and all samples must be untouched.

The samples file is a JSON array of samples:

  {
    "name": "force push",                       // shown in the output
    "role": "mistake" | "legitimate",           // the session's mistake or its legitimate counterpart
    "event": "tool_call" | "tool_result",
    "toolName": "bash",
    "input": { "command": "git push --force" }, // the tool call's arguments
    "toolCallId": "push-1",                     // optional: the call's ID, shared by a tool_call and its tool_result
    "content": "text",                          // tool_result only: the result's text
    "isError": true,                            // tool_result only, default false
    "expect": "blocked" | "context" | "untouched"
  }

"blocked": a tool_call handler returned { block: true }. "context": a handler
returned non-blank additionalContext and nothing else. "untouched": no handler
returned anything. A returned input, content, details or isError, or a thrown
handler, is reported as such and matches no expectation.

"role" says what the sample stands for, independent of "expect". The file holds
at least one "mistake" sample and one "legitimate" sample, or it is refused. A
hook that keeps state gets the sequence its state needs, in order: every sample
runs against the same loaded hook. A sample without "toolCallId" gets an ID of
its own, so give a tool_call and its tool_result the same "toolCallId" when the
hook relates them by it.`;

const args = process.argv.slice(2);
const absent = args[0] === "--absent";
const [hookFile, samplesFile, extra] = absent ? args.slice(1) : args;
if (!hookFile || !samplesFile || extra !== undefined) fail(USAGE);

const samples = readSamples(samplesFile);
let handlers: Map<string, Handler[]>;
if (absent) {
  if (lstatSync(resolve(hookFile), { throwIfNoEntry: false })) fail(`hook file ${hookFile} must be absent`);
  if (samples.some((sample) => sample.expect !== "untouched")) fail("absence checks require untouched samples");
  handlers = new Map();
} else {
  handlers = await loadHook(hookFile);
}
const ctx = {
  cwd: process.cwd(),
  hasUI: false,
  ui: { select: async () => undefined, input: async () => undefined, editor: async () => undefined, custom: async () => undefined, confirm: async () => false, notify() {}, setStatus() {}, setEditorText() {}, getEditorText: () => "" },
};

let failed = 0;
for (const sample of samples) {
  const outcome = await run(sample);
  const passed = outcome.kind === sample.expect;
  if (!passed) failed++;
  const got = outcome.detail ? `${outcome.kind} (${outcome.detail})` : outcome.kind;
  console.log(passed ? `PASS ${sample.name}: ${got}` : `FAIL ${sample.name}: expected ${sample.expect}, got ${got}`);
}
const verdict = failed === 0 ? `OK: ${samples.length} of ${samples.length} samples as expected` : `FAILED: ${failed} of ${samples.length} samples not as expected`;
console.log(verdict);
process.exit(failed === 0 ? 0 : 1);

function readSamples(file: string): Sample[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`samples file ${file} is not readable JSON: ${message(error)}`);
  }
  if (!Array.isArray(parsed)) fail(`samples file ${file} must hold a JSON array of samples. ${USAGE}`);
  for (const [index, sample] of parsed.entries()) {
    const problem = sampleProblem(sample);
    if (problem) fail(`sample ${index + 1} in ${file}: ${problem}. ${USAGE}`);
  }
  const samples = parsed as Sample[];
  const hasBothRoles = samples.some((sample) => sample.role === "mistake") && samples.some((sample) => sample.role === "legitimate");
  if (!hasBothRoles) fail(`samples file ${file} needs at least one sample of role "mistake" and one of role "legitimate"`);
  return samples;
}

function sampleProblem(sample: unknown): string | undefined {
  if (typeof sample !== "object" || sample === null) return "not an object";
  const { name, role, event, toolName, input, toolCallId, content, isError, expect } = sample as Record<string, unknown>;
  if (typeof name !== "string" || !name) return "name must be a non-empty string";
  if (role !== "mistake" && role !== "legitimate") return 'role must be "mistake" or "legitimate"';
  if (event !== "tool_call" && event !== "tool_result") return 'event must be "tool_call" or "tool_result"';
  if (typeof toolName !== "string" || !toolName) return "toolName must be a non-empty string";
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
  if (toolCallId !== undefined && (typeof toolCallId !== "string" || !toolCallId)) return "toolCallId must be a non-empty string";
  if (content !== undefined && typeof content !== "string") return "content must be a string";
  if (isError !== undefined && typeof isError !== "boolean") return "isError must be a boolean";
  if (typeof expect !== "string" || !(EXPECTATIONS as readonly string[]).includes(expect)) return `expect must be one of ${EXPECTATIONS.join(", ")}`;
  return undefined;
}

async function loadHook(file: string): Promise<Map<string, Handler[]>> {
  const registered = new Map<string, Handler[]>();
  let commands = 0;
  const pi = {
    on(event: string, handler: Handler) {
      registered.set(event, [...(registered.get(event) ?? []), handler]);
    },
    registerCommand() {
      commands++;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    appendEntry() {},
    logger: console,
  };
  try {
    // The hook file is the command-line argument, so only a dynamic import can load it.
    const module = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
    if (typeof module.default !== "function") throw new Error("no default-exported factory function");
    await module.default(pi);
  } catch (error) {
    fail(`hook file ${file} did not load: ${message(error)}`);
  }
  if (registered.size === 0 && commands === 0) fail(`hook file ${file} registers nothing: its factory called neither pi.on nor pi.registerCommand`);
  return registered;
}

async function run(sample: Sample): Promise<{ kind: string; detail?: string }> {
  const toolCallId = sample.toolCallId ?? crypto.randomUUID();
  const event =
    sample.event === "tool_call"
      ? { type: "tool_call", toolCallId, toolName: sample.toolName, input: sample.input }
      : { type: "tool_result", toolCallId, toolName: sample.toolName, input: sample.input, content: [{ type: "text", text: sample.content ?? "" }], details: undefined, isError: sample.isError ?? false };
  const contexts: string[] = [];
  const changed: string[] = [];
  for (const handler of handlers.get(sample.event) ?? []) {
    let result: unknown;
    try {
      result = await handler(event, ctx);
    } catch (error) {
      return { kind: "error", detail: message(error) };
    }
    if (typeof result !== "object" || result === null) continue;
    const { block, reason, additionalContext, ...rest } = result as Record<string, unknown>;
    if (sample.event === "tool_call" && block === true) return { kind: "blocked", detail: typeof reason === "string" ? reason : undefined };
    if (typeof additionalContext === "string" && additionalContext.trim()) contexts.push(additionalContext.trim());
    changed.push(...Object.keys(rest).filter((key) => rest[key] !== undefined));
  }
  if (changed.length > 0) return { kind: "changed", detail: `returned ${[...new Set(changed)].join(", ")}` };
  if (contexts.length > 0) return { kind: "context", detail: contexts.join(" | ") };
  return { kind: "untouched" };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(text: string): never {
  console.error(text);
  process.exit(1);
}
