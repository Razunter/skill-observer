import assert from "node:assert/strict";
import skillObserver from "../src/skill-observer.js";
import type { ExtensionAPI, Schema, ToolDefinition } from "../src/omp.js";

/** Runs inside the installed host without submitting a model prompt. */
export default function (pi: ExtensionAPI) {
  const tools: Record<string, ToolDefinition<unknown, unknown>> = {};
  const host: ExtensionAPI = Object.create(pi);
  host.registerTool = (tool) => { tools[tool.name] = tool as ToolDefinition<unknown, unknown>; pi.registerTool(tool); };
  skillObserver(host);
  const resolver = tools.observer_resolve;
  assert.ok(resolver, "Observer resolver must register in the native host");
  // The native host adds parsing to the extension's structural schema facade.
  const schema = resolver.parameters as Schema & { safeParse(value: unknown): { success: boolean } };
  const identity = { kind: "local", skill: "tdd", gist: "Check behavior" };
  assert.equal(schema.safeParse({ outcomes: [{ ...identity, outcome: "declined" }] }).success, true);
  assert.equal(schema.safeParse({ outcomes: [{ ...identity, outcome: "unknown" }] }).success, false);
  pi.on("session_start", (_event, ctx) => {
    console.log("NATIVE_OBSERVER_SCHEMAS_OK");
    // Shutdown is native host behavior outside the extension's minimal facade.
    const nativeContext = ctx as typeof ctx & { shutdown(): void };
    nativeContext.shutdown();
  });
}
