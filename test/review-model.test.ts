import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compactionFingerprint } from "../src/amendments.js";
import { scratchCheckAuthorization } from "../src/executable-check.js";
import { harnessFingerprint, type LedgerRecord, projectFingerprint, type ProjectTarget, proposalFingerprint, putLedgerRecords } from "../src/ledger.js";
import type { PreparedProposalRef } from "../src/review.js";
import { writeObserverStore } from "../src/observer-store.js";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolArguments, ToolDefinition, ToolResultDetails } from "../src/omp.js";
import { HOOK_CHECK_PATH } from "../src/payload.js";
import { registerReviewTool } from "../src/review.js";
import { recordHookCall, recordHookResult } from "../src/session-tool-evidence.js";
import { zod } from "./host-schema.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { provider: "fixture", id: "explicit-judge" };
const projectRepair = (gist: string, quote: string, count: number, remedy = "Other fix") =>
  ({ kind: "project", gist, priority: "evidence", remedy, change: { operation: "project-edit", text: `New check: ${gist}\n`, check: "bun test" }, evidence: [{ quote, count }] });
const drafts = [
  projectRepair("Weak", "Weak support", 1, "Fix weak"),
  projectRepair("Strong", "Strong support", 4, "Fix strong"),
  ...Array.from({ length: 4 }, (_, i) => projectRepair(`Other ${i}`, "Other support", 1)),
];
/** The fixture candidates as repairs of distinct mechanisms of one file in the project `root`. */
const candidatesIn = (root: string) => drafts.map((draft) => ({ ...draft, target: { scope: "project" as const, root, path: "AGENTS.md", mechanism: draft.gist } }));
const rankingsIn = (root: string) => candidatesIn(root).map((entry, index) =>
  ({ id: `proposal:${projectFingerprint({ ...entry.target, root: realpathSync(root) })}`, score: index === 0 ? 3 : 0, confidence: 1, consistent: true }));

function host(options: { assignment?: string; settings?: boolean; models?: boolean; resolver?: boolean; available?: boolean; throws?: boolean; kind?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "observer-review-model-")); roots.push(root);
  let tool: ToolDefinition<unknown, unknown> | undefined;
  let assignment = options.assignment;
  const builtins = ["bash", "write", "edit"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } }));
  const branch: SessionEntry[] = [{ type: "custom_message", id: "observe", customType: "skill-observer", content: "Observation pass." }];
  const pi = {
    zod,
    ...(options.settings !== false && { pi: {
      settings: { getModelRole(role: string) {
        expect(role).toBe("judge");
        if (options.throws) throw new Error("settings unavailable");
        return assignment;
      } },
      ...(options.resolver !== false && { async resolveScopedModels(_parsed: unknown, registry: { getAvailable(): Array<typeof model> }) {
        // The real host can resolve generic role defaults when no assignment exists.
        return assignment?.trim() ? registry.getAvailable().map(model => ({ model })) : [{ model }];
      } }),
    } }),
    registerTool<TParams, TDetails>(definition: ToolDefinition<TParams, TDetails>) {
      tool = definition as ToolDefinition<unknown, unknown>;
    },
    getAllTools: () => [
      ...builtins,
      ...(tool ? [{ name: tool.name, sourceInfo: { source: "extension", path: "/extensions/skill-observer/src/skill-observer.ts" } }] : []),
    ],
    appendEntry(customType: string, data: SessionEntry["data"]) { branch.push({ type: "custom", customType, data }); },
  } satisfies Pick<ExtensionAPI, "zod" | "registerTool" | "getAllTools" | "appendEntry">;
  const api = pi as unknown as ExtensionAPI;
  registerReviewTool(api, { storeFile: () => join(root, "observer.sqlite"), rulesDir: () => root, amendmentsDir: () => root, referencesDir: () => root }, () => undefined);
  const ctx = {
    cwd: root,
    hasUI: true,
    sessionManager: { getBranch: () => branch, getSessionId: () => "review-model" },
    ...(options.models !== false && { modelRegistry: { getAvailable: () => options.available === false ? [] : [{ ...model, kind: options.kind }] } }),
  } as unknown as ExtensionContext;
  let eligible: Array<{ reference: { candidateId: string }; gist: string }> = [];
  const rankings = rankingsIn(root);
  async function call(params: ToolArguments) {
    if (!tool) throw new Error("review tool not registered");
    const id = `review-${branch.length}`;
    const result = await tool.execute(id, params, undefined, undefined, ctx);
    branch.push(
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "observer_review", arguments: params }] } },
      { type: "message", message: { role: "toolResult", toolCallId: id, toolName: "observer_review", isError: result.isError ?? false, details: result.details as ToolResultDetails } },
    );
    return { result, output: JSON.parse(result.content[0]!.text) };
  }
  return {
    root, call, rankings,
    checkHook(path: string, text: string) {
      const cwd = mkdtempSync(join(realpathSync(tmpdir()), "omp-observe-check."));
      roots.push(cwd);
      const samples = join(cwd, "samples.json");
      writeFileSync(join(cwd, path), text);
      writeFileSync(samples, JSON.stringify([
        { name: "wrong target", role: "mistake", event: "tool_call", toolName: "bash", input: { command: "wrong target" }, expect: "blocked" },
        { name: "right target", role: "legitimate", event: "tool_call", toolName: "bash", input: { command: "right target" }, expect: "untouched" },
      ]));
      const command = `bun --no-env-file '${HOOK_CHECK_PATH}' ${path} '${samples}'`;
      const toolCallId = "scratch-hook-check";
      const event = { toolCallId, toolName: "bash", input: { cwd, command } };
      recordHookCall(api, event, scratchCheckAuthorization(event));
      branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: event.input }] } });
      const run = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8" });
      const output = run.stdout + run.stderr;
      expect(run.status, output).toBe(0);
      const content = [{ type: "text" as const, text: output }];
      const details = { exitCode: 0 };
      recordHookResult(api, { ...event, content, details, isError: false }, branch);
      branch.push({ type: "message", message: { role: "toolResult", toolCallId, toolName: "bash", content, details, isError: false } });
      return { operation: "harness", stage: "checked", files: [{ path, text }], checkToolCallId: toolCallId,
        lowerRungs: "Project guidance cannot block the tool call before it reaches Bash." };
    },
    disable() { assignment = undefined; },
    async run(action: "prepare" | "select") {
      const { result, output } = await call(action === "prepare"
        ? { action, candidates: candidatesIn(root) } : { action, proposals: eligible.map(({ reference }) => reference), rankings });
      expect(result.isError).toBeFalsy();
      if (action === "prepare") {
        eligible = output.eligible;
        return output;
      }
      const gists = (references: Array<{ candidateId: string }>) => references.map(({ candidateId }) => eligible.find(({ reference }) => reference.candidateId === candidateId)?.gist);
      return { ...output, selected: gists(output.selected), deferred: gists(output.deferred) };
    },
  };
}

describe("observer_review explicit judge availability", () => {
  it.each([
    {},
    { assignment: "fixture/explicit-judge", settings: false },
    { assignment: "fixture/explicit-judge", models: false },
    { assignment: "fixture/explicit-judge", resolver: false },
    { assignment: "fixture/explicit-judge", kind: "image" },
    { assignment: "fixture/explicit-judge", available: false },
    { assignment: "fixture/explicit-judge", throws: true },
    { assignment: "  " },
  ])("does not request ranking or accept supplied scores when unavailable: %j", async (options) => {
    const h = host(options);
    expect(await h.run("prepare")).toMatchObject({ needsRanking: false, judgeStates: {} });
    expect(await h.run("select")).toMatchObject({
      selected: ["Strong", "Weak", "Other 0", "Other 1", "Other 2"],
      deferred: ["Other 3"], fallback: expect.stringContaining("Advisory ranking unavailable"), failures: [],
    });
  });

  it.each(["chat", "tiny", "judge"])("permits advisory ranking for an explicitly assigned available %s judge", async (kind) => {
    const h = host({ assignment: "fixture/explicit-judge", kind });
    const prepared = await h.run("prepare");
    expect(prepared.needsRanking).toBe(true);
    expect(Object.keys(prepared.judgeStates)).toEqual(h.rankings.map(entry => entry.id));
    expect(JSON.stringify(prepared.judgeStates)).not.toContain("Exact");
    const selected = await h.run("select");
    expect(selected.selected).toEqual(["Weak", "Strong", "Other 0", "Other 1", "Other 2"]);
    expect(selected).not.toHaveProperty("fallback");
  });

  it("rechecks explicit availability at Select instead of trusting earlier Prepare or caller scores", async () => {
    const h = host({ assignment: "fixture/explicit-judge" });
    expect((await h.run("prepare")).needsRanking).toBe(true);
    h.disable();
    expect((await h.run("select")).selected[0]).toBe("Strong");
  });
});

it("keeps scoped Prepare and Select eligibility when other projects have decisions for the same remedies", async () => {
  const { root, call, checkHook } = host();
  const other = mkdtempSync(join(tmpdir(), "observer-review-other-")); roots.push(other);
  const project = (root: string, mechanism: string) => ({ scope: "project" as const, root, path: "AGENTS.md", mechanism });
  const globalHook = { scope: "harness", root: "global-hooks", path: "guard.ts", mechanism: "Configure guard" } as const;
  const projectHook = { ...globalHook, root: "project-hooks" } as const;
  const record = { sessionId: "review-model", timestamp: "2026-11-01T00:00:00Z" };
  const declineProject = (target: ProjectTarget): LedgerRecord => ({
    ...record, kind: "project", target, fingerprint: projectFingerprint(target), gist: target.mechanism, outcome: "declined",
  });
  const skill = "fixture-workflow";
  const applied = { ...record, kind: "upstream", outcome: "applied", skill, gist: "Recorded fix", fingerprint: proposalFingerprint(skill, "Recorded fix") } as const;
  const stale = { ...applied, gist: "Check stale amendment", fingerprint: proposalFingerprint(skill, "Old amendment") };
  const compaction = { ...applied, gist: "Compact amendment", fingerprint: compactionFingerprint(skill, ""), outcome: "declined", compaction: true } as const;
  const seed = (records: LedgerRecord[]) => writeObserverStore(join(root, "observer.sqlite"), new Date(), (db) => putLedgerRecords(db, records));
  seed([
    applied, stale, compaction, declineProject(project(root, "Declined repair")),
    { ...record, kind: "harness", target: globalHook, gist: "Global guard", fingerprint: harnessFingerprint(globalHook), outcome: "declined" },
  ]);
  writeFileSync(join(root, "fixture-stale.md"), `---\ngeneratedBy: skill-observer\namends: ${skill}\nskillHash: old\ncondition: wrong\nscope: text\nfingerprint: ${stale.fingerprint}\n---\n\nOld guidance.\n`);
  writeFileSync(join(root, "AGENTS.md"), "Project guidance.\n");
  symlinkSync("AGENTS.md", join(root, "alias.md"));
  const checked = checkHook(projectHook.path, `export default pi => pi.on("tool_call", ({ input }) =>
  input.command === "wrong target" ? { block: true, reason: "Use the right target" } : undefined);
`);
  const remedy = "Fix guidance";
  const candidates = [
    { ...projectRepair("Declined repair", "Evidence", 1), target: { ...project(root, "Declined repair"), path: "alias.md" } },
    { ...projectRepair("Keep repair", "Evidence", 1), target: project(root, "Keep repair") },
    { kind: "harness", gist: "Global guard", target: globalHook, priority: "evidence", remedy, change: checked },
    { kind: "harness", gist: "Project guard", target: projectHook, priority: "evidence", remedy, change: checked },
    { kind: "upstream", skill, gist: "Take back the recorded fix", fingerprint: applied.fingerprint, priority: "note", remedy, change: { operation: "withdrawal" } },
    { kind: "upstream", skill, gist: stale.gist, priority: "stale", remedy, change: { operation: "stale-delete", rule: "fixture-stale" } },
    { kind: "upstream", skill, gist: compaction.gist, priority: "compaction", remedy, change: { operation: "compaction", includes: [], body: "Shorter.", references: [] } },
  ];
  const prepare = async () => {
    const { result, output } = await call({ action: "prepare", candidates });
    expect(result.isError, JSON.stringify(output.failures)).toBeFalsy();
    return output.eligible as Array<{ gist: string; reference: PreparedProposalRef }>;
  };
  const baseline = await prepare();
  expect(baseline.map(({ gist }) => gist)).toEqual(["Keep repair", "Project guard", "Take back the recorded fix", stale.gist]);
  const foreignHook = { ...projectHook, project: other };
  seed([
    declineProject(project(other, "Keep repair")),
    { ...record, kind: "harness", target: foreignHook, gist: "Project guard", fingerprint: harnessFingerprint(foreignHook), outcome: "declined" },
    ...Array.from({ length: 12 }, (_, i) => declineProject(project(i % 2 === 0 ? root : other, `Unrelated ${i}`))),
  ]);
  const padded = await prepare();
  expect(padded.map(({ reference: { candidateId } }) => candidateId)).toEqual(baseline.map(({ reference: { candidateId } }) => candidateId));
  seed([declineProject(project(root, "Keep repair")), { ...stale, outcome: "declined" }]);
  const selected = await call({ action: "select", proposals: padded.map(({ reference }) => reference) });
  expect(selected.result.isError).toBeFalsy();
  expect(selected.output.selected).toEqual([padded[2]!.reference, padded[1]!.reference]);
  const forged = await call({ action: "select", proposals: [{ ...padded[2]!.reference, contentHash: "wrong" }] });
  expect(forged.result.isError).toBe(true);
  expect(forged.output.selected).toEqual([]);
  const refused = await call({ action: "prepare", candidates: [{ ...candidates[4], skill: "other-workflow" }] });
  expect(refused.result.isError).toBe(false);
  expect(refused.output.rejected).toEqual([{ index: 0, gist: "Take back the recorded fix", reason: expect.stringContaining("belongs to another target") }]);
});
