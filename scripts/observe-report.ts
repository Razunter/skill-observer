/**
 * Prints what `/observe-report` shows for a saved session, without OMP:
 *
 *   bun --no-env-file scripts/observe-report.ts <session.jsonl> [leaf-entry-id]
 *
 * The branch is the chain of parents from the given entry, or from the file's
 * last entry. Skills are read from the real home; the agent dir's rules,
 * managed skills and observer state are copied to a temp dir first, because
 * loading the extension migrates rule files. The fake host has no judge role.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandHandler, ExtensionAPI, ExtensionContext, Schema, SessionEntry } from "../src/omp.js";
import { ompAgentDir } from "../src/provenance.js";

const [sessionFile, leafId] = process.argv.slice(2);
if (!sessionFile) {
  console.error("usage: bun --no-env-file scripts/observe-report.ts <session.jsonl> [leaf-entry-id]");
  process.exit(2);
}

const rows = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEntry & { cwd?: string });
const byId = new Map(rows.filter((row) => row.id).map((row) => [row.id!, row]));
const branch: SessionEntry[] = [];
for (let entry = leafId ? byId.get(leafId) : rows.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.unshift(entry);
if (branch.length === 0) throw new Error(`no entry ${leafId} in ${sessionFile}`);
const cwd = rows.find((row) => row.type === "session")?.cwd ?? process.cwd();

const liveAgentDir = ompAgentDir();
const agentDir = mkdtempSync(join(tmpdir(), "observe-report-"));
for (const name of ["skill-observer", "rules", "managed-skills"]) {
  if (existsSync(join(liveAgentDir, name))) cpSync(join(liveAgentDir, name), join(agentDir, name), { recursive: true });
}
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const schema: Schema = { optional: () => schema, describe: () => schema };
  const builder = () => schema;
  const commands: Record<string, CommandHandler> = {};
  const pi = {
    on: () => {}, registerTool: () => {}, getActiveTools: () => [], setActiveTools: async () => {}, sendMessage: () => {}, appendEntry: () => {},
    registerCommand: (name: string, command: { handler: CommandHandler }) => { commands[name] = command.handler; },
    zod: { object: builder, array: builder, string: builder, number: builder, enum: builder, union: builder, record: builder, unknown: builder },
    pi: { settings: { getModelRole: () => undefined }, resolveScopedModels: async () => [] },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true, agent: { kind: "main" }, cwd,
    sessionManager: { getBranch: () => branch, getSessionId: () => "observe-report" },
    modelRegistry: { getAvailable: () => [] },
    ui: { setStatus: () => {}, notify: (message: string) => console.log(message) },
  } as unknown as ExtensionContext;
  // Imported after the agent dir is redirected, so the load-time migration runs on the copy.
  const { default: skillObserver } = await import("../src/skill-observer.js");
  skillObserver(pi);
  await commands["observe-report"]!("", ctx);
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
