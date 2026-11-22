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

    const toolCallId = "scratch-suite";
    const input = { command: "bun --no-env-file test", cwd: scratch };
    const authorization = scratchCheckAuthorization({ toolName: "bash", toolCallId, input });
    const executed = spawnSync("bun", ["--no-env-file", "test"], { cwd: scratch, encoding: "utf8" });
    expect(executed.status).toBe(0);
    const output = executed.stdout + executed.stderr;
    const content = [{ type: "text", text: output }];
    const details = { exitCode: executed.status ?? undefined };
    const evidence = sessionToolEvidence([
      { type: "custom" },
      { type: "custom", customType: "skill-observer-tool-call", data: { toolCallId, toolName: "bash", input, authorization } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: input }] } },
      { type: "custom", customType: "skill-observer-tool-result", data: {
        toolCallId, toolName: "bash", input, content, details, isError: false, supplier: { source: "builtin", path: "<builtin:bash>" },
      } },
      { type: "message", message: {
        role: "toolResult", toolCallId, toolName: "bash", content: [...content, { type: "text", text: JSON.stringify({ observerToolCallId: toolCallId }) }],
        details, isError: false,
      } },
    ]);
    const prepared = prepareExecutableCheck("extension", [{ path: "extension.ts", text: after }], target, toolCallId, evidence, 0);
    expect(prepared.output).toBe(output);
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
