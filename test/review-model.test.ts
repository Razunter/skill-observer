import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { proposalFingerprint } from "../src/ledger.js";
import type { ExtensionAPI, ExtensionContext, Schema, SessionEntry, ToolArguments, ToolDefinition, ToolResultDetails } from "../src/omp.js";
import { registerReviewTool } from "../src/review.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const schema: Schema = { optional: () => schema, describe: () => schema };
const model = { provider: "fixture", id: "explicit-judge" };
const candidate = (gist: string, quote: string, count: number, remedy = "Other fix") =>
  ({ kind: "local", skill: "test", gist, priority: "evidence", remedy, change: { operation: "direct-edit", preview: `Exact ${gist} diff` }, evidence: [{ quote, count }] });
const candidates = [
  candidate("Weak", "Weak support", 1, "Fix weak"),
  candidate("Strong", "Strong support", 4, "Fix strong"),
  ...Array.from({ length: 4 }, (_, i) => candidate(`Other ${i}`, "Other support", 1)),
];
const rankings = candidates.map((entry, index) => ({ id: `proposal:${proposalFingerprint("test", entry.gist)}`, score: index === 0 ? 3 : 0, confidence: 1, consistent: true }));

function host(options: { assignment?: string; settings?: boolean; models?: boolean; resolver?: boolean; available?: boolean; throws?: boolean; kind?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "observer-review-model-")); roots.push(root);
  let tool: ToolDefinition<unknown, unknown> | undefined;
  let assignment = options.assignment;
  const pi = {
    zod: { object: () => schema, array: () => schema, string: () => schema, number: () => schema, enum: () => schema, union: () => schema, unknown: () => schema, record: () => schema },
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
    registerTool(definition: ToolDefinition<unknown, unknown>) { tool = definition; },
  } as unknown as ExtensionAPI;
  registerReviewTool(pi, { ledgerFile: () => join(root, "ledger.jsonl"), rulesDir: () => root, amendmentsDir: () => root, referencesDir: () => root });
  const branch: SessionEntry[] = [{ type: "custom_message", id: "observe", customType: "skill-observer", content: "Observation pass." }];
  const ctx = {
    cwd: root,
    sessionManager: { getBranch: () => branch, getSessionId: () => "review-model" },
    ...(options.models !== false && { modelRegistry: { getAvailable: () => options.available === false ? [] : [{ ...model, kind: options.kind }] } }),
  } as unknown as ExtensionContext;
  let eligible: Array<{ reference: { candidateId: string }; gist: string }> = [];
  return {
    disable() { assignment = undefined; },
    /** Runs Prepare with the fixture candidates, or Select with the references the last Prepare returned, naming Select's references by the gists Prepare gave them, and saves the completed call on the branch. */
    async run(action: "prepare" | "select") {
      if (!tool) throw new Error("review tool not registered");
      const id = `review-${branch.length}`;
      const params = action === "prepare" ? { action, candidates } : { action, proposals: eligible.map(({ reference }) => reference), rankings };
      const result = await tool.execute(id, params, undefined, undefined, ctx);
      branch.push(
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "observer_review", arguments: params as ToolArguments }] } },
        { type: "message", message: { role: "toolResult", toolCallId: id, toolName: "observer_review", isError: result.isError ?? false, details: result.details as ToolResultDetails } },
      );
      expect(result.isError).toBeFalsy();
      const output = JSON.parse(result.content[0]!.text);
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
    expect(Object.keys(prepared.judgeStates)).toEqual(rankings.map(entry => entry.id));
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
