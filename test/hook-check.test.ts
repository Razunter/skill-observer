import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "check-hook.ts");

const FORCE_PUSH_HOOK = `
export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && String(event.input.command ?? "").includes("push --force")) {
      return { block: true, reason: "force push is not allowed here" };
    }
  });
}
`;

const forcePush = { name: "force push", role: "mistake", event: "tool_call", toolName: "bash", input: { command: "git push --force" } };
const plainPush = { name: "plain push", role: "legitimate", event: "tool_call", toolName: "bash", input: { command: "git push" } };

function run(...args: string[]): Promise<{ code: number | null; out: string }> {
  return bun(script, ...args);
}

function bun(...args: string[]): Promise<{ code: number | null; out: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; out: string }>();
  const child = spawn("bun", ["--no-env-file", ...args], { cwd: root });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, out }));
  return promise;
}

function fixture(hook: string, samples: unknown): { hookFile: string; samplesFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "skill-observer-hook-check-"));
  const hookFile = join(dir, "hook.ts");
  const samplesFile = join(dir, "samples.json");
  writeFileSync(hookFile, hook);
  writeFileSync(samplesFile, JSON.stringify(samples));
  return { hookFile, samplesFile };
}

describe("hook check script", () => {
  it("passes when the mistake is blocked and the legitimate counterpart is untouched", async () => {
    const { hookFile, samplesFile } = fixture(FORCE_PUSH_HOOK, [
      { ...forcePush, expect: "blocked" },
      { ...plainPush, expect: "untouched" },
    ]);

    const { code, out } = await run(hookFile, samplesFile);

    expect(out).toContain("PASS force push: blocked (force push is not allowed here)");
    expect(out).toContain("PASS plain push: untouched");
    expect(out.trim().split("\n").at(-1)).toBe("OK: 2 of 2 samples as expected");
    expect(code).toBe(0);
  });

  it.each([
    ["the mistake expected untouched", [{ ...forcePush, expect: "untouched" }, { ...plainPush, expect: "untouched" }], "FAIL force push: expected untouched, got blocked"],
    ["the legitimate one expected blocked", [{ ...forcePush, expect: "blocked" }, { ...plainPush, expect: "blocked" }], "FAIL plain push: expected blocked, got untouched"],
  ])("fails when %s", async (_case, samples, failLine) => {
    const { hookFile, samplesFile } = fixture(FORCE_PUSH_HOOK, samples);

    const { code, out } = await run(hookFile, samplesFile);

    expect(out).toContain(failLine);
    expect(out.trim().split("\n").at(-1)).toBe("FAILED: 1 of 2 samples not as expected");
    expect(code).not.toBe(0);
  });

  it("reports context added by a tool_result handler and leaves the successful result untouched", async () => {
    const hook = `
export default function (pi) {
  pi.on("tool_result", (event) => {
    if (event.isError && event.content.some((c) => c.text.includes("lockfile"))) {
      return { additionalContext: "Run bun install before retrying." };
    }
  });
}
`;
    const { hookFile, samplesFile } = fixture(hook, [
      { name: "lockfile error", role: "mistake", event: "tool_result", toolName: "bash", input: { command: "bun test" }, content: "stale lockfile", isError: true, expect: "context" },
      { name: "passing run", role: "legitimate", event: "tool_result", toolName: "bash", input: { command: "bun test" }, content: "stale lockfile", expect: "untouched" },
    ]);

    const { code, out } = await run(hookFile, samplesFile);

    expect(out).toContain("PASS lockfile error: context (Run bun install before retrying.)");
    expect(out).toContain("PASS passing run: untouched");
    expect(code).toBe(0);
  });

  it("checks the sequence a stateful hook needs in order", async () => {
    const hook = `
export default function (pi) {
  const read = new Set();
  pi.on("tool_call", (event) => {
    if (event.toolName === "read") read.add(event.input.path);
    if (event.toolName === "edit" && !read.has(event.input.path)) return { block: true, reason: "read the file first" };
  });
}
`;
    const editA = { event: "tool_call", toolName: "edit", input: { path: "a.ts" } };
    const readA = { name: "read a.ts", role: "legitimate", event: "tool_call", toolName: "read", input: { path: "a.ts" }, expect: "untouched" };
    const inOrder = fixture(hook, [
      { ...editA, name: "edit before read", role: "mistake", expect: "blocked" },
      readA,
      { ...editA, name: "edit after read", role: "legitimate", expect: "untouched" },
    ]);
    const outOfOrder = fixture(hook, [
      readA,
      { ...editA, name: "edit before read", role: "mistake", expect: "blocked" },
      { ...editA, name: "edit after read", role: "legitimate", expect: "untouched" },
    ]);

    const [passing, failing] = await Promise.all([run(inOrder.hookFile, inOrder.samplesFile), run(outOfOrder.hookFile, outOfOrder.samplesFile)]);

    expect(passing.out).toContain("PASS edit after read: untouched");
    expect(passing.code).toBe(0);
    expect(failing.out).toContain("FAIL edit before read: expected blocked, got untouched");
    expect(failing.code).not.toBe(0);
  });

  it.each([
    ["a syntax error", "export default function (pi) {", "did not load"],
    ["no default factory", "export const hook = () => {};", "did not load: no default-exported factory function"],
    ["a throwing factory", "export default function () { throw new Error('boom'); }", "did not load: boom"],
    ["no registrations", "export default function () {}", "registers nothing"],
  ])("fails with a clear message on %s", async (_case, hook, message) => {
    const { hookFile, samplesFile } = fixture(hook, [
      { ...forcePush, expect: "blocked" },
      { ...plainPush, expect: "untouched" },
    ]);

    const { code, out } = await run(hookFile, samplesFile);

    expect(out).toContain(message);
    expect(out).toContain(hookFile);
    expect(out).not.toContain("PASS");
    expect(code).not.toBe(0);
  });

  it.each([
    ["only mistakes", [{ ...forcePush, expect: "blocked" }, { ...plainPush, role: "mistake", expect: "untouched" }]],
    ["only legitimate samples", [{ ...forcePush, role: "legitimate", expect: "blocked" }, { ...plainPush, expect: "untouched" }]],
  ])("refuses a samples file with %s", async (_case, samples) => {
    const { hookFile, samplesFile } = fixture(FORCE_PUSH_HOOK, samples);

    const { code, out } = await run(hookFile, samplesFile);

    expect(out).toContain(`samples file ${samplesFile} needs at least one sample of role "mistake" and one of role "legitimate"`);
    expect(out).not.toContain("PASS");
    expect(code).not.toBe(0);
  });

  it("refuses a sample without a role", async () => {
    const { role: _role, ...noRole } = plainPush;
    const { hookFile, samplesFile } = fixture(FORCE_PUSH_HOOK, [{ ...forcePush, expect: "blocked" }, { ...noRole, expect: "untouched" }]);

    const { code, out } = await run(hookFile, samplesFile);

    expect(out).toContain(`sample 2 in ${samplesFile}: role must be "mistake" or "legitimate"`);
    expect(code).not.toBe(0);
  });

  it("is in the package's shipped files", async () => {
    const { out } = await bun("pm", "pack", "--dry-run");

    expect(out).toMatch(/packed .* scripts\/check-hook\.ts\n/);
  });
});
