import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkExecutableInputs, checkPublishedExecutableInputs, prepareExecutableCheck, scratchCheckAuthorization } from "../src/executable-check.js";
import { sessionToolEvidence } from "../src/session-tool-evidence.js";

const checker = join(import.meta.dirname, "../scripts/check-hook.ts");
const samples = [
  { name: "mistake", role: "mistake", event: "tool_call", toolName: "bash", input: { command: "first" }, expect: "untouched" },
  { name: "legitimate", role: "legitimate", event: "tool_call", toolName: "bash", input: { command: "second" }, expect: "untouched" },
];

it("replays both untouched scenarios only while the removed hook stays absent", () => {
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), "omp-observe-check."));
  try {
    const samplesFile = join(cwd, "samples.json");
    writeFileSync(samplesFile, JSON.stringify(samples));
    const check = () => spawnSync("bun", ["--no-env-file", checker, "--absent", "hook.ts", samplesFile], { cwd, encoding: "utf8" });
    const absent = check();
    expect(absent.stdout).toContain("PASS mistake: untouched\nPASS legitimate: untouched");
    expect(absent.status).toBe(0);

    writeFileSync(join(cwd, "hook.ts"), "throw new Error('must not load');");
    const present = check();
    expect(present.status).toBe(1);
    expect(present.stderr).toContain("must be absent");
    expect(present.stderr).not.toContain("must not load");
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

it("binds a successful suite to scratch bytes and the complete extension postimage", () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "omp-observe-check."));
  const target = mkdtempSync(join(realpathSync(tmpdir()), "observer-target."));
  try {
    const after = "export const greeting = 'after';";
    const suite = "import { expect, test } from 'bun:test'; import { greeting } from './extension'; test('greet', () => expect(greeting).toBe('after'));";
    writeFileSync(join(scratch, "extension.ts"), after);
    writeFileSync(join(scratch, "extension.test.ts"), suite);
    writeFileSync(join(target, "extension.ts"), "export const greeting = 'before';");
    writeFileSync(join(target, "extension.test.ts"), suite);

    const input = { command: "bun --no-env-file test", cwd: scratch };
    const observed = observeScratchCheck(input);
    expect(observed.exitCode).toBe(0);
    const prepared = prepareExecutableCheck("extension", [{ path: "extension.ts", text: after }], target, observed.id, observed.evidence, 0);
    expect(prepared.output).toBe(observed.output);
    expect(() => checkPublishedExecutableInputs(prepared, target)).toThrow("extension.ts");

    writeFileSync(join(target, "extension.ts"), after);
    checkPublishedExecutableInputs(prepared, target);
    writeFileSync(join(target, "extension.test.ts"), `${suite}\n// changed elsewhere`);
    expect(() => checkPublishedExecutableInputs(prepared, target, ["extension.ts"])).toThrow("extension.test.ts");
    writeFileSync(join(scratch, "extension.test.ts"), `${suite}\n// changed since check`);
    expect(() => checkExecutableInputs(prepared)).toThrow("changed since the reviewed run");
  } finally {
    rmSync(scratch, { recursive: true });
    rmSync(target, { recursive: true });
  }
});

it.each([
  { name: "an existing Node TAP test script", script: "node --test --test-reporter=tap", test: "match", status: 0, summary: /^# pass 1$/m },
  { name: "an existing Node spec test script", script: "node --test --test-reporter=spec", test: "match", status: 0, summary: /^ℹ pass 1$/m },
  { name: "a Node test script with the default reporter", script: "node --test", test: "match", status: 0, summary: /^(?:#|ℹ) pass 1$/m },
  { name: "an informational script", script: "node --version", test: "match", status: 0, error: /supported check/ },
  { name: "a collection-only Vitest script", script: "vitest list", test: "match", status: undefined, error: /supported check/ },
  { name: "a skipped Node suite", script: "node --test --test-reporter=spec", test: "skip", status: 0, summary: /^ℹ pass 0$/m, error: /meaningful successful check/ },
  { name: "a failing Node suite", script: "node --test --test-reporter=spec", test: "mismatch", status: 1, summary: /^ℹ fail 1$/m, error: /successful native foreground Bash check/ },
])("prepares an extension only from a meaningful configured check: $name", ({ script, test, status, summary, error }) => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "omp-observe-check."));
  const target = mkdtempSync(join(realpathSync(tmpdir()), "observer-target."));
  try {
    const command = "npm run check";
    const manifest = JSON.stringify({ scripts: { check: script } });
    const after = "module.exports = 'after';";
    const assertion = test === "mismatch" ? "before" : "after";
    const skip = test === "skip" ? "{ skip: true }, " : "";
    const suite = `require('node:test')('greeting', ${skip}() => require('node:assert/strict').equal(require('./extension.cjs'), '${assertion}'));`;
    for (const cwd of [scratch, target]) {
      writeFileSync(join(cwd, "package.json"), manifest);
      writeFileSync(join(cwd, "greeting.test.cjs"), suite);
    }
    writeFileSync(join(scratch, "extension.cjs"), after);
    writeFileSync(join(target, "extension.cjs"), "module.exports = 'before';");
    const input = { command, cwd: scratch };
    if (status === undefined) {
      expect(scratchCheckAuthorization({ toolName: "bash", toolCallId: "collection-only", input })).toBeUndefined();
      return;
    }
    const observed = observeScratchCheck(input);
    expect(observed.exitCode).toBe(status);
    if (summary) expect(observed.output).toMatch(summary);
    const prepare = () => prepareExecutableCheck("extension", [{ path: "extension.cjs", text: after }], target, observed.id, observed.evidence, 0);
    if (error) {
      expect(prepare).toThrow(error);
      return;
    }

    const prepared = prepare();
    expect(prepared).toMatchObject({ command, output: observed.output, scratch });
    writeFileSync(join(target, "extension.cjs"), after);
    checkPublishedExecutableInputs(prepared, target);
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ scripts: { check: script }, description: "edited after the run" }));
    expect(() => checkExecutableInputs(prepared)).toThrow("changed since the reviewed run");
  } finally {
    rmSync(scratch, { recursive: true });
    rmSync(target, { recursive: true });
  }
});

it.each([
  { name: "listed source", path: "extension.ts", included: true, declaration: false, error: undefined },
  { name: "unlisted source", path: "extension.ts", included: false, declaration: false, error: /meaningful successful check/ },
  { name: "listed declaration skipped by tsc", path: "extension.d.ts", included: true, declaration: true, error: /declaration changes require passing tests/ },
  { name: "listed arbitrary-extension declaration skipped by tsc", path: "extension.d.css.ts", included: true, declaration: true, error: /declaration changes require passing tests/ },
])("accepts typecheck proof only for checked source: $name", ({ path, included, declaration, error }) => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "omp-observe-check."));
  const target = mkdtempSync(join(realpathSync(tmpdir()), "observer-target."));
  try {
    const after = declaration ? "export type Greeting = MissingType;" : "export const greeting: string = 'after';";
    const before = declaration ? "export type Greeting = string;" : "export const greeting: string = 'before';";
    const tsconfig = JSON.stringify({ compilerOptions: { skipLibCheck: declaration }, files: [included ? path : "unrelated.ts"] });
    for (const cwd of [scratch, target]) {
      writeFileSync(join(cwd, "tsconfig.json"), tsconfig);
      writeFileSync(join(cwd, "unrelated.ts"), "export const count = 1;");
    }
    writeFileSync(join(scratch, path), after);
    writeFileSync(join(target, path), before);
    const command = "tsc --project tsconfig.json --noEmit --noCheck false --listFiles";
    const input = { command, cwd: scratch };
    const observed = observeScratchCheck(input);
    expect(observed.exitCode, observed.output).toBe(0);
    expect(observed.output.split("\n").includes(join(scratch, path))).toBe(included);
    const prepare = () => prepareExecutableCheck("extension", [{ path, text: after }], target, observed.id, observed.evidence, 0);
    if (error) expect(prepare).toThrow(error);
    else expect(prepare()).toMatchObject({ command, output: observed.output });
  } finally {
    rmSync(scratch, { recursive: true });
    rmSync(target, { recursive: true });
  }
});

function observeScratchCheck(input: { command: string; cwd: string }) {
  const id = "scratch-suite";
  const authorization = scratchCheckAuthorization({ toolName: "bash", toolCallId: id, input });
  const env = { ...process.env, PATH: `${join(import.meta.dirname, "../node_modules/.bin")}:${process.env.PATH}` };
  const executed = spawnSync("bash", ["-c", input.command], { cwd: input.cwd, encoding: "utf8", env });
  const output = executed.stdout + executed.stderr;
  const content = [{ type: "text", text: output }];
  const details = { exitCode: executed.status ?? undefined };
  const isError = executed.status !== 0;
  const evidence = sessionToolEvidence([
    { type: "custom" },
    { type: "custom", customType: "skill-observer-tool-call", data: { toolCallId: id, toolName: "bash", input, authorization } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: input }] } },
    { type: "custom", customType: "skill-observer-tool-result", data: {
      toolCallId: id, toolName: "bash", input, content, details, isError, supplier: { source: "builtin", path: "<builtin:bash>" },
    } },
    { type: "message", message: {
      role: "toolResult", toolCallId: id, toolName: "bash", content: [...content, { type: "text", text: JSON.stringify({ observerToolCallId: id }) }],
      details, isError,
    } },
  ]);
  return { id, evidence, output, exitCode: executed.status };
}
