import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import skillObserver from "../src/skill-observer.js";
import type { CommandHandler, CustomMessage, ExtensionAPI, ExtensionContext, Schema } from "../src/omp.js";
import { entries } from "./fixtures.js";
import { makeSkillHome } from "./skill-home.js";

const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it.each([true, false])("discovers the existing user-only correct reference in a pass with a workflow outline only when available: %s", async (available) => {
  const { home, roots } = makeSkillHome(); homes.push(home);
  mkdirSync(roots.cwd, { recursive: true });
  vi.stubEnv("HOME", home); vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".omp/agent"));
  const path = join(roots.skillsDir, "correct/SKILL.md");
  const original = "---\nname: correct\ndescription: Prevent recurring mistakes.\ndisable-model-invocation: true\n---\nArchitecture, types, checks, tests, docs.\n";
  if (available) { mkdirSync(join(roots.skillsDir, "correct"), { recursive: true }); writeFileSync(path, original); }
  let observe: CommandHandler | undefined;
  const sent: CustomMessage[] = [];
  const schema: Schema = { optional: () => schema, describe: () => schema };
  const pi = {
    on() {}, registerTool() {}, appendEntry() {},
    registerCommand(name: string, command: { handler: CommandHandler }) { if (name === "observe") observe = command.handler; },
    getActiveTools: () => [], setActiveTools: async () => {}, sendMessage(message: CustomMessage) { sent.push(message); },
    zod: Object.fromEntries(["object", "array", "string", "number", "enum", "union", "record", "unknown"].map(key => [key, () => schema])),
  } as unknown as ExtensionAPI;
  skillObserver(pi);
  const ctx = { hasUI: true, cwd: roots.cwd, agent: { kind: "main" }, sessionManager: { getBranch: () => entries.skillLessTurn }, ui: { notify() {} } } as unknown as ExtensionContext;
  await observe!("inspect recurring errors", ctx);
  expect(sent).toHaveLength(1);
  expect(String(sent[0]!.content).includes(path)).toBe(available);
  if (available) expect(readFileSync(path, "utf8")).toBe(original);
});
