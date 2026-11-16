import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendLedger, canonicalProjectTarget, harnessFingerprint, type LedgerRecord, projectFingerprint, proposalFingerprint, readLedger } from "../src/ledger.js";
import skillObserver from "../src/skill-observer.js";
import { buildDigest } from "../src/digest.js";
import { createProvenanceResolver, skillHash } from "../src/provenance.js";
import { AMENDMENT_DELIVERY_TYPE } from "../src/reminder.js";
import type {
  AskDetails,
  CommandHandler,
  CustomMessage,
  ExtensionAPI,
  ExtensionContext,
  Schema,
  SendMessageOptions,
  SessionEntry,
  ToolArguments,
  ToolDefinition,
  ToolResult,
  ToolResultDetails,
} from "../src/omp.js";
import type { PatternDraft } from "../src/replay.js";
import * as amendments from "../src/amendments.js";
import { type Gate, HOOK_CHECK_PATH, HOOKS_AND_COMPANION_PATH, INSTRUCTIONS_PATH, parseFragments, type ToolResultCondition, toolResultGuidance } from "../src/payload.js";
import { entries as fx } from "./fixtures.js";
import { groundRepairs } from "./grounding.js";
import { CE_PLUGIN, copySkillEntry, installPlugin, makeSkillHome, uninstallPlugin, writeSkill } from "./skill-home.js";

/** The environment `omp` runs under, taken before tests point HOME at a temp skill home; `test/setup.ts` already pointed the agent dir at a temp one. */
const ompEnv = { ...process.env };
const ompAvailable = process.env.SKILL_OBSERVER_NATIVE_TESTS === "1" && spawnSync("omp", ["--version"], { env: ompEnv }).status === 0;

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Stands in for `pi.zod`: OMP validates parameters, so the fake host keeps only object shapes and descriptions, which reach the model. */
type FakeSchema = Schema & { shape?: Record<string, Schema>; description?: string };
const fakeSchema = (fields: Omit<FakeSchema, "optional" | "describe"> = {}): FakeSchema => ({
  ...fields,
  optional: () => fakeSchema(fields),
  describe: (description) => fakeSchema({ ...fields, description }),
});
const schema = fakeSchema();
const zod: ExtensionAPI["zod"] = {
  object: (shape) => fakeSchema({ shape }),
  array: () => schema,
  string: () => schema,
  number: () => schema,
  enum: () => schema,
  union: () => schema,
  record: () => schema,
  unknown: () => schema,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/**
 * Loads the extension against a fake OMP host whose home directory is a temp
 * skill home, and records what it shows and sends. The host has an explicit,
 * available judge role unless `judge` is false. Given another host's
 * `skillHome`, it is a second session of the same agent dir and project.
 */
function loadExtension(options: { hasUI?: boolean; agentKind?: "main" | "sub" | "unknown"; judge?: boolean; skillHome?: ReturnType<typeof makeSkillHome>; allTools?: ExtensionAPI["getAllTools"]; systemPrompt?: string[] } = {}) {
  const skillHome = options.skillHome ?? makeSkillHome();
  mkdirSync(skillHome.roots.cwd, { recursive: true });
  vi.stubEnv("HOME", skillHome.home);
  vi.stubEnv("PI_CODING_AGENT_DIR", `${skillHome.home}/.omp/agent`);

  const handlers: Record<string, Handler[]> = {};
  const commands: Record<string, CommandHandler> = {};
  const tools: Record<string, ToolDefinition<unknown, unknown>> = {};
  const sent: Array<{ message: CustomMessage; options?: SendMessageOptions }> = [];
  let activeTools = ["read", "ask"];
  const pi: ExtensionAPI = {
    on: (event, handler) => {
      handlers[event] ??= [];
      handlers[event].push(handler as Handler);
    },
    registerCommand: (name, command) => {
      commands[name] = command.handler;
    },
    registerTool: (tool) => {
      tools[tool.name] = tool as ToolDefinition<unknown, unknown>;
      if (!tool.defaultInactive) activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: options.allTools ?? (() => [
      ...["read", "ask", "bash", "write", "edit", "eval", "task"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
      ...Object.keys(tools).map((name) => ({ name, sourceInfo: { source: "extension", path: "/extensions/skill-observer/src/skill-observer.ts" } })),
    ]),
    setActiveTools: async (names) => {
      activeTools = [...names];
    },
    sendMessage: (message, sendOptions) => {
      sent.push({ message, options: sendOptions });
    },
    appendEntry: (customType, data) => {
      const failure = appendFailures.shift();
      if (failure) throw failure;
      branch = [...branch, { type: "custom", id: `custom-${branch.length}`, customType, data: data as SessionEntry["data"] }];
    },
    zod,
    pi: {
      settings: { getModelRole: (role) => role === "judge" && options.judge !== false ? "fixture/explicit-judge" : undefined },
      resolveScopedModels: async () => [{ model: { provider: "fixture", id: "explicit-judge" } }],
    },
  };
  skillObserver(pi);

  let branch: SessionEntry[] = [];
  const appendFailures: Error[] = [];
  let calls = 0;
  const statusCalls: Array<[string, string | undefined]> = [];
  const status = new Map<string, string>();
  const notices: string[] = [];
  const noticeEvents: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const ctx: ExtensionContext = {
    hasUI: options.hasUI ?? true,
    agent: options.agentKind === "unknown" ? undefined : { kind: options.agentKind ?? "main" },
    cwd: skillHome.roots.cwd,
    sessionManager: { getBranch: () => branch, getSessionId: () => "fixture-session" },
    ...(options.systemPrompt && { getSystemPrompt: () => options.systemPrompt! }),
    modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "explicit-judge" }] },
    ui: {
      setStatus: (key, text) => {
        statusCalls.push([key, text]);
        if (text === undefined) status.delete(key);
        else status.set(key, text);
      },
      notify: (message, type) => {
        notices.push(message);
        noticeEvents.push({ message, type });
      },
    },
  };

  const emit = async (event: string) => {
    for (const handler of handlers[event] ?? []) await handler({ type: event }, ctx);
  };

  let startResults: unknown[] = [];

  /** Runs `before_agent_start` for a submitted prompt and returns the messages the handlers add to it. */
  const startAgent = async (prompt: string, event: { systemPrompt?: string[]; reason?: "prompt" | "revive" } = {}): Promise<CustomMessage[]> => {
    const added: CustomMessage[] = [];
    startResults = [];
    for (const handler of handlers.before_agent_start ?? []) {
      const result = (await handler({ type: "before_agent_start", prompt, systemPrompt: [], ...event }, ctx)) as
        | { message?: CustomMessage }
        | undefined;
      startResults.push(result);
      if (result?.message) added.push(result.message);
    }
    return added;
  };

  /** Saves a message `before_agent_start` returned on the branch and fires its `message_end`, as OMP does once it commits a preparation. */
  const commitMessage = async (message: CustomMessage) => {
    branch = [...branch, { type: "custom_message", id: `message-${branch.length}`, customType: message.customType, content: message.content, details: message.details }];
    await emit("message_end");
  };

  /** Saves the prompt's user message on the branch and fires its `message_end`, as OMP does once it commits a preparation. */
  const commitPrompt = async (prompt: string) => {
    branch = [...branch, { type: "message", id: `user-${branch.length}`, message: { role: "user", content: prompt } }];
    await emit("message_end");
  };

  /** Runs `tool_result` as OMP does: each handler sees the result as earlier ones left it, and their additional context is joined. */
  const toolResult = async (event: {
    toolName: string; toolCallId: string; content: Array<{ type: string; text?: string }>;
    details?: unknown; isError?: boolean; input?: Record<string, unknown>;
  }) => {
    const current: typeof event & { additionalContext?: string } = { ...event };
    const contexts: string[] = [];
    for (const handler of handlers.tool_result ?? []) {
      const patch = await handler({ type: "tool_result", ...current }, ctx);
      if (!patch || typeof patch !== "object") continue;
      if ("content" in patch && Array.isArray(patch.content)) current.content = patch.content;
      if ("details" in patch) current.details = patch.details;
      if ("isError" in patch && typeof patch.isError === "boolean") current.isError = patch.isError;
      if ("additionalContext" in patch && typeof patch.additionalContext === "string") contexts.push(patch.additionalContext);
    }
    if (contexts.length > 0) current.additionalContext = contexts.join("\n\n");
    return current;
  };

  const callTool = async (name: string, params: unknown, signal?: AbortSignal): Promise<ToolResult<unknown>> => {
    const tool = tools[name];
    if (!tool) throw new Error(`${name} is not registered`);
    const review = params as { action?: unknown; candidates?: unknown } | undefined;
    if (name === "observer_review" && review?.action === "prepare" && Array.isArray(review.candidates)) {
      const inspect = async (skill: string) => {
        const result = await callTool("observer_review", { action: "inspect", skill });
        return { id: String(branch.at(-1)?.message?.toolCallId), isError: result.isError, details: result.details };
      };
      params = { ...review, candidates: await groundRepairs(review.candidates, inspect) };
    }
    const id = `${name}-call-${++calls}`;
    const result = await tool.execute(id, params, signal, undefined, ctx);
    branch = [...branch,
      { type: "message", id: `assistant-${id}`, message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: structuredClone(params) as ToolArguments }] } },
      { type: "message", id: `result-${id}`, message: { role: "toolResult", toolCallId: id, toolName: name, content: result.content,
        details: structuredClone(result.details) as ToolResultDetails, isError: result.isError ?? false } },
    ];
    return result;
  };

  return {
    getBranch: () => branch,
    toolCall: async (toolName: string, input: Record<string, unknown>, toolCallId: string) => {
      for (const handler of handlers.tool_call ?? []) {
        const result = await handler({ type: "tool_call", toolName, input, toolCallId }, ctx);
        if (result) return result;
      }
    },
    setCwd: (cwd: string) => { ctx.cwd = cwd; },
    setBranch: (entries: SessionEntry[]) => {
      branch = skillHome.relocate(entries);
    },
    endTurn: () => emit("agent_end"),
    on: pi.on,
    failAppend: (error: Error) => { appendFailures.push(error); },
    emit,
    startAgent,
    startResults: () => startResults,
    commitMessage,
    commitPrompt,
    toolResult,
    runCommand: async (name: string, args = "") => {
      const command = commands[name];
      if (!command) throw new Error(`/${name} is not registered`);
      await command(args, ctx);
    },
    /**
     * Runs a registered tool under a fresh call ID, then saves its native call and result on the branch, as OMP does once the call completes.
     * A Prepare's skill-text repair drafts are grounded first, as {@link groundRepairs} describes.
     */
    callTool,
    ledgerFile: join(skillHome.home, ".omp/agent/skill-observer/ledger.jsonl"),
    observationsFile: join(skillHome.home, ".omp/agent/skill-observer/observations.jsonl"),
    rulesDir: join(skillHome.home, ".omp/agent/rules"),
    amendmentsDir: join(skillHome.home, ".omp/agent/skill-observer/amendments"),
    activeTools: () => activeTools,
    tools,
    statusTexts: () => [...status.values()],
    statusCalls,
    notices,
    noticeEvents,
    sent,
    skillHome,
  };
}

it.skipIf(!ompAvailable)("loads native schemas and rejects unknown outcomes", () => {
  const run = spawnSync("omp", [
    "--no-extensions", "--no-session", "--no-title", "--mode", "rpc",
    "--model", "openai-codex/gpt-6-luna:low",
    "--extension", join(import.meta.dirname, "native-schema.ts"),
  ], { env: ompEnv, encoding: "utf8", input: "", timeout: 20_000 });
  expect(run.error).toBeUndefined();
  expect(run.stderr).not.toContain("Failed to load extension");
  expect(run.stdout).toContain("NATIVE_OBSERVER_SCHEMAS_OK");
});

describe("status hint", () => {
  it.each([
    ["a steering message", "steeringUserMessage"],
    ["a rule-violation interrupt", "ruleViolationInterrupt"],
    ["an ask answer with custom input", "askSingleCustomInput"],
    ["an ask answer other than the recommended one", "askSingleOffRecommended"],
  ] as const)("points at /observe after a turn with %s", async (_label, fixture) => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx[fixture]]);
    await host.endTurn();
    expect(host.statusTexts()).toEqual([expect.stringContaining("/observe")]);
  });

  it("points at /observe after a turn with no skill loaded and three or more tool calls", async () => {
    const host = loadExtension();
    host.setBranch(fx.skillLessTurn);
    await host.endTurn();
    expect(host.statusTexts()).toEqual([expect.stringContaining("/observe")]);
  });

  it("stays off when the session has only skill loads, tool errors, harness messages and a cancelled ask", async () => {
    const host = loadExtension();
    host.setBranch([
      ...fx.plainUserMessage,
      ...fx.harnessNoise,
      ...fx.askCancelled,
      ...fx.skillTurnToolError,
    ]);
    await host.endTurn();
    expect(host.statusTexts()).toEqual([]);
  });

  it("clears when the session switches to one without signals", async () => {
    const host = loadExtension();
    host.setBranch(fx.steeringUserMessage);
    await host.endTurn();
    host.setBranch(fx.plainUserMessage);
    await host.emit("session_switch");
    expect(host.statusTexts()).toEqual([]);
  });

  it("stays off when the session's only amendment activity is an on-read amendment delivered after a read", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    host.setBranch(fx.plainUserMessage);
    expect((await readSkill(host, "skill://tdd")).additionalContext).toContain("Body of tdd-afk-seams.");
    await host.endTurn();
    expect(host.statusTexts()).toEqual([]);
  });

  it.skipIf(!ompAvailable)("points at /observe when a pattern amendment fires", async () => {
    const host = loadExtension();
    await amend(host, "tdd", {
      name: "use-ask-tool-for-questions",
      body: "Ask with the ask tool.",
      pattern: "\\?\\s*$",
      matches: ["Shall I go on?"],
      spares: ["I went on."],
    });
    host.setBranch([...fx.plainUserMessage, ...fx.ruleViolationInterrupt]);
    await host.endTurn();
    expect(host.statusTexts()).toEqual(["1 skill correction · /observe"]);
  }, 30_000);

  it("points at /observe when a marked rule watching another tool's calls fires", async () => {
    const host = loadExtension();
    mkdirSync(host.rulesDir, { recursive: true });
    writeFileSync(
      join(host.rulesDir, "use-ask-tool-for-questions.md"),
      '---\ncondition: "\\\\?\\\\s*$"\nscope: "tool:bash"\namends: "tdd"\ngeneratedBy: "skill-observer"\n---\n\nAsk with the ask tool.\n',
    );
    host.setBranch([...fx.plainUserMessage, ...fx.ruleViolationInterrupt]);
    await host.endTurn();
    expect(host.statusTexts()).toEqual(["1 skill correction · /observe"]);
  });

  it.each([
    ["without UI", { hasUI: false }],
    ["in a subagent session", { agentKind: "sub" }],
  ] as const)("shows nothing %s", async (_label, options) => {
    const host = loadExtension(options);
    host.setBranch(fx.steeringUserMessage);
    await host.endTurn();
    await host.emit("session_start");
    expect(host.statusCalls).toEqual([]);
  });
});

describe("/observe", () => {
  it("says there is nothing to observe and starts no turn when the session has no signals", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.harnessNoise.filter((entry) => entry.customType !== "skill-prompt"), ...fx.askCancelled]);
    await host.runCommand("observe");
    expect(host.sent).toEqual([]);
    expect(host.notices).toEqual([expect.stringMatching(/no skill signals/i)]);
  });

  it("starts one turn carrying current evidence and skill provenance", async () => {
    const host = loadExtension();
    host.setBranch([
      ...fx.plainUserMessage,
      ...fx.skillPromptManaged,
      ...fx.skillUrlRead,
      ...fx.steeringUserMessage,
    ]);
    await host.runCommand("observe");

    expect(host.sent).toHaveLength(1);
    const [{ message, options }] = host.sent as [(typeof host.sent)[number]];
    expect(options).toMatchObject({ triggerTurn: true });
    const content = String(message.content);
    expect(content).toContain(textOf(fx.steeringUserMessage));
    expect(content).toMatch(/`tdd`: upstream/);
    expect(content).toMatch(/`implement-spec`: managed/);
  });

  it("keeps observer tools inactive until a pass starts, then adds them", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage]);
    expect(host.activeTools()).toEqual(["read", "ask", "observe"]);
    await host.runCommand("observe");
    expect(host.activeTools()).toEqual(["read", "ask", "observe", "observer_resolve", "observer_check", "observer_review"]);
  });

  it.each([
    ["a restored branch still inside a pass", [], true],
    ["a branch whose pass a later prompt ended", fx.plainUserMessage, false],
  ] as const)("re-adds observer tools on session start for %s", async (_label, after, active) => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, { type: "custom_message", customType: "skill-observer", content: "Observation pass" }, ...after]);
    await host.emit("session_start");
    expect(host.activeTools().includes("observer_resolve")).toBe(active);
  });

  it("runs a pass for a session whose only signal is a loaded skill", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.skillUrlRead]);
    await host.runCommand("observe");
    expect(host.sent).toHaveLength(1);
  });

  /** The line of the message's Skills loaded list that names `skill`. */
  const skillLine = (content: string, skill: string) =>
    content.split("\n").find((line) => line.startsWith(`- \`${skill}\`:`)) ?? "";

  it("names the on-read amendments delivered by reading a skill on that skill's line", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    splitAmendment(host, "tdd", "tdd-red-is-an-assertion-diff");
    host.setBranch(fx.plainUserMessage);
    await readSkill(host, "skill://tdd");
    await host.runCommand("observe");
    const content = String(host.sent[0]?.message.content);
    expect(skillLine(content, "tdd")).toMatch(/amendments delivered: `tdd-afk-seams`, `tdd-red-is-an-assertion-diff`/);
    expect(content).not.toMatch(/Rule violation/);
  });

  it("names the on-read amendments delivered with a /skill: prompt on that skill's line", async () => {
    const host = loadExtension();
    splitAmendment(host, "domain-modeling", "dm-define-terms");
    splitAmendment(host, "domain-modeling", "dm-record-adrs");
    const [reminder] = await host.startAgent(String(fx.skillPromptUpstream[0]?.content));
    const saved: SessionEntry = { type: "custom_message", id: "reminder-1", ...reminder };
    host.setBranch([...fx.plainUserMessage, ...fx.skillPromptUpstream, saved]);
    await host.runCommand("observe");
    expect(skillLine(String(host.sent[0]?.message.content), "domain-modeling")).toMatch(
      /amendments delivered: `dm-define-terms`, `dm-record-adrs`/,
    );
  });

  it("still names an amendment a /skill: reminder delivered after its rule was deleted", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.skillPromptUpstream, ...fx.amendmentReminder]);
    await host.runCommand("observe");
    expect(skillLine(String(host.sent[0]?.message.content), "domain-modeling")).toMatch(/amendments delivered: `dm-define-terms`/);
  });

  it.each([
    [
      "a stale delete",
      async (host: ReturnType<typeof loadExtension>) => {
        setLockHash(host, "tdd", "0000000000000000000000000000000000000001");
        return resolveApproved(host, { stale: [{ rule: "tdd-afk-seams", select: "Delete" }, { rule: "tdd-red-is-an-assertion-diff", select: "Delete" }] });
      },
    ],
    [
      "a withdrawal",
      (host: ReturnType<typeof loadExtension>) =>
        resolveApproved(host, { withdrawals: ledgerRecords(host.ledgerFile).map((record) => ({ fingerprint: record.fingerprint, gist: String(record.gist) })) }),
    ],
  ])("keeps the on-read amendments this session delivered as delivered after %s deleted their rules", async (_label, deleteRules) => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    splitAmendment(host, "tdd", "tdd-red-is-an-assertion-diff");
    host.setBranch(fx.plainUserMessage);
    await readSkill(host, "skill://tdd");

    const result = await deleteRules(host);
    await host.endTurn();

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(host.amendmentsDir, "tdd-afk-seams.md"))).toBe(false);
    expect(host.statusTexts()).toEqual([]);
    await host.runCommand("observe");
    const content = String(host.sent[0]?.message.content);
    expect(skillLine(content, "tdd")).toMatch(/amendments delivered: `tdd-afk-seams`, `tdd-red-is-an-assertion-diff`/);
    expect(content).not.toMatch(/Rule violation/);
  });

  it("still counts the earlier firing of a pattern amendment a stale delete removed", async () => {
    const host = loadExtension();
    mkdirSync(host.rulesDir, { recursive: true });
    writeFileSync(
      join(host.rulesDir, "use-ask-tool-for-questions.md"),
      `---\ncondition: "\\\\?\\\\s*$"\nscope: "text"\namends: "tdd"\nskillHash: "${currentSkillHash(host, "tdd")}"\nfingerprint: "0123456789ab"\ngeneratedBy: "skill-observer"\n---\n\nAsk with the ask tool.\n`,
    );
    changeSkillFile(host, "tdd");
    host.setBranch([...fx.plainUserMessage, ...fx.ruleViolationInterrupt]);

    await resolveApproved(host, { stale: [{ rule: "use-ask-tool-for-questions", select: "Delete" }] });
    await host.endTurn();

    expect(existsSync(join(host.rulesDir, "use-ask-tool-for-questions.md"))).toBe(false);
    expect(host.statusTexts()).toEqual(["1 skill correction · /observe"]);
  });

  it("puts the text typed after /observe into the pass as a user note ahead of the digest", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage]);
    await host.runCommand("observe", "  tdd should say to run the one failing test first\nnot the whole suite  ");
    const content = String(host.sent[0]?.message.content);
    const note = content.indexOf("## User note\n\ntdd should say to run the one failing test first\nnot the whole suite\n");
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(content.indexOf("## Session digest"));
  });

  it("runs a pass for a note alone, in a session with no signals", async () => {
    const host = loadExtension();
    host.setBranch(fx.plainUserMessage);
    await host.runCommand("observe", "jj-vcs keeps suggesting git commands");
    expect(host.sent).toHaveLength(1);
    expect(String(host.sent[0]?.message.content)).toContain("jj-vcs keeps suggesting git commands");
  });

  it("treats a blank note as no note: a session without signals still has nothing to observe", async () => {
    const host = loadExtension();
    host.setBranch(fx.plainUserMessage);
    await host.runCommand("observe", "  \n ");
    expect(host.sent).toEqual([]);
    expect(host.notices).toEqual([expect.stringMatching(/no skill signals/i)]);
  });

  it.each([
    ["without UI", { hasUI: false }],
    ["in a subagent session", { agentKind: "sub" }],
  ] as const)("does nothing %s", async (_label, options) => {
    const host = loadExtension(options);
    host.setBranch(fx.steeringUserMessage);
    await host.runCommand("observe");
    expect(host.sent).toEqual([]);
    expect(host.notices).toEqual([]);
  });
});

describe("retrospective availability", () => {
  const RETRO_BODY = "Look for missing checks, unclear docs and slow tools.";
  const retroBranches = [
    ["a workflow outline", fx.skillLessTurn, true],
    ["a tool error", fx.skillTurnToolError, true],
    ["only a correction", [...fx.plainUserMessage, ...fx.steeringUserMessage], false],
  ] as const;

  it.each(retroBranches)("with %s, discloses an unavailable retro reference only under the project gate, keeping normal observation usable", async (_label, branch, projectGate) => {
    const host = loadExtension();
    host.setBranch([...branch]);
    await host.runCommand("observe");
    const warned = host.noticeEvents.some((notice) => notice.type === "warning" && /retro.*unavailable/i.test(notice.message));
    expect(warned).toBe(projectGate);
    expect(String(host.sent[0]?.message.content).includes("## Retrospective reference")).toBe(projectGate);
    expect(host.activeTools()).toContain("observer_resolve");
  });

  it.each(retroBranches)("with %s, inlines the installed retro body without its frontmatter only under the project gate", async (_label, branch, projectGate) => {
    const host = loadExtension();
    mkdirSync(join(host.skillHome.roots.skillsDir, "retro"), { recursive: true });
    writeFileSync(join(host.skillHome.roots.skillsDir, "retro", "SKILL.md"), `---\nname: retro\ndescription: Run a retrospective.\ndisable-model-invocation: true\n---\n\n${RETRO_BODY}\n`);
    host.setBranch([...branch]);
    await host.runCommand("observe");
    const content = String(host.sent[0]?.message.content);
    expect(content.includes(RETRO_BODY)).toBe(projectGate);
    expect(content).not.toContain("description: Run a retrospective.");
    expect(host.noticeEvents.filter((notice) => notice.type === "warning")).toEqual([]);
    expect(host.sent).toHaveLength(1);
  });

  it("keeps quiet session lifecycle events free of retrospective activity", async () => {
    const host = loadExtension();
    host.setBranch(fx.plainUserMessage);
    for (const event of ["agent_end", "session_start", "session_switch", "session_branch", "session_tree"]) {
      await host.emit(event);
    }
    expect(host.sent).toEqual([]);
    expect(host.noticeEvents).toEqual([]);
    expect(host.activeTools()).not.toContain("observer_resolve");
    expect(existsSync(host.ledgerFile)).toBe(false);
  });
});

describe("supplier label on tool errors", () => {
  const EXTENSION_TOOL = { name: "deploy", sourceInfo: { source: "extension", path: "/extensions/deployer/index.ts" } };
  const MCP_TOOL = { name: "mcp__docs_search", sourceInfo: { source: "mcp", path: "<mcp:mcp__docs_search>" }, mcpServerName: "docs" };
  const SDK_TOOL = { name: "embedded", sourceInfo: { source: "sdk", path: "<sdk:embedded>" } };
  const BUILTIN_BASH = { name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } };
  const ALL_TOOLS = [EXTENSION_TOOL, MCP_TOOL, SDK_TOOL, BUILTIN_BASH];
  const userStart: SessionEntry = { type: "message", id: "user-start", message: { role: "user", content: "Do the work" } };

  /** Runs a failing call through the tool hooks, as OMP does for a call nested in `eval`, then starts a pass and returns its payload. */
  const payloadAfterFailure = async (host: ReturnType<typeof loadExtension>, toolName: string) => {
    host.setBranch([userStart]);
    await host.toolCall(toolName, { target: "staging" }, "failing");
    await host.toolResult({ toolName, toolCallId: "failing", input: { target: "staging" }, content: [{ type: "text", text: "It broke" }], isError: true });
    await host.runCommand("observe");
    return String(host.sent[0]?.message.content);
  };
  const errorLine = (payload: string) => payload.split("\n").find((line) => line.includes('Tool error in')) ?? "";

  it.each([
    ["an extension tool, by its file path", EXTENSION_TOOL.name, "Supplier: `/extensions/deployer/index.ts`."],
    ["an MCP tool, by its server name", MCP_TOOL.name, "Supplier: MCP server `docs`."],
    ["an SDK tool, by the host's placeholder name", SDK_TOOL.name, "Supplier: `<sdk:embedded>`."],
  ])("names the supplier of %s in the next /observe payload", async (_, toolName, label) => {
    const host = loadExtension({ allTools: () => ALL_TOOLS });
    const line = errorLine(await payloadAfterFailure(host, toolName));
    expect(line).toContain(`Tool error in \`${toolName}\``);
    expect(line).toContain(label);
  });

  it("adds no supplier text to a failing built-in tool", async () => {
    const host = loadExtension({ allTools: () => ALL_TOOLS });
    const line = errorLine(await payloadAfterFailure(host, "bash"));
    expect(line).toContain("Tool error in `bash`");
    expect(line).not.toContain("Supplier");
  });

  it.each([
    ["the host lookup throws", () => { throw new Error("registry unavailable"); }],
    ["the host lists no such tool", () => [BUILTIN_BASH]],
  ])("says the supplier was not recorded, without failing the hook, when %s", async (_, allTools) => {
    const host = loadExtension({ allTools });
    const line = errorLine(await payloadAfterFailure(host, EXTENSION_TOOL.name));
    expect(line).toContain("Tool error in `deploy`");
    expect(line).toContain("Supplier not recorded.");
  });

  it.each([
    ["a result copied before suppliers were recorded", [
      { type: "custom", id: "old-call", customType: "skill-observer-tool-call", data: { toolCallId: "old", toolName: "deploy", input: { target: "staging" } } },
      { type: "custom", id: "old-result", customType: "skill-observer-tool-result", data: { toolCallId: "old", toolName: "deploy", input: { target: "staging" }, content: [{ type: "text", text: "It broke" }], isError: true } },
    ]],
    ["a result the extension did not copy", [
      { type: "message", id: "native-call", message: { role: "assistant", content: [{ type: "toolCall", id: "native", name: "deploy", arguments: { target: "staging" } }] } },
      { type: "message", id: "native-result", message: { role: "toolResult", toolCallId: "native", toolName: "deploy", content: "It broke", isError: true } },
    ]],
  ])("says the supplier was not recorded for %s", async (_, entries) => {
    const host = loadExtension({ allTools: () => ALL_TOOLS });
    host.setBranch([userStart, ...entries as SessionEntry[]]);
    await host.runCommand("observe");
    const line = errorLine(String(host.sent[0]?.message.content));
    expect(line).toContain("Tool error in `deploy`");
    expect(line).toContain("Supplier not recorded.");
  });

  it("labels a device dispatch with its inner tool's supplier, not the dispatching write's", async () => {
    const host = loadExtension({ allTools: () => [...ALL_TOOLS, { name: "write", sourceInfo: { source: "builtin", path: "<builtin:write>" } }] });
    const outer = { path: "xd://mcp__docs_search", content: '{"query":"zod"}' };
    host.setBranch([userStart,
      { type: "message", id: "dispatching", message: { role: "assistant", content: [{ type: "toolCall", id: "dispatch", name: "write", arguments: outer }] } }]);
    await host.toolCall("write", outer, "dispatch");
    await host.toolCall(MCP_TOOL.name, { query: "zod" }, "dispatch");
    // The inner result fires before the outer one, as observed in OMP 18.20.2.
    await host.toolResult({ toolName: MCP_TOOL.name, toolCallId: "dispatch", input: { query: "zod" }, content: [{ type: "text", text: "Server down" }], isError: true });
    await host.toolResult({ toolName: "write", toolCallId: "dispatch", input: outer, content: [{ type: "text", text: "Server down" }], isError: true });
    host.getBranch().push({ type: "message", id: "dispatched", message: { role: "toolResult", toolCallId: "dispatch", toolName: "write", content: "Server down", isError: true } });
    await host.runCommand("observe");
    const line = errorLine(String(host.sent[0]?.message.content));
    expect(line).toContain(`Tool error in \`${MCP_TOOL.name}\``);
    expect(line).toContain("Supplier: MCP server `docs`.");
  });
});

describe("observation publication receipt metadata", () => {
  it("captures nested skill reads and errors outside observation without interpreting eval code", async () => {
    const host = loadExtension();
    host.setBranch([{ type: "message", id: "user-start", message: { role: "user", content: "Do the work" } }]);
    await host.toolCall("read", { path: "skill://tdd" }, "nested-read");
    await host.toolResult({ toolName: "read", toolCallId: "nested-read", input: { path: "skill://tdd" }, content: [{ type: "text", text: "Skill instructions" }], isError: false });
    await host.toolCall("bash", { command: "check" }, "nested-check");
    await host.toolResult({ toolName: "bash", toolCallId: "nested-check", input: { command: "check" }, content: [{ type: "text", text: "Check failed" }], isError: true });
    const digest = buildDigest(host.getBranch(), { provenance: createProvenanceResolver(host.skillHome.roots) });
    expect(digest.skills.map(skill => skill.name)).toContain("tdd");
    expect(digest.signals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tool-error", error: expect.stringContaining("Check failed") })]));
  });

  // OMP 18.12.6 persists the assistant message after the tool hooks run; the digest must not depend on that order.
  it.each(["after", "before"])("attributes a device dispatch to its inner tool once when the native call is persisted %s the hooks", async (order) => {
    const host = loadExtension();
    const outer = { path: "xd://read", content: '{"path":"skill://tdd"}' };
    const native = { type: "message", id: "dispatching", message: { role: "assistant", content: [{ type: "toolCall", id: "dispatch", name: "write", arguments: outer }] } };
    host.setBranch([
      { type: "message", id: "user-start", message: { role: "user", content: "Do the work" } },
      ...(order === "before" ? [native] : []),
    ]);
    await host.toolCall("write", outer, "dispatch");
    await host.toolCall("read", { path: "skill://tdd" }, "dispatch");
    await host.toolResult({ toolName: "read", toolCallId: "dispatch", input: { path: "skill://tdd" }, content: [{ type: "text", text: "Skill instructions" }], isError: false });
    await host.toolResult({ toolName: "write", toolCallId: "dispatch", input: outer, content: [{ type: "text", text: "Skill instructions" }], isError: false });
    if (order === "after") host.getBranch().push(native);
    host.getBranch().push({ type: "message", id: "dispatched", message: { role: "toolResult", toolCallId: "dispatch", toolName: "write", content: "Skill instructions" } });
    const digest = buildDigest(host.getBranch(), { provenance: createProvenanceResolver(host.skillHome.roots) });
    expect(digest.skills.map(skill => skill.name)).toEqual(["tdd"]);
    expect(digest.toolExercises?.map(exercise => exercise.tool)).toEqual(["read"]);
  });

  it("lets a pass resolve a real project publication using IDs visible in production-hook tool results", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const file = join(root, "package.json");
    const content = '{"scripts":{"check":"node --check app.js"}}\n';
    writeFileSync(file, content);
    const branch = [
      { type: "custom_message", customType: "skill-observer", content: "Observation pass" },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call_write|fc_opaque_write", name: "write", arguments: { path: file, content } }] } },
      { type: "message", message: { role: "toolResult", toolName: "write", toolCallId: "call_write|fc_opaque_write", isError: false } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call_bash|fc_opaque_check", name: "bash", arguments: { command: "node --check app.js", cwd: root } }] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "call_bash|fc_opaque_check", isError: false, details: { timeoutSeconds: 30, wallTimeMs: 5 } } },
    ];
    host.setBranch(JSON.parse(JSON.stringify(branch)));
    const original = [{ type: "text", text: "[project/file#58EB]\nObserved tool output." }, { type: "image" }];
    const write = await host.toolResult({ toolName: "write", toolCallId: "call_write|fc_opaque_write", content: original, isError: false });
    const check = await host.toolResult({ toolName: "bash", toolCallId: "call_bash|fc_opaque_check", content: original, details: { timeoutSeconds: 30, wallTimeMs: 5 }, isError: false });
    const visibleId = (blocks: Array<{ type: string; text?: string }>) => {
      for (const block of blocks) {
        if (block.type !== "text" || !block.text) continue;
        let metadata: unknown;
        try { metadata = JSON.parse(block.text); } catch { continue; }
        if (metadata && typeof metadata === "object" && "observerToolCallId" in metadata && typeof metadata.observerToolCallId === "string") {
          return metadata.observerToolCallId;
        }
      }
      return undefined;
    };
    const result = await host.callTool("observer_resolve", { outcomes: [{
      kind: "project", target: { scope: "project", root, path: "package.json", mechanism: "Wire check" },
      gist: "Wire the existing check", outcome: "applied",
      publication: { writeToolCallId: visibleId(write.content), checkToolCallIds: [visibleId(check.content)], afterHash: createHash("sha256").update(content).digest("hex") },
    }] });
    expect(result.details).toMatchObject({ records: [{ kind: "project", outcome: "applied" }], failures: [] });
    expect(write.content.slice(0, original.length)).toEqual(original);
    expect(check.content.slice(0, original.length)).toEqual(original);
    expect(check.details).toEqual({ timeoutSeconds: 30, wallTimeMs: 5 });
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("accepts native receipts when hooks fire before assistant/result persistence", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const content = "{}\n";
    writeFileSync(join(root, "package.json"), content);
    host.setBranch([{ type: "custom_message", customType: "skill-observer", content: "Observation pass" }]);
    for (const [name, id, input, details] of [
      ["write", "native-write", { path: "package.json", content }, {}],
      ["bash", "native-check", { command: "node --check app.js", cwd: root }, { exitCode: 0 }],
    ] as const) {
      await host.toolCall(name, input, id);
      host.setBranch([...host.getBranch(), { type: "message", message: { role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: input }] } }]);
      await host.toolResult({ toolName: name, toolCallId: id, input, content: [], isError: false, details });
      host.setBranch([...host.getBranch(), { type: "message", message: { role: "toolResult", toolName: name,
        toolCallId: id, isError: false, details } }]);
    }
    const result = await host.callTool("observer_resolve", { outcomes: [{
      kind: "project", target: { scope: "project", root, path: "package.json", mechanism: "Parse written JSON" },
      gist: "Parse written JSON", outcome: "applied",
      publication: { writeToolCallId: "native-write", checkToolCallIds: ["native-check"], afterHash: createHash("sha256").update(content).digest("hex") },
    }] });
    expect(result.details).toMatchObject({ records: [{ kind: "project", outcome: "applied" }], failures: [] });
  });
});

/** A Prepare/Select entry as `observer_review` returns it. */
interface ReviewEntry {
  reference: { reviewToolCallId: string; candidateId: string; contentHash: string };
  proposal: {
    candidateId: string; fingerprint: string; skill: string; kind: string; gist: string; priority: string;
    evidence: Array<Record<string, unknown>>; preview: string; change: { operation: string } & Record<string, unknown>;
    alternatives?: Array<{ change: { operation: string } & Record<string, unknown>; preview: string }>;
  };
}

const reviewEntries = (result: ToolResult<unknown>, list: "eligible" | "selected" | "deferred" = "eligible") =>
  (result.details as Record<typeof list, ReviewEntry[]>)[list];

/** Starts an observation pass, then runs the registered Prepare, then Select with every reference that Prepare returned. */
async function prepareAndSelect(host: ReturnType<typeof loadExtension>, candidates: unknown[], select: Record<string, unknown> = {}) {
  startPass(host);
  const prepared = await host.callTool("observer_review", { action: "prepare", candidates });
  expect(prepared.isError).toBeFalsy();
  return host.callTool("observer_review", { action: "select", proposals: reviewEntries(prepared).map((entry) => entry.reference), ...select });
}

const referencesDir = (host: ReturnType<typeof loadExtension>) => join(host.skillHome.home, ".omp/agent/skill-observer/references");
/** Every file this extension owns under the agent dir, with its text, so a read-only review can be shown to change none. */
const ownedFiles = (host: ReturnType<typeof loadExtension>) => Object.fromEntries([host.rulesDir, host.amendmentsDir, referencesDir(host)]
  .filter((dir) => existsSync(dir))
  .flatMap((dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()))
  .map((entry) => join(entry.parentPath, entry.name))
  .map((path) => [path, readFileSync(path, "utf8")]));
/** Every byte observer_resolve could change: the rule and reference files it owns, and the ledger. */
const observerBytes = (host: ReturnType<typeof loadExtension>) =>
  ({ ...ownedFiles(host), ledger: existsSync(host.ledgerFile) ? readFileSync(host.ledgerFile, "utf8") : null });
const resolve = (host: ReturnType<typeof loadExtension>, outcomes: unknown[]) => host.callTool("observer_resolve", { outcomes });
const failures = (result: ToolResult<unknown>) => (result.details as { failures: string[] }).failures;

const lastCallId = (host: ReturnType<typeof loadExtension>) => String(host.getBranch().at(-1)?.message?.toolCallId);

/** Saves the hidden message `/observe` sends, which starts an observation pass. */
const startPass = (host: ReturnType<typeof loadExtension>) =>
  host.getBranch().push({ type: "custom_message", id: `observe-${host.getBranch().length}`, customType: "skill-observer", content: "Observation pass." });

/**
 * The user's answer to one selected proposal, as the host reports it: the chosen option's label, `""` for none, or `Other: <text>` for custom input;
 * `{ option, note }` for an option chosen with the note the user attached to it.
 */
type AnswerUser = (proposal: ReviewEntry["proposal"]) => string | { option: string; note: string };

/**
 * Saves a native `ask` call with the form `selection`, a Select's result,
 * returned as `askHtml`, and its successful result in the shape the installed
 * host saves: one answer per radio group, named by the proposal's candidate
 * ID, and in a separate `notes` list an option note per noted chosen option.
 * Only the user's answers are synthetic, by default an explicit Apply.
 * Returns the call ID.
 */
function askUser(host: ReturnType<typeof loadExtension>, selection: ToolResult<unknown>, answer: AnswerUser = () => "Apply"): string {
  const id = `ask-${host.getBranch().length}`;
  const html: string = JSON.parse(resultText(selection)).askHtml;
  const given = reviewEntries(selection, "selected").map(({ proposal }) => {
    const chosen = answer(proposal);
    const [option, note] = typeof chosen === "string" ? [chosen, undefined] : [chosen.option, chosen.note];
    return { name: proposal.candidateId, question: "Apply this change?", answer: option, note };
  });
  const answers = given.map(({ note: _, ...entry }) => entry);
  const notes = given.flatMap(({ name, question, answer: option, note }) => note === undefined ? [] : [{ name, question, option, value: `${name}=${option}`, text: note }]);
  const submitted = Object.fromEntries(answers.filter((entry) => entry.answer).map((entry) => [entry.name, entry.answer.startsWith("Other: ") ? entry.answer.slice(7) : `${entry.name}=${entry.answer}`]));
  host.getBranch().push(
    { type: "message", id: `call-${id}`, message: { role: "assistant", content: [{ type: "toolCall", id, name: "ask", arguments: { html } }] } },
    { type: "message", id: `result-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "ask", isError: false, details: { answers, ...(notes.length > 0 && { notes }) },
      content: [{ type: "text", text: `User answers:\n${JSON.stringify(submitted, null, 2)}` }] } },
  );
  return id;
}

type DraftEvidence = Array<{ quote: string; count: number }>;
interface OnReadDraft { gist: string; section: string; skill?: string; kind?: string; fingerprint?: string; evidence?: DraftEvidence }
/** A pattern amendment's or barrier rule's draft, as a `rule` change and observer_check take it. */
type PatternRule = PatternDraft & { body: string };
interface RuleProposalDraft { skill: string; kind: string; gist: string; rule: PatternRule; evidence?: DraftEvidence }

const onReadCandidate = ({ skill = "tdd", kind = "upstream", gist, section, fingerprint, evidence }: OnReadDraft) => ({
  kind, skill, gist, priority: "evidence", remedy: "Add the missing guidance", change: { operation: "on-read-append", section },
  ...(fingerprint && { fingerprint }), ...(evidence && { evidence }),
});
const ruleCandidate = ({ rule, ...draft }: RuleProposalDraft) => ({
  ...draft, priority: "evidence", remedy: "Add a barrier against the repeated mistake", change: { operation: "rule", ...rule },
});

/**
 * Starts an observation pass, runs the registered Prepare and Select over
 * `candidates`, and saves the user's answer to each in the native Ask of its
 * Select's form, by default an explicit Apply. Returns each selected proposal
 * and its approval for observer_resolve, by gist.
 */
async function approveCandidates(host: ReturnType<typeof loadExtension>, candidates: readonly unknown[], answer?: AnswerUser) {
  startPass(host);
  const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [...candidates] });
  expect(prepared.isError).toBeFalsy();
  const references = reviewEntries(prepared).map((entry) => entry.reference);
  // Select fills five slots, so a pass with more proposals selects and asks them five at a time.
  const selections: Array<{ selected: ReviewEntry[]; selectionToolCallId: string; askToolCallId: string }> = [];
  for (let i = 0; i < references.length; i += 5) {
    const selection = await host.callTool("observer_review", { action: "select", proposals: references.slice(i, i + 5) });
    const selectionToolCallId = lastCallId(host);
    selections.push({ selected: reviewEntries(selection, "selected"), selectionToolCallId, askToolCallId: askUser(host, selection, answer) });
  }
  const selectionOf = (gist: string) => {
    const found = selections.find(({ selected }) => selected.some(({ proposal }) => proposal.gist === gist));
    if (!found) throw new Error(`Select did not select "${gist}"`);
    const { selectionToolCallId, askToolCallId } = found;
    return { entry: found.selected.find(({ proposal }) => proposal.gist === gist)!, selectionToolCallId, askToolCallId };
  };
  const entry = (gist: string) => selectionOf(gist).entry;
  return { entry, approval: (gist: string) => (({ entry, ...asked }) => ({ proposal: entry.reference, ...asked }))(selectionOf(gist)) };
}

/** Has the user approve `candidates` as {@link approveCandidates} does; returns each one's applied answer for observer_resolve, in candidate order. */
async function approve(host: ReturnType<typeof loadExtension>, candidates: ReadonlyArray<{ gist: string; evidence?: DraftEvidence } & Record<string, unknown>>, answer?: AnswerUser) {
  const { entry, approval } = await approveCandidates(host, candidates, answer);
  return candidates.map(({ gist, evidence }) => {
    const { skill, kind, fingerprint } = entry(gist).proposal;
    return { skill, kind, gist, fingerprint, outcome: "applied", ...(evidence && { evidence }), approval: approval(gist) };
  });
}

type ReferenceDraft = Array<{ name: string; body: string }>;
/** A stale amendment the user answers by selecting `select`; `body` and `references` draft its Update, which is offered only with a body. */
interface StaleDraft { rule: string; select: "Update" | "Delete"; skill?: string; kind?: string; body?: string; references?: ReferenceDraft }
/** A withdrawal of the applied fix under `fingerprint`, recorded with `gist`; `body` and `references` rewrite the skill's on-read amendment without it. */
interface WithdrawalDraft { fingerprint: unknown; gist: string; skill?: string; kind?: string; body?: string; references?: ReferenceDraft }

const staleGist = (rule: string) => `Settle ${rule}.`;
const staleCandidates = ({ rule, skill = "tdd", kind = "upstream", body, references }: StaleDraft) => {
  const base = { kind, skill, gist: staleGist(rule), priority: "stale", remedy: "Settle the stale amendment" };
  return [
    ...(body === undefined ? [] : [{ ...base, change: { operation: "stale-update", rule, body, ...(references && { references }) } }]),
    { ...base, change: { operation: "stale-delete", rule } },
  ];
};
const withdrawalCandidate = ({ fingerprint, gist, skill = "tdd", kind = "upstream", body, references }: WithdrawalDraft) => ({
  kind, skill, gist, fingerprint: String(fingerprint), priority: "note", remedy: "Take back the retracted fix",
  change: { operation: "withdrawal", ...(body !== undefined && { body }), ...(references && { references }) },
});
/** A compaction of `skill`'s on-read amendment: `includes` names this Prepare's on-read fixes it covers, by gist; `references` is the complete set. */
interface CompactionDraft { includes: string[]; body: string; references?: ReferenceDraft; skill?: string; kind?: string }
const compactionGist = (skill: string) => `Compact the on-read amendment of ${skill}.`;
const compactionCandidate = ({ includes, body, references = [], skill = "tdd", kind = "upstream" }: CompactionDraft) => ({
  kind, skill, gist: compactionGist(skill), priority: "compaction", remedy: "Keep the amendment short", change: { operation: "compaction", includes, body, references },
});

/**
 * Has the user answer, in one pass, each stale amendment with its
 * `select`, and each withdrawal, on-read fix, rule and compaction with Apply,
 * each with `note` attached when given.
 * Returns the observer_resolve `stale`, `outcomes` and `compactions` carrying them out.
 */
async function approveAll(
  host: ReturnType<typeof loadExtension>,
  { stale = [], withdrawals = [], fixes = [], rules = [], compactions = [], note }:
    { stale?: StaleDraft[]; withdrawals?: WithdrawalDraft[]; fixes?: OnReadDraft[]; rules?: RuleProposalDraft[]; compactions?: CompactionDraft[]; note?: string },
) {
  const candidates = [...stale.flatMap(staleCandidates), ...withdrawals.map(withdrawalCandidate), ...fixes.map(onReadCandidate), ...rules.map(ruleCandidate),
    ...compactions.map(compactionCandidate)];
  const { entry, approval } = await approveCandidates(host, candidates, (proposal) => {
    const option = stale.find(({ rule }) => proposal.gist === staleGist(rule))?.select ?? "Apply";
    return note === undefined ? option : { option, note };
  });
  return {
    stale: stale.map(({ rule, select }) => ({ rule, action: select.toLowerCase(), approval: approval(staleGist(rule)) })),
    outcomes: [
      ...withdrawals.map(({ fingerprint, gist, skill = "tdd", kind = "upstream" }) =>
        ({ skill, kind, gist, fingerprint: String(fingerprint), outcome: "withdrawn", approval: approval(gist) })),
      ...[...fixes, ...rules].map(({ gist, evidence }) => {
        const { skill, kind, fingerprint } = entry(gist).proposal;
        return { skill, kind, gist, fingerprint, outcome: "applied", ...(evidence && { evidence }), approval: approval(gist) };
      }),
    ],
    compactions: compactions.map(({ skill = "tdd" }) => ({ skill, outcome: "applied", approval: approval(compactionGist(skill)) })),
  };
}
/** Has the user approve `drafts` as {@link approveAll} does, then runs observer_resolve with them. */
const resolveApproved = async (host: ReturnType<typeof loadExtension>, drafts: Parameters<typeof approveAll>[1]) =>
  host.callTool("observer_resolve", await approveAll(host, drafts));

const approveOnRead = (host: ReturnType<typeof loadExtension>, drafts: readonly OnReadDraft[], answer?: AnswerUser) =>
  approve(host, drafts.map(onReadCandidate), answer);
const approveRules = (host: ReturnType<typeof loadExtension>, drafts: readonly RuleProposalDraft[], answer?: AnswerUser) =>
  approve(host, drafts.map(ruleCandidate), answer);
/** Runs the registered Prepare over pattern amendment and barrier rule drafts. */
const prepareRules = (host: ReturnType<typeof loadExtension>, drafts: readonly RuleProposalDraft[]) =>
  host.callTool("observer_review", { action: "prepare", candidates: drafts.map(ruleCandidate) });

describe("observer_review selection", () => {
  const candidate = (gist: string, priority = "evidence", count = 1) => ({
    skill: "tdd", kind: "upstream", gist, priority, remedy: "Improve the existing guidance",
    change: { operation: "on-read-append", section: `## ${gist}\n\nExact text for ${gist}.` },
    evidence: [{ quote: `Evidence for ${gist}`, count }],
  });
  const ranked = (gist: string, score: number) => ({
    id: `proposal:${proposalFingerprint("tdd", gist)}`, score, confidence: 0.95, consistent: true,
  });

  it("merges duplicate evidence and removes scoped declines before exposing judge states", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const other = join(host.skillHome.home, "other-project");
    mkdirSync(other);
    const project = { kind: "project", target: { scope: "project", root: other, path: "checks.json", mechanism: "Wire check" }, gist: "Wire check" };
    host.setCwd(other);
    await host.callTool("observer_resolve", { outcomes: [{ ...project, outcome: "declined" }] });
    host.setCwd(root);
    await host.callTool("observer_resolve", { outcomes: [outcome("tdd", "upstream", "Declined mechanism", "declined")] });
    startPass(host);
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [
      candidate("Declined mechanism"),
      candidate("One mechanism"),
      { ...candidate("One mechanism", "note"), evidence: [{ quote: "Another source", count: 2 }, { quote: "Evidence for One mechanism", count: 1 }] },
      { ...project, target: { ...project.target, root }, priority: "evidence", remedy: "Wire the existing check",
        change: { operation: "direct-edit", preview: "Exact project diff" }, evidence: [{ quote: "Unwired", count: 1 }] },
    ] });
    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({
      eligible: [
        { proposal: { gist: "One mechanism", priority: "note", evidence: [{ quote: "Evidence for One mechanism", count: 1 }, { quote: "Another source", count: 2 }] } },
        { proposal: { kind: "project", gist: "Wire check", change: { operation: "direct-edit" }, preview: "Exact project diff" } },
      ],
      needsRanking: false,
      judgeStates: {},
    });
    expect(JSON.stringify(result.details)).not.toContain("Declined mechanism");
    await host.callTool("observer_resolve", { outcomes: [{ ...project, target: { ...project.target, root }, outcome: "declined" }] });
    const suppressed = await host.callTool("observer_review", { action: "prepare", candidates: [
      { ...project, target: { ...project.target, root }, priority: "evidence", remedy: "Wire check", change: { operation: "direct-edit", preview: "Exact diff" } },
    ] });
    expect(suppressed.details).toMatchObject({ eligible: [], judgeStates: {}, needsRanking: false });
  });

  it("rejects out-of-scope project review candidates without recording any outcome", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [{
      kind: "project", target: { scope: "project", root, path: "../outside.json", mechanism: "Escape" },
      gist: "Escape", priority: "note", remedy: "Write outside", change: { operation: "direct-edit", preview: "Unscoped diff" },
    }] });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ eligible: [], selected: [], deferred: [], failures: [expect.any(String)] });
    expect(existsSync(host.ledgerFile)).toBe(false);
  });

  it("keeps class priority and five slots authoritative, then records selected overflow as Later", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-stale");
    splitAmendment(host, "domain-modeling", "domain-modeling-amendment");
    const candidates = [
      candidate("Low evidence", "evidence", 1), candidate("High evidence", "evidence", 4),
      { ...candidate("Stale update"), priority: "stale", change: { operation: "stale-update", rule: "tdd-stale", body: "Rewritten stale body." } },
      candidate("Explicit note", "note", 1), candidate("Other evidence", "evidence", 2),
      { ...candidate("Compact guidance"), skill: "domain-modeling", priority: "compaction", change: { operation: "compaction", includes: [], body: "## Compact\n\nShorter.", references: [] } },
      candidate("Overflow evidence", "evidence", 1),
    ];
    startPass(host);
    const result = await prepareAndSelect(host, candidates, { rankings: [
      ranked("Low evidence", 2), ranked("High evidence", 1), ranked("Other evidence", 3), ranked("Overflow evidence", 0),
    ] });
    expect(result.details).toMatchObject({
      selected: [
        { proposal: { priority: "stale" } }, { proposal: { gist: "Explicit note" } },
        { proposal: { gist: "Other evidence" } }, { proposal: { gist: "Low evidence" } }, { proposal: { gist: "High evidence" } },
      ],
      deferred: [{ proposal: { gist: "Overflow evidence" } }, { proposal: { priority: "compaction" } }],
    });
    const { deferred: [overflow] } = JSON.parse(resultText(result));
    expect(failures(await host.callTool("observer_resolve", { outcomes: [{ proposal: overflow, outcome: "later" }] }))).toEqual([]);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ gist: "Overflow evidence", outcome: "later", evidence: [{ quote: "Evidence for Overflow evidence", count: 1 }] });
  });

  it.each(["missing", "failed", "partial", "low confidence", "inconsistent", "unknown ID", "duplicate ID"] as const)(
    "uses stable evidence ordering and one disclosed fallback for %s rankings", async (failure) => {
      const host = loadExtension();
      const candidates = [candidate("Original tie", "evidence", 2), candidate("Strong evidence", "evidence", 4), candidate("Later tie", "evidence", 2),
        ...Array.from({ length: 3 }, (_, i) => candidate(`Overflow ${i}`))];
      let rankings = candidates.map((entry, index) => ranked(entry.gist, index === 0 ? 3 : 0));
      if (failure === "partial") rankings = rankings.slice(0, 1);
      if (failure === "low confidence") rankings = rankings.map((entry) => ({ ...entry, confidence: 0.1 }));
      if (failure === "inconsistent") rankings = rankings.map((entry) => ({ ...entry, consistent: false }));
      if (failure === "unknown ID") rankings = [...rankings, { ...ranked("Other mechanism", 3) }];
      if (failure === "duplicate ID") rankings = [...rankings, rankings[0]!];
      const result = await prepareAndSelect(host, candidates, {
        rankings: failure === "missing" || failure === "failed" ? undefined : rankings,
        rankingFailure: failure === "failed" ? "Host judge unavailable" : undefined,
      });
      expect(result.isError).toBeFalsy();
      expect(result.details).toMatchObject({
        selected: [{ proposal: { gist: "Strong evidence" } }, { proposal: { gist: "Original tie" } }, { proposal: { gist: "Later tie" } },
          { proposal: { gist: "Overflow 0" } }, { proposal: { gist: "Overflow 1" } }],
        deferred: [{ proposal: { gist: "Overflow 2" } }], fallback: expect.any(String),
      });
      expect(result.content).toHaveLength(1);
    },
  );

  it("skips judge work for singleton classes and keeps previews out of minimized ranking states", async () => {
    const host = loadExtension();
    startPass(host);
    const singleton = await host.callTool("observer_review", { action: "prepare", candidates: [candidate("Only note", "note"), candidate("Only evidence")] });
    expect(singleton.details).toMatchObject({ needsRanking: false, judgeStates: {} });
    const fullySelected = await host.callTool("observer_review", { action: "prepare", candidates: [candidate("First evidence"), candidate("Second evidence")] });
    expect(fullySelected.details).toMatchObject({ needsRanking: false, judgeStates: {} });
    const belowCutoff = await host.callTool("observer_review", { action: "prepare", candidates: [
      ...Array.from({ length: 5 }, (_, i) => candidate(`Note ${i}`, "note")),
      candidate("First evidence"), candidate("Second evidence"),
    ] });
    expect(belowCutoff.details).toMatchObject({ needsRanking: false, judgeStates: {} });
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: Array.from({ length: 6 }, (_, i) => candidate(`Evidence ${i}`)) });
    expect(prepared.details).toMatchObject({ needsRanking: true });
    const details = prepared.details;
    if (!details || typeof details !== "object" || !("judgeStates" in details)) throw new Error("missing judge states");
    expect(JSON.stringify(details.judgeStates)).not.toContain("Exact text");
    const selected = await prepareAndSelect(host, [candidate("Only evidence")]);
    expect(selected.details).toMatchObject({ selected: [{ proposal: { gist: "Only evidence" } }], deferred: [] });
    expect(selected.details).not.toHaveProperty("fallback");
  });

  it("ranks distinct occurrences above multiple descriptions of one occurrence", async () => {
    const host = loadExtension();
    const result = await prepareAndSelect(host, [
      { ...candidate("One repeated description"), evidence: [
        { quote: "First description", count: 1, occurrenceIds: ["entry-a"] },
        { quote: "Second description", count: 1, occurrenceIds: ["entry-a"] },
        { quote: "Third description", count: 1, occurrenceIds: ["entry-a"] },
      ] },
      { ...candidate("Actual recurrence"), evidence: [{ quote: "Repeated failure", count: 2, occurrenceIds: ["entry-b", "entry-c"] }] },
    ]);
    expect(result.details).toMatchObject({ selected: [
      { proposal: { gist: "Actual recurrence" } }, { proposal: { gist: "One repeated description" } },
    ] });
  });

  it("counts a tool error once with the workflow outline of the turn it happened in", async () => {
    const host = loadExtension();
    const calls = ["c1", "c2", "c3"].map(id => ({ type: "toolCall", id, name: "bash", arguments: { command: id } }));
    const digest = buildDigest([
      { type: "message", id: "prompt", message: { role: "user", content: "Do the work" } },
      { type: "message", id: "calls", message: { role: "assistant", content: calls } },
      ...calls.map(({ id }) => ({ type: "message", id: `result-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "bash", content: "out", isError: id === "c1" } })),
    ] as SessionEntry[], { provenance: createProvenanceResolver(host.skillHome.roots) });
    const evidence = digest.signals.map(signal => ({ quote: signal.kind, count: 1, occurrenceIds: signal.occurrenceIds }));
    expect(evidence.map(item => item.quote)).toEqual(["tool-error", "workflow"]);
    const result = await prepareAndSelect(host, [
      { ...candidate("Error inside its workflow"), evidence },
      { ...candidate("Actual recurrence"), evidence: [
        { quote: "First failure", count: 1, occurrenceIds: ["entry-b"] },
        { quote: "Second failure", count: 1, occurrenceIds: ["entry-c"] },
      ] },
    ]);
    expect(result.details).toMatchObject({ selected: [
      { proposal: { gist: "Actual recurrence" } }, { proposal: { gist: "Error inside its workflow" } },
    ] });
  });

  it("still counts distinct events inside one cited workflow turn as separate occurrences", async () => {
    const host = loadExtension();
    const select = async (others: number) => (await prepareAndSelect(host, [
      { ...candidate("Two errors in one turn"), evidence: [{ quote: "Turn", count: 3, occurrenceIds: ["w", "w/e1", "w/e2"] }] },
      { ...candidate("Other"), evidence: Array.from({ length: others }, (_, i) => ({ quote: `Other ${i}`, count: 1, occurrenceIds: [`o${i}`] })) },
    ])).details;
    // Two occurrences: ahead of two others on repeat count, behind three others.
    expect(await select(2)).toMatchObject({ selected: [{ proposal: { gist: "Two errors in one turn" } }, { proposal: { gist: "Other" } }] });
    expect(await select(3)).toMatchObject({ selected: [{ proposal: { gist: "Other" } }, { proposal: { gist: "Two errors in one turn" } }] });
  });
});

describe("observer_review prepared proposals", () => {
  const remedy = "Fix the skill's guidance";
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const writeReference = (host: ReturnType<typeof loadExtension>, skill: string, name: string, body: string) => {
    mkdirSync(join(referencesDir(host), skill), { recursive: true });
    writeFileSync(join(referencesDir(host), skill, name), body);
    return join(referencesDir(host), skill, name);
  };

  it("prepares canonical on-read append, pattern amendment and barrier rule writes from target bytes it reads itself", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-amendment");
    const amendment = join(host.amendmentsDir, "tdd-amendment.md");
    const before = ownedFiles(host);
    startPass(host);
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [
      { kind: "upstream", skill: "tdd", gist: "Name the seam", priority: "evidence", remedy,
        change: { operation: "on-read-append", section: "\n## Seams\n\nName the seam first.\n\n" } },
      { kind: "upstream", skill: "tdd", gist: "Ask with the ask tool", priority: "evidence", remedy,
        change: { operation: "rule", name: "use-ask-tool", body: "Ask with the ask tool.\n", pattern: "\\?\\s*$", matches: ["Shall I go on?"], spares: ["I went on."] } },
      { kind: "local", skill: "ce-commit-jj", gist: "Never echo TODO", priority: "note", remedy,
        change: { operation: "rule", name: "no-todo-echo", body: "Finish the work instead.", pattern: "TODO", scope: "tool:bash", matches: [{ command: "echo TODO" }], spares: [{ command: "echo done" }] } },
    ] });
    expect(result.isError).toBeFalsy();
    const [append, pattern, barrier] = reviewEntries(result);
    expect(append?.proposal.change).toEqual({
      operation: "on-read-append", effect: "append", section: "## Seams\n\nName the seam first.",
      rule: expect.objectContaining({ name: "tdd-amendment", path: amendment, amends: "tdd" }),
      target: { path: amendment, sha256: sha256(amendment) },
    });
    expect(append?.proposal.preview).toBe(`Append this section to the on-read amendment \`${amendment}\` of \`tdd\` (upstream):\n\n## Seams\n\nName the seam first.`);
    const patternPath = join(host.rulesDir, "use-ask-tool.md");
    expect(pattern?.proposal.change).toEqual({
      operation: "rule", body: "Ask with the ask tool.", matches: ["Shall I go on?"], spares: ["I went on."],
      rule: { name: "use-ask-tool", path: patternPath, description: "Ask with the ask tool", condition: "\\?\\s*$", scope: "text", amends: "tdd",
        skillHash: currentSkillHash(host, "tdd"), fingerprint: proposalFingerprint("tdd", "Ask with the ask tool") },
      target: { path: patternPath, sha256: null },
    });
    expect(pattern?.proposal.preview).toBe([
      `Write the pattern amendment \`use-ask-tool\` at \`${patternPath}\` for \`tdd\` (upstream).`,
      "Scope: text", "Pattern: \\?\\s*$", 'Matches:\n- "Shall I go on?"', 'Spares:\n- "I went on."', "", "Ask with the ask tool.",
    ].join("\n"));
    expect(barrier?.proposal.change).toMatchObject({ operation: "rule", rule: { name: "no-todo-echo", scope: "tool:bash", amends: "ce-commit-jj" },
      matches: [{ command: "echo TODO" }], spares: [{ command: "echo done" }] });
    expect(barrier?.proposal.change.rule).not.toHaveProperty("skillHash");
    expect(barrier?.proposal.preview).toContain('Write the barrier rule `no-todo-echo`');
    expect(barrier?.proposal.preview).toContain('Matches:\n- {"command":"echo TODO"}\nSpares:\n- {"command":"echo done"}');
    const reviewToolCallId = lastCallId(host);
    for (const entry of [append, pattern, barrier]) {
      expect(entry?.reference).toEqual({ reviewToolCallId, candidateId: entry?.proposal.candidateId, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
    expect(JSON.parse(resultText(result)).eligible.map((entry: ReviewEntry) => entry.reference)).toEqual([append, pattern, barrier].map((entry) => entry?.reference));
    expect(ownedFiles(host)).toEqual(before);
  });

  it("suppresses a declined proposal whose target is no longer writable, and prepares the rest", async () => {
    const host = loadExtension();
    appendLedger(host.ledgerFile, [{ fingerprint: proposalFingerprint("removed-skill", "Declined fix"), skill: "removed-skill", kind: "upstream",
      gist: "Declined fix", outcome: "declined", timestamp: new Date().toISOString(), sessionId: "fixture-session" } as LedgerRecord]);
    startPass(host);
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [
      { kind: "upstream", skill: "removed-skill", gist: "Declined fix", priority: "evidence", remedy, change: { operation: "on-read-append", section: "## Gone\n\nGone." } },
      { kind: "upstream", skill: "tdd", gist: "Name the seam", priority: "evidence", remedy, change: { operation: "on-read-append", section: "## Seams\n\nName the seam." } },
    ] });
    expect(result.isError).toBeFalsy();
    expect(reviewEntries(result).map((entry) => entry.proposal.gist)).toEqual(["Name the seam"]);
  });

  it("previews an on-read section the amendment already holds as recording only, and Resolve leaves its bytes unchanged", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const bytes = readFileSync(file, "utf8");
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
      { kind: "upstream", skill: "tdd", gist: "Seams again", priority: "evidence", remedy, change: { operation: "on-read-append", section: `\n${SEAMS}\n` } },
    ] });
    const [entry] = reviewEntries(prepared);
    expect(entry?.proposal.change).toMatchObject({ effect: "record", section: SEAMS, target: { path: file, sha256: sha256(file) } });
    expect(entry?.proposal.preview).toBe(`The on-read amendment \`${file}\` of \`tdd\` (upstream) already holds this section, so only the proposal ledger changes:\n\n${SEAMS}`);
    const [answer] = await approveOnRead(host, [{ gist: "Seams again", section: `\n${SEAMS}\n` }]);
    const resolved = await host.callTool("observer_resolve", { outcomes: [answer] });
    expect(resolved.isError).toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ gist: "Seams again", outcome: "applied" });
    expect((resolved.details as { publications: unknown[] }).publications).toEqual([]);
  });

  it("prepares stale Update/Delete, withdrawal and compaction effects with the reference files they write and delete", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-amendment");
    splitAmendment(host, "domain-modeling", "domain-modeling-amendment");
    const tdd = join(host.amendmentsDir, "tdd-amendment.md");
    const domain = join(host.amendmentsDir, "domain-modeling-amendment.md");
    const oldReference = writeReference(host, "tdd", "old.md", "Old reference.\n");
    const notes = writeReference(host, "domain-modeling", "notes.md", "Notes.\n");
    const gone = { fingerprint: proposalFingerprint("tdd", "Gone fix"), skill: "tdd", kind: "upstream", gist: "Gone fix", outcome: "applied",
      rule: join(host.rulesDir, "gone-fix.md"), timestamp: new Date().toISOString(), sessionId: "fixture-session" } as LedgerRecord;
    appendLedger(host.ledgerFile, [gone]);
    const reds = join(referencesDir(host), "tdd", "reds.md");
    const kept = join(referencesDir(host), "domain-modeling", "kept.md");
    const tddFix = { fingerprint: proposalFingerprint("tdd", "Gist of tdd-amendment."), gist: "Gist of tdd-amendment." };
    const before = ownedFiles(host);
    const stale = { kind: "upstream", skill: "tdd", gist: "Gist of tdd-amendment.", priority: "stale", remedy };
    const withdraw = { kind: "upstream", skill: "tdd", gist: tddFix.gist, fingerprint: tddFix.fingerprint, priority: "note", remedy };
    startPass(host);
    const first = await host.callTool("observer_review", { action: "prepare", candidates: [
      { ...stale, change: { operation: "stale-update", rule: "tdd-amendment", body: `## Reds\n\nWhen red, read \`${reds}\`.\n`, references: [{ name: "reds.md", body: "Red first.\n" }] } },
      { ...withdraw, change: { operation: "withdrawal", body: "## Left\n\nThe rest." } },
      { kind: "upstream", skill: "domain-modeling", gist: "Gist one", priority: "evidence", remedy, change: { operation: "on-read-append", section: "## One\n\nGist one." } },
      { kind: "upstream", skill: "domain-modeling", gist: "Compact", priority: "compaction", remedy,
        change: { operation: "compaction", includes: ["Gist one"], body: `## Short\n\nWhen modeling, read \`${kept}\`.`, references: [{ name: "kept.md", body: "Kept.\n" }] } },
      { ...stale, change: { operation: "stale-delete", rule: "tdd-amendment" } },
    ] });
    const second = await host.callTool("observer_review", { action: "prepare", candidates: [
      { ...withdraw, change: { operation: "withdrawal" } },
      { kind: "upstream", skill: "tdd", gist: "Gone fix", fingerprint: gone.fingerprint, priority: "note", remedy, change: { operation: "withdrawal" } },
    ] });
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    const [staleQuestion, rewrite, , compaction] = reviewEntries(first);
    const [deletion, record] = reviewEntries(second);
    const [update, remove] = staleQuestion?.proposal.alternatives ?? [];
    const tddRule = expect.objectContaining({ name: "tdd-amendment", path: tdd, fingerprint: tddFix.fingerprint });
    const tddTarget = { path: tdd, sha256: sha256(tdd) };
    const releasedTdd = { folder: join(referencesDir(host), "tdd"), before: [{ path: oldReference, sha256: sha256(oldReference) }], write: [], remove: ["old.md"] };
    expect(staleQuestion?.proposal).toMatchObject({ candidateId: `stale:${tddFix.fingerprint}`, priority: "stale" });
    expect(staleQuestion?.proposal).not.toHaveProperty("change");
    expect(update?.change).toEqual({
      operation: "stale-update", rule: tddRule, target: tddTarget, body: `## Reds\n\nWhen red, read \`${reds}\`.`,
      references: { ...releasedTdd, write: [{ name: "reds.md", body: "Red first." }] },
    });
    expect(update?.preview).toBe(`Update the stale amendment \`tdd-amendment\` at \`${tdd}\` of \`tdd\` (upstream), pinned to the skill as installed now. New body:\n\n## Reds\n\nWhen red, read \`${reds}\`.\n\nReference file \`${reds}\`:\n\nRed first.\n\nDeletes reference files \`${oldReference}\`.`);
    expect(rewrite?.proposal.change).toEqual({ operation: "withdrawal", withdrawn: tddFix, effect: "rewrite", rule: tddRule, target: tddTarget, body: "## Left\n\nThe rest." });
    expect(compaction?.proposal.change).toEqual({
      operation: "compaction", rule: expect.objectContaining({ name: "domain-modeling-amendment", path: domain }), target: { path: domain, sha256: sha256(domain) },
      includes: [proposalFingerprint("domain-modeling", "Gist one")], body: `## Short\n\nWhen modeling, read \`${kept}\`.`,
      references: { folder: join(referencesDir(host), "domain-modeling"), before: [{ path: notes, sha256: sha256(notes) }], write: [{ name: "kept.md", body: "Kept." }], remove: ["notes.md"] },
    });
    expect(compaction?.proposal.candidateId).toBe(`compaction:${amendments.compactionFingerprint("domain-modeling", "Body of domain-modeling-amendment.")}`);
    expect(compaction?.proposal.preview).toContain(`Reference file \`${kept}\`:\n\nKept.\n\nDeletes reference files \`${notes}\`.`);
    expect(remove?.change).toEqual({ operation: "stale-delete", rule: tddRule, target: tddTarget, references: releasedTdd });
    expect(remove?.preview).toBe(`Delete the stale amendment \`tdd-amendment\` at \`${tdd}\` of \`tdd\` (upstream); the fixes it holds go out of force.\n\nDeletes reference files \`${oldReference}\`.`);
    expect(deletion?.proposal.change).toEqual({ operation: "withdrawal", withdrawn: tddFix, effect: "delete", rule: tddRule, target: tddTarget, references: releasedTdd });
    expect(record?.proposal).toMatchObject({ candidateId: `withdrawal:${gone.fingerprint}`, change: { operation: "withdrawal", withdrawn: { fingerprint: gone.fingerprint, gist: "Gone fix" }, effect: "record" } });
    expect(ownedFiles(host)).toEqual(before);
  });

  it("selects exactly the proposals its references name, as their successful Prepare saved them, and returns their references, not their bodies", async () => {
    const host = loadExtension();
    startPass(host);
    const candidates = ["Evidence fix", "Note fix"].map((gist, index) => ({ kind: "upstream", skill: "tdd", gist, priority: index ? "note" : "evidence", remedy,
      change: { operation: "on-read-append", section: `## ${gist}\n\nDo it.` }, evidence: [{ quote: gist, count: 1 }] }));
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates });
    const eligible = reviewEntries(prepared);
    const before = ownedFiles(host);
    const selected = await host.callTool("observer_review", { action: "select", proposals: eligible.map((entry) => entry.reference) });
    expect(selected.isError).toBeFalsy();
    expect(reviewEntries(selected, "selected")).toEqual([eligible[1], eligible[0]]);
    expect(JSON.parse(resultText(selected))).toEqual({
      selected: [eligible[1]?.reference, eligible[0]?.reference], deferred: [],
      askHtml: expect.stringMatching(/^<form>/), failures: [],
    });
    expect(ownedFiles(host)).toEqual(before);
  });

  it("returns in Prepare's text each proposal's reference, fingerprint, target, kind, gist and preview, and the sections of its target amendment, not its change or evidence", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    splitAmendment(host, "grill-with-docs", "grill-stale");
    const root = host.skillHome.roots.cwd;
    const target = { scope: "project", root, path: "package.json", mechanism: "Wire the typecheck." } as const;
    const evidence = [{ quote: "the quoted signal", count: 2, source: "signal source" }];
    const stale = { kind: "upstream", skill: "grill-with-docs", gist: "Gist of grill-stale.", priority: "stale", remedy, evidence };
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
      { ...onReadCandidate({ gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR }), evidence },
      { ...onReadCandidate({ skill: "domain-modeling", gist: "Define terms first.", section: "## Terms\n\nDefine terms first." }), evidence },
      { kind: "project", target, gist: "Wire the typecheck.", priority: "evidence", remedy, change: { operation: "direct-edit", preview: "Exact project diff" }, evidence },
      { ...stale, change: { operation: "stale-update", rule: "grill-stale", body: "Rewritten." } },
      { ...stale, change: { operation: "stale-delete", rule: "grill-stale" } },
    ] });
    expect(prepared.isError).toBeFalsy();
    const [scope, terms, project, question] = reviewEntries(prepared);
    const shown = (entry: ReviewEntry | undefined) => ({ reference: entry?.reference, fingerprint: entry?.proposal.fingerprint, gist: entry?.proposal.gist });
    expect(JSON.parse(resultText(prepared))).toEqual({
      eligible: [
        { ...shown(scope), kind: "upstream", skill: "tdd", preview: scope?.proposal.preview, amendmentSections: ["Seams", "Red"] },
        { ...shown(terms), kind: "upstream", skill: "domain-modeling", preview: terms?.proposal.preview, amendmentSections: [] },
        { ...shown(project), kind: "project", target: canonicalProjectTarget(root, target), preview: "Exact project diff" },
        { ...shown(question), kind: "upstream", skill: "grill-with-docs", previews: question?.proposal.alternatives?.map(({ preview }) => preview) },
      ],
      needsRanking: false, judgeStates: {}, failures: [],
    });
    expect(resultText(prepared)).not.toContain("the quoted signal");
  });

  it("keeps a prepared proposal's content hash the hash of its saved proposal, which the amendment's sections stay out of", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    startPass(host);
    const inspected = await host.callTool("observer_review", { action: "inspect", skill: "tdd" });
    const [source] = (inspected.details as { inspection: { sources: Array<{ path: string }> } }).inspection.sources;
    const diagnosis = {
      inspection: lastCallId(host), explanation: "The inspected guidance names no first step.", delta: "A future agent takes the first step.",
      citations: [{ source: source!.path, lines: { from: 1, to: 1 } }],
    };
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
      { ...onReadCandidate({ gist: "First", section: "## First\n\nText for First." }), evidence: [{ quote: "First", count: 2, source: "signal for First" }], diagnosis },
    ] });
    const [entry] = reviewEntries(prepared);
    const json = JSON.stringify(entry?.proposal);
    expect(entry?.reference.contentHash).toBe(createHash("sha256").update(json).digest("hex"));
    expect(json).not.toContain("Seams");
    // Pins the hash, with the temp home masked: Prepare keeps amendment sections out of the proposal.
    expect(createHash("sha256").update(json.replaceAll(host.skillHome.home, "<home>")).digest("hex"))
      .toBe("3e72a9cf4d3594e1e03b1cd80a36740037905b977ba53865ff32a622d9f2560a");
  });

  it("returns one Ask form showing each selected proposal's preview whole, escaped and with hidden whitespace marked, with no option preselected", async () => {
    const host = loadExtension();
    const long = `A long line ${"that keeps going ".repeat(20)}to its end.`;
    const selection = await prepareAndSelect(host, [{ kind: "local", skill: "ce-commit-jj", gist: "Use <jj> & not git", priority: "evidence", remedy: "Edit the skill",
      change: { operation: "direct-edit", preview: `- if (a < b && c > d)\n    x  y\t\na\tb c \n\n${long}` }, evidence: [{ quote: "git commit <again>", count: 2, source: "user" }] }]);
    const { candidateId } = reviewEntries(selection, "selected")[0]!.proposal;
    const { askHtml } = JSON.parse(resultText(selection));
    expect(askHtml).toBe([
      "<form>", "<fieldset>",
      "<legend>`ce-commit-jj` (local): Use &lt;jj&gt; &amp; not git</legend>",
      "<p>Edit the skill</p>",
      "<p>Diagnosis: The inspected guidance does not cover this; its sections hold no such step.</p>",
      "<p>Behavior change: A future agent takes the drafted step.</p>",
      `<p>Cited guidance, inspection observer_review-call-1: ${join(host.skillHome.roots.skillsDir, "ce-commit-jj/SKILL.md")} lines 1–1</p>`,
      "<ul>", '<li>"git commit &lt;again&gt;" (×2, user)</li>', "</ul>",
      `<p>- if (a &lt; b &amp;&amp; c &gt; d)<br>····x··y→<br>a→b c·<br><br>${long}</p>`,
      "<p><b>Apply this change?</b></p>",
      ...["Apply", "Later", "Decline"].map((label) => `<label><input type="radio" name="${candidateId}" value="${candidateId}=${label}" required>${label}</label>`),
      "</fieldset>", "</form>",
    ].join("\n"));
    expect(askHtml).not.toMatch(/<pre|checked/);
    const none = await host.callTool("observer_review", { action: "select", proposals: [] });
    expect(JSON.parse(resultText(none))).not.toHaveProperty("askHtml");
  });

  it("asks a stale amendment's Update and Delete as one question that takes one of the five slots", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-stale");
    const stale = { kind: "upstream", skill: "tdd", gist: "Gist of tdd-stale.", priority: "stale", remedy };
    const fixes = Array.from({ length: 5 }, (_, i) => ({ kind: "upstream", skill: "domain-modeling", gist: `Fix ${i}`, priority: "evidence", remedy,
      change: { operation: "on-read-append", section: `## Fix ${i}\n\nDo ${i}.` }, evidence: [{ quote: `Fix ${i}`, count: 5 - i }] }));
    const selected = await prepareAndSelect(host, [
      { ...stale, change: { operation: "stale-delete", rule: "tdd-stale" } },
      ...fixes,
      { ...stale, change: { operation: "stale-update", rule: "tdd-stale", body: "Rewritten.\n" } },
    ], { rankingFailure: "no judge in this test" });
    expect(selected.isError).toBeFalsy();
    const [question, ...rest] = reviewEntries(selected, "selected");
    expect(question?.proposal.alternatives?.map(({ change, preview }) => [change.operation, preview.split(" ")[0]])).toEqual([["stale-update", "Update"], ["stale-delete", "Delete"]]);
    expect(question?.proposal.alternatives?.[0]?.change).toMatchObject({ body: "Rewritten." });
    const id = question?.proposal.candidateId;
    const offered = [...String(JSON.parse(resultText(selected)).askHtml).matchAll(new RegExp(`name="${id}" value="${id}=(\\w+)"`, "g"))].map(([, label]) => label);
    expect(offered).toEqual(["Keep", "Update", "Delete"]);
    expect(rest.map((entry) => entry.proposal.gist)).toEqual(["Fix 0", "Fix 1", "Fix 2", "Fix 3"]);
    expect(reviewEntries(selected, "deferred").map((entry) => entry.proposal.gist)).toEqual(["Fix 4"]);
  });

  const reviewFixture = async () => {
    const host = loadExtension();
    startPass(host);
    const draft = { kind: "upstream", skill: "tdd", gist: "Name the seam", priority: "evidence", remedy, change: { operation: "on-read-append", section: "## Seams\n\nName the seam." } };
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [draft] });
    const prepareId = lastCallId(host);
    const [entry] = reviewEntries(prepared);
    if (!entry) throw new Error("Prepare returned no proposal");
    return { host, draft, prepareId, reference: entry.reference };
  };
  type ReviewFixture = Awaited<ReturnType<typeof reviewFixture>>;
  /** Rewrites the saved Prepare result on the branch. */
  const editPrepareResult = (fixture: ReviewFixture, edit: (message: NonNullable<SessionEntry["message"]>) => void) => {
    const branch = structuredClone(fixture.host.getBranch());
    const result = branch.find((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === fixture.prepareId);
    if (!result?.message) throw new Error("no saved Prepare result");
    edit(result.message);
    fixture.host.setBranch(branch);
  };

  it.each<[string, string, (fixture: ReviewFixture) => Promise<Record<string, unknown>>]>([
    ["a forged review call ID", "no completed review call", async ({ reference }) => ({ proposals: [{ ...reference, reviewToolCallId: "observer_review-call-999" }] })],
    ["another tool's call ID", "not an observer_review Prepare", async ({ host, reference }) => {
      await host.callTool("observer_resolve", { outcomes: [] });
      return { proposals: [{ ...reference, reviewToolCallId: lastCallId(host) }] };
    }],
    ["a failed Prepare", "did not succeed", async ({ host, draft, reference }) => {
      const failed = await host.callTool("observer_review", { action: "prepare", candidates: [draft, { ...draft, kind: "project" }] });
      expect(failed.isError).toBe(true);
      return { proposals: [{ ...reference, reviewToolCallId: lastCallId(host) }] };
    }],
    ["a Prepare absent from this branch", "no completed review call", async (fixture) => {
      fixture.host.setBranch(fixture.host.getBranch().filter((entry) => !JSON.stringify(entry).includes(fixture.prepareId)));
      return { proposals: [fixture.reference] };
    }],
    ["a Prepare result saved as failed", "did not succeed", async (fixture) => {
      editPrepareResult(fixture, (message) => { message.isError = true; });
      return { proposals: [fixture.reference] };
    }],
    ["a mismatched content hash", "content hash does not match", async ({ reference }) => ({ proposals: [{ ...reference, contentHash: "0".repeat(64) }] })],
    ["a candidate ID that Prepare never returned", "no single proposal", async ({ reference }) => ({ proposals: [{ ...reference, candidateId: "proposal:000000000000" }] })],
    ["a duplicated reference", "referenced twice", async ({ reference }) => ({ proposals: [reference, reference] })],
    ["a saved proposal altered after Prepare", "no longer matches its content hash", async (fixture) => {
      editPrepareResult(fixture, (message) => {
        const [entry] = (message.details as unknown as { eligible: ReviewEntry[] }).eligible;
        entry!.proposal.change.section = "## Seams\n\nSubstituted.";
      });
      return { proposals: [fixture.reference] };
    }],
    ["a newly supplied draft", "not candidate drafts", async ({ draft, reference }) => ({
      proposals: [reference], candidates: [{ ...draft, change: { operation: "on-read-append", section: "## Seams\n\nSubstituted." } }],
    })],
    ["a draft instead of references", "not candidate drafts", async ({ draft }) => ({ candidates: [draft] })],
  ])("rejects %s at Select without selecting or writing anything", async (_label, reason, select) => {
    const fixture = await reviewFixture();
    const params = await select(fixture);
    const before = ownedFiles(fixture.host);
    const result = await fixture.host.callTool("observer_review", { action: "select", ...params });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ selected: [], deferred: [], failures: [expect.stringContaining(reason)] });
    expect(resultText(result)).not.toContain("Substituted");
    expect(ownedFiles(fixture.host)).toEqual(before);
  });

  it("rejects Select once a later prompt ended the pass, so no approval form is shown", async () => {
    const host = loadExtension();
    startPass(host);
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [onReadCandidate({ gist: "Name the seam", section: SEAMS })] });
    host.getBranch().push({ type: "message", id: "prompt", message: { role: "user", content: "Why did you stop?" } });
    const result = await host.callTool("observer_review", { action: "select", proposals: reviewEntries(prepared).map((entry) => entry.reference) });
    expect(result.details).toMatchObject({ selected: [], failures: [expect.stringContaining("no observation pass is current")] });
    expect(resultText(result)).not.toContain("askHtml");
  });

  it.each<[string, (host: ReturnType<typeof loadExtension>) => Record<string, unknown>]>([
    ["a bare carriage return in an on-read section", () => ({ priority: "evidence", change: { operation: "on-read-append", section: "## Seams\n\nUse foo\rbar." } })],
    ["CRLF line ends in an on-read section", () => ({ priority: "evidence", change: { operation: "on-read-append", section: "## Seams\r\n\r\nName the seam." } })],
    ["CRLF line ends in a rule body", () => ({ priority: "evidence",
      change: { operation: "rule", name: "use-ask-tool", body: "Ask with the ask tool.\r\nAlways.", pattern: "\\?\\s*$", matches: ["Shall I go on?"], spares: ["I went on."] } })],
    ["a carriage return in a reference file", (host) => ({ priority: "compaction", change: { operation: "compaction", includes: [],
      body: `## Short\n\nWhen you need r.md, read \`${join(referencesDir(host), "tdd", "r.md")}\`.`, references: [{ name: "r.md", body: "One.\r\nTwo." }] } })],
  ])("refuses %s at Prepare, which the Ask would preview without it", async (_label, draft) => {
    const host = loadExtension();
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [{ kind: "upstream", skill: "tdd", gist: "Name the seam", remedy, ...draft(host) }] });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining("carriage return")] });
  });

  it("refuses at Prepare a compaction over a reference folder holding a subfolder, which replacing it would delete unseen", async () => {
    const host = loadExtension();
    const nested = join(referencesDir(host), "tdd", "drafts", "keep.md");
    mkdirSync(dirname(nested), { recursive: true });
    writeFileSync(nested, "The user's draft.\n");
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [{ kind: "upstream", skill: "tdd", gist: "Compact", remedy,
      priority: "compaction", change: { operation: "compaction", includes: [], body: "## Short\n\nName the seam.", references: [] } }] });
    expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining("holds more than reference files")] });
    expect(readFileSync(nested, "utf8")).toBe("The user's draft.\n");
  });

  it.each([
    ["an on-read append without its section", { kind: "upstream", skill: "tdd", change: { operation: "on-read-append", section: " " } }, "an on-read append needs its `section`"],
    ["an on-read section without its heading", { kind: "upstream", skill: "tdd", change: { operation: "on-read-append", section: "Name the seam." } }, "an on-read append's `section` is a `## ` heading line"],
    ["a rule without its body", { kind: "local", skill: "ce-commit-jj", change: { operation: "rule", name: "jj-not-git", body: "", pattern: "\\bgit commit\\b", scope: "tool:bash",
      matches: [{ command: "git commit" }], spares: [{ command: "jj commit" }] } }, "a rule change needs its `body`"],
    ["a rule for a new skill", { kind: "new", skill: "deploy-notes", change: { operation: "rule", name: "notes", body: "Draft notes.", pattern: "notes" } }, "prepare its barrier rule once the skill exists"],
  ])("names the Prepare field of %s", async (_label, draft, reason) => {
    const host = loadExtension();
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [{ gist: "Name the seam", priority: "evidence", remedy, ...draft }] });
    expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining(reason)] });
  });
});

describe("proposal approval of on-read appends", () => {
  const amendment = (host: ReturnType<typeof loadExtension>) => join(host.amendmentsDir, "tdd-amendment.md");
  const approved = async (answer?: AnswerUser) => {
    const host = loadExtension();
    const [applied] = await approveOnRead(host, [{ gist: "Name the seam", section: "  ## Seams\n\nName the seam first.\n\n", evidence: [{ quote: "which seam?", count: 1 }] }], answer);
    if (!applied) throw new Error("no applied answer");
    return { host, applied };
  };
  type Approved = Awaited<ReturnType<typeof approved>>;
  /** Resolves `outcomes` and expects a failure for `reason` that left every observer byte unchanged and recorded no Later or Decline. */
  const expectNoWrite = async (host: ReturnType<typeof loadExtension>, outcomes: unknown[], reason: string) => {
    const before = observerBytes(host);
    const result = await resolve(host, outcomes);
    expect(result.isError).toBe(true);
    expect(failures(result)).toEqual([expect.stringContaining(reason)]);
    expect((result.details as { records: unknown[] }).records).toEqual([]);
    expect(observerBytes(host)).toEqual(before);
  };
  /** The saved native Ask call and result an approval cites. */
  const savedAsk = ({ host, applied }: Approved) => {
    const id = applied.approval.askToolCallId;
    const call = host.getBranch().find((entry) => Array.isArray(entry.message?.content) && entry.message.content.some((block) => block.id === id));
    const result = host.getBranch().find((entry) => entry.message?.toolCallId === id);
    if (!call?.message || !result?.message) throw new Error("no saved Ask");
    const args = (call.message.content as Array<{ arguments?: ToolArguments }>)[0]?.arguments;
    if (!args) throw new Error("no saved Ask arguments");
    return { call, result, args, details: result.message.details as AskDetails };
  };

  it("appends exactly the prepared section the form showed above the Apply the user chose", async () => {
    const { host, applied } = await approved();
    const result = await resolve(host, [applied]);
    expect(result.isError).toBeFalsy();
    expect(savedAsk({ host, applied }).args.html)
      .toContain(`<p>Create the on-read amendment \`${amendment(host)}\` of \`tdd\` (upstream) with this section:<br><br>## Seams<br><br>Name the seam first.</p>`);
    expect(readRule(amendment(host)).body).toBe("## Seams\n\nName the seam first.");
    expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({
      skill: "tdd", kind: "upstream", gist: "Name the seam", outcome: "applied", fingerprint: proposalFingerprint("tdd", "Name the seam"),
      rule: amendment(host), evidence: [{ quote: "which seam?", count: 1 }],
    })]);
  });

  it.each<[string, string, (fixture: Approved) => Record<string, unknown>]>([
    ["a raw section draft", "not a `rule`", ({ applied: { approval: _, ...answer } }) => ({ ...answer, rule: { body: "## Seams\n\nName the seam first." } })],
    ["a raw draft with a blank pattern", "not a `rule`", ({ applied: { approval: _, ...answer } }) => ({ ...answer, rule: { body: "## Seams\n\nName the seam first.", pattern: " " } })],
    ["an approval beside a substituted section", "not a `rule`", ({ applied }) => ({ ...applied, rule: { body: "## Seams\n\nSubstituted." } })],
    ["an applied answer without approval", "needs `approval`", ({ applied: { approval: _, ...answer } }) => answer],
    ["a forged Prepare reference", "no completed review call", ({ applied }) =>
      ({ ...applied, approval: { ...applied.approval, proposal: { ...applied.approval.proposal, reviewToolCallId: "observer_review-call-99" } } })],
    ["a changed content hash", "content hash", ({ applied }) =>
      ({ ...applied, approval: { ...applied.approval, proposal: { ...applied.approval.proposal, contentHash: "0".repeat(64) } } })],
    ["a forged Select ID", "no single completed selection call", ({ applied }) => ({ ...applied, approval: { ...applied.approval, selectionToolCallId: "observer_review-call-99" } })],
    ["the Prepare cited as its Select", "not a successful observer_review Select", ({ applied }) =>
      ({ ...applied, approval: { ...applied.approval, selectionToolCallId: applied.approval.proposal.reviewToolCallId } })],
    ["a forged Ask ID", "no single completed Ask call", ({ applied }) => ({ ...applied, approval: { ...applied.approval, askToolCallId: "ask-99" } })],
    ["the Select cited as its Ask", "not an ask the model made itself", ({ applied }) =>
      ({ ...applied, approval: { ...applied.approval, askToolCallId: applied.approval.selectionToolCallId } })],
    ["another proposal's identity", "not this answer", ({ applied }) => ({ ...applied, gist: "Name every seam" })],
    ["an approval beside a raw pattern rule", "not a `rule`", ({ applied }) =>
      ({ ...applied, rule: { name: "tdd-seams", body: "Name the seam.", pattern: "\\bseams?\\b", matches: ["which seam"], spares: ["done"] } })],
    ["an approval on a Later answer", "comes only with an applied on-read fix", ({ applied }) => ({ ...applied, outcome: "later" })],
  ])("writes nothing for %s", async (_label, reason, answer) => {
    const fixture = await approved();
    await expectNoWrite(fixture.host, [answer(fixture)], reason);
  });

  it.each<[string, string, string]>([
    ["Decline", "selected `Decline`", "Decline"],
    ["Later", "selected `Later`", "Later"],
    ["no option", "selected no option", ""],
    ["Apply joined with another label", "selected `Apply, Later`", "Apply, Later"],
    ["custom input", "custom input", "Other: yes apply it"],
  ])("writes nothing when the user's answer is %s", async (_label, reason, answer) => {
    const { host, applied } = await approved(() => answer);
    await expectNoWrite(host, [applied], reason);
  });

  it("writes nothing for an Apply with an approval note and no revision, quoting the note and asking for the revision", async () => {
    const { host, applied } = await approved(() => ({ option: "Apply", note: "  Say it in one line.  " }));
    const before = observerBytes(host);
    const result = await resolve(host, [applied]);
    expect(failures(result)).toEqual([expect.stringMatching(/"Say it in one line\.".*observer_review/)]);
    expect((result.details as { records: unknown[] }).records).toEqual([]);
    expect(observerBytes(host)).toEqual(before);
  });

  it("treats a whitespace-only note on Apply as no note", async () => {
    const { host, applied } = await approved(() => ({ option: "Apply", note: " \n " }));
    expect((await resolve(host, [applied])).isError).toBeFalsy();
    expect(readRule(amendment(host)).body).toBe("## Seams\n\nName the seam first.");
  });

  it("writes nothing for a Later with a note that cites the approval: a note never stands in for Apply", async () => {
    const { host, applied } = await approved(() => ({ option: "Later", note: "Apply it next week." }));
    await expectNoWrite(host, [applied], "selected `Later`");
  });

  it("records a Decline with a note exactly as one without", async () => {
    const recorded = async (answer: AnswerUser) => {
      const { host, applied } = await approved(answer);
      const result = await resolve(host, [{ proposal: applied.approval.proposal, outcome: "declined" }]);
      expect(failures(result)).toEqual([]);
      return { files: ownedFiles(host), records: ledgerRecords(host.ledgerFile).map(({ timestamp: _, sessionId: __, ...record }) => record) };
    };
    expect(await recorded(() => ({ option: "Decline", note: "Only for unit tests." }))).toEqual(await recorded(() => "Decline"));
  });

  it.each<[string, string, (fixture: Approved) => void]>([
    ["a cancelled Ask", "cancelled", (fixture) => {
      const { result } = savedAsk(fixture);
      result.message!.isError = true;
      result.message!.details = {};
    }],
    ["text claiming consent over an empty answer", "selected no option", (fixture) => {
      const { result, details } = savedAsk(fixture);
      details.answers![0]!.answer = "";
      result.message!.content = [{ type: "text", text: "User selected: Apply" }];
    }],
    ["Apply submitted by a timeout", "timed out", (fixture) => { savedAsk(fixture).details.timedOut = true; }],
    ["a form differing from the Select's by one character", "not this Select's `askHtml` unchanged", (fixture) => {
      const { args } = savedAsk(fixture);
      args.html = `${args.html} `;
    }],
    ["an answer under another name", "no single answer", (fixture) => { savedAsk(fixture).details.answers![0]!.name = "proposal:000000000000"; }],
    ["a result without answers", "no single answer", (fixture) => { savedAsk(fixture).details.answers = []; }],
    ["two answers for the proposal", "no single answer", (fixture) => {
      const { answers } = savedAsk(fixture).details;
      answers!.push({ ...answers![0]! });
    }],
    ["duplicate Ask results", "no single completed Ask call", (fixture) => { fixture.host.getBranch().push(structuredClone(savedAsk(fixture).result)); }],
    ["a hook-only Ask", "not an ask the model made itself", (fixture) => {
      const { call, result, args, details } = savedAsk(fixture);
      const id = fixture.applied.approval.askToolCallId;
      fixture.host.setBranch(fixture.host.getBranch().flatMap((entry): SessionEntry[] => {
        if (entry === call) return [{ type: "custom", id: "hook-call", customType: "skill-observer-tool-call", data: { toolCallId: id, toolName: "ask", input: args } }];
        if (entry === result) return [{ type: "custom", id: "hook-result", customType: "skill-observer-tool-result",
          data: { toolCallId: id, toolName: "ask", input: args, isError: false, details, content: [] } }];
        return [entry];
      }));
    }],
    ["an Ask saved before its Select", "must follow", (fixture) => {
      const { call, result } = savedAsk(fixture);
      const rest = fixture.host.getBranch().filter((entry) => entry !== call && entry !== result);
      const select = rest.findIndex((entry) => entry.message?.role === "assistant" && JSON.stringify(entry).includes('"select"'));
      fixture.host.setBranch([...rest.slice(0, select), call, result, ...rest.slice(select)]);
    }],
  ])("writes nothing for %s", async (_label, reason, edit) => {
    const fixture = await approved();
    edit(fixture);
    await expectNoWrite(fixture.host, [fixture.applied], reason);
  });

  it("binds each answer of one form to its own proposal", async () => {
    const host = loadExtension();
    const seams = `proposal:${proposalFingerprint("tdd", "Name the seam")}`;
    const [seamsAnswer, redAnswer] = await approveOnRead(host, [{ gist: "Name the seam", section: SEAMS }, { gist: "Red is a diff", section: RED }],
      (proposal) => proposal.candidateId === seams ? "Apply" : "Decline");
    const result = await resolve(host, [seamsAnswer, redAnswer]);
    expect(failures(result)).toEqual([expect.stringContaining("selected `Decline`")]);
    expect(readRule(amendment(host)).body).toBe(SEAMS);
    expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({ gist: "Name the seam", outcome: "applied" })]);
  });

  it("writes nothing when the Ask showed the form of another Select than the approval cites", async () => {
    const host = loadExtension();
    startPass(host);
    const prepared = await host.callTool("observer_review", { action: "prepare",
      candidates: [{ gist: "Name the seam", section: SEAMS }, { gist: "Red is a diff", section: RED }].map(onReadCandidate) });
    const references = reviewEntries(prepared).map((entry) => entry.reference);
    await host.callTool("observer_review", { action: "select", proposals: references });
    const selectionToolCallId = lastCallId(host);
    const askToolCallId = askUser(host, await host.callTool("observer_review", { action: "select", proposals: references.slice(0, 1) }));
    const answer = { skill: "tdd", kind: "upstream", gist: "Name the seam", outcome: "applied", approval: { proposal: references[0], selectionToolCallId, askToolCallId } };
    await expectNoWrite(host, [answer], "not this Select's `askHtml` unchanged");
  });

  it.each<[string, string, (fixture: Approved) => void]>([
    ["an ordinary prompt", "no observation pass is current", ({ host }) => {
      host.getBranch().push({ type: "message", id: "prompt", message: { role: "user", content: "Now the next task." } });
    }],
    ["a /clear reset", "no observation pass is current", ({ host }) => { host.getBranch().push({ type: "reset_boundary", id: "reset" }); }],
    ["a /skill: start", "no observation pass is current", ({ host }) => {
      host.getBranch().push({ type: "custom_message", id: "skill", customType: "skill-prompt", content: "Skill.", details: { name: "tdd" } });
    }],
    ["a new /observe", "earlier observation pass", ({ host }) => { startPass(host); }],
    ["a retraction steering message", "may retract", ({ host }) => {
      host.getBranch().push({ type: "message", id: "steer", message: { role: "user", steering: true, content: "Wait, don't add the seam section." } });
    }],
    ["a branch without the Ask receipts", "no single completed Ask call", ({ host, applied }) => {
      host.setBranch(host.getBranch().filter((entry) => !JSON.stringify(entry).includes(`"${applied.approval.askToolCallId}"`)));
    }],
    ["a branch without the observation message", "no observation pass is current", ({ host }) => {
      host.setBranch(host.getBranch().filter((entry) => entry.customType !== "skill-observer"));
    }],
  ])("ends the approval at %s after the answer", async (_label, reason, end) => {
    const fixture = await approved();
    end(fixture);
    await expectNoWrite(fixture.host, [fixture.applied], reason);
  });

  it("keeps the approval across compaction, agent and harness messages, and a reload of the saved session", async () => {
    const fixture = await approved();
    const { host, applied } = fixture;
    host.getBranch().push(
      { type: "compaction", id: "compaction", firstKeptEntryId: String(savedAsk(fixture).result.id) },
      { type: "message", id: "agent", message: { role: "user", attribution: "agent", content: "Subagent finished." } },
      { type: "message", id: "harness", message: { role: "user", synthetic: true, content: "Reminder." } },
      { type: "custom_message", id: "async", customType: "async-result", content: "<task-result>done</task-result>" },
      { type: "message", id: "text", message: { role: "assistant", content: [{ type: "text", text: "Recording the answers." }] } },
    );
    host.setBranch(JSON.parse(JSON.stringify(host.getBranch())));
    const result = await resolve(host, [applied]);
    expect(result.isError).toBeFalsy();
    expect(readRule(amendment(host)).body).toBe("## Seams\n\nName the seam first.");
  });

  it("lets a second call of the same pass reuse the approval without appending the section twice", async () => {
    const { host, applied } = await approved();
    expect((await resolve(host, [applied])).isError).toBeFalsy();
    expect((await resolve(host, [applied])).isError).toBeFalsy();
    expect(readRule(amendment(host)).body).toBe("## Seams\n\nName the seam first.");
    expect(ledgerRecords(host.ledgerFile).map(({ outcome }) => outcome)).toEqual(["applied", "applied"]);
  });

  it("checks the approval again right before writing, after the call's replay wait", async () => {
    const { host, applied } = await approved();
    const before = observerBytes(host);
    const pending = resolve(host, [applied]);
    host.getBranch().push({ type: "message", id: "steer", message: { role: "user", steering: true, content: "Stop, not that one." } });
    const result = await pending;
    expect(failures(result)).toEqual([expect.stringContaining("may retract")]);
    expect(observerBytes(host)).toEqual(before);
  });
});

describe("proposal reconciliation of on-read appends", () => {
  const amendment = (host: ReturnType<typeof loadExtension>) => join(host.amendmentsDir, "tdd-amendment.md");
  const MINE = "## Mine\n\nThe user's own words.";
  const claim = { changedTarget: "The user appended a Mine section.", reason: "Append the approved section after it.", preserved: "The section is unchanged and Mine stays as written." };
  /** `tdd`'s amendment holding Seams, an approved Red append, and then the user's unrelated edit appending Mine to the amendment. */
  const changedAfterApproval = async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
    const [applied] = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }]);
    if (!applied) throw new Error("no applied answer");
    appendFileSync(amendment(host), `\n${MINE}\n`);
    return { host, applied };
  };
  type Changed = Awaited<ReturnType<typeof changedAfterApproval>>;
  const reviseCandidate = ({ applied }: Changed, overrides: Record<string, unknown> = {}) => ({
    kind: "upstream", skill: "tdd", gist: applied.gist, priority: "evidence", remedy: "Add the missing guidance",
    change: { operation: "on-read-append", section: RED }, reconciles: { approval: applied.approval, ...claim }, ...overrides,
  });
  const prepareRevision = (host: ReturnType<typeof loadExtension>, candidate: unknown) =>
    host.callTool("observer_review", { action: "prepare", candidates: [candidate] });
  /** Prepares the revision of the approved Red append and returns the answer citing it. */
  const reconciled = async (fixture: Changed) => {
    const prepared = await prepareRevision(fixture.host, reviseCandidate(fixture));
    expect(prepared.isError).toBeFalsy();
    const [revision] = reviewEntries(prepared);
    if (!revision) throw new Error("no revision");
    return { ...fixture.applied, approval: { ...fixture.applied.approval, revision: revision.reference } };
  };
  const expectNoWrite = async (host: ReturnType<typeof loadExtension>, outcomes: unknown[], reason: string) => {
    const before = { amendment: readFileSync(amendment(host), "utf8"), ledger: readFileSync(host.ledgerFile, "utf8") };
    const result = await resolve(host, outcomes);
    expect(failures(result)).toEqual([expect.stringContaining(reason)]);
    expect({ amendment: readFileSync(amendment(host), "utf8"), ledger: readFileSync(host.ledgerFile, "utf8") }).toEqual(before);
  };

  it("writes nothing when the amendment changed after Prepare and no reconciliation cites the approval", async () => {
    const { host, applied } = await changedAfterApproval();
    await expectNoWrite(host, [applied], "changed since Prepare");
  });

  it("appends the revised section after the user's unrelated edit, reporting the reconciliation apart from the user's approval", async () => {
    const fixture = await changedAfterApproval();
    const answer = await reconciled(fixture);
    const result = await resolve(fixture.host, [answer]);
    expect(result.isError).toBeFalsy();
    expect(readRule(amendment(fixture.host)).body).toBe(`${SEAMS}\n\n${MINE}\n\n${RED}`);
    const { revision, ...approval } = answer.approval;
    expect((result.details as { approvals: unknown[] }).approvals).toEqual([{
      fingerprint: fixture.applied.fingerprint, approval, selected: "Apply", reconciliation: { revision, ...claim, preview: expect.stringContaining(RED) },
    }]);
    expect(resultText(result)).toContain(`reconciled by the main agent in revision \`${revision.candidateId}\` of review \`${revision.reviewToolCallId}\`, not approved by the user`);
  });

  it("writes nothing when the amendment changed again after the revision was prepared", async () => {
    const fixture = await changedAfterApproval();
    const answer = await reconciled(fixture);
    appendFileSync(amendment(fixture.host), "\n## Later\n\nMore of the user's words.\n");
    await expectNoWrite(fixture.host, [answer], "changed since the reconciliation");
  });

  it.each<[string, string, (fixture: Changed) => Record<string, unknown>]>([
    ["a revision that rewrites the amendment without the user's section", "only an on-read append",
      () => ({ priority: "stale", gist: "Gist of tdd-amendment.", change: { operation: "stale-update", rule: "tdd-amendment", body: `${SEAMS}\n\n${RED}` } })],
    ["a revision that deletes the changed amendment", "only an on-read append",
      () => ({ priority: "stale", gist: "Gist of tdd-amendment.", change: { operation: "stale-delete", rule: "tdd-amendment" } })],
    ["a revision for another skill", "approved proposal's own", () => ({ skill: "domain-modeling" })],
    ["a revision under another identity", "approved proposal's own", () => ({ gist: "Reds are diffs of assertions." })],
    ["a revision without its judgment", "preserved", ({ applied }) => ({ reconciles: { approval: applied.approval, ...claim, preserved: "" } })],
    ["a revision citing a forged Ask", "no single completed Ask call", ({ applied }) =>
      ({ reconciles: { approval: { ...applied.approval, askToolCallId: "ask-99" }, ...claim } })],
  ])("refuses to prepare %s", async (_label, reason, overrides) => {
    const fixture = await changedAfterApproval();
    const result = await prepareRevision(fixture.host, reviseCandidate(fixture, overrides(fixture)));
    expect(result.isError).toBe(true);
    expect((result.details as { failures: string[] }).failures).toEqual([expect.stringContaining(reason)]);
  });

  it("refuses to prepare a revision for an amendment that did not change", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
    const [applied] = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }]);
    const result = await prepareRevision(host, reviseCandidate({ host, applied: applied! }));
    expect((result.details as { failures: string[] }).failures).toEqual([expect.stringContaining("unchanged")]);
  });

  it.each<[string, string, (fixture: Changed, answer: Awaited<ReturnType<typeof reconciled>>) => unknown]>([
    ["a branch without the original Ask", "no single completed Ask call", ({ host, applied }, answer) => {
      host.setBranch(host.getBranch().filter((entry) => !JSON.stringify(entry).includes(`"${applied.approval.askToolCallId}"`)));
      return answer;
    }],
    ["a message the user sent after the revision", "may retract", ({ host }, answer) => {
      host.getBranch().push({ type: "message", id: "steer", message: { role: "user", steering: true, content: "Leave my section alone." } });
      return answer;
    }],
    ["a forged revision reference", "content hash", (_fixture, answer) =>
      ({ ...answer, approval: { ...answer.approval, revision: { ...answer.approval.revision, contentHash: "0".repeat(64) } } })],
  ])("writes nothing for %s", async (_label, reason, edit) => {
    const fixture = await changedAfterApproval();
    const answer = await reconciled(fixture);
    await expectNoWrite(fixture.host, [edit(fixture, answer)], reason);
  });

  it("binds a revision to the proposal it revises: another approved proposal cannot cite it", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
    const [red, oneBehaviour] = await approveOnRead(host, [
      { gist: "A red is an assertion diff.", section: RED },
      { gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR },
    ]);
    appendFileSync(amendment(host), `\n${MINE}\n`);
    const answer = await reconciled({ host, applied: red! });
    await expectNoWrite(host, [{ ...oneBehaviour, approval: { ...oneBehaviour!.approval, revision: answer.approval.revision } }], "lineage");
  });

  describe("under an approval note", () => {
    const NOTE = "Say it in one line.";
    const REVISED = "## Red\n\nA red is an assertion diff.";
    const judgment = { reason: "The user asked for one line.", preserved: "Same Red guidance, shorter; nothing else in the amendment changes." };
    /** `tdd`'s amendment holding Seams, and the user's Apply to a Red append with NOTE attached. */
    const noted = async (): Promise<Changed> => {
      const host = loadExtension();
      await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
      const [applied] = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }], () => ({ option: "Apply", note: NOTE }));
      if (!applied) throw new Error("no applied answer");
      return { host, applied };
    };
    const revise = (fixture: Changed, overrides: Record<string, unknown> = {}) => prepareRevision(fixture.host, reviseCandidate(fixture,
      { change: { operation: "on-read-append", section: REVISED }, reconciles: { approval: fixture.applied.approval, ...judgment }, ...overrides }));
    /** Prepares the revision as `revise` does and returns the answer citing it. */
    const citing = async (fixture: Changed, overrides?: Record<string, unknown>) => {
      const prepared = await revise(fixture, overrides);
      expect(failures(prepared)).toEqual([]);
      const [revision] = reviewEntries(prepared);
      if (!revision) throw new Error("no revision");
      return { ...fixture.applied, approval: { ...fixture.applied.approval, revision: revision.reference } };
    };

    it("writes the section as the note revised it, without a second Ask, and reports the note, the reason and the text written", async () => {
      const fixture = await noted();
      const answer = await citing(fixture);
      const result = await resolve(fixture.host, [answer]);
      expect(result.isError).toBeFalsy();
      expect(readRule(amendment(fixture.host)).body).toBe(`${SEAMS}\n\n${REVISED}`);
      expect(fixture.host.getBranch().findLast((entry) => entry.message?.toolName === "ask")?.message?.toolCallId).toBe(answer.approval.askToolCallId);
      const { revision, ...approval } = answer.approval;
      expect((result.details as { approvals: unknown[] }).approvals).toEqual([{
        fingerprint: fixture.applied.fingerprint, approval, selected: "Apply", note: NOTE, reconciliation: { revision, ...judgment, preview: expect.stringContaining(REVISED) },
      }]);
      expect(resultText(result)).toContain(NOTE);
      expect(resultText(result)).toContain(judgment.reason);
      expect(resultText(result)).toContain("A red is an assertion diff.");
      const record = ledgerRecords(fixture.host.ledgerFile).at(-1)!;
      expect(Object.keys(record).sort()).toEqual(Object.keys(ledgerRecords(fixture.host.ledgerFile)[0]!).sort());
      expect(record).toMatchObject({ gist: "A red is an assertion diff.", outcome: "applied", rule: amendment(fixture.host) });
    });

    it("covers the note and a target changed after Prepare with one revision, which states how the target changed", async () => {
      const fixture = await noted();
      appendFileSync(amendment(fixture.host), `\n${MINE}\n`);
      expect(failures(await revise(fixture))).toEqual([expect.stringContaining("changedTarget")]);
      const answer = await citing(fixture, { reconciles: { approval: fixture.applied.approval, ...judgment, changedTarget: claim.changedTarget } });
      const result = await resolve(fixture.host, [answer]);
      expect(result.isError).toBeFalsy();
      expect(readRule(amendment(fixture.host)).body).toBe(`${SEAMS}\n\n${MINE}\n\n${REVISED}`);
      expect((result.details as { approvals: Array<{ note?: string; reconciliation?: Record<string, unknown> }> }).approvals)
        .toEqual([expect.objectContaining({ note: NOTE, reconciliation: expect.objectContaining({ changedTarget: claim.changedTarget }) })]);
    });

    it("writes the approved section unchanged under a note that only asks for a check, reporting the note and what was checked", async () => {
      const fixture = await noted();
      const checked = { reason: "Checked the amendment: no section covers reds yet.", preserved: "The approved section, unchanged." };
      const answer = await citing(fixture, { change: { operation: "on-read-append", section: RED }, reconciles: { approval: fixture.applied.approval, ...checked } });
      const result = await resolve(fixture.host, [answer]);
      expect(result.isError).toBeFalsy();
      expect(readRule(amendment(fixture.host)).body).toBe(`${SEAMS}\n\n${RED}`);
      for (const shown of [NOTE, checked.reason]) expect(resultText(result)).toContain(shown);
    });

    it.each<[string, string, Record<string, unknown>]>([
      ["for another skill", "approved proposal's own", { skill: "domain-modeling" }],
      ["under another ledger identity", "approved proposal's own", { gist: "Reds are diffs of assertions." }],
    ])("refuses to prepare a revision %s", async (_label, reason, overrides) => {
      const result = await revise(await noted(), overrides);
      expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining(reason)] });
    });

    it("writes nothing for a revision saved before the user answered", async () => {
      const fixture = await noted();
      const answer = await citing(fixture);
      const branch = fixture.host.getBranch();
      const revisionEntries = branch.filter((entry) => JSON.stringify(entry).includes(`"${answer.approval.revision.reviewToolCallId}"`));
      const rest = branch.filter((entry) => !revisionEntries.includes(entry));
      const askCall = rest.findIndex((entry) => JSON.stringify(entry).includes(`"${answer.approval.askToolCallId}"`));
      fixture.host.setBranch([...rest.slice(0, askCall), ...revisionEntries, ...rest.slice(askCall)]);
      await expectNoWrite(fixture.host, [answer], "prepared before the user answered");
    });
  });
});

type Outcome = { skill: string; kind: string; gist: string; outcome: string; fingerprint?: string };

const outcome = (skill: string, kind: string, gist: string, answer: string): Outcome => ({
  skill,
  kind,
  gist,
  outcome: answer,
});

function ledgerRecords(file: string): Array<Record<string, string>> {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** The file names in the rules and amendments directories; none before a rule is written. */
function rulesWritten(host: { rulesDir: string; amendmentsDir: string }): string[] {
  return [host.rulesDir, host.amendmentsDir].flatMap((dir) => (existsSync(dir) ? readdirSync(dir) : []));
}

/** A tool result's text blocks as one string. */
function resultText(result: ToolResult<unknown>): string {
  return result.content.map((block) => block.text).join("\n");
}

/**
 * Writes an on-read amendment of `skill` as passes before ADR 0003 left it,
 * one file per fix, moved to the amendments directory since: a skill whose
 * split amendments no migration has joined yet. The fix's applied ledger
 * record names the file in the rules directory where the pass wrote it.
 */
function splitAmendment(
  host: ReturnType<typeof loadExtension>,
  skill: string,
  name: string,
  options: { body?: string; evidence?: Array<{ quote: string; count: number }> } = {},
): void {
  const gist = `Gist of ${name}.`;
  const fingerprint = proposalFingerprint(skill, gist);
  mkdirSync(host.amendmentsDir, { recursive: true });
  writeFileSync(
    join(host.amendmentsDir, `${name}.md`),
    `---\ndescription: "${gist}"\namends: "${skill}"\nskillHash: "${currentSkillHash(host, skill)}"\nfingerprint: "${fingerprint}"\ngeneratedBy: "skill-observer"\n---\n\n${options.body ?? `Body of ${name}.`}\n`,
  );
  const rule = join(host.rulesDir, `${name}.md`);
  const record = { fingerprint, skill, kind: "upstream", gist, outcome: "applied", rule, evidence: options.evidence, timestamp: new Date().toISOString(), sessionId: "fixture-session" };
  mkdirSync(dirname(host.ledgerFile), { recursive: true });
  appendFileSync(host.ledgerFile, `${JSON.stringify(record)}\n`);
}

/**
 * Reads `path` through the host's hooks and saves the call and its result on
 * the branch. A native call reaches an assistant message of the branch after
 * its `tool_call` hooks, as in OMP; a nested one, made from eval, has only its
 * hooks. Returns the result as the `tool_result` handlers leave it.
 */
async function readSkill(host: ReturnType<typeof loadExtension>, path: string, options: { nested?: boolean; isError?: boolean } = {}) {
  const id = `read-${host.getBranch().length}`;
  const input = { path };
  await host.toolCall("read", input, id);
  if (!options.nested) {
    host.getBranch().push({ type: "message", id: `call-${id}`, message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: input }] } });
  }
  const result = await host.toolResult({ toolName: "read", toolCallId: id, input, content: [{ type: "text", text: "Skill instructions." }], isError: options.isError ?? false });
  host.getBranch().push({ type: "message", id: `result-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "read", content: result.content, isError: result.isError } });
  return result;
}

describe("observer_resolve", () => {
  it("appends one ledger record per outcome and reports the ledger it wrote", async () => {
    const host = loadExtension();
    const result = await host.callTool("observer_resolve", {
      outcomes: [
        outcome("ce-commit-jj", "local", "Ask one question at a time.", "applied"),
        outcome("implement-spec", "managed", "Run the typecheck before each commit.", "later"),
        outcome("deploy-notes", "new", "Draft release notes from the jj log.", "declined"),
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain(host.ledgerFile);
    const record = (skill: string, kind: string, answer: string) =>
      expect.objectContaining({
        skill,
        kind,
        outcome: answer,
        fingerprint: expect.any(String),
        timestamp: expect.any(String),
        sessionId: "fixture-session",
      });
    expect(ledgerRecords(host.ledgerFile)).toEqual([
      record("ce-commit-jj", "local", "applied"),
      record("implement-spec", "managed", "later"),
      record("deploy-notes", "new", "declined"),
    ]);
  });

  it("gives the same fingerprint to gists that differ only in case, punctuation or spacing", async () => {
    const host = loadExtension();
    await host.callTool("observer_resolve", {
      outcomes: [
        outcome("tdd", "upstream", "Re-run the seam's test first.", "later"),
        outcome("tdd", "upstream", "re-run  the seam's test, FIRST", "later"),
        outcome("tdd", "upstream", "Rerun the seams test first", "later"),
        outcome("grill-with-docs", "upstream", "Re-run the seam's test first.", "later"),
        outcome("tdd", "upstream", "Re-run the seam's test last.", "later"),
      ],
    });

    const [first, restyled, rePunctuated, otherSkill, otherGist] = ledgerRecords(host.ledgerFile).map((r) => r.fingerprint);
    expect(restyled).toBe(first);
    expect(rePunctuated).toBe(first);
    expect(otherSkill).not.toBe(first);
    expect(otherGist).not.toBe(first);
  });

  it("keeps the evidence an answer cites on its ledger record, and records an answer without evidence", async () => {
    const host = loadExtension();
    const evidence = [
      { quote: "run only the failing test, not the whole suite", count: 3 },
      { quote: "`ts-no-tiny-functions` fired", count: 1 },
    ];
    const result = await host.callTool("observer_resolve", {
      outcomes: [
        { ...outcome("tdd", "upstream", "Run the one failing test first.", "later"), evidence },
        outcome("grill-with-docs", "upstream", "Ask one question at a time.", "declined"),
      ],
    });

    expect(result.isError).toBeFalsy();
    const [cited, uncited] = ledgerRecords(host.ledgerFile);
    expect(cited).toMatchObject({ skill: "tdd", outcome: "later", evidence });
    expect(uncited).toMatchObject({ skill: "grill-with-docs", outcome: "declined" });
    expect(uncited).not.toHaveProperty("evidence");
  });

  it("keeps a re-offered Later entry's earlier evidence on its new answer, unless the answer cites its own", async () => {
    const host = loadExtension();
    const earlier = [{ quote: "run only the failing test", count: 2 }];
    const fresh = [{ quote: "the whole suite again", count: 1 }];
    await host.callTool("observer_resolve", {
      outcomes: [
        { ...outcome("tdd", "upstream", "Run the one failing test first.", "later"), evidence: earlier },
        { ...outcome("grill-with-docs", "upstream", "Ask one question at a time.", "later"), evidence: earlier },
      ],
    });
    const [tdd, grill] = ledgerRecords(host.ledgerFile);
    await host.callTool("observer_resolve", {
      outcomes: [
        { ...outcome("tdd", "upstream", "Run the one failing test first.", "declined"), fingerprint: tdd?.fingerprint },
        { ...outcome("grill-with-docs", "upstream", "Ask one question at a time.", "declined"), fingerprint: grill?.fingerprint, evidence: fresh },
      ],
    });

    const [, , tddAgain, grillAgain] = ledgerRecords(host.ledgerFile);
    expect(tddAgain).toMatchObject({ outcome: "declined", evidence: earlier });
    expect(grillAgain).toMatchObject({ outcome: "declined", evidence: fresh });
  });

  it("keeps a new answer when the ledger ends in a line cut short by an interrupted write", async () => {
    const host = loadExtension();
    mkdirSync(dirname(host.ledgerFile), { recursive: true });
    writeFileSync(host.ledgerFile, '{"fingerprint":"0123456789ab","skill":"tdd","outc');
    await host.callTool("observer_resolve", {
      outcomes: [outcome("deploy-notes", "new", "Draft release notes from the jj log.", "later")],
    });

    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage]);
    await host.runCommand("observe");
    expect(String(host.sent[0]?.message.content)).toContain("Draft release notes from the jj log.");
  });
});

describe("project proposal decisions", () => {
  const projectAnswer = (root: string, path = "package.json", answer = "declined") => ({
    kind: "project", target: { scope: "project", root, path, mechanism: "Wire the existing typecheck." },
    gist: "Wire the existing typecheck.", outcome: answer,
  });

  it("shows global history and only the current project's decisions from one shared ledger", async () => {
    const host = loadExtension();
    const a = join(host.skillHome.home, "project-a");
    const b = join(host.skillHome.home, "project-b");
    mkdirSync(a); mkdirSync(b);
    host.setCwd(a);
    await host.callTool("observer_resolve", { outcomes: [
      { ...projectAnswer(a, "package.json", "later"), gist: "Project A check." },
      outcome("tdd", "upstream", "Global check.", "later"),
    ] });
    host.setCwd(b);
    await host.callTool("observer_resolve", { outcomes: [{ ...projectAnswer(b, "package.json", "later"), gist: "Project B check." }] });
    await host.runCommand("observe", "Review checks");
    const message = String(host.sent[0]?.message.content);
    expect(message).toContain("Project B check.");
    expect(message).toContain("Global check.");
    expect(message).not.toContain("Project A check.");
    const records = ledgerRecords(host.ledgerFile);
    expect(records[0]?.fingerprint).not.toBe(records[2]?.fingerprint);
    expect(records[1]?.fingerprint).toBe(proposalFingerprint("tdd", "Global check."));
  });

  it("canonicalizes root and target symlink aliases while accepting a missing safe leaf", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const alias = join(host.skillHome.home, "project-alias");
    symlinkSync(root, alias);
    mkdirSync(join(root, "checks"));
    symlinkSync(join(root, "checks"), join(root, "alias-checks"));
    host.setCwd(root);
    const evidence = [{ quote: "the existing check is not wired", count: 2 }];
    await host.callTool("observer_resolve", { outcomes: [{ ...projectAnswer(root, "checks/new.json", "later"), evidence }] });
    host.setCwd(alias);
    const result = await host.callTool("observer_resolve", { outcomes: [projectAnswer(alias, "alias-checks/new.json")] });
    expect(result.isError).toBeFalsy();
    const [first, second] = ledgerRecords(host.ledgerFile);
    expect(second?.fingerprint).toBe(first?.fingerprint);
    expect(second).toMatchObject({ target: { scope: "project", root, path: "checks/new.json" }, evidence });
    expect(existsSync(join(root, "checks/new.json"))).toBe(false);
    expect(rulesWritten(host)).toEqual([]);
  });

  it("rejects malformed, foreign-root and escaping targets even without host schema validation", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const outside = join(host.skillHome.home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "missing"), join(root, "dangling"));
    const invalid = [
      projectAnswer(root, "../outside/file"), projectAnswer(root, "/tmp/file"),
      projectAnswer(root, "escape/new/file"), projectAnswer(root, "dangling/file"),
      projectAnswer(outside), projectAnswer(root, ""), projectAnswer(root, "."),
      { ...projectAnswer(root), target: { scope: "project", root, path: 17, mechanism: "check" } },
      { ...projectAnswer(root), fingerprint: "forged-global" },
      { ...projectAnswer(root), rule: { body: "Not a skill amendment" } },
      { ...projectAnswer(root), outcome: "withdrawn" },
    ];
    const result = await host.callTool("observer_resolve", { outcomes: invalid });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ records: [], failures: expect.any(Array) });
    const details = result.details;
    expect(details && typeof details === "object" && "failures" in details ? details.failures : undefined).toHaveLength(invalid.length);
    expect(existsSync(host.ledgerFile)).toBe(false);
    expect(rulesWritten(host)).toEqual([]);
  });

  it("refuses an applied project answer without observed write and verification evidence", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    writeFileSync(join(root, "package.json"), "{}\n");
    const result = await host.callTool("observer_resolve", { outcomes: [{
      ...projectAnswer(root, "package.json", "applied"),
      publication: { beforeHash: "invented", afterHash: "invented", writeToolCallId: "missing", checkToolCallIds: ["missing"] },
    }] });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ records: [] });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe("{}\n");
    expect(existsSync(host.ledgerFile)).toBe(false);
  });

  it("records an observed normal-tool project publication without making a skill rule", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const file = join(root, "package.json");
    const content = '{"scripts":{"typecheck":"tsc --noEmit"}}\n';
    writeFileSync(file, content);
    host.setBranch(JSON.parse(JSON.stringify([
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "project-write", name: "write", arguments: { path: file, content } }] } },
      { type: "message", message: { role: "toolResult", toolName: "write", toolCallId: "project-write", isError: false, content: [{ type: "text", text: "Written" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "project-check", name: "bash", arguments: { command: "bun run typecheck", cwd: root } }] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "project-check", isError: false, details: { timeoutSeconds: 30, wallTimeMs: 5 } } },
    ])));
    const publication = {
      writeToolCallId: "project-write", checkToolCallIds: ["project-check"],
      afterHash: createHash("sha256").update(content).digest("hex"),
    };
    const result = await host.callTool("observer_resolve", { outcomes: [{ ...projectAnswer(root, "package.json", "applied"), publication }] });
    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ records: [{ kind: "project", outcome: "applied", publication }] });
    expect(ledgerRecords(host.ledgerFile)[0]).not.toHaveProperty("skill");
    expect(ledgerRecords(host.ledgerFile)[0]).not.toHaveProperty("rule");
    expect(rulesWritten(host)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("accepts a nullable service name on a completed foreground verification", async () => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    const content = "{}\n";
    writeFileSync(join(root, "package.json"), content);
    host.setBranch([
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "write", name: "write", arguments: { path: "package.json", content } }] } },
      { type: "message", message: { role: "toolResult", toolName: "write", toolCallId: "write", isError: false } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "check", name: "bash", arguments: { command: "node --check app.js", cwd: root, name: null, async: false } }] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "check", isError: false, details: { exitCode: 0 } } },
    ]);
    const result = await host.callTool("observer_resolve", { outcomes: [{
      ...projectAnswer(root, "package.json", "applied"),
      publication: { writeToolCallId: "write", checkToolCallIds: ["check"], afterHash: createHash("sha256").update(content).digest("hex") },
    }] });
    expect(result.details).toMatchObject({ records: [{ outcome: "applied" }], failures: [] });
  });

  it.each(["safe sibling", "outside sibling", "symlink escape", "missing target", "outside sibling with target hint"] as const)(
    "validates every multi-file edit path with %s", async (scenario) => {
      const host = loadExtension();
      const root = host.skillHome.roots.cwd;
      const content = "{}\n";
      writeFileSync(join(root, "package.json"), content);
      writeFileSync(join(root, "other.json"), content);
      const outside = join(host.skillHome.home, "outside.json");
      writeFileSync(outside, content);
      symlinkSync(outside, join(root, "escape.json"));
      const sibling = scenario.startsWith("outside sibling") ? outside : scenario === "symlink escape" ? "escape.json" : join(root, "other.json");
      const input = `*** Begin Patch\n[${scenario === "missing target" ? "other.json" : "package.json"}#1234]\nPUT 1.=1:\n+{}\n[${sibling}#5678]\nPUT 1.=1:\n+{}\n*** End Patch\n`;
      host.setBranch([
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "edit", name: "edit", arguments: {
          input, ...(scenario === "outside sibling with target hint" && { path: "package.json" }),
        } }] } },
        { type: "message", message: { role: "toolResult", toolName: "edit", toolCallId: "edit", isError: false } },
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "check", name: "bash", arguments: { command: "node --check app.js", cwd: root } }] } },
        { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "check", isError: false, details: { exitCode: 0 } } },
      ]);
      const result = await host.callTool("observer_resolve", { outcomes: ["package.json", "other.json"].map((path) => ({
        ...projectAnswer(root, path, "applied"),
        publication: { writeToolCallId: "edit", checkToolCallIds: ["check"], afterHash: createHash("sha256").update(content).digest("hex") },
      })) });
      const accepted = scenario === "safe sibling";
      expect(result.isError ?? false).toBe(!accepted);
      expect(readLedger(host.ledgerFile).map((record) => record.kind === "project" ? record.target.path : undefined))
        .toEqual(accepted ? ["package.json", "other.json"] : scenario === "missing target" ? ["other.json"] : []);
    },
  );

  it.each(["successful", "failed write", "failed check", "missing result", "check before write", "duplicate call", "named service", "replaced write", "replaced check"] as const)(
    "resolves nested eval receipts only with complete provenance: %s", async (scenario) => {
      const host = loadExtension();
      const root = host.skillHome.roots.cwd;
      const content = "{}\n";
      writeFileSync(join(root, "package.json"), content);
      host.setBranch([{ type: "custom_message", customType: "skill-observer", content: "Observation pass" }]);
      const check = async () => {
        const input = { command: "node --check app.js", cwd: root, ...(scenario === "named service" && { name: "server" }) };
        await host.toolCall("bash", input, "js-bash-check");
        await host.toolResult({ toolName: "bash", toolCallId: "js-bash-check",
          input: { ...input, cwd: scenario === "replaced check" ? host.skillHome.home : root },
          content: [], isError: scenario === "failed check", details: { exitCode: scenario === "failed check" ? 1 : 0 } });
      };
      if (scenario === "check before write") await check();
      await host.toolCall("write", { path: "package.json", content }, "js-write-target");
      if (scenario === "duplicate call") await host.toolCall("write", { path: "other.json", content }, "js-write-target");
      if (scenario !== "missing result") await host.toolResult({ toolName: "write", toolCallId: "js-write-target",
        input: { path: scenario === "replaced write" ? "other.json" : "package.json", content },
        content: [], isError: scenario === "failed write" });
      if (scenario !== "check before write") await check();
      const result = await host.callTool("observer_resolve", { outcomes: [{
        ...projectAnswer(root, "package.json", "applied"),
        publication: { writeToolCallId: "js-write-target", checkToolCallIds: ["js-bash-check"], afterHash: createHash("sha256").update(content).digest("hex") },
      }] });
      expect(result.isError ?? false).toBe(scenario !== "successful");
      expect(readLedger(host.ledgerFile).map((record) => record.outcome)).toEqual(scenario === "successful" ? ["applied"] : []);
    },
  );

  it.each(["matching native and hook", "mismatched result ID", "conflicting success and error", "conflicting status persisted before the hooks",
    "failed result", "unfinished service", "background check", "device-dispatched check", "duplicate native result", "result before its request"] as const)(
    "pairs native and hook check receipts strictly: %s", async (scenario) => {
      const host = loadExtension();
      const root = host.skillHome.roots.cwd;
      const content = "{}\n";
      writeFileSync(join(root, "package.json"), content);
      const nativeCall = (id: string, name: string, args: Record<string, unknown>) =>
        ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
      const nativeResult = (id: string, name: string, isError: boolean, details?: Record<string, unknown>) =>
        ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, isError, details } });
      const input = { command: "node --check app.js", cwd: root, ...(scenario === "background check" && { async: true }) };
      const details = scenario === "unfinished service" ? { wallTimeMs: 5, service: { id: "server" } } : { exitCode: scenario === "failed result" ? 1 : 0 };
      const dispatched = scenario === "device-dispatched check";
      const persistedFirst = dispatched || scenario === "conflicting status persisted before the hooks";
      const native = dispatched ? { name: "write", input: { path: "xd://bash", content: JSON.stringify(input) } } : { name: "bash", input };
      const resultId = scenario === "mismatched result ID" ? "other-check" : "check";
      host.setBranch([nativeCall("write", "write", { path: "package.json", content }), nativeResult("write", "write", false)]);
      // A device dispatch is persisted natively before its inner hook; an ordinary call's hook precedes persistence, but capture must not depend on it.
      if (persistedFirst) host.setBranch([...host.getBranch(), nativeCall("check", native.name, native.input)]);
      await host.toolCall("bash", input, "check");
      if (!persistedFirst) host.setBranch([...host.getBranch(), nativeCall("check", native.name, native.input)]);
      await host.toolResult({ toolName: "bash", toolCallId: resultId, input, content: [], details,
        isError: scenario === "failed result" || scenario.startsWith("conflicting") });
      const branch = host.getBranch();
      const resultEntry = nativeResult(resultId, native.name, scenario === "failed result", details);
      const nativeCallAt = branch.findIndex((entry) => entry.message?.role === "assistant" && Array.isArray(entry.message.content) &&
        entry.message.content.some((block) => block.type === "toolCall" && block.id === "check"));
      if (scenario === "result before its request") branch.splice(nativeCallAt, 0, resultEntry);
      else branch.push(resultEntry);
      if (scenario === "duplicate native result") branch.push(resultEntry);
      host.setBranch(branch);
      expect(host.getBranch().filter((entry) => entry.customType === "skill-observer-tool-call")).toHaveLength(1);
      const result = await host.callTool("observer_resolve", { outcomes: [{
        ...projectAnswer(root, "package.json", "applied"),
        publication: { writeToolCallId: "write", checkToolCallIds: ["check"], afterHash: createHash("sha256").update(content).digest("hex") },
      }] });
      const accepted = scenario === "matching native and hook";
      expect(result.isError ?? false).toBe(!accepted);
      expect(readLedger(host.ledgerFile).map((record) => record.outcome)).toEqual(accepted ? ["applied"] : []);
    },
  );

  it.each(["wrong write target", "wrong check project", "failed check", "check before write", "stale hash", "async check"] as const)(
    "does not record applied with %s", async (failure) => {
      const host = loadExtension();
      const root = host.skillHome.roots.cwd;
      const file = join(root, "package.json");
      const content = "{}\n";
      writeFileSync(file, content);
      const writeEntries = [
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "write", name: "write", arguments: { path: failure === "wrong write target" ? join(root, "other.json") : file, content } }] } },
        { type: "message", message: { role: "toolResult", toolName: "write", toolCallId: "write", isError: false } },
      ];
      const checkEntries = [
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "check", name: "bash", arguments: { command: "bun run typecheck", cwd: failure === "wrong check project" ? host.skillHome.home : root, async: failure === "async check" } }] } },
        { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "check", isError: failure === "failed check", details: { exitCode: failure === "failed check" ? 1 : 0 } } },
      ];
      host.setBranch(JSON.parse(JSON.stringify(failure === "check before write" ? [...checkEntries, ...writeEntries] : [...writeEntries, ...checkEntries])));
      const result = await host.callTool("observer_resolve", { outcomes: [{
        ...projectAnswer(root, "package.json", "applied"),
        publication: { writeToolCallId: "write", checkToolCallIds: ["check"], afterHash: failure === "stale hash" ? "0".repeat(64) : createHash("sha256").update(content).digest("hex") },
      }] });
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ records: [] });
      expect(existsSync(host.ledgerFile)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(content);
    },
  );

  it("never interprets project records as skill edits or withdrawal ownership", async () => {
    const host = loadExtension();
    const fingerprint = "project-owned";
    mkdirSync(dirname(host.ledgerFile), { recursive: true });
    writeFileSync(host.ledgerFile, `${JSON.stringify({
      fingerprint, kind: "project", skill: "tdd",
      target: { scope: "project", root: host.skillHome.roots.cwd, path: "checks.json", mechanism: "Project-only check" },
      gist: "Project-only check", outcome: "applied", timestamp: new Date().toISOString(), sessionId: "fixture-session",
    })}\n`);
    host.setBranch([...fx.plainUserMessage, ...fx.skillUrlRead]);
    await host.runCommand("observe", "Review");
    expect(String(host.sent[0]?.message.content).split("### Rules in force")[1]).not.toContain("Project-only check");
    const result = await host.callTool("observer_resolve", { outcomes: [
      { ...outcome("tdd", "upstream", "Project-only check", "withdrawn"), fingerprint },
    ] });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ records: [] });
  });
});

describe("observer hook and companion intents", () => {
  const agentDir = (host: ReturnType<typeof loadExtension>) => join(host.skillHome.home, ".omp/agent");
  const projectHooks = (host: ReturnType<typeof loadExtension>) => join(realpathSync(host.skillHome.roots.cwd), ".omp/hooks/pre");
  const intent = (root: string, mechanism: string, target: Record<string, unknown> = {}) => ({
    kind: "harness", target: { scope: "harness", root, mechanism, ...target },
    gist: mechanism, priority: "evidence", remedy: "Block the mistake in code",
    change: {
      operation: "harness", stage: "intent", event: "tool_call for bash", predicate: "the command runs `git commit` in a jj repository",
      action: "block the call and name `jj commit`", mistake: "git commit -m fix", legitimate: "jj commit -m fix",
      scope: "every jj repository", lowerRungs: "A barrier rule only reminds; no project check runs before the commit.",
    },
    evidence: [{ quote: "git commit again", count: 2 }],
  });
  /** Prepares and selects `candidates` in a new pass, has the user give each the answer, and returns the selected references. */
  const asked = async (host: ReturnType<typeof loadExtension>, candidates: unknown[], answer: AnswerUser) => {
    const selection = await prepareAndSelect(host, candidates);
    askUser(host, selection, answer);
    return reviewEntries(selection, "selected");
  };
  const answered = (entries: ReviewEntry[], outcome: string) => entries.map(({ reference }) => ({ kind: "harness", proposal: reference, outcome }));
  const otherProject = (host: ReturnType<typeof loadExtension>) => {
    const other = join(host.skillHome.home, "other-project");
    mkdirSync(other, { recursive: true });
    host.setCwd(other);
    return other;
  };
  const hookText = "export default function (pi) {\n  pi.on(\"tool_call\", (event) => event.input.command?.startsWith(\"git commit\") ? { block: true, reason: \"use jj commit\" } : undefined);\n}\n";
  const checkOutput = "mistake git commit -m fix: blocked\nlegitimate jj commit -m fix: untouched";
  /** The hook check the draft passed, run on the hook at its root-relative `file` so the same command reruns in the root after the write. */
  const hookCheck = (file: string) => ({ command: `bun --no-env-file ${HOOK_CHECK_PATH} ${file} /tmp/draft/samples.json`, output: checkOutput });
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const evidence = [{ quote: 'Tool error in `bash` "git commit -m fix": "fatal: not a git repository"', count: 2 }];
  const code = (root: string, mechanism: string, approval: unknown, files: Array<{ path: string; text: string }>, target: Record<string, unknown> = {}, check = hookCheck(files[0]?.path ?? "")) => ({
    ...intent(root, mechanism, target), evidence, change: { operation: "harness", stage: "code", intent: approval, files, check },
  });
  /** Starts a pass in which the user answers `candidate` alone with `answer`; returns its form, proposal and where the answer is saved. */
  const askIntent = async (host: ReturnType<typeof loadExtension>, candidate: unknown, answer: AnswerUser = () => "Apply") => {
    const selection = await prepareAndSelect(host, [candidate]);
    const selectionToolCallId = lastCallId(host);
    const askToolCallId = askUser(host, selection, answer);
    const [entry] = reviewEntries(selection, "selected");
    return { selection, proposal: entry!.proposal, approval: { proposal: entry!.reference, selectionToolCallId, askToolCallId } };
  };
  /** Prepares, selects and asks the code candidate in the current pass. */
  const askCode = async (host: ReturnType<typeof loadExtension>, candidate: unknown, answer: AnswerUser = () => "Apply") => {
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [candidate] });
    expect(failures(prepared)).toEqual([]);
    const selection = await host.callTool("observer_review", { action: "select", proposals: reviewEntries(prepared).map(({ reference }) => reference) });
    const selectionToolCallId = lastCallId(host);
    const askToolCallId = askUser(host, selection, answer);
    const [entry] = reviewEntries(selection, "selected");
    return { selection, entry: entry!, approval: { proposal: entry!.reference, selectionToolCallId, askToolCallId } };
  };
  /** Saves a native write of `text` to `file` and a foreground check in `cwd` after it, as the pass publishes an approved hook; writes the file too. */
  const publish = (host: ReturnType<typeof loadExtension>, file: string, text: string, cwd: string,
    { checkFirst = false, checkFails = false, command = hookCheck(basename(file)).command } = {}) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    const n = host.getBranch().length;
    const write = [
      { type: "message", id: `call-write-${n}`, message: { role: "assistant", content: [{ type: "toolCall", id: `write-${n}`, name: "write", arguments: { path: file, content: text } }] } },
      { type: "message", id: `result-write-${n}`, message: { role: "toolResult", toolName: "write", toolCallId: `write-${n}`, isError: false, content: [{ type: "text", text: "Written" }] } },
    ];
    const run = [
      { type: "message", id: `call-check-${n}`, message: { role: "assistant", content: [{ type: "toolCall", id: `check-${n}`, name: "bash", arguments: { command, cwd } }] } },
      { type: "message", id: `result-check-${n}`, message: { role: "toolResult", toolName: "bash", toolCallId: `check-${n}`, isError: checkFails, details: { exitCode: checkFails ? 1 : 0 }, content: [{ type: "text", text: checkOutput }] } },
    ];
    host.getBranch().push(...(checkFirst ? [...run, ...write] : [...write, ...run]) as SessionEntry[]);
    return { writeToolCallIds: [`write-${n}`], checkToolCallIds: [`check-${n}`] };
  };
  const applied = (approval: unknown, publication: unknown) => ({ kind: "harness", outcome: "applied", approval, publication });

  it("prepares a project hook, a global hook and a companion intent, and the form shows each description with its root kind and path", async () => {
    const host = loadExtension();
    const selection = await prepareAndSelect(host, [
      intent("project-hooks", "Block git commit here"), intent("global-hooks", "Block git commit everywhere"),
      intent("global-hooks", "Fix my hand-written hook", { path: "mine.ts" }), intent("companion", "Register a jj tool"),
    ]);
    expect(selection.isError).toBeFalsy();
    const [project, global, edited, companion] = reviewEntries(selection, "selected").map(({ proposal }) => proposal);
    const { askHtml } = JSON.parse(resultText(selection));
    expect(askHtml).toContain(`<legend>\`skill-observer-${project!.fingerprint}.ts\` (project hook): Block git commit here</legend>`);
    expect(askHtml).toContain(`<legend>\`skill-observer-${global!.fingerprint}.ts\` (global hook): Block git commit everywhere</legend>`);
    expect(askHtml).toContain("<legend>`mine.ts` (global hook): Fix my hand-written hook</legend>");
    expect(askHtml).toContain("<legend>`skill-observer-companion` (companion extension): Register a jj tool</legend>");
    expect(project!.preview).toContain(join(projectHooks(host), `skill-observer-${project!.fingerprint}.ts`));
    expect(global!.preview).toContain(join(agentDir(host), "hooks/pre", `skill-observer-${global!.fingerprint}.ts`));
    expect(edited!.preview).toContain(join(agentDir(host), "hooks/pre/mine.ts"));
    expect(companion!.preview).toContain(join(agentDir(host), "extensions/skill-observer-companion"));
    for (const line of ["Event: tool_call for bash", "Predicate: the command runs `git commit` in a jj repository", "Action: block the call and name `jj commit`",
      "Mistake sample: git commit -m fix", "Legitimate sample: jj commit -m fix", "Scope: every jj repository",
      "Why each lower rung fails: A barrier rule only reminds; no project check runs before the commit."]) {
      expect(askHtml.split(line)).toHaveLength(5);
    }
    expect(askHtml.split("An Apply with a note is asked again.")).toHaveLength(5);
    expect(new Set([project, global, edited, companion].map((proposal) => proposal!.fingerprint)).size).toBe(4);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["another root kind", { root: "user-extensions" }, "needs a root"],
    ["a path escaping its root", { path: "../escape.ts" }, "plain root-relative"],
    ["an absolute path", { path: "/tmp/escape.ts" }, "plain root-relative"],
    ["a path through a symlink out of its root", { path: "out/escape.ts" }, "escapes its root"],
    ["a companion change naming a file", { root: "companion", path: "index.ts" }, "not by a file"],
  ])("refuses a target with %s", async (_label, target, reason) => {
    const host = loadExtension();
    const hooks = join(agentDir(host), "hooks/pre");
    mkdirSync(hooks, { recursive: true });
    symlinkSync(host.skillHome.home, join(hooks, "out"));
    const { root = "global-hooks", ...rest } = target;
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [intent(String(root), "Escape", rest)] });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining(reason)] });
  });

  it.each<[string, string, string, (root: string) => void]>([
    ["the project's hooks directory", ".omp/hooks/pre/block.ts", "as a project hook", () => {}],
    ["the project's hooks directory through a symlink to another project directory", ".omp/hooks/pre/block.ts", "as a project hook", (root) => {
      mkdirSync(join(root, "actual-hooks/pre"), { recursive: true });
      mkdirSync(join(root, ".omp"), { recursive: true });
      symlinkSync(join(root, "actual-hooks"), join(root, ".omp/hooks"));
    }],
    ["the global hooks directory of an agent directory inside the project", "agent/hooks/pre/block.ts", "as a global hook", (root) => vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))],
    ["the companion directory of an agent directory inside the project", "agent/extensions/skill-observer-companion/index.ts", "as a companion change", (root) => vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))],
  ])("refuses a project proposal inside %s, naming the harness scope", async (_label, path, scope, arrange) => {
    const host = loadExtension();
    const root = host.skillHome.roots.cwd;
    arrange(root);
    const target = { scope: "project", root, path, mechanism: "Block git commit" };
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [{
      kind: "project", target, gist: "Block git commit", priority: "evidence", remedy: "Write a hook", change: { operation: "direct-edit", preview: "export default () => {}" },
    }] });
    expect(prepared.isError).toBe(true);
    expect(failures(prepared)).toEqual([expect.stringContaining(`\`harness\` target scope, ${scope}`)]);
    const resolved = await resolve(host, [{ kind: "project", target, gist: "Block git commit", outcome: "later" }]);
    expect(failures(resolved)).toEqual([expect.stringContaining(`\`harness\` target scope, ${scope}`)]);
  });

  it("keeps a declined global hook out of another project's pass, and a declined project hook out of view there", async () => {
    const host = loadExtension();
    const candidates = [intent("global-hooks", "Block git commit everywhere"), intent("project-hooks", "Block git commit here")];
    const declined = await asked(host, candidates, () => "Decline");
    expect(failures(await resolve(host, answered(declined, "declined")))).toEqual([]);
    expect(ledgerRecords(host.ledgerFile).map(({ outcome }) => outcome)).toEqual(["declined", "declined"]);
    const here = await host.callTool("observer_review", { action: "prepare", candidates });
    expect(reviewEntries(here)).toEqual([]);
    otherProject(host);
    const there = await host.callTool("observer_review", { action: "prepare", candidates });
    expect(reviewEntries(there).map(({ proposal }) => proposal.gist)).toEqual(["Block git commit here"]);
  });

  it("brings a Later intent back in the next pass of its scope, which names the three directories", async () => {
    const host = loadExtension();
    const later = await asked(host, [intent("global-hooks", "Block git commit everywhere"), intent("project-hooks", "Block git commit here")],
      () => ({ option: "Later", note: "After the jj migration." }));
    expect(failures(await resolve(host, answered(later, "later")))).toEqual([]);
    await host.runCommand("observe", "Review hooks");
    const here = String(host.sent.at(-1)?.message.content);
    expect(here).toContain("Block git commit everywhere Re-offer when: After the jj migration.");
    expect(here).toContain("Block git commit here Re-offer when: After the jj migration.");
    expect(here).toContain(`Project hooks directory: \`${projectHooks(host)}\``);
    expect(here).toContain(`Global hooks directory: \`${join(agentDir(host), "hooks/pre")}\``);
    expect(here).toContain(`Companion extension directory: \`${join(agentDir(host), "extensions/skill-observer-companion")}\``);
    otherProject(host);
    await host.runCommand("observe", "Review hooks");
    const there = String(host.sent.at(-1)?.message.content);
    expect(there).toContain("Block git commit everywhere");
    expect(there).not.toContain("Block git commit here");
  });

  it("names the hook and companion procedure file and the hook check script in a pass with only a User note, without the procedure's text", async () => {
    const host = loadExtension();
    await host.runCommand("observe", "Review hooks");
    const payload = String(host.sent.at(-1)?.message.content);
    expect(payload).toContain(`Hook and companion procedure file: \`${HOOKS_AND_COMPANION_PATH}\`. Hook check script: \`${HOOK_CHECK_PATH}\`.`);
    expect(payload).toContain("read the procedure file named below");
    const procedure = readFileSync(HOOKS_AND_COMPANION_PATH, "utf8").split(/\n{2,}/).filter((block) => !block.startsWith("#"));
    expect(procedure.filter((block) => payload.includes(block.trim()))).toEqual([]);
  });

  it("writes no file and records nothing as applied for an intent Apply alone", async () => {
    const host = loadExtension();
    const approved = await asked(host, [intent("project-hooks", "Block git commit here"), intent("global-hooks", "Block git commit everywhere")], () => "Apply");
    const applied = await resolve(host, answered(approved, "applied"));
    expect(applied.isError).toBe(true);
    expect(failures(applied)).toEqual([expect.stringContaining("drafting only"), expect.stringContaining("drafting only")]);
    expect(existsSync(host.ledgerFile)).toBe(false);
    expect(existsSync(projectHooks(host))).toBe(false);
    expect(existsSync(join(agentDir(host), "hooks"))).toBe(false);
    expect(existsSync(join(agentDir(host), "extensions"))).toBe(false);
  });

  describe("at the code stage", () => {
    it.each<[string, (host: ReturnType<typeof loadExtension>, candidate: unknown) => Promise<unknown>, string]>([
      ["no intent approval cited", async () => undefined, "needs `approval`"],
      ["an intent answered Later", async (host, candidate) => (await askIntent(host, candidate, () => "Later")).approval, "selected `Later`"],
      ["an intent Apply with a note", async (host, candidate) => (await askIntent(host, candidate, () => ({ option: "Apply", note: "Only on main." }))).approval, "Only on main."],
      ["an intent Apply of an earlier pass", async (host, candidate) => { const { approval } = await askIntent(host, candidate); startPass(host); return approval; }, "earlier observation pass"],
      ["an intent Apply of another hook", async (host) => (await askIntent(host, intent("global-hooks", "Block git push everywhere"))).approval, "another"],
    ])("refuses a code stage with %s", async (_label, cite, reason) => {
      const host = loadExtension();
      const candidate = intent("global-hooks", "Block git commit everywhere");
      const approval = await cite(host, candidate);
      if (host.getBranch().length === 0) startPass(host);
      const fingerprint = harnessFingerprint({ scope: "harness", root: "global-hooks", mechanism: "Block git commit everywhere" });
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
        code("global-hooks", "Block git commit everywhere", approval, [{ path: `skill-observer-${fingerprint}.ts`, text: hookText }]),
      ] });
      expect(prepared.isError).toBe(true);
      expect(prepared.details).toMatchObject({ eligible: [], failures: [expect.stringContaining(reason)] });
    });

    it("shows the hook file's exact text, the check command and its result in an Ask of its own", async () => {
      const host = loadExtension();
      const { proposal, approval } = await askIntent(host, intent("project-hooks", "Block git commit here"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const candidate = code("project-hooks", "Block git commit here", approval, [{ path: file, text: hookText }]);
      const { selection, entry } = await askCode(host, candidate);
      const { askHtml } = JSON.parse(resultText(selection));
      expect(askHtml).toContain(`<legend>\`${file}\` (project hook): Block git commit here</legend>`);
      expect(askHtml).toContain(join(projectHooks(host), file));
      expect(askHtml).toContain('export default function (pi) {<br>··pi.on("tool_call", (event) =&gt; event.input.command?.startsWith("git commit")');
      expect(askHtml).toContain(`Check command: ${hookCheck(file).command}`);
      expect(askHtml).toContain("mistake git commit -m fix: blocked<br>legitimate jj commit -m fix: untouched");
      expect(askHtml).toContain("An Apply with a note is asked again.");
      expect(entry.proposal.fingerprint).toBe(proposal.fingerprint);

      const other = await host.callTool("observer_review", { action: "prepare", candidates: [onReadCandidate({ gist: "Name the seam.", section: "## Seams\n\nName the seam." })] });
      const together = await host.callTool("observer_review", { action: "select", proposals: [entry.reference, ...reviewEntries(other).map(({ reference }) => reference)] });
      expect(together.isError).toBe(true);
      expect(failures(together)).toEqual([expect.stringContaining("its own Select and Ask")]);
    });

    it("records an applied hook from its write and check receipts, writing nothing itself and keeping no file text", async () => {
      const host = loadExtension();
      const { proposal, approval: intentApproval } = await askIntent(host, intent("global-hooks", "Block git commit everywhere"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const { approval } = await askCode(host, code("global-hooks", "Block git commit everywhere", intentApproval, [{ path: file, text: hookText }]));
      const hooks = join(agentDir(host), "hooks/pre");
      expect(existsSync(join(hooks, file))).toBe(false);
      const receipts = publish(host, join(hooks, file), hookText, hooks);
      const publication = { ...receipts, files: [{ path: file, afterHash: sha(hookText) }] };
      const result = await resolve(host, [applied(approval, publication)]);
      expect(failures(result)).toEqual([]);
      expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({ kind: "harness", fingerprint: proposal.fingerprint, outcome: "applied", publication })]);
      const ledger = readFileSync(host.ledgerFile, "utf8");
      for (const text of ["export default", checkOutput.split("\n")[0]!, "Predicate"]) expect(ledger).not.toContain(text);

      const noted = await askCode(host, code("global-hooks", "Block git commit everywhere", intentApproval, [{ path: file, text: hookText }]), () => ({ option: "Apply", note: "Also block git push." }));
      const refused = await resolve(host, [applied(noted.approval, { ...publish(host, join(hooks, file), hookText, hooks), files: [{ path: file, afterHash: sha(hookText) }] })]);
      expect(failures(refused)).toEqual([expect.stringContaining("Also block git push.")]);
    });

    it.each([
      ["its code prepared and asked again", "code", true],
      ["its code asked again", "code", false],
      ["its intent prepared and asked again", "intent", true],
    ] as const)("refuses an Apply the user answered again later in the pass, %s, with Decline", async (_label, stage, reprepared) => {
      const host = loadExtension();
      const candidate = intent("global-hooks", "Block git commit everywhere");
      const { proposal, approval: intentApproval } = await askIntent(host, candidate);
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const codeCandidate = code("global-hooks", "Block git commit everywhere", intentApproval, [{ path: file, text: hookText }]);
      if (stage === "intent") {
        await askCode(host, candidate, () => "Decline");
        const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [codeCandidate] });
        expect(failures(prepared)).toEqual([expect.stringContaining("superseded")]);
        return;
      }
      const { entry, approval } = await askCode(host, codeCandidate);
      if (reprepared) await askCode(host, codeCandidate, () => "Decline");
      else askUser(host, await host.callTool("observer_review", { action: "select", proposals: [entry.reference] }), () => "Decline");
      const hooks = join(agentDir(host), "hooks/pre");
      const result = await resolve(host, [applied(approval, { ...publish(host, join(hooks, file), hookText, hooks), files: [{ path: file, afterHash: sha(hookText) }] })]);
      expect(failures(result)).toEqual([expect.stringContaining("superseded")]);
      expect(existsSync(host.ledgerFile)).toBe(false);
    });

    it("refuses an applied hook whose write and check came before the code's Apply", async () => {
      const host = loadExtension();
      const { proposal, approval: intentApproval } = await askIntent(host, intent("global-hooks", "Block git commit everywhere"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const hooks = join(agentDir(host), "hooks/pre");
      const early = publish(host, join(hooks, file), hookText, hooks);
      const { approval } = await askCode(host, code("global-hooks", "Block git commit everywhere", intentApproval, [{ path: file, text: hookText }]));
      const result = await resolve(host, [applied(approval, { ...early, files: [{ path: file, afterHash: sha(hookText) }] })]);
      expect(failures(result)).toEqual([expect.stringContaining("before the user's Apply")]);
      expect(existsSync(host.ledgerFile)).toBe(false);
    });

    it.each([
      ["an unrelated command", () => "true"],
      ["the hook check on the draft outside the target", () => `bun --no-env-file ${HOOK_CHECK_PATH} /tmp/draft/hook.ts /tmp/draft/samples.json`],
      ["the hook check followed by another command", (file: string) => `bun --no-env-file ${HOOK_CHECK_PATH} ${file} /tmp/draft/samples.json; true`],
      ["the hook check with another command on the next line", (file: string) => `bun --no-env-file ${HOOK_CHECK_PATH} ${file}\n/usr/bin/true`],
      ["the hook check with another command after a carriage return", (file: string) => `bun --no-env-file ${HOOK_CHECK_PATH} ${file}\r/usr/bin/true`],
      ["another script on the hook", (file: string) => `bun --no-env-file /tmp/draft/check.ts ${file} /tmp/draft/samples.json`],
    ] as const)("refuses hook code whose check is %s, since the check rerun after the write must test the written hook", async (_label, command) => {
      const host = loadExtension();
      const { proposal, approval } = await askIntent(host, intent("global-hooks", "Block git commit everywhere"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
        code("global-hooks", "Block git commit everywhere", approval, [{ path: file, text: hookText }], {}, { command: command(file), output: checkOutput }),
      ] });
      expect(failures(prepared)).toEqual([expect.stringContaining(HOOK_CHECK_PATH)]);
    });

    it.each([
      ["no publication", "needs `publication`"], ["no write", "no observed write"], ["a write of another file", "no observed write"],
      ["a check before the write", "after its write"], ["a check in another directory", "in the target root"], ["a failed check", "no successful observed tool call"],
      ["a missing file hash", "afterHash"], ["an unrelated successful command as its check", "not the approved check"],
    ] as const)(
      "refuses an applied hook with %s", async (scenario, reason) => {
        const host = loadExtension();
        const { proposal, approval: intentApproval } = await askIntent(host, intent("global-hooks", "Block git commit everywhere"));
        const file = `skill-observer-${proposal.fingerprint}.ts`;
        const { approval } = await askCode(host, code("global-hooks", "Block git commit everywhere", intentApproval, [{ path: file, text: hookText }]));
        const hooks = join(agentDir(host), "hooks/pre");
        const target = scenario === "a write of another file" ? join(hooks, "other.ts") : join(hooks, file);
        if (scenario === "a write of another file") {
          mkdirSync(hooks, { recursive: true });
          writeFileSync(join(hooks, file), hookText);
        }
        const receipts = publish(host, target, hookText, scenario === "a check in another directory" ? host.skillHome.roots.cwd : hooks, {
          checkFirst: scenario === "a check before the write", checkFails: scenario === "a failed check",
          ...(scenario === "an unrelated successful command as its check" && { command: "true" }),
        });
        const publication = scenario === "no publication" ? undefined : {
          ...receipts, ...(scenario === "no write" && { writeToolCallIds: [] }),
          files: scenario === "a missing file hash" ? [] : [{ path: file, afterHash: sha(hookText) }],
        };
        const result = await resolve(host, [applied(approval, publication)]);
        expect(result.isError).toBe(true);
        expect(failures(result)).toEqual([expect.stringContaining(reason)]);
        expect(existsSync(host.ledgerFile)).toBe(false);
      },
    );

    it.each(["the hash it states", "the approved text's hash"] as const)("refuses an applied hook whose written file differs from the approved text, stating %s", async (stated) => {
      const host = loadExtension();
      const { proposal, approval: intentApproval } = await askIntent(host, intent("global-hooks", "Block git commit everywhere"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const { approval } = await askCode(host, code("global-hooks", "Block git commit everywhere", intentApproval, [{ path: file, text: hookText }]));
      const hooks = join(agentDir(host), "hooks/pre");
      const written = hookText.replace("jj commit", "jj describe");
      const receipts = publish(host, join(hooks, file), written, hooks);
      const result = await resolve(host, [applied(approval, { ...receipts, files: [{ path: file, afterHash: sha(stated === "the hash it states" ? written : hookText) }] })]);
      expect(failures(result)).toEqual([expect.stringContaining(file)]);
      expect(existsSync(host.ledgerFile)).toBe(false);
      expect(readFileSync(join(hooks, file), "utf8")).toBe(written);
    });

    it("leaves one later record for an intent Apply and a code Later, which comes back as an intent question saying a draft existed", async () => {
      const host = loadExtension();
      const { proposal, approval: intentApproval } = await askIntent(host, intent("project-hooks", "Block git commit here"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const { entry } = await askCode(host, code("project-hooks", "Block git commit here", intentApproval, [{ path: file, text: hookText }]), () => "Later");
      const twice = await resolve(host, [{ kind: "harness", proposal: entry.reference, outcome: "later" }, { kind: "harness", proposal: intentApproval.proposal, outcome: "later" }]);
      expect(failures(twice)).toEqual([expect.stringContaining("one answer")]);
      expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({ fingerprint: proposal.fingerprint, outcome: "later", reoffer: expect.stringContaining("A draft existed") })]);
      expect(readFileSync(host.ledgerFile, "utf8")).not.toContain("export default");
      expect(existsSync(projectHooks(host))).toBe(false);

      await host.runCommand("observe", "Review hooks");
      startPass(host);
      expect(String(host.sent.at(-1)?.message.content)).toMatch(/Block git commit here Re-offer when: A draft existed/);
      const again = await host.callTool("observer_review", { action: "prepare", candidates: [code("project-hooks", "Block git commit here", intentApproval, [{ path: file, text: hookText }])] });
      expect(failures(again)).toEqual([expect.stringContaining("earlier observation pass")]);
      const asIntent = await host.callTool("observer_review", { action: "prepare", candidates: [intent("project-hooks", "Block git commit here")] });
      expect(reviewEntries(asIntent).map(({ proposal: { fingerprint } }) => fingerprint)).toEqual([proposal.fingerprint]);
    });

    it("changes an existing hand-written hook through both stages", async () => {
      const host = loadExtension();
      const hooks = join(agentDir(host), "hooks/pre");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "mine.ts"), "export default function () {}\n");
      const { approval: intentApproval } = await askIntent(host, intent("global-hooks", "Fix my hand-written hook", { path: "mine.ts" }));
      const { selection, approval } = await askCode(host, code("global-hooks", "Fix my hand-written hook", intentApproval, [{ path: "mine.ts", text: hookText }], { path: "mine.ts" }));
      expect(JSON.parse(resultText(selection)).askHtml).toContain(`Replace \`${join(hooks, "mine.ts")}\``);
      const receipts = publish(host, join(hooks, "mine.ts"), hookText, hooks);
      const result = await resolve(host, [applied(approval, { ...receipts, files: [{ path: "mine.ts", afterHash: sha(hookText) }] })]);
      expect(failures(result)).toEqual([]);
      expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({ outcome: "applied", target: expect.objectContaining({ root: "global-hooks", path: "mine.ts" }) })]);
    });

    it("lists an applied hook under remedy outcomes in a later pass, counting exercises after its record", async () => {
      const host = loadExtension();
      const { proposal, approval: intentApproval } = await askIntent(host, intent("project-hooks", "Block git commit here"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const { approval } = await askCode(host, code("project-hooks", "Block git commit here", intentApproval, [{ path: file, text: hookText }]));
      const receipts = publish(host, join(projectHooks(host), file), hookText, projectHooks(host));
      expect(failures(await resolve(host, [applied(approval, { ...receipts, files: [{ path: file, afterHash: sha(hookText) }] })]))).toEqual([]);

      const later = new Date(Date.now() + 60_000).toISOString();
      host.setBranch([...fx.plainUserMessage,
        { type: "message", id: "call-commit", timestamp: later, message: { role: "assistant", content: [{ type: "toolCall", id: "commit", name: "bash", arguments: { command: "git commit -m fix" } }] } },
        { type: "message", id: "result-commit", timestamp: later, message: { role: "toolResult", toolCallId: "commit", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] } },
      ] as SessionEntry[]);
      await host.runCommand("observe", "Did the hook help?");
      const blocks = String(host.sent.at(-1)?.message.content).split("\n\n");
      expect(blocks[blocks.indexOf("### Remedy outcomes") + 1]).toBe(`- ${proposal.fingerprint} (\`${file}\` (project hook)): exercised-clean (evidence: tool-result:commit).`);
      await host.runCommand("observe-report");
      expect(host.notices.at(-1)).toContain(`- ${proposal.fingerprint}: exercised-clean (\`${file}\` (project hook))`);
    });
  });

  describe("companion changes", () => {
    const companionDir = (host: ReturnType<typeof loadExtension>) => join(agentDir(host), "extensions/skill-observer-companion");
    const manifest = '{ "name": "skill-observer-companion", "omp": { "extensions": ["./index.ts"] } }\n';
    const entry = "export default function (pi) {\n  pi.registerTool({ name: \"jj_status\" });\n}\n";
    const testFile = "import { expect, it } from \"bun:test\";\nit(\"registers jj_status\", () => expect(1).toBe(1));\n";
    const companionFiles = [{ path: "package.json", text: manifest }, { path: "index.ts", text: entry }, { path: "index.test.ts", text: testFile }];
    const bunTest = { command: "bun test", output: "index.test.ts:\n(pass) registers jj_status\n\n 1 pass\n 0 fail" };
    const companionCode = (approval: unknown, files: Array<{ path: string; text: string }>, checked = bunTest) => ({ ...code("companion", "Register a jj tool", approval, files), change: { operation: "harness", stage: "code", intent: approval, files, check: checked } });
    /** Saves a native write of each file and then one check, as the pass publishes an approved companion change; writes the files too. */
    const publishAll = (host: ReturnType<typeof loadExtension>, root: string, files: ReadonlyArray<{ path: string; text: string }>,
      { command = "bun test", cwd = root, checkFirst = false, checkFails = false, async = false } = {}) => {
      const n = host.getBranch().length;
      const writes = files.flatMap(({ path, text }, i) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
        return [
          { type: "message", id: `call-write-${n}-${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `write-${n}-${i}`, name: "write", arguments: { path: join(root, path), content: text } }] } },
          { type: "message", id: `result-write-${n}-${i}`, message: { role: "toolResult", toolName: "write", toolCallId: `write-${n}-${i}`, isError: false, content: [{ type: "text", text: "Written" }] } },
        ];
      });
      const run = [
        { type: "message", id: `call-check-${n}`, message: { role: "assistant", content: [{ type: "toolCall", id: `check-${n}`, name: "bash", arguments: { command, cwd, ...(async && { async: true }) } }] } },
        { type: "message", id: `result-check-${n}`, message: { role: "toolResult", toolName: "bash", toolCallId: `check-${n}`, isError: checkFails, details: { exitCode: checkFails ? 1 : 0 }, content: [{ type: "text", text: bunTest.output }] } },
      ];
      host.getBranch().push(...(checkFirst ? [...run, ...writes] : [...writes, ...run]) as SessionEntry[]);
      return { writeToolCallIds: files.map((_, i) => `write-${n}-${i}`), checkToolCallIds: [`check-${n}`], files: files.map(({ path, text }) => ({ path, afterHash: sha(text) })) };
    };

    it("shows every file and the bun test result in an Ask of its own, and the first applied change creates the directory and its manifest", async () => {
      const host = loadExtension();
      const { proposal, approval: intentApproval } = await askIntent(host, intent("companion", "Register a jj tool"));
      const { selection, approval } = await askCode(host, companionCode(intentApproval, companionFiles));
      const { askHtml } = JSON.parse(resultText(selection));
      expect(askHtml).toContain("<legend>`skill-observer-companion` (companion extension): Register a jj tool</legend>");
      for (const { path } of companionFiles) expect(askHtml).toContain(`Create \`${join(companionDir(host), path)}\` with:`);
      expect(askHtml).toContain("pi.registerTool({ name: \"jj_status\" });");
      expect(askHtml).toContain("it(\"registers jj_status\"");
      expect(askHtml).toContain('"omp": { "extensions": ["./index.ts"] }');
      expect(askHtml).toContain("Check command: bun test");
      expect(askHtml).toContain("(pass) registers jj_status");
      expect(existsSync(companionDir(host))).toBe(false);

      const publication = publishAll(host, companionDir(host), companionFiles);
      const result = await resolve(host, [applied(approval, publication)]);
      expect(failures(result)).toEqual([]);
      expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({ kind: "harness", fingerprint: proposal.fingerprint, outcome: "applied", publication })]);
      expect(readFileSync(host.ledgerFile, "utf8")).not.toContain("registerTool");
    });

    it("accepts a later change of one file that keeps the companion's manifest and test file", async () => {
      const host = loadExtension();
      for (const { path, text } of companionFiles) {
        mkdirSync(companionDir(host), { recursive: true });
        writeFileSync(join(companionDir(host), path), text);
      }
      const changed = [{ path: "index.ts", text: entry.replace("jj_status", "jj_log") }];
      const { approval: intentApproval } = await askIntent(host, intent("companion", "Register a jj tool"));
      const { selection, approval } = await askCode(host, companionCode(intentApproval, changed));
      expect(JSON.parse(resultText(selection)).askHtml).toContain(`Replace \`${join(companionDir(host), "index.ts")}\` with:`);
      expect(failures(await resolve(host, [applied(approval, publishAll(host, companionDir(host), changed))]))).toEqual([]);
    });

    it.each<[string, Array<{ path: string; text: string }>, typeof bunTest, string]>([
      ["a file escaping the companion directory", [...companionFiles, { path: "../other/index.ts", text: entry }], bunTest, "plain root-relative"],
      ["a file through a symlink out of the companion directory", [...companionFiles, { path: "out/index.ts", text: entry }], bunTest, "escapes its root"],
      ["no test file, kept or added", companionFiles.filter(({ path }) => path !== "index.test.ts"), bunTest, "test file"],
      ["a test file only under node_modules", [...companionFiles.filter(({ path }) => path !== "index.test.ts"), { path: "node_modules/dep/a.test.ts", text: testFile }], bunTest, "test file"],
      ["no manifest in a new companion", companionFiles.filter(({ path }) => path !== "package.json"), bunTest, "package.json"],
      ["a manifest declaring no entry", [{ path: "package.json", text: '{ "name": "skill-observer-companion" }' }, ...companionFiles.slice(1)], bunTest, "omp.extensions"],
      ["a check other than bun test", companionFiles, { command: "bunx vitest run", output: "1 passed" }, "bun test"],
      ["bun test followed by another command", companionFiles, { ...bunTest, command: "bun test ; true" }, "bun test"],
      ["bun test with another command on the next line", companionFiles, { ...bunTest, command: "bun test \n/usr/bin/true" }, "bun test"],
      ["bun test --help, which runs no test", companionFiles, { ...bunTest, command: "bun test --help" }, "bun test"],
      ["bun test with a preload the form does not show as companion code", companionFiles, { ...bunTest, command: "bun test --preload /tmp/x.ts" }, "bun test"],
    ])("refuses companion code with %s", async (_label, files, checked, reason) => {
      const host = loadExtension();
      mkdirSync(agentDir(host), { recursive: true });
      if (files.some(({ path }) => path.startsWith("out/"))) {
        mkdirSync(companionDir(host), { recursive: true });
        symlinkSync(host.skillHome.home, join(companionDir(host), "out"));
      }
      const { approval } = await askIntent(host, intent("companion", "Register a jj tool"));
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [companionCode(approval, files, checked)] });
      expect(prepared.isError).toBe(true);
      expect(failures(prepared)).toEqual([expect.stringContaining(reason)]);
    });

    it.each([
      ["a check other than bun test", { command: "bun run lint" }, "bun test"],
      ["a check in another directory", { cwd: "elsewhere" }, "in the target root"],
      ["a check before the writes", { checkFirst: true }, "after its write"],
      ["a background check", { async: true }, "foreground"],
      ["a failed check", { checkFails: true }, "no successful observed tool call"],
      ["a written file differing from its approved text", { differs: true }, "index.test.ts"],
      ["a file now lying outside the companion directory", { escapes: true }, "escapes its root"],
    ] as const)("refuses an applied companion change with %s", async (_label, scenario, reason) => {
      const host = loadExtension();
      const files = [...companionFiles, { path: "lib/util.ts", text: "export const x = 1;\n" }];
      const { approval: intentApproval } = await askIntent(host, intent("companion", "Register a jj tool"));
      const { approval } = await askCode(host, companionCode(intentApproval, files));
      const root = companionDir(host);
      if ("escapes" in scenario) {
        mkdirSync(root, { recursive: true });
        mkdirSync(join(host.skillHome.home, "outside"), { recursive: true });
        symlinkSync(join(host.skillHome.home, "outside"), join(root, "lib"));
      }
      const options = { ...scenario, ...("cwd" in scenario && { cwd: host.skillHome.roots.cwd }) };
      const publication = publishAll(host, root, files, options);
      if ("differs" in scenario) writeFileSync(join(root, "index.test.ts"), testFile.replace("toBe(1)", "toBe(2)"));
      const result = await resolve(host, [applied(approval, publication)]);
      expect(result.isError).toBe(true);
      expect(failures(result)).toEqual([expect.stringContaining(reason)]);
      expect(existsSync(host.ledgerFile)).toBe(false);
    });

    it("keeps declined and Later companion records in view in every project", async () => {
      const host = loadExtension();
      const declined = await asked(host, [intent("companion", "Register a jj tool")], () => "Decline");
      expect(failures(await resolve(host, answered(declined, "declined")))).toEqual([]);
      const later = await asked(host, [intent("companion", "Register a jj log tool")], () => ({ option: "Later", note: "After the jj migration." }));
      expect(failures(await resolve(host, answered(later, "later")))).toEqual([]);
      otherProject(host);
      await host.runCommand("observe", "Review the companion");
      expect(String(host.sent.at(-1)?.message.content)).toContain("Register a jj log tool Re-offer when: After the jj migration.");
      const there = await host.callTool("observer_review", { action: "prepare", candidates: [intent("companion", "Register a jj tool"), intent("companion", "Register a jj log tool")] });
      expect(reviewEntries(there).map(({ proposal }) => proposal.gist)).toEqual(["Register a jj log tool"]);
    });
  });

  describe("removing a hook", () => {
    const handText = "export default function (pi) {\n\tpi.on(\"tool_call\", () => ({ block: true }));\n}\n";
    const removal = (root: string, path: string | undefined, gist = "Remove the misfiring hook") => ({
      kind: "harness", target: { scope: "harness", root, mechanism: "remove the hook", ...(path !== undefined && { path }) },
      gist, priority: "evidence", remedy: "It blocks legitimate commits", change: { operation: "harness", stage: "removal" },
      evidence: [{ quote: "the hook blocked jj commit", count: 1 }],
    });
    /** Writes a hook no pass wrote, `mine.ts`, in the `root` hooks directory; returns its path. */
    const handWritten = (host: ReturnType<typeof loadExtension>, root: "project-hooks" | "global-hooks") => {
      const dir = root === "project-hooks" ? projectHooks(host) : join(agentDir(host), "hooks/pre");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mine.ts"), handText);
      return join(dir, "mine.ts");
    };
    const removed = (approval: unknown) => ({ kind: "harness", outcome: "applied", approval });

    it("shows the hook file as it stands, offering Apply and Decline only", async () => {
      const host = loadExtension();
      const file = handWritten(host, "project-hooks");
      const { selection } = await askIntent(host, removal("project-hooks", "mine.ts"));
      const { askHtml } = JSON.parse(resultText(selection));
      expect(askHtml).toContain("<legend>`mine.ts` (project hook): Remove the misfiring hook</legend>");
      expect(askHtml).toContain(file);
      expect(askHtml).toContain('export default function (pi) {<br>→pi.on("tool_call", () =&gt; ({ block: true }));<br>}');
      expect(askHtml).toContain(">Apply</label>");
      expect(askHtml).toContain(">Decline</label>");
      expect(askHtml).not.toContain(">Later</label>");
    });

    it.each([
      ["a hook file that is not there", "global-hooks", "gone.ts", "no hook file"],
      ["the companion extension", "companion", undefined, "only a hook file"],
    ] as const)("refuses removing %s", async (_label, root, path, reason) => {
      const host = loadExtension();
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [removal(root, path)] });
      expect(prepared.isError).toBe(true);
      expect(failures(prepared)).toEqual([expect.stringContaining(reason)]);
    });

    it("refuses recording a removal once a folder above the hook leads out of the hooks directory", async () => {
      const host = loadExtension();
      const hooks = join(agentDir(host), "hooks/pre");
      mkdirSync(join(hooks, "sub"), { recursive: true });
      writeFileSync(join(hooks, "sub/hook.ts"), handText);
      const { approval } = await askIntent(host, removal("global-hooks", "sub/hook.ts"));
      const outside = join(host.skillHome.home, "outside");
      mkdirSync(outside, { recursive: true });
      rmSync(join(hooks, "sub"), { recursive: true });
      symlinkSync(outside, join(hooks, "sub"));
      const result = await resolve(host, [removed(approval)]);
      expect(failures(result)).toEqual([expect.stringContaining("escapes its root")]);
      expect(existsSync(host.ledgerFile)).toBe(false);
    });

    it("refuses recording a removal once its hooks directory leads somewhere other than where Prepare found it", async () => {
      const host = loadExtension();
      const hooks = join(agentDir(host), "hooks/pre");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "hook.ts"), handText);
      const { approval } = await askIntent(host, removal("global-hooks", "hook.ts"));
      const outside = join(host.skillHome.home, "outside");
      mkdirSync(outside, { recursive: true });
      renameSync(hooks, join(host.skillHome.home, "moved-pre"));
      symlinkSync(outside, hooks);
      const result = await resolve(host, [removed(approval)]);
      expect(failures(result)).toEqual([expect.stringContaining("no longer resolves")]);
      expect(existsSync(host.ledgerFile)).toBe(false);
    });

    it("records an approved removal only once the file is gone, and a hand-written hook's without a prior applied record", async () => {
      const host = loadExtension();
      const file = handWritten(host, "global-hooks");
      const { proposal, approval } = await askIntent(host, removal("global-hooks", "mine.ts"));
      const early = await resolve(host, [removed(approval)]);
      expect(failures(early)).toEqual([expect.stringContaining("still there")]);
      expect(readFileSync(file, "utf8")).toBe(handText);
      expect(existsSync(host.ledgerFile)).toBe(false);

      rmSync(file);
      const result = await resolve(host, [removed(approval)]);
      expect(failures(result)).toEqual([]);
      expect(resultText(result)).toContain(`- withdrawn \`mine.ts\` (global hook), fingerprint \`${proposal.fingerprint}\`: Remove the misfiring hook`);
      expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({
        kind: "harness", outcome: "withdrawn", fingerprint: proposal.fingerprint, target: expect.objectContaining({ root: "global-hooks", path: "mine.ts" }),
      })]);
    });

    it("records removing an observer hook as a withdrawal of its applied record", async () => {
      const host = loadExtension();
      const { proposal, approval: intentApproval } = await askIntent(host, intent("project-hooks", "Block git commit here"));
      const file = `skill-observer-${proposal.fingerprint}.ts`;
      const { approval: codeApproval } = await askCode(host, code("project-hooks", "Block git commit here", intentApproval, [{ path: file, text: hookText }]));
      const receipts = publish(host, join(projectHooks(host), file), hookText, projectHooks(host));
      expect(failures(await resolve(host, [applied(codeApproval, { ...receipts, files: [{ path: file, afterHash: sha(hookText) }] })]))).toEqual([]);

      const { approval } = await askIntent(host, removal("project-hooks", file));
      rmSync(join(projectHooks(host), file));
      const result = await resolve(host, [removed(approval)]);
      expect(failures(result)).toEqual([]);
      expect(resultText(result)).toContain(`- withdrawn \`${file}\` (project hook), fingerprint \`${proposal.fingerprint}\`: Block git commit here`);
      expect(ledgerRecords(host.ledgerFile).map(({ fingerprint, outcome }) => [fingerprint, outcome])).toEqual([[proposal.fingerprint, "applied"], [proposal.fingerprint, "withdrawn"]]);
      await host.runCommand("observe", "Is the hook gone?");
      expect(String(host.sent.at(-1)?.message.content)).not.toContain("### Remedy outcomes");
    });

    it("leaves a declined removal's file and does not offer it again, while a change to the same hook is still offered", async () => {
      const host = loadExtension();
      const file = handWritten(host, "global-hooks");
      const { approval } = await askIntent(host, removal("global-hooks", "mine.ts"), () => "Decline");
      expect(failures(await resolve(host, [{ kind: "harness", proposal: approval.proposal, outcome: "declined" }]))).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(handText);
      startPass(host);
      const again = await host.callTool("observer_review", { action: "prepare", candidates: [removal("global-hooks", "mine.ts", "Remove it after all")] });
      expect(reviewEntries(again)).toEqual([]);
      const change = await host.callTool("observer_review", { action: "prepare", candidates: [intent("global-hooks", "Fix my hand-written hook", { path: "mine.ts" })] });
      expect(reviewEntries(change).map(({ proposal: { gist } }) => gist)).toEqual(["Fix my hand-written hook"]);
    });
  });
});

describe("/observe with answers from earlier passes", () => {
  /** The lines under a `### <heading>` of the message, up to the next heading. */
  function ledgerList(content: string, heading: string): string {
    const marker = `### ${heading}\n`;
    const start = content.indexOf(marker);
    if (start === -1) return "";
    const rest = content.slice(start + marker.length);
    const end = rest.search(/^#/m);
    return end === -1 ? rest : rest.slice(0, end);
  }

  /** Runs `/observe` on `branch`, by default a session with a correction, and returns the message it sent. */
  async function observe(
    host: {
      setBranch(entries: SessionEntry[]): void;
      runCommand(name: string): Promise<void>;
      sent: Array<{ message: CustomMessage }>;
    },
    branch = [...fx.plainUserMessage, ...fx.steeringUserMessage],
  ) {
    host.setBranch(branch);
    await host.runCommand("observe");
    expect(host.sent).toHaveLength(1);
    return String(host.sent[0]?.message.content);
  }

  const RULES_IN_FORCE = "Rules in force";
  /** The lines of one loaded skill's entry under Rules in force, up to the next skill's entry. */
  const skillEntry = (content: string, skill: string) => {
    const lines = ledgerList(content, RULES_IN_FORCE).split("\n");
    const start = lines.findIndex((line) => line.startsWith(`- \`${skill}\` (`));
    if (start === -1) return "";
    const end = lines.findIndex((line, i) => i > start && !line.startsWith("  "));
    return lines.slice(start, end === -1 ? undefined : end).join("\n");
  };
  /** The names from `names` in the order they appear in `text`. */
  const inOrder = (text: string, names: readonly string[]) =>
    text.split("\n").flatMap((line) => names.filter((name) => line.includes(`\`${name}\``)));

  /** Loads `tdd` (upstream), `implement-spec` (managed), `grill-with-docs` and `domain-modeling` (upstream). */
  const fourSkillsLoaded = [
    ...fx.plainUserMessage,
    ...fx.skillUrlRead,
    ...fx.skillPromptManaged,
    ...fx.harnessNoise,
    ...fx.physicalSkillRead,
  ];

  /** Writes a marked rule for `amends` as an earlier pass left it: a pattern amendment when pinned, else a barrier rule. */
  function markedRule(host: ReturnType<typeof loadExtension>, rule: { name: string; amends: string; scope: string; pinned?: boolean }) {
    mkdirSync(host.rulesDir, { recursive: true });
    const pin = rule.pinned ? `skillHash: "${currentSkillHash(host, rule.amends)}"\n` : "";
    writeFileSync(
      join(host.rulesDir, `${rule.name}.md`),
      `---\ndescription: "Gist of ${rule.name}."\ncondition: "x"\nscope: "${rule.scope}"\namends: "${rule.amends}"\n${pin}generatedBy: "skill-observer"\n---\n\nA rule.\n`,
    );
  }

  it("lists the loaded skills' rules with their fixes in force and nothing for other skills, apart from declined and deferred ones", async () => {
    const host = loadExtension();
    await host.callTool("observer_resolve", {
      outcomes: [
        outcome("implement-spec", "managed", "Run the typecheck before each commit.", "applied"),
        outcome("implement-spec", "managed", "Read the spec before the tickets.", "declined"),
        outcome("grill-with-docs", "upstream", "Ask one question at a time.", "later"),
        outcome("worktree-add", "managed", "Name the workspace after the ticket.", "applied"),
      ],
    });
    await addOnReadFix(host, "tdd", "Take seams from the ticket.", "## Seams\n\nTake seams from the ticket.");
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", "## Red\n\nA red is an assertion diff, not a crash.");
    await addOnReadFix(host, "domain-modeling", "Define each term first.", "## Glossary\n\nDefine each term in the glossary first.");
    markedRule(host, { name: "jj-no-git-commit", amends: "ce-commit-jj", scope: "tool:bash" });

    const content = await observe(host, fourSkillsLoaded);
    expect(content).not.toContain("Applied: check for recurrence");
    const tdd = skillEntry(content, "tdd").split("\n");
    expect(tdd[1]).toContain("`tdd-amendment`");
    expect(tdd[1]).toContain(String(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body.length));
    expect(tdd[1]?.match(/"[^"]+"/g)).toEqual(['"Seams"', '"Red"']);
    const fixes = tdd.slice(2);
    expect(fixes).toHaveLength(2);
    for (const gist of ["A red is an assertion diff.", "Take seams from the ticket."]) {
      const fix = fixes.find((line) => line.includes(proposalFingerprint("tdd", gist)));
      expect(fix).toContain(gist);
    }
    expect(skillEntry(content, "domain-modeling")).toContain("Define each term first.");
    expect(skillEntry(content, "implement-spec")).toContain("Run the typecheck before each commit.");
    const inForce = ledgerList(content, RULES_IN_FORCE);
    expect(inForce).not.toMatch(/jj-no-git-commit|Name the workspace|Read the spec|Ask one question/);
    expect(content).not.toContain("Read the spec before the tickets.");
    expect(ledgerList(content, "Later")).toContain("Ask one question at a time.");
  });

  it("shows each fix's fingerprint, gist, date and quotes under its rule", async () => {
    const host = loadExtension();
    const evidence = [
      { quote: "which seam is this testing?", count: 2 },
      { quote: "the ticket names the seams", count: 1 },
    ];
    await host.callTool("observer_resolve", {
      outcomes: await approveOnRead(host, [{ gist: "Take seams from the ticket.", section: "## Seams\n\nTake seams from the ticket.", evidence }]),
    });
    const [record] = ledgerRecords(host.ledgerFile);

    const lines = skillEntry(await observe(host, fourSkillsLoaded), "tdd").split("\n");
    const rule = lines.findIndex((l) => l.includes("`tdd-amendment`"));
    const fix = lines[rule + 1] ?? "";
    expect(fix).toContain("Take seams from the ticket.");
    expect(fix).toContain(String(record?.fingerprint));
    expect(fix).toContain(String(record?.timestamp).slice(0, 10));
    expect(fix).toContain('"which seam is this testing?" (×2)');
    expect(fix).toContain('"the ticket names the seams" (×1)');
  });

  it("lists the rule an old merge wrote as in force, and none of the fixes its `merged` records replaced", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-seams-and-reds");
    const merged = join(host.rulesDir, "tdd-seams-and-reds.md");
    const record = (gist: string, outcome: string, rule: string) => ({
      fingerprint: proposalFingerprint("tdd", gist),
      skill: "tdd",
      kind: "upstream",
      gist,
      outcome,
      rule,
      timestamp: new Date().toISOString(),
      sessionId: "fixture-session",
    });
    const sources = { "tdd-afk-seams": "Take seams from the ticket.", "tdd-red-is-an-assertion-diff": "A red is an assertion diff." };
    const records = [
      ...Object.entries(sources).map(([name, gist]) => record(gist, "applied", join(host.rulesDir, `${name}.md`))),
      ...Object.values(sources).map((gist) => record(gist, "merged", merged)),
    ];
    appendFileSync(host.ledgerFile, records.map((r) => `${JSON.stringify(r)}\n`).join(""));

    const content = await observe(host, fourSkillsLoaded);
    const tdd = skillEntry(content, "tdd");
    expect(tdd).toContain("`tdd-seams-and-reds`");
    expect(tdd).toContain("Gist of tdd-seams-and-reds.");
    expect(content).not.toMatch(/Take seams from the ticket|A red is an assertion diff/);
  });

  it("lists a pattern amendment that fired this session first with its firing count, and every rule of the skill", async () => {
    const host = loadExtension();
    const onRead = ["tdd-afk-seams", "tdd-name-the-seam", "tdd-red-is-an-assertion-diff", "tdd-one-behaviour"];
    for (const name of onRead) splitAmendment(host, "tdd", name, { evidence: [{ quote: name, count: 5 }] });
    markedRule(host, { name: "ts-no-tiny-functions", amends: "tdd", scope: "text", pinned: true });
    markedRule(host, { name: "use-ask-tool-for-questions", amends: "implement-spec", scope: "tool:bash" });

    const content = await observe(host, [...fourSkillsLoaded, ...fx.ruleViolationInterrupt, ...fx.repeatedRuleViolation.slice(0, 2)]);
    const tdd = skillEntry(content, "tdd");
    expect(inOrder(tdd, ["ts-no-tiny-functions", ...onRead])[0]).toBe("ts-no-tiny-functions");
    expect(inOrder(tdd, ["ts-no-tiny-functions", ...onRead]).sort()).toEqual(["ts-no-tiny-functions", ...onRead].sort());
    const pattern = tdd.split("\n").find((line) => line.includes("`ts-no-tiny-functions`"));
    expect(pattern).toContain("Pattern amendment");
    expect(pattern).toContain("`text`");
    expect(pattern).toMatch(/\b2\b/);
    const barrier = skillEntry(content, "implement-spec").split("\n").find((line) => line.includes("`use-ask-tool-for-questions`"));
    expect(barrier).toContain("Barrier rule");
    expect(barrier).toContain("`tool:bash`");
    expect(barrier).toMatch(/\b1\b/);
  });

  it("ranks a skill's rules that didn't fire by summed evidence counts, then newest first", async () => {
    const host = loadExtension();
    const fix = (name: string, counts: number[]) =>
      splitAmendment(host, "tdd", name, { evidence: counts.map((count, i) => ({ quote: `${name} ${i}`, count })) });
    fix("tdd-older-four", [3, 1]);
    fix("tdd-most", [5]);
    fix("tdd-newer-four", [4]);
    fix("tdd-newest-none", []);

    const tdd = skillEntry(await observe(host, fourSkillsLoaded), "tdd");
    expect(inOrder(tdd, ["tdd-older-four", "tdd-most", "tdd-newer-four", "tdd-newest-none"])).toEqual([
      "tdd-most",
      "tdd-newer-four",
      "tdd-older-four",
      "tdd-newest-none",
    ]);
  });

  it("lists amendments kept or updated at a stale check as in force, and doesn't count a delivered on-read amendment as a firing", async () => {
    const host = loadExtension();
    for (const [name, count] of [["tdd-afk-seams", 1], ["tdd-red-is-an-assertion-diff", 1], ["tdd-name-the-seam", 3]] as const) {
      splitAmendment(host, "tdd", name, { evidence: [{ quote: name, count }] });
    }
    setLockHash(host, "tdd", "0000000000000000000000000000000000000001");
    const { stale: [update] } = await approveAll(host, { stale: [{ rule: "tdd-red-is-an-assertion-diff", select: "Update", body: "A red is an assertion diff, not a crash." }] });
    await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "tdd-afk-seams", action: "keep" }, update] });

    // The session read tdd, which delivered the kept and the updated amendment.
    const delivery: SessionEntry = { type: "custom", id: "delivery-1", customType: AMENDMENT_DELIVERY_TYPE, data: { skill: "tdd", rules: ["tdd-afk-seams", "tdd-red-is-an-assertion-diff"] } };
    const tdd = skillEntry(await observe(host, [...fx.plainUserMessage, ...fx.skillUrlRead, delivery]), "tdd");
    expect(inOrder(tdd, ["tdd-afk-seams", "tdd-red-is-an-assertion-diff", "tdd-name-the-seam"])).toEqual([
      "tdd-name-the-seam",
      "tdd-red-is-an-assertion-diff",
      "tdd-afk-seams",
    ]);
    expect(tdd).toContain("Gist of tdd-afk-seams.");
    expect(tdd).toContain("Gist of tdd-red-is-an-assertion-diff.");
    expect(tdd).not.toContain("fired");
  });

  it("lists the fixes in the skill's on-read amendment after a stale keep, and no fix for the amendment itself", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Take seams from the ticket.", "## Seams\n\nTake seams from the ticket.");
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", "## Red\n\nA red is an assertion diff.");
    setLockHash(host, "tdd", "0000000000000000000000000000000000000001");
    await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "tdd-amendment", action: "keep" }] });

    const tdd = skillEntry(await observe(host, fourSkillsLoaded), "tdd").split("\n");
    const fixes = tdd.slice(2);
    expect(fixes).toHaveLength(2);
    for (const gist of ["A red is an assertion diff.", "Take seams from the ticket."]) {
      const fix = fixes.find((line) => line.includes(proposalFingerprint("tdd", gist)));
      expect(fix).toContain(gist);
    }
  });

  it("lists deferred proposals to re-offer, and leaves out declined ones and applied ones for skills this session didn't load", async () => {
    const host = loadExtension();
    await host.callTool("observer_resolve", {
      outcomes: [
        outcome("deploy-notes", "new", "Draft release notes from the jj log.", "declined"),
        outcome("implement-spec", "managed", "Run the typecheck before each commit.", "later"),
        outcome("grill-with-docs", "local", "Ask one question at a time.", "applied"),
      ],
    });

    const content = await observe(host);
    const [, deferred] = ledgerRecords(host.ledgerFile);
    expect(content).not.toContain("Draft release notes from the jj log.");
    expect(ledgerList(content, "Later")).toContain("Run the typecheck before each commit.");
    expect(ledgerList(content, "Later")).toContain(String(deferred?.fingerprint));
    expect(content).not.toContain("Ask one question at a time.");
  });

  it("describes each proposal by its latest answer", async () => {
    const host = loadExtension();
    await host.callTool("observer_resolve", {
      outcomes: [
        outcome("tdd", "upstream", "Name the seam before the first test.", "declined"),
        outcome("implement-spec", "managed", "Run the typecheck before each commit.", "later"),
      ],
    });
    await host.callTool("observer_resolve", {
      outcomes: [
        outcome("tdd", "upstream", "Name the seam before the first test.", "later"),
        outcome("implement-spec", "managed", "Run the typecheck before each commit.", "applied"),
      ],
    });

    const content = await observe(host);
    expect(ledgerList(content, "Later")).toContain("Name the seam before the first test.");
    expect(content).not.toContain("Run the typecheck before each commit.");
  });

  it("replaces a deferred proposal answered under its ledger fingerprint, even with a reworded gist", async () => {
    const host = loadExtension();
    await host.callTool("observer_resolve", {
      outcomes: [outcome("implement-spec", "managed", "Run the typecheck before each commit.", "later")],
    });
    const [deferred] = ledgerRecords(host.ledgerFile);
    await host.callTool("observer_resolve", {
      outcomes: [
        {
          ...outcome("implement-spec", "managed", "Typecheck before committing.", "declined"),
          fingerprint: deferred?.fingerprint,
        },
      ],
    });

    const content = await observe(host);
    expect(ledgerList(content, "Later")).not.toContain("typecheck");
    expect(content).not.toContain("Typecheck before committing.");
  });

  it("leaves out an applied fix whose rule file was deleted by other means, without writing to the ledger", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    splitAmendment(host, "tdd", "tdd-red-is-an-assertion-diff");
    rmSync(join(host.amendmentsDir, "tdd-afk-seams.md"));
    const ledger = readFileSync(host.ledgerFile, "utf8");

    const inForce = ledgerList(await observe(host, fourSkillsLoaded), RULES_IN_FORCE);
    expect(inForce).toContain("Gist of tdd-red-is-an-assertion-diff.");
    expect(inForce).not.toContain("Gist of tdd-afk-seams.");
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
  });

  it("lists every hand-written rule by name and description, whether or not a loaded skill relates to it", async () => {
    const host = loadExtension();
    mkdirSync(host.rulesDir, { recursive: true });
    writeFileSync(
      join(host.rulesDir, "use-ask-tool-for-questions.md"),
      '---\ndescription: "Ask questions with the ask tool."\ncondition: "\\\\?\\\\s*$"\n---\n\nAsk with the ask tool.\n',
    );
    writeFileSync(join(host.rulesDir, "prefer-jj.md"), "Use jj, not git.\n");
    await addOnReadFix(host, "tdd", "Take seams from the ticket.", "## Seams\n\nTake seams from the ticket.");

    const content = await observe(host);
    const handWritten = content.slice(content.indexOf("Hand-written rules in the user rules directory:"));
    expect(handWritten).toContain("- `use-ask-tool-for-questions`: Ask questions with the ask tool.");
    expect(handWritten).toContain("- `prefer-jj`:");
    expect(handWritten).not.toContain("tdd-amendment");
  });

  it("lists a withdrawn fix neither as in force nor as a Later entry", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    const [applied] = ledgerRecords(host.ledgerFile);
    await resolveApproved(host, { withdrawals: [{ fingerprint: applied?.fingerprint, gist: "Gist of tdd-afk-seams." }] });

    const content = await observe(host, fourSkillsLoaded);
    expect(content).not.toContain("Gist of tdd-afk-seams.");
    expect(content).not.toContain(String(applied?.fingerprint));
  });
});

/** A rule file's frontmatter keys and body; values are unquoted as YAML reads them. */
function readRule(file: string): { frontmatter: Record<string, string>; body: string } {
  const [, head = "", body = ""] = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(readFileSync(file, "utf8")) ?? [];
  const frontmatter: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const [, key, value] = /^(\w+):\s*(.*)$/.exec(line) ?? [];
    if (key && value !== undefined) frontmatter[key] = value.startsWith('"') ? JSON.parse(value) : value;
  }
  return { frontmatter, body: body.trim() };
}

/** Pattern amendments with samples that pass the replay check. */
const focusedTestsRule: PatternRule = {
  name: "tdd-no-focused-tests",
  body: "Run the whole file; drop `.only`.",
  pattern: "\\bit\\.only\\(",
  matches: ['Focus it: it.only("adds", () => {})'],
  spares: ['it("adds", () => {})'],
};
const bailRule: PatternRule = {
  name: "tdd-no-bail",
  body: "Run the whole file.",
  pattern: "--bail\\b",
  scope: "tool:bash",
  matches: [{ command: "bun run test --bail" }],
  spares: [{ command: "bun run test" }],
};
const noTodoRule: PatternRule = {
  name: "dm-no-todo",
  body: "Ask instead of leaving TODO markers.",
  pattern: "\\bTODO\\b",
  matches: ["Left a TODO for the naming."],
  spares: ["Asked about the naming instead."],
};

/** Applies a pattern amendment for `skill` through Prepare, Select, the user's explicit Apply and observer_resolve. */
const amend = async (host: ReturnType<typeof loadExtension>, skill: string, rule: PatternRule, gist = `Gist of ${rule.name}.`, kind = "upstream") =>
  host.callTool("observer_resolve", { outcomes: await approveRules(host, [{ skill, kind, gist, rule }]) });

/** Applies an on-read fix for `skill` through Prepare, Select, the user's explicit Apply and observer_resolve: the section it adds to the skill's on-read amendment. */
const addOnReadFix = async (host: ReturnType<typeof loadExtension>, skill: string, gist: string, section: string, kind = "upstream") =>
  host.callTool("observer_resolve", { outcomes: await approveOnRead(host, [{ skill, kind, gist, section }]) });

/** Sections of `tdd`'s on-read amendment, as on-read fixes carry them. */
const SEAMS = "## Seams\n\nName the seam under test before writing the first test.";
const RED = "## Red\n\nA red is an assertion diff, not a crash.";
const ONE_BEHAVIOUR = "## Scope\n\nTest one behaviour per test.";
const SESSIONS = "## Named sessions\n\nPass --session <name> on every scenario command and close exactly that one.";

describe("observer_resolve with upstream fixes", () => {
  it("creates the skill's on-read amendment from the first on-read fix, pinned to the skill's content hash", async () => {
    const host = loadExtension();
    const result = await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);

    const file = join(host.amendmentsDir, "tdd-amendment.md");
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain(file);
    expect(rulesWritten(host)).toEqual(["tdd-amendment.md"]);
    const { frontmatter, body } = readRule(file);
    expect(frontmatter).toMatchObject({ amends: "tdd", skillHash: currentSkillHash(host, "tdd") });
    expect(frontmatter).not.toHaveProperty("condition");
    expect(frontmatter).not.toHaveProperty("scope");
    expect(body).toBe(SEAMS);
    expect(ledgerRecords(host.ledgerFile)).toEqual([
      expect.objectContaining({ skill: "tdd", kind: "upstream", outcome: "applied", gist: "Name the seam before the first test.", rule: file }),
    ]);
  });

  it("appends each later on-read fix as a section, leaving the text before it unchanged byte for byte, with a ledger record per fix", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const first = readFileSync(file, "utf8");

    const [red, oneBehaviour] = await approveOnRead(host, [
      { gist: "A red is an assertion diff.", section: RED },
      { gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR },
    ]);
    const result = await host.callTool("observer_resolve", {
      outcomes: [red, outcome("tdd", "upstream", "Mock only at the seam.", "declined"), oneBehaviour],
    });

    expect(result.isError).toBeFalsy();
    expect(rulesWritten(host)).toEqual(["tdd-amendment.md"]);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith(first.trimEnd())).toBe(true);
    expect(readRule(file).body).toBe([SEAMS, RED, ONE_BEHAVIOUR].join("\n\n"));
    const records = ledgerRecords(host.ledgerFile);
    expect(records.map(({ gist, outcome, rule }) => ({ gist, outcome, rule }))).toEqual([
      { gist: "Name the seam first.", outcome: "applied", rule: file },
      { gist: "A red is an assertion diff.", outcome: "applied", rule: file },
      { gist: "Mock only at the seam.", outcome: "declined", rule: undefined },
      { gist: "Test one behaviour per test.", outcome: "applied", rule: file },
    ]);
    expect(new Set(records.map(({ fingerprint }) => fingerprint)).size).toBe(4);
  });

  it("keeps a re-applied on-read fix's section single when a second call of the pass answers it applied again", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name sessions on shared machines.", SESSIONS);

    const result = await addOnReadFix(host, "tdd", "Name sessions on shared machines.", SESSIONS);

    expect(result.isError).toBeFalsy();
    expect(rulesWritten(host)).toEqual(["tdd-amendment.md"]);
    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(SESSIONS);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({
      fingerprint: proposalFingerprint("tdd", "Name sessions on shared machines."),
      outcome: "applied",
    });
  });

  it("keeps the section single when one call carries the same applied on-read fix twice", async () => {
    const host = loadExtension();

    const [fix] = await approveOnRead(host, [{ gist: "Name sessions on shared machines.", section: SESSIONS }]);
    const result = await host.callTool("observer_resolve", { outcomes: [fix, fix] });

    expect(result.isError).toBeFalsy();
    expect(rulesWritten(host)).toEqual(["tdd-amendment.md"]);
    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(SESSIONS);
  });

  it("adds an on-read fix to the skill's one on-read amendment under whatever name and fingerprint it has", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams", { body: "Take seams from the ticket." });

    const result = await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);

    const file = join(host.amendmentsDir, "tdd-afk-seams.md");
    expect(result.isError).toBeFalsy();
    expect(rulesWritten(host)).toEqual(["tdd-afk-seams.md"]);
    expect(readRule(file).body).toBe(`Take seams from the ticket.\n\n${RED}`);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ gist: "A red is an assertion diff.", outcome: "applied", rule: file });
  });

  it("records and changes nothing for an on-read fix to a skill split into two on-read amendments, asking to join them by hand", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    const fixes = await approveOnRead(host, [{ gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR }]);
    splitAmendment(host, "tdd", "tdd-red-is-an-assertion-diff");
    const files = Object.fromEntries(readdirSync(host.amendmentsDir).map((name) => [name, readFileSync(join(host.amendmentsDir, name), "utf8")]));
    const ledger = readFileSync(host.ledgerFile, "utf8");

    const result = await host.callTool("observer_resolve", { outcomes: fixes });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Not recorded[\s\S]*join them into one by hand/);
    expect(Object.fromEntries(rulesWritten(host).map((name) => [name, readFileSync(join(host.amendmentsDir, name), "utf8")]))).toEqual(files);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
  });

  it.skipIf(!ompAvailable)("writes a pattern amendment that watches the model's text", async () => {
    const host = loadExtension();
    await amend(host, "tdd", focusedTestsRule);

    expect(readRule(join(host.rulesDir, "tdd-no-focused-tests.md")).frontmatter).toMatchObject({
      condition: "\\bit\\.only\\(",
      scope: "text",
      amends: "tdd",
      skillHash: currentSkillHash(host, "tdd"),
    });
  }, 30_000);

  it.skipIf(!ompAvailable)("writes a pattern amendment that watches one tool's calls", async () => {
    const host = loadExtension();
    const result = await amend(host, "tdd", bailRule);

    expect(result.isError).toBeFalsy();
    expect(readRule(join(host.rulesDir, "tdd-no-bail.md")).frontmatter).toMatchObject({
      condition: "--bail\\b",
      scope: "tool:bash",
      amends: "tdd",
      skillHash: currentSkillHash(host, "tdd"),
    });
  }, 30_000);

  it.skipIf(!ompAvailable)("keeps a pattern amendment in its own file next to the skill's on-read amendment", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await amend(host, "tdd", focusedTestsRule, "Run the whole file.");

    expect(rulesWritten(host).sort()).toEqual(["tdd-amendment.md", "tdd-no-focused-tests.md"]);
    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(SEAMS);
  }, 30_000);

  it.each(["rulesDir", "amendmentsDir"] as const)("leaves a file it didn't write under the amendment's name in the %s untouched and reports it", async (dir) => {
    const host = loadExtension();
    const [fix] = await approveOnRead(host, [{ gist: "Name the seam before the first test.", section: SEAMS }]);
    const foreign = join(host[dir], "tdd-amendment.md");
    mkdirSync(host[dir], { recursive: true });
    writeFileSync(foreign, "---\ncondition: \"x\"\n---\n\nThe user's own rule.\n");

    const result = await host.callTool("observer_resolve", {
      outcomes: [fix, outcome("ce-commit-jj", "local", "Ask one question at a time.", "applied")],
    });

    expect(readFileSync(foreign, "utf8")).toBe("---\ncondition: \"x\"\n---\n\nThe user's own rule.\n");
    expect(rulesWritten(host)).toEqual(["tdd-amendment.md"]);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(foreign);
    expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({ skill: "ce-commit-jj" })]);
  });

  it("prepares no pattern amendment under the name of another skill's on-read amendment", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "domain-modeling", "Define each term first.", "## Glossary\n\nDefine each term first.");

    const result = await prepareRules(host, [{ skill: "tdd", kind: "upstream", gist: "Run the whole file.", rule: { ...focusedTestsRule, name: "domain-modeling-amendment" } }]);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(join(host.amendmentsDir, "domain-modeling-amendment.md"));
    expect(rulesWritten(host)).toEqual(["domain-modeling-amendment.md"]);
  });

  it("prepares no pattern amendment that would replace a rule it wrote for a different proposal under the same name", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-seams", { body: "Name the seam first." });
    const result = await prepareRules(host, [{ skill: "tdd", kind: "upstream", gist: "Keep each test at one seam.",
      rule: { name: "tdd-seams", body: "Test at one seam only.", pattern: "\\bseams\\b", matches: ["two seams"], spares: ["one seam"] } }]);

    expect(result.isError).toBe(true);
    expect(reviewEntries(result)).toEqual([]);
    expect(readRule(join(host.amendmentsDir, "tdd-seams.md")).body).toBe("Name the seam first.");
  });

  it.each([
    ["a skill missing from the lock", "ce-commit-jj", "## Fix\n\nFix."],
    ["an empty section", "tdd", " "],
    ["a section that opens with no `##` heading", "tdd", "Fix.\n\n## Later heading\n\nMore."],
  ])("prepares no on-read append for %s, so nothing can approve it", async (_label, skill, section) => {
    const host = loadExtension();
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
      { kind: "upstream", skill, gist: "Fix the skill.", priority: "evidence", remedy: "Fix it", change: { operation: "on-read-append", section } },
    ] });

    expect(prepared.isError).toBe(true);
    expect(reviewEntries(prepared)).toEqual([]);
    expect(rulesWritten(host)).toEqual([]);
  });

  it.each([
    ["a rule name that leaves the rules directory", { name: "../escape", body: "Fix.", pattern: "x" }],
    ["a pattern that isn't a regex", { name: "tdd-fix", body: "Fix.", pattern: "(unclosed" }],
    ["a pattern without a rule name", { body: "Fix.", pattern: "x", matches: ["x"], spares: ["y"] }],
    ["a pattern under the on-read amendment's name", { name: "tdd-amendment", body: "Fix.", pattern: "x", matches: ["x"], spares: ["y"] }],
    ["a scope with a path glob", { name: "tdd-fix", body: "Fix.", pattern: "x", scope: "tool:edit(*.ts)" }],
    ["a scope naming no tool", { name: "tdd-fix", body: "Fix.", pattern: "x", scope: "tool" }],
    ["a scope reserved for on-read amendments", { name: "tdd-fix", body: "Fix.", pattern: "x", scope: "tool:read" }],
  ])("prepares no pattern amendment for %s, so nothing can approve it", async (_label, rule) => {
    const host = loadExtension();
    const result = await prepareRules(host, [{ skill: "tdd", kind: "upstream", gist: "Fix the skill.", rule: rule as PatternRule }]);

    expect(result.isError).toBe(true);
    expect(reviewEntries(result)).toEqual([]);
    expect(rulesWritten(host)).toEqual([]);
    expect(existsSync(dirname(host.rulesDir) + "/escape.md")).toBe(false);
  });
});

describe("withdrawing applied fixes", () => {
  it("deletes the rule file of a withdrawn fix and records it as withdrawn under the fix's fingerprint", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    const [applied] = ledgerRecords(host.ledgerFile);

    const result = await resolveApproved(host, { withdrawals: [{ fingerprint: applied?.fingerprint, gist: "Gist of tdd-afk-seams." }] });

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(host.amendmentsDir, "tdd-afk-seams.md"))).toBe(false);
    // Recorded under the path the applied record named, where the pass wrote the file.
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({
      fingerprint: applied?.fingerprint,
      skill: "tdd",
      gist: "Gist of tdd-afk-seams.",
      outcome: "withdrawn",
      rule: applied?.rule,
    });
  });

  /** Adds the Seams and Red sections to `tdd`'s on-read amendment and returns their applied records. */
  async function twoSections(host: ReturnType<typeof loadExtension>) {
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    const [seams, red] = ledgerRecords(host.ledgerFile);
    return { seams, red, file: join(host.amendmentsDir, "tdd-amendment.md") };
  }

  it("rewrites the skill's on-read amendment with the body a withdrawn fix inside it carries, and the fix leaves Rules in force", async () => {
    const host = loadExtension();
    const { red, file } = await twoSections(host);
    const { frontmatter } = readRule(file);

    const result = await resolveApproved(host, { withdrawals: [{ fingerprint: red?.fingerprint, gist: "A red is an assertion diff.", body: SEAMS }] });

    expect(result.isError).toBeFalsy();
    expect(readRule(file)).toEqual({ frontmatter, body: SEAMS });
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ fingerprint: red?.fingerprint, outcome: "withdrawn", rule: file });
    host.setBranch([...fx.plainUserMessage, ...fx.skillUrlRead]);
    await host.runCommand("observe");
    const content = String(host.sent[0]?.message.content);
    const inForce = content.slice(content.indexOf("### Rules in force"));
    expect(inForce).toContain('sections "Seams".');
    expect(inForce).toContain("Name the seam first.");
    expect(inForce).not.toContain("A red is an assertion diff.");
  });

  it("deletes the skill's on-read amendment when a withdrawn fix leaves its body empty", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    const [seams] = ledgerRecords(host.ledgerFile);

    const result = await resolveApproved(host, { withdrawals: [{ fingerprint: seams?.fingerprint, gist: "Name the seam first.", body: "" }] });

    expect(result.isError).toBeFalsy();
    expect(rulesWritten(host)).toEqual([]);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ fingerprint: seams?.fingerprint, outcome: "withdrawn" });
  });

  it("prepares no withdrawal inside the skill's on-read amendment that carries no new body, and changes nothing", async () => {
    const host = loadExtension();
    const { red, file } = await twoSections(host);
    const rule = readFileSync(file, "utf8");
    const ledger = readFileSync(host.ledgerFile, "utf8");

    const result = await host.callTool("observer_review", { action: "prepare", candidates: [withdrawalCandidate({ fingerprint: red?.fingerprint, gist: "A red is an assertion diff." })] });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining("the withdrawal needs its `body`")] });
    expect(readFileSync(file, "utf8")).toBe(rule);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
  });

  it("records and changes nothing for a withdrawal that empties the skill's on-read amendment while another fix in force is in it", async () => {
    const host = loadExtension();
    const { seams, red, file } = await twoSections(host);
    const rule = readFileSync(file, "utf8");
    const ledger = readFileSync(host.ledgerFile, "utf8");

    const result = await resolveApproved(host, { withdrawals: [{ fingerprint: red?.fingerprint, gist: "A red is an assertion diff.", body: "" }] });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(new RegExp(`Not recorded[\\s\\S]*${seams?.fingerprint}`));
    expect(readFileSync(file, "utf8")).toBe(rule);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
  });

  it("moves a fix to another skill: withdrawn for the old skill and applied for the new one in one call", async () => {
    const host = loadExtension();
    const { red, file } = await twoSections(host);

    const result = await resolveApproved(host, {
      withdrawals: [{ fingerprint: red?.fingerprint, gist: "Move the red fix to domain-modeling.", body: SEAMS }],
      fixes: [{ skill: "domain-modeling", gist: "A red is an assertion diff.", section: RED }],
    });

    const movedFile = join(host.amendmentsDir, "domain-modeling-amendment.md");
    expect(result.isError).toBeFalsy();
    expect(readRule(file).body).toBe(SEAMS);
    expect(readRule(movedFile)).toMatchObject({ frontmatter: { amends: "domain-modeling" }, body: RED });
    expect(ledgerRecords(host.ledgerFile).slice(2)).toEqual([
      expect.objectContaining({ skill: "tdd", fingerprint: red?.fingerprint, outcome: "withdrawn" }),
      expect.objectContaining({ skill: "domain-modeling", outcome: "applied", rule: movedFile }),
    ]);
  });

  it("takes a fix out of the skill's on-read amendment before adding one in the same call", async () => {
    const host = loadExtension();
    const { red, file } = await twoSections(host);

    const { outcomes: [withdrawn, oneBehaviour] } = await approveAll(host, {
      withdrawals: [{ fingerprint: red?.fingerprint, gist: "A red is an assertion diff.", body: SEAMS }],
      fixes: [{ gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR }],
    });
    await host.callTool("observer_resolve", { outcomes: [oneBehaviour, withdrawn] });

    expect(readRule(file).body).toBe(`${SEAMS}\n\n${ONE_BEHAVIOUR}`);
  });

  it.each([
    ["a hand-written rule", "tdd", "applied", true],
    ["a fingerprint whose latest answer is later", "tdd", "later", false],
    ["a fingerprint the ledger doesn't hold", "tdd", undefined, false],
    ["another skill's fix", "domain-modeling", "applied", false],
  ] as const)("prepares no withdrawal naming %s, and changes nothing", async (_label, skill, earlier, handWritten) => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    const file = join(host.amendmentsDir, "tdd-afk-seams.md");
    if (handWritten) writeFileSync(file, "---\namends: \"tdd\"\n---\n\nThe user's own rule.\n");
    if (earlier === "later") {
      await host.callTool("observer_resolve", { outcomes: [outcome("tdd", "upstream", "Gist of tdd-afk-seams.", "later")] });
    }
    const [applied] = ledgerRecords(host.ledgerFile);
    const rule = readFileSync(file, "utf8");
    const ledger = readFileSync(host.ledgerFile, "utf8");

    const result = await host.callTool("observer_review", { action: "prepare", candidates: [
      withdrawalCandidate({ skill, gist: "Gist of tdd-afk-seams.", fingerprint: earlier === undefined ? "0123456789ab" : applied?.fingerprint }),
    ] });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ eligible: [], failures: [expect.any(String)] });
    expect(readFileSync(file, "utf8")).toBe(rule);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
  });
});

describe("compacting on-read amendments", () => {
  /** A section of about `size` characters of body. */
  const section = (heading: string, size: number) => `## ${heading}\n\n${"Keep this instruction. ".repeat(Math.ceil(size / 23))}`.trim();
  const referencesDir = (host: ReturnType<typeof loadExtension>) => join(host.skillHome.home, ".omp/agent/skill-observer/references");
  /** The files in the skill's reference folder, by name, with their text. */
  const referenceFiles = (host: ReturnType<typeof loadExtension>, skill: string) => {
    const folder = join(referencesDir(host), skill);
    return existsSync(folder) ? Object.fromEntries(readdirSync(folder).map((name) => [name, readFileSync(join(folder, name), "utf8")])) : {};
  };
  /** Has the user approve a compaction of `tdd`, by default covering no addition, then resolves it. */
  const compact = async (host: ReturnType<typeof loadExtension>, draft: Partial<CompactionDraft> = {}) =>
    host.callTool("observer_resolve", await approveAll(host, { compactions: [{ includes: [], body: "## Short\n\nOne line.", ...draft }] }));
  /** The pointer line a compacted body keeps in place of a section moved to reference file `name`. */
  const pointer = (host: ReturnType<typeof loadExtension>, skill: string, name: string) =>
    `When you need ${name}, read \`${join(referencesDir(host), skill, name)}\`.`;
  /** Runs `/observe` on `branch` and returns the message it sent. */
  async function observe(host: ReturnType<typeof loadExtension>, branch: SessionEntry[]) {
    host.sent.length = 0;
    host.setBranch(branch);
    await host.runCommand("observe");
    return String(host.sent[0]?.message.content);
  }
  /** The Rules in force line of the rule named `name`. */
  const ruleLine = (content: string, name: string) =>
    content.slice(content.indexOf("### Rules in force")).split("\n").find((line) => line.includes(`\`${name}\``)) ?? "";
  const tddLoaded = [...fx.plainUserMessage, ...fx.skillUrlRead];

  it("marks a loaded skill's on-read amendment over the limit and not one under it, and lists no skill that wasn't loaded", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", section("Seams", 4100));
    await addOnReadFix(host, "domain-modeling", "Define each term first.", section("Glossary", 3900));
    await addOnReadFix(host, "grill-with-docs", "Ask one question at a time.", section("Questions", 4100));

    const content = await observe(host, [...tddLoaded, ...fx.physicalSkillRead]);

    const overLimit = ruleLine(content, "tdd-amendment");
    const underLimit = ruleLine(content, "domain-modeling-amendment");
    const overBody = readRule(join(host.amendmentsDir, "tdd-amendment.md")).body;
    const underBody = readRule(join(host.amendmentsDir, "domain-modeling-amendment.md")).body;
    expect(overBody.length).toBeGreaterThan(4000);
    expect(underBody.length).toBeLessThanOrEqual(4000);
    expect(overLimit).toContain(String(overBody.length));
    expect(overLimit).toContain("over the compaction limit");
    expect(overLimit.match(/"[^"]+"/g)).toEqual(['"Seams"']);
    expect(underLimit).toContain(String(underBody.length));
    expect(underLimit).not.toContain("over the compaction limit");
    expect(underLimit.match(/"[^"]+"/g)).toEqual(['"Glossary"']);
    expect(content).not.toContain("grill-with-docs-amendment");
  });

  it("replaces the body and writes exactly the given reference files, which a /skill: start then reaches through the body's pointers", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "domain-modeling", "Define each term first.", section("Glossary", 4100));
    const file = join(host.amendmentsDir, "domain-modeling-amendment.md");
    const { frontmatter } = readRule(file);
    const folder = join(referencesDir(host), "domain-modeling");
    await compact(host, {
      skill: "domain-modeling",
      body: `## Short\n\n${pointer(host, "domain-modeling", "old.md")}\n${pointer(host, "domain-modeling", "kept.md")}`,
      references: [{ name: "old.md", body: "Old." }, { name: "kept.md", body: "Kept." }],
    });
    const body = `## Glossary\n\nDefine each term first. When naming a term, read \`${folder}/terms.md\`. ${pointer(host, "domain-modeling", "kept.md")}`;

    const result = await compact(host, { skill: "domain-modeling", body, references: [{ name: "kept.md", body: "Kept, shorter." }, { name: "terms.md", body: "Term rules." }] });

    expect(result.isError).toBeFalsy();
    expect(readRule(file)).toEqual({ frontmatter, body });
    expect(referenceFiles(host, "domain-modeling")).toEqual({ "kept.md": "Kept, shorter.\n", "terms.md": "Term rules.\n" });
    expect(rulesWritten(host)).toEqual(["domain-modeling-amendment.md"]);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "domain-modeling", outcome: "applied", compaction: true, rule: file });
    host.setBranch(fx.plainUserMessage);
    const [reminder] = await host.startAgent(String(fx.skillPromptUpstream[0]?.content));
    expect(String(reminder?.content)).toContain(`read \`${folder}/terms.md\``);
    expect(String(reminder?.content)).not.toContain("Keep this instruction.");
  });

  it("writes an approved compaction exactly as prepared after this call's two approved additions it covers, removing the reference files it leaves out, and reports what it rests on", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const { frontmatter } = readRule(file);
    mkdirSync(join(referencesDir(host), "tdd"), { recursive: true });
    writeFileSync(join(referencesDir(host), "tdd", "old.md"), "Old recipes.\n");
    const body = `${SEAMS}\n\n${RED}\n\n${ONE_BEHAVIOUR}\n\n${pointer(host, "tdd", "kept.md")}`;
    const approved = await approveAll(host, {
      fixes: [{ gist: "A red is an assertion diff.", section: RED }, { gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR }],
      compactions: [{ includes: ["A red is an assertion diff.", "Test one behaviour per test."], body, references: [{ name: "kept.md", body: "Kept." }] }],
    });

    const result = await host.callTool("observer_resolve", approved);

    expect(result.isError).toBeFalsy();
    expect(readRule(file)).toEqual({ frontmatter, body });
    expect(referenceFiles(host, "tdd")).toEqual({ "kept.md": "Kept.\n" });
    expect(ledgerRecords(host.ledgerFile).slice(1).map(({ gist, outcome, compaction }) => [gist, outcome, compaction])).toEqual([
      ["A red is an assertion diff.", "applied", undefined],
      ["Test one behaviour per test.", "applied", undefined],
      ["Compact the on-read amendment of `tdd`.", "applied", true],
    ]);
    const [compaction] = approved.compactions;
    expect((result.details as { approvals: Array<{ approval: unknown; selected: string }> }).approvals.at(-1)).toEqual({
      fingerprint: ledgerRecords(host.ledgerFile).at(-1)?.fingerprint, approval: compaction?.approval, selected: "Apply",
    });
    expect(resultText(result)).toContain(`the user selected Apply in Ask \`${compaction?.approval.askToolCallId}\` for proposal \`${compaction?.approval.proposal.candidateId}\``);
  });

  it("writes an approved compaction over the on-read amendment this call's approved addition created", async () => {
    const host = loadExtension();
    const body = "## Short\n\nName the seam first.";

    const result = await host.callTool("observer_resolve", await approveAll(host, {
      fixes: [{ gist: "Name the seam first.", section: SEAMS }],
      compactions: [{ includes: ["Name the seam first."], body }],
    }));

    expect(result.details).toMatchObject({ failures: [], deferred: [] });
    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(body);
    expect(ledgerRecords(host.ledgerFile).map(({ outcome, compaction }) => [outcome, compaction])).toEqual([["applied", undefined], ["applied", true]]);
  });

  it("records a compaction that includes an addition the user declined in the same Ask as later and writes nothing for it, while the approved addition is appended", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", section("Seams", 4100));
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const before = readRule(file).body;
    const declined = "Test one behaviour per test.";

    const { entry, approval } = await approveCandidates(host, [
      onReadCandidate({ gist: "A red is an assertion diff.", section: RED }), onReadCandidate({ gist: declined, section: ONE_BEHAVIOUR }),
      compactionCandidate({ includes: ["A red is an assertion diff.", declined], body: `## Short\n\n${pointer(host, "tdd", "seams.md")}`, references: [{ name: "seams.md", body: "Seams." }] }),
    ], (proposal) => proposal.gist === declined ? "Decline" : "Apply");
    const result = await host.callTool("observer_resolve", {
      outcomes: [
        { ...outcome("tdd", "upstream", "A red is an assertion diff.", "applied"), approval: approval("A red is an assertion diff.") },
        { ...outcome("tdd", "upstream", declined, "declined"), fingerprint: entry(declined).proposal.fingerprint },
      ],
      compactions: [{ skill: "tdd", outcome: "applied", approval: approval(compactionGist("tdd")) }],
    });

    expect(result.isError).toBeFalsy();
    expect(readRule(file).body).toBe(`${before}\n\n${RED}`);
    expect(referenceFiles(host, "tdd")).toEqual({});
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "tdd", outcome: "later", compaction: true });
    expect(ledgerRecords(host.ledgerFile).at(-1)).not.toHaveProperty("rule");
    expect(result.details).toMatchObject({ deferred: [expect.stringContaining(`compaction of \`tdd\`: it includes additions this call didn't apply (\`${proposalFingerprint("tdd", declined)}\`)`)] });
  });

  it("records a compaction as later and writes nothing for it when it leaves out an on-read fix applied for its skill in the same call", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", section("Seams", 4100));
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const before = readRule(file).body;

    const result = await host.callTool("observer_resolve", await approveAll(host, {
      fixes: [{ gist: "A red is an assertion diff.", section: RED }],
      compactions: [{ includes: [], body: SEAMS }],
    }));

    expect(result.isError).toBeFalsy();
    expect(readRule(file).body).toBe(`${before}\n\n${RED}`);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "tdd", outcome: "later", compaction: true });
    expect(result.details).toMatchObject({ deferred: [expect.stringMatching(/compaction of `tdd`.*A red is an assertion diff/)] });
  });

  it("prepares a compaction's `includes` as the identities of the additions it prepared, so Resolve applies it over a re-offered Later fix", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", section("Seams", 4100));
    await host.callTool("observer_resolve", { outcomes: [outcome("tdd", "upstream", "A red is an assertion diff.", "later")] });
    const later = String(ledgerRecords(host.ledgerFile).at(-1)?.fingerprint);
    const gist = "Reds are assertion diffs, never crashes.";
    const body = `${SEAMS}\n\n${RED}`;
    const addition = onReadCandidate({ gist, fingerprint: later, section: RED });

    const unknown = await host.callTool("observer_review", { action: "prepare", candidates: [addition, compactionCandidate({ includes: [gist, "Never prepared"], body })] });
    expect(unknown).toMatchObject({ isError: true, details: { eligible: [], failures: [expect.stringContaining("Never prepared")] } });
    const { entry, approval } = await approveCandidates(host, [compactionCandidate({ includes: [gist], body }), addition]);
    expect(entry(compactionGist("tdd")).proposal.change.includes).toEqual([later]);
    const result = await host.callTool("observer_resolve", {
      outcomes: [{ ...outcome("tdd", "upstream", gist, "applied"), fingerprint: later, approval: approval(gist) }],
      compactions: [{ skill: "tdd", outcome: "applied", approval: approval(compactionGist("tdd")) }],
    });

    expect(result.details).toMatchObject({ deferred: [], failures: [] });
    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(body);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ outcome: "applied", compaction: true });
  });

  describe("proposal approval of compactions", () => {
    /** `tdd`'s on-read amendment with the Seams section, and the user's Apply to a Red fix and a compaction covering it. */
    async function approvedCompaction(answer?: AnswerUser) {
      const host = loadExtension();
      await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
      const candidates = [onReadCandidate({ gist: "A red is an assertion diff.", section: RED }), compactionCandidate({ includes: ["A red is an assertion diff."], body: `${SEAMS}\n\n${RED}` })];
      const { approval } = await approveCandidates(host, candidates, answer);
      const fix = { ...outcome("tdd", "upstream", "A red is an assertion diff.", "applied"), approval: approval("A red is an assertion diff.") };
      return { host, fix, compaction: { skill: "tdd", outcome: "applied", approval: approval(compactionGist("tdd")) } };
    }
    type Approved = Awaited<ReturnType<typeof approvedCompaction>>;

    it.each<[string, string, (approved: Approved) => Record<string, unknown>]>([
      ["a substituted body beside the approval", "carries no `body`", ({ compaction }) => ({ compactions: [{ ...compaction, body: "## Substituted\n\nNot what the user saw." }] })],
      ["substituted `includes` beside the approval", "carries no `body`, `includes`", ({ compaction }) => ({ compactions: [{ ...compaction, includes: [] }] })],
      ["substituted reference files beside the approval", "`references`", ({ compaction }) => ({ compactions: [{ ...compaction, references: [{ name: "other.md", body: "Other." }] }] })],
      ["an applied compaction without approval", "needs `approval`", ({ compaction: { approval: _, ...answer } }) => ({ compactions: [answer] })],
      ["an approval on a Later compaction", "comes only with an applied compaction", ({ compaction }) => ({ compactions: [{ ...compaction, outcome: "later" }] })],
      ["another skill's compaction", "the compaction of `tdd`, not of `domain-modeling`", ({ compaction }) => ({ compactions: [{ ...compaction, skill: "domain-modeling" }] })],
      ["an on-read fix's approval", "does not carry out", ({ fix, compaction }) => ({ compactions: [{ ...compaction, approval: fix.approval }] })],
      ["the compaction's approval sent as an on-read fix", "does not carry out", ({ fix, compaction }) => ({ outcomes: [{ ...fix, approval: compaction.approval }] })],
      ["a forged content hash", "content hash", ({ compaction }) =>
        ({ compactions: [{ ...compaction, approval: { ...compaction.approval, proposal: { ...compaction.approval.proposal, contentHash: "0".repeat(64) } } }] })],
      ["a reconciliation of it", "is reconciled", ({ compaction }) => ({ compactions: [{ ...compaction, approval: { ...compaction.approval, revision: compaction.approval.proposal } }] })],
      ["an amendment changed since Prepare", "changed since Prepare read it; prepare it again and ask again", ({ host, compaction }) => {
        writeFileSync(join(host.amendmentsDir, "tdd-amendment.md"), `${readFileSync(join(host.amendmentsDir, "tdd-amendment.md"), "utf8")}\n## Mine\n\nThe user's own words.\n`);
        return { compactions: [compaction] };
      }],
      ["a reference file added since Prepare", "reference files", ({ host, compaction }) => {
        mkdirSync(join(referencesDir(host), "tdd"), { recursive: true });
        writeFileSync(join(referencesDir(host), "tdd", "mine.md"), "The user's own recipes.\n");
        return { compactions: [compaction] };
      }],
    ])("writes and records nothing for %s", async (_label, reason, params) => {
      const approved = await approvedCompaction();
      const sent = params(approved);
      const before = { files: ownedFiles(approved.host), ledger: readFileSync(approved.host.ledgerFile, "utf8") };

      const result = await approved.host.callTool("observer_resolve", { outcomes: [], ...sent });

      expect(failures(result)).toEqual([expect.stringContaining(reason)]);
      expect((result.details as { records: unknown[] }).records).toEqual([]);
      expect({ files: ownedFiles(approved.host), ledger: readFileSync(approved.host.ledgerFile, "utf8") }).toEqual(before);
    });

    it("writes nothing for a compaction the user declined", async () => {
      const { host, fix, compaction } = await approvedCompaction((proposal) => proposal.priority === "compaction" ? "Decline" : "Apply");
      const before = ownedFiles(host);

      const result = await host.callTool("observer_resolve", { outcomes: [], compactions: [compaction] });

      expect(failures(result)).toEqual([expect.stringContaining("selected `Decline`")]);
      expect(ownedFiles(host)).toEqual(before);
      expect(fix.approval.askToolCallId).toBe(compaction.approval.askToolCallId);
    });

    it("writes and records nothing for a compaction applied with a note", async () => {
      const { host, compaction } = await approvedCompaction((proposal) => proposal.priority === "compaction" ? { option: "Apply", note: "Keep Red first." } : "Apply");
      const before = { files: ownedFiles(host), ledger: readFileSync(host.ledgerFile, "utf8") };

      const result = await host.callTool("observer_resolve", { outcomes: [], compactions: [compaction] });

      expect(failures(result)).toEqual([expect.stringContaining("with the note \"Keep Red first.\"")]);
      expect((result.details as { records: unknown[] }).records).toEqual([]);
      expect({ files: ownedFiles(host), ledger: readFileSync(host.ledgerFile, "utf8") }).toEqual(before);
    });
  });

  it.each([
    ["an applied compaction", "compaction"],
    ["a stale update", "stale"],
    ["a withdrawal", "withdrawal"],
  ] as const)("records, prepares and writes nothing for %s whose body lacks the absolute path of a reference file it carries", async (_label, answer) => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    const red = ledgerRecords(host.ledgerFile).at(-1);
    setLockHash(host, "tdd", "0000000000000000000000000000000000000001");
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const rule = readFileSync(file, "utf8");
    const ledger = readFileSync(host.ledgerFile, "utf8");
    // Points at one file by its bare name and at the other by its path, as the live pass wrote it.
    const body = `## Seams\n\nRead references/tdd/seams.md. ${pointer(host, "tdd", "reds.md")}`;
    const references = [
      { name: "seams.md", body: "Seam recipes." },
      { name: "reds.md", body: "Red recipes." },
    ];

    const result = await host.callTool("observer_review", { action: "prepare", candidates: answer === "compaction"
      ? [compactionCandidate({ includes: [], body, references })]
      : answer === "withdrawal"
        ? [withdrawalCandidate({ fingerprint: red?.fingerprint, gist: "A red is an assertion diff.", body, references })]
        : staleCandidates({ rule: "tdd-amendment", select: "Update", body, references }) });

    expect(result.isError).toBe(true);
    const failures = (result.details as { failures: string[] }).failures.join("\n");
    expect(failures).toMatch(/pointer[\s\S]*seams\.md/);
    expect(failures).not.toMatch(/reds\.md/);
    expect(readFileSync(file, "utf8")).toBe(rule);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
    expect(existsSync(referencesDir(host))).toBe(false);
  });

  it.each([
    ["an applied compaction", "compaction"],
    ["a withdrawal", "withdrawal"],
  ] as const)("records and rewrites nothing for %s whose reference files can't be written", async (_label, answer) => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    const red = ledgerRecords(host.ledgerFile).at(-1);
    // A file where the references directory belongs makes every write under it fail.
    writeFileSync(referencesDir(host), "In the way.");
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const rule = readFileSync(file, "utf8");
    const ledger = readFileSync(host.ledgerFile, "utf8");
    const body = `## Seams\n\n${pointer(host, "tdd", "seams.md")}`;
    const references = [{ name: "seams.md", body: "Seam recipes." }];

    const result = answer === "withdrawal"
      ? await resolveApproved(host, { withdrawals: [{ fingerprint: red?.fingerprint, gist: "A red is an assertion diff.", body, references }] })
      : await compact(host, { body, references });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Not recorded");
    expect(resultText(result)).not.toMatch(/approval|changed since/);
    expect(readFileSync(file, "utf8")).toBe(rule);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
  });

  it("keeps the old reference files and body when writing a compaction's reference files fails", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    await compact(host, { body: `${SEAMS}\n\n${pointer(host, "tdd", "reds.md")}`, references: [{ name: "reds.md", body: "Red recipes." }] });
    const file = join(host.amendmentsDir, "tdd-amendment.md");
    const rule = readFileSync(file, "utf8");
    // A read-only references directory refuses every new entry in it.
    chmodSync(referencesDir(host), 0o555);
    try {
      const result = await compact(host, { body: `## Short\n\n${pointer(host, "tdd", "seams.md")}`, references: [{ name: "seams.md", body: "Seam recipes." }] });

      expect(result.isError).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(rule);
      expect(referenceFiles(host, "tdd")).toEqual({ "reds.md": "Red recipes.\n" });
    } finally {
      chmodSync(referencesDir(host), 0o755);
    }
  });

  it("records a compaction as later and writes nothing for it when a stale update of the amendment settled in the same call", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", section("Seams", 4100));
    setLockHash(host, "tdd", "0000000000000000000000000000000000000001");

    const approved = await approveAll(host, { stale: [{ rule: "tdd-amendment", select: "Update", body: SEAMS }], compactions: [{ includes: [], body: RED }] });
    const result = await host.callTool("observer_resolve", approved);

    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(SEAMS);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "tdd", outcome: "later", compaction: true });
    expect(result.details).toMatchObject({ deferred: [expect.stringMatching(/compaction of `tdd`.*stale/)] });
  });

  it("offers no compaction again for a body whose compaction was declined, until an addition changes the body", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", section("Seams", 4100));
    const MARK = "over the compaction limit";
    expect(ruleLine(await observe(host, tddLoaded), "tdd-amendment")).toContain(MARK);

    await host.callTool("observer_resolve", { outcomes: [], compactions: [{ skill: "tdd", outcome: "declined" }] });
    expect(ruleLine(await observe(host, tddLoaded), "tdd-amendment")).not.toContain(MARK);

    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    expect(ruleLine(await observe(host, tddLoaded), "tdd-amendment")).toContain(MARK);
  });

  it("lists compaction records neither as fixes in force nor as Later entries", async () => {
    const host = loadExtension();
    for (const skill of ["tdd", "domain-modeling", "grill-with-docs"]) {
      await addOnReadFix(host, skill, `First fix of ${skill}.`, section("First", 100));
    }
    await compact(host);
    await host.callTool("observer_resolve", { outcomes: [], compactions: [{ skill: "domain-modeling", outcome: "declined" }, { skill: "grill-with-docs", outcome: "later" }] });
    expect(ledgerRecords(host.ledgerFile).filter((record) => record.compaction)).toHaveLength(3);

    const content = await observe(host, [...tddLoaded, ...fx.physicalSkillRead, ...fx.steeringUserMessage]);
    expect(content).toContain("First fix of tdd.");
    expect(content).not.toContain("Compact the on-read amendment");
  });

  it("prepares no withdrawal citing a compaction's fingerprint", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await compact(host);
    const compaction = ledgerRecords(host.ledgerFile).at(-1);

    const result = await host.callTool("observer_review", { action: "prepare", candidates: [
      withdrawalCandidate({ fingerprint: compaction?.fingerprint, gist: "Compact.", body: "" }),
    ] });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ failures: [expect.stringContaining("is a compaction, not a fix")] });
    expect(rulesWritten(host)).toEqual(["tdd-amendment.md"]);
  });

  it.each([
    ["a parent directory", "../escape.md"],
    ["a path separator", "nested/file.md"],
    ["a bare `..`", ".."],
  ])("prepares, writes and records nothing for a reference file name with %s", async (_label, name) => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    const rule = readFileSync(join(host.amendmentsDir, "tdd-amendment.md"), "utf8");
    const ledger = readFileSync(host.ledgerFile, "utf8");

    const result = await host.callTool("observer_review", { action: "prepare", candidates: [compactionCandidate({ includes: [], body: "## Short\n\nOne line.", references: [{ name, body: "Escaped." }] })] });

    expect(result.isError).toBe(true);
    expect(readFileSync(join(host.amendmentsDir, "tdd-amendment.md"), "utf8")).toBe(rule);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
    expect(existsSync(referencesDir(host))).toBe(false);
  });

  describe("reference files follow their amendment", () => {
    /** `tdd`'s amendment with two sections and a compaction that gave it one reference file. */
    async function compacted(host: ReturnType<typeof loadExtension>) {
      await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
      await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
      const [seams, red] = ledgerRecords(host.ledgerFile);
      await compact(host, { body: `${SEAMS}\n\n${RED}\n\n${pointer(host, "tdd", "reds.md")}`, references: [{ name: "reds.md", body: "Red recipes." }] });
      expect(Object.keys(referenceFiles(host, "tdd"))).toEqual(["reds.md"]);
      return { seams, red };
    }
    it("withdrawing the amendment's last fix deletes the skill's reference folder", async () => {
      const host = loadExtension();
      const { seams, red } = await compacted(host);

      const result = await resolveApproved(host, { withdrawals: [
        { fingerprint: seams?.fingerprint, gist: "Name the seam first.", body: "" },
        { fingerprint: red?.fingerprint, gist: "A red is an assertion diff.", body: "" },
      ] });

      expect(result.isError).toBeFalsy();
      expect(rulesWritten(host)).toEqual([]);
      expect(existsSync(join(referencesDir(host), "tdd"))).toBe(false);
    });

    it("a stale delete of the amendment deletes the skill's reference folder", async () => {
      const host = loadExtension();
      await compacted(host);
      setLockHash(host, "tdd", "0000000000000000000000000000000000000001");

      await resolveApproved(host, { stale: [{ rule: "tdd-amendment", select: "Delete" }] });

      expect(rulesWritten(host)).toEqual([]);
      expect(existsSync(join(referencesDir(host), "tdd"))).toBe(false);
    });

    it("a withdrawal that carries reference files replaces the folder's contents, and one without them leaves it", async () => {
      const host = loadExtension();
      const { seams, red } = await compacted(host);

      await resolveApproved(host, { withdrawals: [{ fingerprint: seams?.fingerprint, gist: "Name the seam first.", body: RED }] });
      expect(referenceFiles(host, "tdd")).toEqual({ "reds.md": "Red recipes.\n" });

      await resolveApproved(host, { withdrawals: [{
        fingerprint: red?.fingerprint, gist: "A red is an assertion diff.",
        body: `## Other\n\n${pointer(host, "tdd", "other.md")}`, references: [{ name: "other.md", body: "Other." }],
      }] });
      expect(referenceFiles(host, "tdd")).toEqual({ "other.md": "Other.\n" });
    });

    it("a stale update that carries reference files replaces the folder's contents", async () => {
      const host = loadExtension();
      await compacted(host);
      setLockHash(host, "tdd", "0000000000000000000000000000000000000001");

      const result = await resolveApproved(host, { stale: [
        { rule: "tdd-amendment", select: "Update", body: `${SEAMS}\n\n${pointer(host, "tdd", "seams.md")}`, references: [{ name: "seams.md", body: "Seam recipes." }] },
      ] });

      expect(result.isError).toBeFalsy();
      expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(`${SEAMS}\n\n${pointer(host, "tdd", "seams.md")}`);
      expect(referenceFiles(host, "tdd")).toEqual({ "seams.md": "Seam recipes.\n" });
    });

    it("lists the amendment's reference files under Rules in force", async () => {
      const host = loadExtension();
      await compacted(host);

      expect(ruleLine(await observe(host, tddLoaded), "tdd-amendment")).toContain(`Reference files: \`${join(referencesDir(host), "tdd", "reds.md")}\`.`);
    });
  });
});

/** A barrier rule for `ce-commit-jj` whose samples pass the replay check. */
const JJ_NOT_GIT: PatternRule = {
  name: "jj-not-git",
  body: "Use `jj commit`; this repo has no git index.",
  pattern: "\\bgit commit\\b",
  scope: "tool:bash",
  matches: [{ command: 'git commit -m "wip"' }],
  spares: [{ command: 'jj commit -m "wip"' }],
};

/** The applied answer of a barrier rule for a local or managed skill, approved through Prepare, Select and the user's explicit Apply. */
const barrierFix = async (host: ReturnType<typeof loadExtension>, skill: string, kind: string, rule: Partial<PatternRule> = {}, gist = "Commit with jj, not git.") => {
  const [applied] = await approveRules(host, [{ skill, kind, gist, rule: { ...JJ_NOT_GIT, ...rule } }]);
  if (!applied) throw new Error("no applied answer");
  return applied;
};

describe("observer_resolve with barrier rules for local and managed skills", () => {
  it.skipIf(!ompAvailable).each([
    ["a local skill", "ce-commit-jj", "local"],
    ["a managed skill", "implement-spec", "managed"],
  ])("writes the barrier rule for %s, marked and linked to its ledger record, with no lock hash", async (_label, skill, kind) => {
    const host = loadExtension();
    const result = await host.callTool("observer_resolve", { outcomes: [await barrierFix(host, skill, kind)] });

    const file = join(host.rulesDir, "jj-not-git.md");
    expect(result.isError).toBeFalsy();
    const { frontmatter, body } = readRule(file);
    const [record] = ledgerRecords(host.ledgerFile);
    expect(frontmatter).toMatchObject({
      description: "Commit with jj, not git.",
      condition: "\\bgit commit\\b",
      scope: "tool:bash",
      amends: skill,
      fingerprint: record?.fingerprint,
      generatedBy: "skill-observer",
    });
    expect(frontmatter).not.toHaveProperty("skillHash");
    expect(body).toBe("Use `jj commit`; this repo has no git index.");
    expect(record).toMatchObject({ skill, kind, outcome: "applied", rule: file });
  }, 30_000);

  it.each([
    ["no pattern", "ce-commit-jj", "local", { pattern: undefined }, /`pattern`/],
    ["a blank pattern", "ce-commit-jj", "local", { pattern: " " }, /`pattern`/],
    ["a scope that is neither text nor one tool", "ce-commit-jj", "local", { scope: "thinking" }, /scope `thinking`/],
    ["an uppercase tool name", "ce-commit-jj", "local", { scope: "tool:Bash" }, /scope `tool:Bash`/],
    ["no mistake sample", "ce-commit-jj", "local", { matches: undefined }, /`matches`/],
    ["no legitimate sample", "ce-commit-jj", "local", { spares: [] }, /`spares`/],
    ["a skill of another provenance than the candidate names", "implement-spec", "local", {}, /not a local skill/],
    ["a new skill", "jj-commit", "new", {}, /new skill/],
  ])("prepares no barrier rule with %s, so nothing can approve it", async (_label, skill, kind, rule, reason) => {
    const host = loadExtension();
    const result = await prepareRules(host, [{ skill, kind, gist: "Commit with jj, not git.", rule: { ...JJ_NOT_GIT, ...rule } as PatternRule }]);

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringMatching(reason)] });
    expect(rulesWritten(host)).toEqual([]);
  });

  it("prepares no barrier rule over a hand-written rule file under the same name, and leaves it untouched", async () => {
    const host = loadExtension();
    const foreign = join(host.rulesDir, "jj-not-git.md");
    const handWritten = "---\ncondition: \"git commit\"\nscope: \"tool:bash\"\n---\n\nThe user's own rule.\n";
    mkdirSync(host.rulesDir, { recursive: true });
    writeFileSync(foreign, handWritten);

    const result = await prepareRules(host, [{ skill: "ce-commit-jj", kind: "local", gist: "Commit with jj, not git.", rule: JJ_NOT_GIT }]);

    expect(readFileSync(foreign, "utf8")).toBe(handWritten);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(foreign);
  });
});

describe("proposal approval of pattern amendments and barrier rules", () => {
  const jjFile = (host: ReturnType<typeof loadExtension>) => join(host.rulesDir, "jj-not-git.md");
  /** Resolves `outcomes` and expects a failure for `reason` that left every observer byte unchanged and recorded nothing, not even a Later. */
  const expectNoWrite = async (host: ReturnType<typeof loadExtension>, outcomes: unknown[], reason: string) => {
    const before = observerBytes(host);
    const result = await host.callTool("observer_resolve", { outcomes });
    expect(result.isError).toBe(true);
    expect(failures(result)).toEqual([expect.stringContaining(reason)]);
    expect((result.details as { records: unknown[] }).records).toEqual([]);
    expect(observerBytes(host)).toEqual(before);
  };
  const drafts = {
    "a barrier rule": { skill: "ce-commit-jj", kind: "local", gist: "Commit with jj, not git.", rule: JJ_NOT_GIT },
    "a pattern amendment": { skill: "tdd", kind: "upstream", gist: "Run the whole file.", rule: focusedTestsRule },
  } satisfies Record<string, RuleProposalDraft>;
  type Approved = { host: ReturnType<typeof loadExtension>; applied: Awaited<ReturnType<typeof barrierFix>> };
  const approved = async (draft: RuleProposalDraft, answer?: AnswerUser): Promise<Approved> => {
    const host = loadExtension();
    const [applied] = await approveRules(host, [draft], answer);
    if (!applied) throw new Error("no applied answer");
    return { host, applied };
  };

  it.skipIf(!ompAvailable)("writes a pattern amendment and a barrier rule exactly as prepared once their replay passes, and reports what each rests on", async () => {
    const host = loadExtension();
    const answers = await approveRules(host, Object.values(drafts));
    const result = await host.callTool("observer_resolve", { outcomes: answers });

    expect(result.isError).toBeFalsy();
    expect(readRule(jjFile(host))).toMatchObject({ body: JJ_NOT_GIT.body, frontmatter: { condition: JJ_NOT_GIT.pattern, scope: "tool:bash" } });
    expect(readRule(join(host.rulesDir, "tdd-no-focused-tests.md"))).toMatchObject({ body: focusedTestsRule.body, frontmatter: { condition: focusedTestsRule.pattern, scope: "text" } });
    expect(ledgerRecords(host.ledgerFile).map(({ outcome }) => outcome)).toEqual(["applied", "applied"]);
    expect((result.details as { approvals: unknown[] }).approvals).toEqual(answers.map(({ fingerprint, approval }) => ({ fingerprint, approval, selected: "Apply" })));
    expect(resultText(result)).toContain("changes carried out from prepared proposals rest on");
  }, 30_000);

  it.each(Object.entries(drafts))("writes nothing for %s sent as a raw rule draft", async (_label, draft) => {
    const { host, applied: { approval: _, ...answer } } = await approved(draft);
    await expectNoWrite(host, [{ ...answer, rule: draft.rule }], "not a `rule`");
  });

  it.each<[string, string, (fixture: Approved) => unknown]>([
    ["an approval beside a substituted rule", "not a `rule`", ({ applied }) => ({ ...applied, rule: { ...JJ_NOT_GIT, body: "Substituted." } })],
    ["another proposal's identity", "not this answer", ({ applied }) => ({ ...applied, gist: "Commit with jj." })],
    ["a changed content hash", "content hash", ({ applied }) =>
      ({ ...applied, approval: { ...applied.approval, proposal: { ...applied.approval.proposal, contentHash: "0".repeat(64) } } })],
    ["an ordinary prompt after the answer", "no observation pass is current", ({ host, applied }) => {
      host.getBranch().push({ type: "message", id: "prompt", message: { role: "user", content: "Now the next task." } });
      return applied;
    }],
    ["a rule file written at its path after Prepare", "changed since Prepare", ({ host, applied }) => {
      mkdirSync(host.rulesDir, { recursive: true });
      writeFileSync(jjFile(host), "---\ncondition: \"git\"\n---\n\nThe user's own rule.\n");
      return applied;
    }],
  ])("writes nothing for %s", async (_label, reason, edit) => {
    const fixture = await approved(drafts["a barrier rule"]);
    await expectNoWrite(fixture.host, [edit(fixture)], reason);
  });

  it("writes nothing for an applied pattern amendment without approval", async () => {
    const { host, applied: { approval: _, ...answer } } = await approved(drafts["a pattern amendment"]);
    await expectNoWrite(host, [answer], "needs `approval`");
  });

  it.each(Object.entries(drafts))("writes nothing for %s applied with a note and no revision, quoting the note", async (_label, draft) => {
    const { host, applied } = await approved(draft, () => ({ option: "Apply", note: "Only on main." }));
    await expectNoWrite(host, [applied], "\"Only on main.\"");
  });

  it.each<[string, string, string]>([
    ["Decline", "selected `Decline`", "Decline"],
    ["custom input", "custom input", "Other: only in this repo"],
  ])("writes nothing when the user's answer is %s", async (_label, reason, answer) => {
    const { host, applied } = await approved(drafts["a barrier rule"], () => answer);
    await expectNoWrite(host, [applied], reason);
  });

  it("writes nothing for a local skill answer citing the approval of a direct edit", async () => {
    const host = loadExtension();
    const [applied] = await approve(host, [{ kind: "local", skill: "ce-commit-jj", gist: "Commit with jj, not git.", priority: "evidence", remedy: "Edit the skill",
      change: { operation: "direct-edit", preview: "Exact skill diff" } }]);
    await expectNoWrite(host, [applied], "the approved proposal is a direct edit");
  });

  it("checks the approval again right before writing, after the replay wait, and records no Later for a retracted answer", async () => {
    const { host, applied } = await approved(drafts["a barrier rule"]);
    vi.stubEnv("PATH", "");
    const before = observerBytes(host);
    const pending = host.callTool("observer_resolve", { outcomes: [applied] });
    host.getBranch().push({ type: "message", id: "steer", message: { role: "user", steering: true, content: "Stop, not that one." } });
    const result = await pending;
    expect(failures(result)).toEqual([expect.stringContaining("may retract")]);
    expect(result.details).toMatchObject({ records: [], deferred: [] });
    expect(observerBytes(host)).toEqual(before);
  });

  describe("reconciling a rule that changed after Prepare", () => {
    const claim = { changedTarget: "The user appended a line about git push.", reason: "Keep the approved rule and the user's line.", preserved: "The approved body and pattern are unchanged; the user's line stays." };
    const USER_LINE = "Never run git push either.";
    /** `jj-not-git` as an earlier pass wrote it, an approved rewrite of its body, and then the user's edit appending a line to the file. */
    const changedAfterApproval = async () => {
      const host = loadExtension();
      const { gist } = drafts["a barrier rule"];
      amendments.writeObserverRule({ name: "jj-not-git", path: jjFile(host), description: gist, condition: JJ_NOT_GIT.pattern, scope: "tool:bash",
        amends: "ce-commit-jj", fingerprint: proposalFingerprint("ce-commit-jj", gist), body: "Use jj." });
      const [applied] = await approveRules(host, [drafts["a barrier rule"]]);
      if (!applied) throw new Error("no applied answer");
      appendFileSync(jjFile(host), `\n${USER_LINE}\n`);
      return { host, applied };
    };
    /** Prepares a revision of the approved rewrite as `rule`, citing the approval. */
    const prepareRevision = ({ host, applied }: Approved, rule: PatternRule) =>
      host.callTool("observer_review", { action: "prepare", candidates: [
        { ...ruleCandidate({ ...drafts["a barrier rule"], rule }), reconciles: { approval: applied.approval, ...claim } },
      ] });
    /** Prepares a revision whose body keeps the user's line, and returns the answer citing it. */
    const reconciled = async (fixture: Approved, rule: Partial<PatternRule> = {}) => {
      const prepared = await prepareRevision(fixture, { ...JJ_NOT_GIT, body: `${JJ_NOT_GIT.body}\n\n${USER_LINE}`, ...rule });
      expect(prepared.isError).toBeFalsy();
      const [revision] = reviewEntries(prepared);
      if (!revision) throw new Error("no revision");
      return { ...fixture.applied, approval: { ...fixture.applied.approval, revision: revision.reference } };
    };

    it("writes nothing when no reconciliation cites the approval", async () => {
      const { host, applied } = await changedAfterApproval();
      await expectNoWrite(host, [applied], "changed since Prepare");
    });

    it.skipIf(!ompAvailable)("replays and writes the revised rule, reporting the reconciliation apart from the user's approval", async () => {
      const fixture = await changedAfterApproval();
      const answer = await reconciled(fixture);
      const result = await fixture.host.callTool("observer_resolve", { outcomes: [answer] });
      expect(result.isError).toBeFalsy();
      expect(readRule(jjFile(fixture.host)).body).toBe(`${JJ_NOT_GIT.body}\n\n${USER_LINE}`);
      const { revision, ...approval } = answer.approval;
      expect((result.details as { approvals: unknown[] }).approvals).toEqual([{ fingerprint: fixture.applied.fingerprint, approval, selected: "Apply",
        reconciliation: { revision, ...claim, preview: expect.stringContaining(USER_LINE) } }]);
      expect(resultText(result)).toContain("not approved by the user");
    }, 30_000);

    it.skipIf(!ompAvailable)("replays the revision's own samples, and records it as later without writing when they misfire", async () => {
      const fixture = await changedAfterApproval();
      const answer = await reconciled(fixture, { spares: [{ command: "git commit --amend" }] });
      const before = readFileSync(jjFile(fixture.host), "utf8");
      const result = await fixture.host.callTool("observer_resolve", { outcomes: [answer] });
      expect(result.details).toMatchObject({ failures: [], approvals: [], deferred: [expect.stringMatching(/spares\[0\].*git commit --amend/)] });
      expect(readFileSync(jjFile(fixture.host), "utf8")).toBe(before);
      expect(ledgerRecords(fixture.host.ledgerFile).at(-1)).toMatchObject({ outcome: "later" });
    }, 30_000);

    it("writes nothing when the rule changed again after the revision was prepared", async () => {
      const fixture = await changedAfterApproval();
      const answer = await reconciled(fixture);
      appendFileSync(jjFile(fixture.host), "And another line.\n");
      await expectNoWrite(fixture.host, [answer], "changed since the reconciliation");
    });

    it("refuses to prepare a revision under another rule name", async () => {
      const fixture = await changedAfterApproval();
      const result = await prepareRevision(fixture, { ...JJ_NOT_GIT, name: "jj-not-git-either" });
      expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining("approved proposal's own rule")] });
    });
  });

  describe("revising a rule by an approval note", () => {
    const NOTE = "Mention jj describe too.";
    const REVISED_BODY = "Use `jj commit` or `jj describe`; this repo has no git index.";
    const judgment = { reason: "The user asked to mention jj describe.", preserved: "Same barrier against git commit; only the body names jj describe." };
    const noted = () => approved(drafts["a barrier rule"], () => ({ option: "Apply", note: NOTE }));
    /** Prepares a revision of the noted barrier rule as `rule`, citing its approval. */
    const prepareRevision = ({ host, applied }: Approved, rule: PatternRule) =>
      host.callTool("observer_review", { action: "prepare", candidates: [
        { ...ruleCandidate({ ...drafts["a barrier rule"], rule }), reconciles: { approval: applied.approval, ...judgment } },
      ] });

    it.skipIf(!ompAvailable)("replays and writes the rule as the note revised it, without a second Ask, and reports the note, the reason and the rule written", async () => {
      const fixture = await noted();
      const prepared = await prepareRevision(fixture, { ...JJ_NOT_GIT, body: REVISED_BODY });
      const [revision] = reviewEntries(prepared);
      if (!revision) throw new Error("no revision");
      const result = await fixture.host.callTool("observer_resolve", { outcomes: [{ ...fixture.applied, approval: { ...fixture.applied.approval, revision: revision.reference } }] });
      expect(result.isError).toBeFalsy();
      expect(readRule(jjFile(fixture.host))).toMatchObject({ body: REVISED_BODY, frontmatter: { condition: JJ_NOT_GIT.pattern } });
      expect(fixture.host.getBranch().findLast((entry) => entry.message?.toolName === "ask")?.message?.toolCallId).toBe(fixture.applied.approval.askToolCallId);
      expect((result.details as { approvals: unknown[] }).approvals).toEqual([expect.objectContaining({ note: NOTE, reconciliation: expect.objectContaining(judgment) })]);
      for (const shown of [NOTE, judgment.reason, REVISED_BODY]) expect(resultText(result)).toContain(shown);
    }, 30_000);

    it.each<[string, string, Partial<PatternRule>]>([
      ["under another rule name", "approved proposal's own rule", { name: "jj-not-git-either", body: REVISED_BODY }],
    ])("refuses to prepare a revision %s", async (_label, reason, rule) => {
      const result = await prepareRevision(await noted(), { ...JJ_NOT_GIT, ...rule });
      expect(result.details).toMatchObject({ eligible: [], failures: [expect.stringContaining(reason)] });
    });
  });
});

/** Runs observer_check on `drafts` and returns its result with the per-draft verdicts. */
async function check(host: ReturnType<typeof loadExtension>, drafts: PatternDraft[]) {
  const result = await host.callTool("observer_check", { drafts });
  return { ...result, text: resultText(result), results: (result.details as { results: unknown[] }).results };
}

describe("observer_check", () => {
  describe.skipIf(!ompAvailable)("under OMP's TTSR engine", () => {
    it("passes a text pattern that fires on its mistake and stays silent on its counterpart", async () => {
      const result = await check(loadExtension(), [
        { name: "no-focused-tests", pattern: "\\bit\\.only\\(", matches: ['it.only("adds", () => {})'], spares: ['it("adds", () => {})'] },
      ]);
      expect(result.isError).toBeFalsy();
      expect(result.results).toEqual([{ name: "no-focused-tests", verdict: "passed" }]);
    }, 30_000);

    it("names the mistake sample a text pattern misses", async () => {
      const result = await check(loadExtension(), [
        {
          name: "no-focused-tests",
          pattern: "\\bit\\.only\\(",
          matches: ['it.only("adds", () => {})', 'describe.only("math", () => {})'],
          spares: ['it("adds", () => {})'],
        },
      ]);
      expect(result.results).toEqual([
        { name: "no-focused-tests", verdict: "misfired", misfires: [expect.objectContaining({ sample: "matches", index: 1 })] },
      ]);
    }, 30_000);

    it("names the legitimate sample a text pattern fires on", async () => {
      const result = await check(loadExtension(), [
        { name: "no-only", pattern: "\\.only\\b", matches: ['it.only("adds", () => {})'], spares: ["Run the whole file, never .only ones."] },
      ]);
      expect(result.results).toEqual([
        { name: "no-only", verdict: "misfired", misfires: [expect.objectContaining({ sample: "spares", index: 0 })] },
      ]);
    }, 30_000);

    it("matches a bash pattern against the call's arguments as JSON, quotes escaped", async () => {
      const samples = { scope: "tool:bash", matches: [{ command: 'git commit -m "wip"' }], spares: [{ command: "git commit -m wip" }] };
      const result = await check(loadExtension(), [
        { name: "escaped-quote", pattern: '-m \\\\"wip', ...samples },
        { name: "raw-quote", pattern: '-m "wip"', ...samples },
      ]);
      expect(result.results).toEqual([
        { name: "escaped-quote", verdict: "passed" },
        { name: "raw-quote", verdict: "misfired", misfires: [expect.objectContaining({ sample: "matches", index: 0 })] },
      ]);
    }, 30_000);

    it("names the legitimate call a bash pattern fires on", async () => {
      const result = await check(loadExtension(), [
        { name: "no-git-commit", pattern: "\\bcommit\\b", scope: "tool:bash", matches: [{ command: "git commit -a" }], spares: [{ command: "jj commit" }] },
      ]);
      expect(result.results).toEqual([
        { name: "no-git-commit", verdict: "misfired", misfires: [expect.objectContaining({ sample: "spares", index: 0 })] },
      ]);
    }, 30_000);

    it("matches an edit pattern against the file content, not the arguments JSON", async () => {
      const result = await check(loadExtension(), [
        {
          name: "no-a-export",
          pattern: '^export const x = "a";$',
          scope: "tool:edit",
          matches: ['export const x = "a";'],
          spares: ['export const x = "b";'],
        },
      ]);
      expect(result.results).toEqual([{ name: "no-a-export", verdict: "passed" }]);
    }, 30_000);
  });

  it.each([
    ["no mistake sample", { matches: undefined }, /`matches`/],
    ["no legitimate sample", { spares: [] }, /`spares`/],
    ["an argument object for text", { matches: [{ text: "it.only(" }] }, /`text` sample must be a string/],
    ["a string for a bash call", { scope: "tool:bash", matches: ["git commit"], spares: [{ command: "jj commit" }] }, /`tool:bash` sample must be the call's arguments/],
  ])("rejects a draft with %s and runs nothing", async (_label, change, reason) => {
    const result = await check(loadExtension(), [
      { name: "no-only", pattern: "\\.only\\(", matches: ["it.only("], spares: ["it("], ...change },
    ]);
    expect(result.isError).toBe(true);
    expect(result.results).toEqual([{ name: "no-only", verdict: "rejected", reason: expect.stringMatching(reason) }]);
  });

  it("reports that the check can't run when `omp` is not on PATH", async () => {
    const host = loadExtension();
    vi.stubEnv("PATH", "");
    const result = await check(host, [{ name: "no-only", pattern: "\\.only\\(", matches: ["it.only("], spares: ["it("] }]);
    expect(result.isError).toBe(true);
    expect(result.results).toEqual([{ name: "no-only", verdict: "unchecked", reason: expect.stringContaining("omp") }]);
    expect(result.text).toMatch(/offer no barrier rule/);
  });
});

describe("observer_resolve replays each pattern before writing it", () => {
  it.skipIf(!ompAvailable)("refuses a rule that fails the check, writes nothing, and records the answer as later with the misfire", async () => {
    const host = loadExtension();
    const fix = { ...await barrierFix(host, "ce-commit-jj", "local", { spares: [{ command: "git commit --amend" }] }), evidence: [{ quote: "use jj", count: 2 }] };
    const result = await host.callTool("observer_resolve", { outcomes: [fix] });

    expect(rulesWritten(host)).toEqual([]);
    const [record] = ledgerRecords(host.ledgerFile);
    expect(record).toMatchObject({ skill: "ce-commit-jj", kind: "local", outcome: "later", evidence: [{ quote: "use jj", count: 2 }] });
    expect(record).not.toHaveProperty("rule");
    expect(result.details).toMatchObject({ deferred: [expect.stringMatching(/spares\[0\].*git commit --amend/)] });
    expect(resultText(result)).toMatch(/spares\[0\]/);
  }, 30_000);

  it("records an approved barrier answer as later without writing a rule when `omp` can't run", async () => {
    const host = loadExtension();
    const fix = await barrierFix(host, "ce-commit-jj", "local");
    vi.stubEnv("PATH", "");
    const result = await host.callTool("observer_resolve", { outcomes: [fix] });

    expect(rulesWritten(host)).toEqual([]);
    expect(ledgerRecords(host.ledgerFile)).toEqual([expect.objectContaining({ skill: "ce-commit-jj", outcome: "later" })]);
    expect(result.details).toMatchObject({ deferred: [expect.stringContaining("omp")] });
  });

  it("records, writes and deletes nothing when the call is cancelled during the check", async () => {
    const host = loadExtension();
    vi.stubEnv("PATH", "");
    splitAmendment(host, "tdd", "tdd-name-the-seam");
    setLockHash(host, "tdd", "0000000000000000000000000000000000000001");
    const { outcomes, stale } = await approveAll(host, {
      rules: [{ skill: "ce-commit-jj", kind: "local", gist: "Commit with jj, not git.", rule: JJ_NOT_GIT }],
      fixes: [{ gist: "Name the seam before the first test.", section: SEAMS }],
      stale: [{ rule: "tdd-name-the-seam", select: "Delete" }],
    });
    const ledger = readFileSync(host.ledgerFile, "utf8");
    const rules = rulesWritten(host);
    const cancelled = new AbortController();
    cancelled.abort();

    const call = host.callTool(
      "observer_resolve",
      { outcomes, stale },
      cancelled.signal,
    );

    await expect(call).rejects.toThrow();
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
    expect(rulesWritten(host)).toEqual(rules);
  });
});

/** Rewrites one skill's entry in the temp home's lock, or removes it when `hash` is undefined. */
function setLockHash(host: ReturnType<typeof loadExtension>, folder: string, hash: string | undefined): void {
  const lockFile = host.skillHome.roots.lockFile;
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  if (hash === undefined) delete lock.skills[folder];
  else lock.skills[folder] = { ...lock.skills[folder], skillFolderHash: hash };
  writeFileSync(lockFile, JSON.stringify(lock));
}

/** Appends a line to `file` in the skill's folder under the temp home's skills directory, creating it when missing. */
function changeSkillFile(host: ReturnType<typeof loadExtension>, folder: string, file = "SKILL.md"): void {
  const path = join(host.skillHome.roots.skillsDir, folder, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${existsSync(path) ? readFileSync(path, "utf8") : ""}Changed.\n`);
}

const currentSkillHash = (host: ReturnType<typeof loadExtension>, name: string) =>
  skillHash(createProvenanceResolver(host.skillHome.roots).byName(name));

/** Runs `/observe` and returns the Stale amendments section of the message it sent. */
async function staleSection(host: ReturnType<typeof loadExtension>, branch = [...fx.plainUserMessage, ...fx.steeringUserMessage]) {
  host.sent.length = 0;
  host.setBranch(branch);
  await host.runCommand("observe");
  const content = String(host.sent[0]?.message.content ?? "");
  const start = content.indexOf("## Stale amendments");
  return start === -1 ? "" : content.slice(start);
}

describe("stale amendments", () => {
  const NEW_HASH = "0000000000000000000000000000000000000001";

  async function withAmendment() {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-name-the-seam", { body: "Name the seam first." });
    return host;
  }

  it("asks about an amendment once any file in its skill's folder changes, and not before", async () => {
    const host = await withAmendment();
    expect(await staleSection(host)).not.toContain("tdd-name-the-seam");

    changeSkillFile(host, "tdd", "references/seams.md");
    expect(await staleSection(host)).toMatch(/`tdd-name-the-seam`[^\n]*upstream skill whose files changed/);
  });

  it("does not ask about an amendment when only the lock hash changes", async () => {
    const host = await withAmendment();
    setLockHash(host, "tdd", NEW_HASH);
    expect(await staleSection(host)).not.toContain("tdd-name-the-seam");
  });

  it("asks about an amendment whose skill left the lock", async () => {
    const host = await withAmendment();
    setLockHash(host, "tdd", undefined);
    expect(await staleSection(host)).toContain("tdd-name-the-seam");
  });

  it.skipIf(process.getuid?.() === 0)("still lists a stale amendment when another amendment's skill folder can't be read", async () => {
    const host = await withAmendment();
    splitAmendment(host, "domain-modeling", "domain-modeling-glossary", { body: "Define terms first." });
    changeSkillFile(host, "domain-modeling", "references/terms.md");
    const locked = join(host.skillHome.roots.skillsDir, "domain-modeling", "references");
    changeSkillFile(host, "tdd", "references/seams.md");
    chmodSync(locked, 0o000);
    try {
      const section = await staleSection(host);
      expect(section).toContain("tdd-name-the-seam");
      expect(section).not.toContain("domain-modeling-glossary");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(!ompAvailable)("never asks about a local barrier rule, even once its skill enters the lock", async () => {
    const host = loadExtension();
    await host.callTool("observer_resolve", { outcomes: [await barrierFix(host, "ce-commit-jj", "local")] });
    expect(await staleSection(host)).not.toContain("jj-not-git");

    setLockHash(host, "ce-commit-jj", NEW_HASH);
    expect(await staleSection(host)).not.toContain("jj-not-git");
  }, 30_000);

  it.skipIf(!ompAvailable)("refuses a stale answer for a barrier rule and leaves the rule unpinned", async () => {
    const host = loadExtension();
    await host.callTool("observer_resolve", { outcomes: [await barrierFix(host, "ce-commit-jj", "local")] });
    const file = join(host.rulesDir, "jj-not-git.md");
    const before = readFileSync(file, "utf8");

    const result = await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "jj-not-git", action: "keep" }] });

    expect(result.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  }, 30_000);

  it("starts a pass for a stale amendment in a session without signals", async () => {
    const host = await withAmendment();
    changeSkillFile(host, "tdd");
    expect(await staleSection(host, fx.plainUserMessage)).toContain("tdd-name-the-seam");
    expect(host.sent[0]?.options).toMatchObject({ triggerTurn: true });
  });

  it("keep re-pins the rule to the skill's current hash and leaves its body", async () => {
    const host = await withAmendment();
    changeSkillFile(host, "tdd");
    const result = await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "tdd-name-the-seam", action: "keep" }] });

    expect(result.isError).toBeFalsy();
    const rule = readRule(join(host.amendmentsDir, "tdd-name-the-seam.md"));
    expect(rule.frontmatter.skillHash).toBe(currentSkillHash(host, "tdd"));
    expect(rule.body).toBe("Name the seam first.");
    expect(await staleSection(host)).not.toContain("tdd-name-the-seam");
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "tdd", kind: "upstream", outcome: "kept" });
  });

  it("keeps frontmatter keys added to the rule by hand when it re-pins", async () => {
    const host = await withAmendment();
    const file = join(host.amendmentsDir, "tdd-name-the-seam.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("\n---\n", '\ninterruptMode: "never"\n---\n'));
    changeSkillFile(host, "tdd");
    await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "tdd-name-the-seam", action: "keep" }] });

    expect(readRule(file).frontmatter).toMatchObject({ interruptMode: "never", skillHash: currentSkillHash(host, "tdd") });
  });

  it("update rewrites the body and re-pins the rule", async () => {
    const host = await withAmendment();
    changeSkillFile(host, "tdd");
    await resolveApproved(host, { stale: [{ rule: "tdd-name-the-seam", select: "Update", body: "Name the seam in the plan." }] });

    const rule = readRule(join(host.amendmentsDir, "tdd-name-the-seam.md"));
    expect(rule.frontmatter.skillHash).toBe(currentSkillHash(host, "tdd"));
    expect(rule.frontmatter).not.toHaveProperty("condition");
    expect(rule.body).toBe("Name the seam in the plan.");
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "tdd", outcome: "updated" });
  });

  it("delete removes the rule", async () => {
    const host = await withAmendment();
    changeSkillFile(host, "tdd");
    await resolveApproved(host, { stale: [{ rule: "tdd-name-the-seam", select: "Delete" }] });

    expect(existsSync(join(host.amendmentsDir, "tdd-name-the-seam.md"))).toBe(false);
    expect(await staleSection(host)).not.toContain("tdd-name-the-seam");
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "tdd", outcome: "deleted" });
  });

  it("records a stale answer under the fingerprint of the proposal that wrote the rule", async () => {
    const host = await withAmendment();
    changeSkillFile(host, "tdd");
    await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "tdd-name-the-seam", action: "keep" }] });

    const [applied, kept] = ledgerRecords(host.ledgerFile);
    expect(kept?.fingerprint).toBe(applied?.fingerprint);
  });

  it("keeps the evidence of the proposal that wrote the rule on a stale answer", async () => {
    const host = loadExtension();
    const evidence = [{ quote: "which seam is this testing?", count: 2 }];
    splitAmendment(host, "tdd", "tdd-name-the-seam", { body: "Name the seam first.", evidence });
    changeSkillFile(host, "tdd");
    await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "tdd-name-the-seam", action: "keep" }] });

    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ outcome: "kept", evidence });
  });

  it("prepares no deletion of a rule it didn't write", async () => {
    const host = loadExtension();
    const foreign = join(host.rulesDir, "use-ask-tool.md");
    mkdirSync(host.rulesDir, { recursive: true });
    writeFileSync(foreign, "---\ncondition: \"x\"\namends: \"tdd\"\n---\n\nThe user's own rule.\n");
    const result = await host.callTool("observer_review", { action: "prepare", candidates: staleCandidates({ rule: "use-ask-tool", select: "Delete" }) });

    expect(result.isError).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});

describe("stale answers in a call with other answers", () => {
  const amendmentFile = (host: ReturnType<typeof loadExtension>) => join(host.amendmentsDir, "tdd-amendment.md");

  /** `tdd`'s on-read amendment with the Seams and Red sections, gone stale; returns their applied records. */
  async function staleAmendment(host: ReturnType<typeof loadExtension>) {
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    changeSkillFile(host, "tdd");
    const [seams, red] = ledgerRecords(host.ledgerFile);
    return { seams, red };
  }

  /** Runs `/observe` with `tdd` loaded and returns its Rules in force section. */
  async function inForce(host: ReturnType<typeof loadExtension>) {
    host.sent.length = 0;
    host.setBranch([...fx.plainUserMessage, ...fx.skillUrlRead]);
    await host.runCommand("observe");
    const content = String(host.sent[0]?.message.content);
    return content.slice(content.indexOf("### Rules in force"));
  }

  /** An addition of a Scope section to `tdd`'s on-read amendment. */
  const oneBehaviour = { gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR };

  it("keeps a section added in the same call as a stale update of the skill's on-read amendment", async () => {
    const host = loadExtension();
    await staleAmendment(host);

    const result = await resolveApproved(host, { fixes: [oneBehaviour], stale: [{ rule: "tdd-amendment", select: "Update", body: SEAMS }] });

    expect(result.isError).toBeFalsy();
    expect(readRule(amendmentFile(host))).toMatchObject({ frontmatter: { skillHash: currentSkillHash(host, "tdd") }, body: `${SEAMS}\n\n${ONE_BEHAVIOUR}` });
  });

  it("recreates the amendment from a section added in the same call as a stale delete, with only that fix in force", async () => {
    const host = loadExtension();
    await staleAmendment(host);

    const result = await resolveApproved(host, { fixes: [oneBehaviour], stale: [{ rule: "tdd-amendment", select: "Delete" }] });

    expect(result.isError).toBeFalsy();
    expect(readRule(amendmentFile(host))).toMatchObject({ frontmatter: { skillHash: currentSkillHash(host, "tdd") }, body: ONE_BEHAVIOUR });
    const rules = await inForce(host);
    expect(rules).toContain("Test one behaviour per test.");
    expect(rules).not.toContain("Name the seam first.");
  });

  it("records each fix in the amendment as deleted on a stale delete, so an on-read fix added later recreates the amendment without them", async () => {
    const host = loadExtension();
    const { seams, red } = await staleAmendment(host);

    await resolveApproved(host, { stale: [{ rule: "tdd-amendment", select: "Delete" }] });
    await resolveApproved(host, { fixes: [oneBehaviour] });

    expect(ledgerRecords(host.ledgerFile).filter((record) => record.outcome === "deleted").map((record) => record.fingerprint)).toEqual(
      expect.arrayContaining([seams?.fingerprint, red?.fingerprint]),
    );
    const rules = await inForce(host);
    expect(rules).toContain("Test one behaviour per test.");
    expect(rules).not.toContain("Name the seam first.");
    expect(rules).not.toContain("A red is an assertion diff.");
  });

  it("records and writes nothing for a withdrawal carrying a body for an amendment a stale update changed in the same call", async () => {
    const host = loadExtension();
    const { red } = await staleAmendment(host);
    const updated = `${SEAMS}\n\n${RED}\n\n${ONE_BEHAVIOUR}`;

    const result = await resolveApproved(host, {
      withdrawals: [{ fingerprint: red?.fingerprint, gist: "A red is an assertion diff.", body: SEAMS }],
      stale: [{ rule: "tdd-amendment", select: "Update", body: updated }],
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/Not recorded[\s\S]*stale/);
    expect(readRule(amendmentFile(host)).body).toBe(updated);
    expect(ledgerRecords(host.ledgerFile).map((record) => record.outcome)).not.toContain("withdrawn");
  });

  it.skipIf(!ompAvailable)("carries out stale settlements, then withdrawals, then answers in answer order with a pattern amendment between additions, then compactions, across two skills, and reports each publication in that order", async () => {
    const host = loadExtension();
    const TERMS = "## Terms\n\nDefine each term first.";
    const AGGREGATES = "## Aggregates\n\nName each aggregate's invariant.";
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await amend(host, "tdd", focusedTestsRule);
    await addOnReadFix(host, "domain-modeling", "Define each term first.", TERMS);
    changeSkillFile(host, "domain-modeling");
    const pattern = ledgerRecords(host.ledgerFile)[1]!;
    const terms = `${TERMS} Use the glossary's words.`;
    const compacted = `${SEAMS}\n\n${RED}\n\n${ONE_BEHAVIOUR}`;
    const { stale, outcomes: [withdrawal, red, aggregates, behaviour, bail], compactions } = await approveAll(host, {
      stale: [{ rule: "domain-modeling-amendment", skill: "domain-modeling", select: "Update", body: terms }],
      withdrawals: [{ fingerprint: pattern.fingerprint, gist: String(pattern.gist) }],
      fixes: [
        { gist: "A red is an assertion diff.", section: RED },
        { skill: "domain-modeling", gist: "Name each aggregate's invariant.", section: AGGREGATES },
        { gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR },
      ],
      rules: [{ skill: "tdd", kind: "upstream", gist: "Run the whole file.", rule: bailRule }],
      compactions: [{ includes: ["A red is an assertion diff.", "Test one behaviour per test."], body: compacted }],
    });

    const result = await host.callTool("observer_resolve", { outcomes: [red, bail, aggregates, withdrawal, behaviour], stale, compactions });

    expect(result.details).toMatchObject({ failures: [], deferred: [] });
    const tdd = join(host.amendmentsDir, "tdd-amendment.md");
    const domainModeling = join(host.amendmentsDir, "domain-modeling-amendment.md");
    const compaction = ledgerRecords(host.ledgerFile).at(-1)!;
    const published: Array<[string, string, string, unknown]> = [
      ["stale-update", "domain-modeling", domainModeling, amendments.skillAmendmentFingerprint("domain-modeling")],
      ["withdrawal", "tdd", join(host.rulesDir, "tdd-no-focused-tests.md"), pattern.fingerprint],
      ["on-read-append", "tdd", tdd, red?.fingerprint],
      ["rule", "tdd", join(host.rulesDir, "tdd-no-bail.md"), bail?.fingerprint],
      ["on-read-append", "domain-modeling", domainModeling, aggregates?.fingerprint],
      ["on-read-append", "tdd", tdd, behaviour?.fingerprint],
      ["compaction", "tdd", tdd, compaction.fingerprint],
    ];
    expect((result.details as { publications: unknown[] }).publications).toEqual(
      published.map(([operation, skill, rule, fingerprint]) => ({ operation, skill, rule, fingerprint })));
    expect(ledgerRecords(host.ledgerFile).slice(3).map(({ fingerprint, outcome }) => [fingerprint, outcome])).toEqual(
      published.map(([operation, , , fingerprint]) => [fingerprint, operation === "stale-update" ? "updated" : operation === "withdrawal" ? "withdrawn" : "applied"]));
    expect(readRule(tdd).body).toBe(compacted);
    expect(readRule(domainModeling).body).toBe(`${terms}\n\n${AGGREGATES}`);
    expect(existsSync(join(host.rulesDir, "tdd-no-focused-tests.md"))).toBe(false);
    expect(readRule(join(host.rulesDir, "tdd-no-bail.md")).body).toBe(bailRule.body);
  }, 30_000);
});

describe("proposal approval of stale answers and withdrawals", () => {
  const amendmentFile = (host: ReturnType<typeof loadExtension>) => join(host.amendmentsDir, "tdd-amendment.md");
  const MINE = "## Mine\n\nThe user's own words.";
  /** `tdd`'s on-read amendment with the Seams and Red sections, gone stale; returns their applied records. */
  async function twoStaleSections(host: ReturnType<typeof loadExtension>) {
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    changeSkillFile(host, "tdd");
    const [seams, red] = ledgerRecords(host.ledgerFile);
    if (!seams || !red) throw new Error("no applied records");
    return { seams, red };
  }
  /** Runs observer_resolve with `params` and checks that it refused each answer for `reason` and left every owned file and the ledger as they were. */
  async function expectNoWrite(host: ReturnType<typeof loadExtension>, params: Record<string, unknown>, reason: string) {
    const before = { files: ownedFiles(host), ledger: readFileSync(host.ledgerFile, "utf8") };
    const result = await host.callTool("observer_resolve", { outcomes: [], ...params });
    expect(failures(result).length).toBeGreaterThan(0);
    for (const failure of failures(result)) expect(failure).toContain(reason);
    expect({ files: ownedFiles(host), ledger: readFileSync(host.ledgerFile, "utf8") }).toEqual(before);
  }
  type Row = Record<string, string>;
  const withdrawn = (record: Row) => ({ ...outcome("tdd", "upstream", String(record.gist), "withdrawn"), fingerprint: record.fingerprint });

  it.each<[string, string, (host: ReturnType<typeof loadExtension>, records: { seams: Row; red: Row }) => Promise<Record<string, unknown>>]>([
    ["a stale Update with a raw body", "needs `approval`", async () => ({ stale: [{ rule: "tdd-amendment", action: "update", body: SEAMS }] })],
    ["a stale Delete", "needs `approval`", async () => ({ stale: [{ rule: "tdd-amendment", action: "delete" }] })],
    ["a withdrawal with a raw body", "not a `rule`", async (_host, { red }) => ({ outcomes: [{ ...withdrawn(red), rule: { body: SEAMS } }] })],
    ["a withdrawal", "needs `approval`", async (_host, { red }) => ({ outcomes: [withdrawn(red)] })],
    ["a stale Update with a note", "with the note \"Keep Seams.\"", async (host) =>
      ({ stale: (await approveAll(host, { stale: [{ rule: "tdd-amendment", select: "Update", body: SEAMS }], note: "Keep Seams." })).stale })],
    ["a stale Delete with a note", "with the note \"Keep Seams.\"", async (host) =>
      ({ stale: (await approveAll(host, { stale: [{ rule: "tdd-amendment", select: "Delete", body: SEAMS }], note: "Keep Seams." })).stale })],
    ["a withdrawal with a note", "with the note \"Keep Seams.\"", async (host, { red }) =>
      ({ outcomes: (await approveAll(host, { withdrawals: [{ fingerprint: red.fingerprint, gist: String(red.gist), body: SEAMS }], note: "Keep Seams." })).outcomes })],
    ["an approved stale Update carrying a substituted body", "no `body`", async (host) => {
      const { stale: [update] } = await approveAll(host, { stale: [{ rule: "tdd-amendment", select: "Update", body: SEAMS }] });
      return { stale: [{ ...update, body: "## Substituted\n\nNot what the user saw." }] };
    }],
    ["an approved withdrawal carrying a substituted body", "not a `rule`", async (host, { red }) => {
      const { outcomes: [answer] } = await approveAll(host, { withdrawals: [{ fingerprint: red.fingerprint, gist: String(red.gist), body: SEAMS }] });
      return { outcomes: [{ ...answer, rule: { body: "## Substituted\n\nNot what the user saw." } }] };
    }],
    ["an approved stale Update sent as a Delete", "selected Update for a stale-update change", async (host) => {
      const { stale: [update] } = await approveAll(host, { stale: [{ rule: "tdd-amendment", select: "Update", body: SEAMS }] });
      return { stale: [{ ...update, action: "delete" }] };
    }],
    ["an approved withdrawal sent as an applied fix", "does not carry out", async (host, { red }) => {
      const { outcomes: [answer] } = await approveAll(host, { withdrawals: [{ fingerprint: red.fingerprint, gist: String(red.gist), body: SEAMS }] });
      return { outcomes: [{ ...answer, outcome: "applied" }] };
    }],
    ["a withdrawal citing an approved on-read fix", "does not carry out", async (host, { red }) => {
      const [applied] = await approveOnRead(host, [{ gist: String(red.gist), section: RED, fingerprint: red.fingerprint }]);
      return { outcomes: [{ ...applied, outcome: "withdrawn" }] };
    }],
    ["a stale amendment answered Keep", "not Update or Delete", async (host) => {
      const { approval } = await approveCandidates(host, staleCandidates({ rule: "tdd-amendment", select: "Update", body: SEAMS }), () => "Keep");
      return { stale: [{ rule: "tdd-amendment", action: "update", approval: approval(staleGist("tdd-amendment")) }] };
    }],
    ["a stale form whose Delete preview was replaced before asking", "not this Select's `askHtml` unchanged", async (host) => {
      const { stale } = await approveAll(host, { stale: [{ rule: "tdd-amendment", select: "Update", body: SEAMS }] });
      const ask = host.getBranch().findLast((entry) => entry.message?.role === "assistant");
      const args = (ask?.message?.content as Array<{ arguments: ToolArguments }>)[0]!.arguments;
      args.html = args.html?.replace("go out of force", "stay in force");
      return { stale };
    }],
  ])("writes and records nothing for %s", async (_label, reason, params) => {
    const host = loadExtension();
    const records = await twoStaleSections(host);
    await expectNoWrite(host, await params(host, records), reason);
  });

  it("carries out an approved stale Update and withdrawal in one call from their prepared changes, stale first, and refuses an unapproved withdrawal alone", async () => {
    const host = loadExtension();
    const { seams, red } = await twoStaleSections(host);
    splitAmendment(host, "domain-modeling", "dm-define-terms");
    const term = ledgerRecords(host.ledgerFile).at(-1)!;
    const updated = `${SEAMS}\n\n${ONE_BEHAVIOUR}`;
    const { stale, outcomes } = await approveAll(host, {
      withdrawals: [{ skill: "domain-modeling", fingerprint: term.fingerprint, gist: String(term.gist) }],
      stale: [{ rule: "tdd-amendment", select: "Update", body: updated }],
    });

    const result = await host.callTool("observer_resolve", { outcomes: [...outcomes, withdrawn(red)], stale });

    expect(failures(result)).toEqual([expect.stringContaining("needs `approval`")]);
    expect(readRule(amendmentFile(host))).toMatchObject({ frontmatter: { skillHash: currentSkillHash(host, "tdd") }, body: updated });
    expect(existsSync(join(host.amendmentsDir, "dm-define-terms.md"))).toBe(false);
    expect(ledgerRecords(host.ledgerFile).slice(3).map(({ fingerprint, outcome }) => [fingerprint, outcome])).toEqual([
      [amendments.skillAmendmentFingerprint("tdd"), "updated"], [term.fingerprint, "withdrawn"],
    ]);
    expect((result.details as { approvals: Array<{ fingerprint: string; selected: string }> }).approvals.map(({ fingerprint, selected }) => [fingerprint, selected])).toEqual([
      [amendments.skillAmendmentFingerprint("tdd"), "Update"], [term.fingerprint, "Apply"],
    ]);
    expect(resultText(result)).toContain(`the user selected Update in Ask \`${stale[0]?.approval.askToolCallId}\``);
    expect(seams.fingerprint).not.toBe(red.fingerprint);
  });

  it("carries out the stale alternative whose option the user selected, not the other one prepared with it", async () => {
    const host = loadExtension();
    await twoStaleSections(host);
    const { stale } = await approveAll(host, { stale: [{ rule: "tdd-amendment", select: "Delete", body: SEAMS }] });

    const result = await host.callTool("observer_resolve", { outcomes: [], stale });

    expect(result.isError).toBeFalsy();
    expect(existsSync(amendmentFile(host))).toBe(false);
    expect(ledgerRecords(host.ledgerFile).slice(2).map(({ outcome }) => outcome)).toEqual(["deleted", "deleted", "deleted"]);
    expect(ledgerRecords(host.ledgerFile)[2]).toMatchObject({ fingerprint: amendments.skillAmendmentFingerprint("tdd"), outcome: "deleted" });
  });

  it("takes back a fix the user asked for in prose only once an Ask approves its shown withdrawal", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    const [applied] = ledgerRecords(host.ledgerFile);
    const file = join(host.amendmentsDir, "tdd-afk-seams.md");
    startPass(host);
    host.getBranch().push({ type: "message", id: "prose", message: { role: "user", steering: true, content: "Please take back the afk seams fix." } });
    const selection = await prepareAndSelect(host, [withdrawalCandidate({ fingerprint: applied?.fingerprint, gist: String(applied?.gist) })]);
    const selected = reviewEntries(selection, "selected");
    const selectionToolCallId = lastCallId(host);
    const answer = withdrawn(applied!);

    await expectNoWrite(host, { outcomes: [answer] }, "needs `approval`");
    await expectNoWrite(host, { outcomes: [{ ...answer, approval: { proposal: selected[0]!.reference, selectionToolCallId, askToolCallId: selectionToolCallId } }] }, "is not an ask");
    expect(existsSync(file)).toBe(true);

    const askToolCallId = askUser(host, selection);
    const result = await host.callTool("observer_resolve", { outcomes: [{ ...answer, approval: { proposal: selected[0]!.reference, selectionToolCallId, askToolCallId } }] });

    expect(result.isError).toBeFalsy();
    expect(existsSync(file)).toBe(false);
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ fingerprint: applied?.fingerprint, outcome: "withdrawn" });
  });

  it.each([
    ["a withdrawal", { withdrawals: [{ fingerprint: proposalFingerprint("tdd", "Gist of tdd-afk-seams."), gist: "Gist of tdd-afk-seams." }] }],
    ["a stale Delete", { stale: [{ rule: "tdd-afk-seams", select: "Delete" as const }] }],
  ])("deletes a rule whose instruction content changed since %s was previewed only after a fresh Ask", async (_label, drafts) => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    changeSkillFile(host, "tdd");
    const file = join(host.amendmentsDir, "tdd-afk-seams.md");
    const approved = await approveAll(host, drafts);
    appendFileSync(file, "\nThe user's unrelated line.\n");

    await expectNoWrite(host, approved, "changed since Prepare read it; prepare it again and ask again");
    expect(readFileSync(file, "utf8")).toContain("The user's unrelated line.");

    const result = await host.callTool("observer_resolve", await approveAll(host, drafts));
    expect(result.isError).toBeFalsy();
    expect(existsSync(file)).toBe(false);
  });

  it("deletes a rule whose only change since the withdrawal was previewed is a stale Keep's re-pin", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    changeSkillFile(host, "tdd");
    const file = join(host.amendmentsDir, "tdd-afk-seams.md");
    const approved = await approveAll(host, { withdrawals: [{ fingerprint: proposalFingerprint("tdd", "Gist of tdd-afk-seams."), gist: "Gist of tdd-afk-seams." }] });
    const before = readFileSync(file, "utf8");
    await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "tdd-afk-seams", action: "keep" }] });
    expect(readFileSync(file, "utf8")).not.toBe(before);

    const result = await host.callTool("observer_resolve", approved);

    expect(result.isError).toBeFalsy();
    expect(existsSync(file)).toBe(false);
  });

  it.each([
    ["a withdrawal rewrite", (red: Row) => ({ withdrawals: [{ fingerprint: red.fingerprint, gist: String(red.gist), body: SEAMS }] })],
    ["a stale Update", () => ({ stale: [{ rule: "tdd-amendment", select: "Update" as const, body: SEAMS }] })],
  ])("keeps content added since %s was previewed, and takes no reconciliation for it", async (_label, drafts) => {
    const host = loadExtension();
    const { red } = await twoStaleSections(host);
    const approved = await approveAll(host, drafts(red));
    appendFileSync(amendmentFile(host), `\n${MINE}\n`);

    await expectNoWrite(host, approved, "changed since Prepare");
    const revised = (approval: Record<string, unknown>) => ({ ...approval, revision: approval.proposal });
    await expectNoWrite(host, {
      stale: approved.stale.map((answer) => ({ ...answer, approval: revised(answer.approval) })),
      outcomes: approved.outcomes.map((answer) => ({ ...answer, approval: revised(answer.approval) })),
    }, "only an approved on-read fix, pattern amendment or barrier rule is reconciled");
    expect(readRule(amendmentFile(host)).body).toContain(MINE);
  });

  it("keeps a reference file added since the withdrawal that releases the folder was previewed", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    const [seams] = ledgerRecords(host.ledgerFile);
    const folder = join(referencesDir(host), "tdd");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "old.md"), "Old recipes.\n");
    const approved = await approveAll(host, { withdrawals: [{ fingerprint: seams?.fingerprint, gist: "Name the seam first.", body: "" }] });
    writeFileSync(join(folder, "new.md"), "The user's new recipes.\n");

    await expectNoWrite(host, approved, `the reference files in \`${folder}\` changed since Prepare`);
    expect(readdirSync(folder).sort()).toEqual(["new.md", "old.md"]);
  });

  it.each([
    ["the withdrawal of its last fix", "new.md", (fingerprint: string) => ({ withdrawals: [{ fingerprint, gist: "Name the seam first.", body: "" }] })],
    ["a stale Delete", "new.md", () => ({ stale: [{ rule: "tdd-amendment", select: "Delete" as const }] })],
    ["the withdrawal of its last fix", "drafts/new.md", (fingerprint: string) => ({ withdrawals: [{ fingerprint, gist: "Name the seam first.", body: "" }] })],
    ["a stale Delete", "drafts/new.md", () => ({ stale: [{ rule: "tdd-amendment", select: "Delete" as const }] })],
  ])("keeps content added to the empty folder since %s that releases it was previewed: %s", async (_label, added, drafts) => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    changeSkillFile(host, "tdd");
    const [seams] = ledgerRecords(host.ledgerFile);
    const folder = join(referencesDir(host), "tdd");
    const approved = await approveAll(host, drafts(String(seams?.fingerprint)));
    mkdirSync(dirname(join(folder, added)), { recursive: true });
    writeFileSync(join(folder, added), "The user's new recipes.\n");

    await expectNoWrite(host, approved, `the reference files in \`${folder}\` changed since Prepare`);
    expect(readFileSync(join(folder, added), "utf8")).toBe("The user's new recipes.\n");
  });

  it("refuses the deletion that releases a reference folder no prepared deletion previewed, and carries it out once prepared again", async () => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    splitAmendment(host, "tdd", "tdd-red-is-an-assertion-diff");
    changeSkillFile(host, "tdd");
    const folder = join(referencesDir(host), "tdd");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "old.md"), "Old recipes.\n");
    const approved = await approveAll(host, { stale: [{ rule: "tdd-afk-seams", select: "Delete" }, { rule: "tdd-red-is-an-assertion-diff", select: "Delete" }] });

    const result = await host.callTool("observer_resolve", approved);

    expect(failures(result)).toEqual([expect.stringContaining("which its preview didn't show; prepare it again and ask again")]);
    expect(rulesWritten(host)).toEqual(["tdd-red-is-an-assertion-diff.md"]);
    expect(readdirSync(folder)).toEqual(["old.md"]);
    await resolveApproved(host, { stale: [{ rule: "tdd-red-is-an-assertion-diff", select: "Delete" }] });
    expect(rulesWritten(host)).toEqual([]);
    expect(existsSync(folder)).toBe(false);
  });

  it("tells the user on stale, withdrawal and compaction fieldsets, and only there, that an answer with a note is asked again", async () => {
    const host = loadExtension();
    await twoStaleSections(host);
    splitAmendment(host, "domain-modeling", "dm-define-terms");
    const fix = ledgerRecords(host.ledgerFile).at(-1)!;
    const ask = "Ask one question at a time.";
    const selection = await prepareAndSelect(host, [
      ...staleCandidates({ rule: "tdd-amendment", select: "Update", body: SEAMS }),
      withdrawalCandidate({ skill: "domain-modeling", fingerprint: fix.fingerprint, gist: String(fix.gist) }),
      onReadCandidate({ skill: "grill-with-docs", gist: ask, section: "## One question\n\nAsk one question at a time." }),
      compactionCandidate({ skill: "grill-with-docs", includes: [ask], body: "## One question\n\nOne question at a time." }),
    ]);
    expect(failures(selection)).toEqual([]);
    const fieldsets = String(JSON.parse(resultText(selection)).askHtml).split("<fieldset>").slice(1);
    const warned = (gist: string) => fieldsets.find((fieldset) => fieldset.includes(gist))!.includes("asked again");
    expect([staleGist("tdd-amendment"), String(fix.gist), compactionGist("grill-with-docs"), ask].map(warned)).toEqual([true, true, true, false]);
  });
});

describe("answers citing their prepared proposal", () => {
  const recorded = (fields: Record<string, unknown>) => ({ ...fields, timestamp: expect.any(String), sessionId: "fixture-session" });
  const sourced = (quote: string) => [{ quote, count: 2, source: `signal for ${quote}` }];
  /** Prepares one on-read fix of `tdd` per gist, each citing its own sourced evidence, and selects them: the sixth is deferred. */
  async function preparedFixes(host: ReturnType<typeof loadExtension>, gists: string[]) {
    startPass(host);
    const candidates = gists.map((gist) => ({ ...onReadCandidate({ gist, section: `## ${gist}\n\nText for ${gist}.` }), evidence: sourced(gist) }));
    const selection = await prepareAndSelect(host, candidates);
    const reference = (gist: string) =>
      [...reviewEntries(selection, "selected"), ...reviewEntries(selection, "deferred")].find(({ proposal }) => proposal.gist === gist)!.reference;
    return { selection, reference };
  }

  it("carries out an applied on-read fix, a rule and a withdrawal from their outcome and approval alone, recorded as prepared", async () => {
    const host = loadExtension();
    splitAmendment(host, "domain-modeling", "dm-define-terms");
    const [fix] = ledgerRecords(host.ledgerFile);
    if (!fix) throw new Error("no applied fix");
    // The rule's replay can't run without `omp`, so it is recorded as Later under its prepared identity.
    vi.stubEnv("PATH", "");
    const { outcomes } = await approveAll(host, {
      withdrawals: [{ skill: "domain-modeling", fingerprint: fix.fingerprint, gist: String(fix.gist) }],
      fixes: [{ gist: "Name the seam", section: SEAMS, evidence: [{ quote: "which seam?", count: 2 }] }],
      rules: [{ skill: "ce-commit-jj", kind: "local", gist: "Commit with jj, not git.", rule: JJ_NOT_GIT }],
    });

    const result = await resolve(host, outcomes.map(({ outcome, approval }) => ({ outcome, approval })));

    expect(failures(result)).toEqual([]);
    expect(existsSync(join(host.amendmentsDir, "dm-define-terms.md"))).toBe(false);
    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(SEAMS);
    expect(ledgerRecords(host.ledgerFile).slice(1)).toEqual([
      recorded({ fingerprint: fix.fingerprint, skill: "domain-modeling", kind: "upstream", gist: fix.gist, outcome: "withdrawn", rule: fix.rule }),
      recorded({ fingerprint: proposalFingerprint("tdd", "Name the seam"), skill: "tdd", kind: "upstream", gist: "Name the seam", outcome: "applied",
        rule: join(host.amendmentsDir, "tdd-amendment.md"), evidence: [{ quote: "which seam?", count: 2 }] }),
      recorded({ fingerprint: proposalFingerprint("ce-commit-jj", "Commit with jj, not git."), skill: "ce-commit-jj", kind: "local", gist: "Commit with jj, not git.", outcome: "later" }),
    ]);
  });

  it("records a Later, a Decline and a Select-deferred proposal from their proposal reference alone, under its identity and evidence without its source", async () => {
    const host = loadExtension();
    const gists = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
    const { selection, reference } = await preparedFixes(host, gists);
    expect(reviewEntries(selection, "deferred").map(({ proposal }) => proposal.gist)).toEqual(["Sixth"]);
    askUser(host, selection, ({ gist }) => (gist === "First" ? "Later" : gist === "Second" ? "Decline" : ""));

    const result = await resolve(host, [
      { outcome: "later", proposal: reference("First"), reoffer: "Once the seam is named twice more." },
      { outcome: "declined", proposal: reference("Second") },
      { outcome: "later", proposal: reference("Sixth"), reoffer: "Selected past the cap; offer it next pass." },
    ]);

    expect(failures(result)).toEqual([]);
    const answered = (gist: string, outcome: string, reoffer?: string) => recorded({
      fingerprint: proposalFingerprint("tdd", gist), skill: "tdd", kind: "upstream", gist, outcome,
      evidence: [{ quote: gist, count: 2 }], ...(reoffer && { reoffer }),
    });
    expect(ledgerRecords(host.ledgerFile)).toEqual([
      answered("First", "later", "Once the seam is named twice more."),
      answered("Second", "declined"),
      answered("Sixth", "later", "Selected past the cap; offer it next pass."),
    ]);
  });

  it("carries out a pass from the references its text results give alone: a noted Apply revised, an Apply, a Later and a deferred proposal", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    startPass(host);
    const text = (result: ToolResult<unknown>) => JSON.parse(resultText(result));
    const gists = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
    const prepared = text(await host.callTool("observer_review", { action: "prepare",
      candidates: gists.map((gist) => ({ ...onReadCandidate({ gist, section: `## ${gist}\n\nText for ${gist}.` }), evidence: sourced(gist) })) }));
    expect(prepared.eligible[0].amendmentSections).toEqual(["Seams"]);
    const reference = (gist: string) => prepared.eligible.find((entry: { gist: string }) => entry.gist === gist).reference;
    const selection = await host.callTool("observer_review", { action: "select", proposals: prepared.eligible.map((entry: { reference: unknown }) => entry.reference) });
    const selectionToolCallId = lastCallId(host);
    const { selected, deferred } = text(selection);
    expect(deferred).toEqual([reference("Sixth")]);
    const askToolCallId = askUser(host, selection, ({ gist }) => (gist === "First" ? { option: "Apply", note: "Say it shorter." } : gist === "Second" ? "Apply" : "Later"));
    const approval = (gist: string) => ({ proposal: selected.find((ref: { candidateId: string }) => ref.candidateId === reference(gist).candidateId), selectionToolCallId, askToolCallId });
    const revision = text(await host.callTool("observer_review", { action: "prepare", candidates: [{
      ...onReadCandidate({ gist: "First", section: "## First\n\nShorter." }),
      reconciles: { approval: approval("First"), reason: "The user asked for it shorter.", preserved: "Same First guidance; nothing else changes." },
    }] })).eligible[0].reference;

    const result = await resolve(host, [
      { outcome: "applied", approval: { ...approval("First"), revision } },
      { outcome: "applied", approval: approval("Second") },
      { outcome: "later", proposal: reference("Third"), reoffer: "When it recurs." },
      { outcome: "later", proposal: deferred[0], reoffer: "Selected past the cap; offer it next pass." },
    ]);

    expect(failures(result)).toEqual([]);
    expect(readRule(join(host.amendmentsDir, "tdd-amendment.md")).body).toBe(`${SEAMS}\n\n## First\n\nShorter.\n\n## Second\n\nText for Second.`);
    expect(ledgerRecords(host.ledgerFile).slice(1).map(({ gist, outcome }) => [gist, outcome]))
      .toEqual([["First", "applied"], ["Second", "applied"], ["Third", "later"], ["Sixth", "later"]]);
  });

  it("records a cited proposal's evidence over a re-offered entry's earlier evidence, and carries the earlier evidence when the proposal cites none", async () => {
    const host = loadExtension();
    const earlier = [{ quote: "run only the failing test", count: 3 }];
    await resolve(host, [
      { ...outcome("tdd", "upstream", "Run the failing test first.", "later"), evidence: earlier, reoffer: "When it recurs." },
      { ...outcome("tdd", "upstream", "Name the seam.", "later"), evidence: earlier, reoffer: "When it recurs." },
    ]);
    const [cited, uncited] = ledgerRecords(host.ledgerFile);
    startPass(host);
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
      { ...onReadCandidate({ gist: "Run the failing test first.", section: RED, fingerprint: cited?.fingerprint }), evidence: sourced("the whole suite again") },
      onReadCandidate({ gist: "Name the seam.", section: SEAMS, fingerprint: uncited?.fingerprint }),
    ] });
    const [withEvidence, without] = reviewEntries(prepared).map(({ reference }) => reference);

    await resolve(host, [{ outcome: "declined", proposal: withEvidence }, { outcome: "declined", proposal: without }]);

    expect(ledgerRecords(host.ledgerFile).slice(2)).toEqual([
      expect.objectContaining({ fingerprint: cited?.fingerprint, outcome: "declined", evidence: [{ quote: "the whole suite again", count: 2 }] }),
      expect.objectContaining({ fingerprint: uncited?.fingerprint, outcome: "declined", evidence: earlier }),
    ]);
  });

  it.each<[string, string, (host: ReturnType<typeof loadExtension>, reference: (gist: string) => unknown) => Promise<unknown>]>([
    ["a Later whose supplied gist differs from its proposal's", "not this answer", async (_host, reference) =>
      ({ outcome: "later", proposal: reference("First"), gist: "Second", reoffer: "Later." })],
    ["a Decline whose supplied skill differs from its proposal's", "not this answer", async (_host, reference) =>
      ({ outcome: "declined", proposal: reference("First"), skill: "grill-with-docs" })],
    ["a Decline whose supplied kind differs from its proposal's", "not this answer", async (_host, reference) =>
      ({ outcome: "declined", proposal: reference("First"), kind: "local" })],
    ["an approved fix whose supplied gist differs from its proposal's", "not this answer", async (host) => {
      const [applied] = await approveOnRead(host, [{ gist: "Name the seam", section: SEAMS }]);
      return { outcome: "applied", approval: applied!.approval, gist: "Name every seam" };
    }],
    ["an answer citing its proposal through both `approval` and `proposal`", "cites its proposal once", async (host, reference) => {
      const [applied] = await approveOnRead(host, [{ gist: "Name the seam", section: SEAMS }]);
      return { outcome: "applied", approval: applied!.approval, proposal: reference("First") };
    }],
    ["an answer citing nothing without its gist", "needs its `skill`, `kind` and `gist`", async () => ({ outcome: "declined", skill: "tdd", kind: "upstream" })],
    ["a Decline citing a proposal of an earlier observation pass", "earlier observation pass", async (host, reference) => {
      startPass(host);
      return { outcome: "declined", proposal: reference("First") };
    }],
  ])("records and writes nothing for %s", async (_label, reason, answer) => {
    const host = loadExtension();
    const { reference } = await preparedFixes(host, ["First"]);
    const params = await answer(host, reference);
    const before = observerBytes(host);

    const result = await resolve(host, [params]);

    expect(failures(result)).toEqual([expect.stringContaining(reason)]);
    expect(observerBytes(host)).toEqual(before);
  });

  it("records the user's note on Later as the reoffer of a Later citing its proposal, and a supplied reoffer over it", async () => {
    const host = loadExtension();
    const { selection, reference } = await preparedFixes(host, ["First", "Second"]);
    askUser(host, selection, () => ({ option: "Later", note: "  After the next release.  " }));

    const result = await resolve(host, [
      { outcome: "later", proposal: reference("First") },
      { outcome: "later", proposal: reference("Second"), reoffer: "When reds recur." },
    ]);

    expect(failures(result)).toEqual([]);
    expect(ledgerRecords(host.ledgerFile).map(({ gist, reoffer }) => [gist, reoffer])).toEqual([["First", "After the next release."], ["Second", "When reds recur."]]);
  });

  it.each<[string, (host: ReturnType<typeof loadExtension>, askId: string) => void]>([
    ["a timeout's submission", (host, askId) => {
      const result = host.getBranch().find((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === askId)!;
      (result.message!.details as { timedOut?: boolean }).timedOut = true;
    }],
    ["an Ask result with no Ask call", (host, askId) => {
      host.setBranch(host.getBranch().filter((entry) => entry.id !== `call-${askId}`));
    }],
  ])("records no Later note from %s", async (_label, edit) => {
    const host = loadExtension();
    const { selection, reference } = await preparedFixes(host, ["First"]);
    edit(host, askUser(host, selection, () => ({ option: "Later", note: "After the next release." })));

    const result = await resolve(host, [{ outcome: "later", proposal: reference("First") }]);

    expect(failures(result)).toEqual([]);
    expect(ledgerRecords(host.ledgerFile)).toEqual([expect.not.objectContaining({ reoffer: expect.anything() })]);
  });

  it.each(["cited", "typed"])("records nothing for a %s Decline of a withdrawal: the fix stays in force", async (how) => {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams");
    const fix = ledgerRecords(host.ledgerFile).at(-1)!;
    const { entry } = await approveCandidates(host, [withdrawalCandidate({ fingerprint: fix.fingerprint, gist: String(fix.gist) })], () => "Decline");
    const answer = how === "cited"
      ? { outcome: "declined", proposal: entry(String(fix.gist)).reference }
      : { ...outcome("tdd", "upstream", String(fix.gist), "declined"), fingerprint: fix.fingerprint };
    const before = observerBytes(host);

    const result = await resolve(host, [answer]);

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("stays in force");
    expect(observerBytes(host)).toEqual(before);
  });

  it("refuses an answer citing a proposal that a later Prepare of the pass holds again, naming the latest reference", async () => {
    const host = loadExtension();
    const { reference } = await preparedFixes(host, ["First"]);
    const again = await host.callTool("observer_review", { action: "prepare", candidates: [{ ...onReadCandidate({ gist: "First", section: "## First\n\nNewer text." }), evidence: sourced("First") }] });
    const latest = reviewEntries(again)[0]!.reference;
    const before = observerBytes(host);

    const result = await resolve(host, [{ outcome: "declined", proposal: reference("First") }]);

    expect(failures(result)).toEqual([expect.stringContaining(latest.reviewToolCallId)]);
    expect(observerBytes(host)).toEqual(before);
  });

  it("takes the latest Prepare of a proposal from a nested, hook-recorded Prepare too", async () => {
    const host = loadExtension();
    const { reference } = await preparedFixes(host, ["First"]);
    await host.callTool("observer_review", { action: "prepare", candidates: [{ ...onReadCandidate({ gist: "First", section: "## First\n\nNewer text." }), evidence: sourced("First") }] });
    const [call, result] = host.getBranch().slice(-2);
    const { id, name, arguments: input } = (call!.message!.content as Array<{ id: string; name: string; arguments: unknown }>)[0]!;
    const latest = (result!.message!.details as { eligible: ReviewEntry[] }).eligible[0]!.reference;
    host.setBranch([...host.getBranch().slice(0, -2),
      { type: "custom", id: "hook-call", customType: "skill-observer-tool-call", data: { toolCallId: id, toolName: name, input } },
      { type: "custom", id: "hook-result", customType: "skill-observer-tool-result",
        data: { toolCallId: id, toolName: name, input, isError: false, details: result!.message!.details, content: [] } } as SessionEntry,
    ]);

    expect(failures(await resolve(host, [{ outcome: "declined", proposal: reference("First") }]))).toEqual([expect.stringContaining(latest.reviewToolCallId)]);
    expect(failures(await resolve(host, [{ outcome: "declined", proposal: latest }]))).toEqual([]);
  });

  it("names a cited proposal once in its refusal", async () => {
    const host = loadExtension();
    const { reference } = await preparedFixes(host, ["First"]);
    const forged = { ...(reference("First") as Record<string, string>), contentHash: "0".repeat(64) };

    const [failure] = failures(await resolve(host, [{ outcome: "declined", proposal: forged }]));

    expect(failure).toMatch(/^proposal `[^`]+` of review `[^`]+`: content hash/);
  });
});

describe("observer_resolve takes no raw protected change", () => {
  const references = [{ name: "seams.md", body: "Seam recipes." }];
  const withdrawn = { ...outcome("tdd", "upstream", "A red is an assertion diff.", "withdrawn"), fingerprint: proposalFingerprint("tdd", "A red is an assertion diff.") };
  /** Each shape `observer_resolve` once carried out from the caller's own draft, before every protected change came only from an approved prepared proposal. */
  it.each<[string, string, Record<string, unknown>]>([
    ["an on-read append with a raw section", "not a `rule`", { outcomes: [{ ...outcome("tdd", "upstream", "Test one behaviour per test.", "applied"), rule: { body: ONE_BEHAVIOUR } }] }],
    ["an on-read append without approval", "needs `approval`", { outcomes: [outcome("tdd", "upstream", "Test one behaviour per test.", "applied")] }],
    ["a pattern amendment with a raw rule", "not a `rule`", { outcomes: [{ ...outcome("tdd", "upstream", "Run the whole file.", "applied"), rule: focusedTestsRule }] }],
    ["a barrier rule with a raw rule", "not a `rule`", { outcomes: [{ ...outcome("ce-commit-jj", "local", "Commit with jj, not git.", "applied"), rule: JJ_NOT_GIT }] }],
    ["a stale Update with a raw body and reference files", "needs `approval`", { stale: [{ rule: "tdd-amendment", action: "update", body: SEAMS, references }] }],
    ["a stale Delete without approval", "needs `approval`", { stale: [{ rule: "tdd-amendment", action: "delete" }] }],
    ["a withdrawal with a raw body and reference files", "not a `rule`", { outcomes: [{ ...withdrawn, rule: { body: SEAMS, references } }] }],
    ["a withdrawal without approval", "needs `approval`", { outcomes: [withdrawn] }],
    ["a compaction with a raw body, includes and reference files", "carries no `body`", { compactions: [{ skill: "tdd", outcome: "applied", includes: [], body: SEAMS, references }] }],
    ["a compaction without approval", "needs `approval`", { compactions: [{ skill: "tdd", outcome: "applied" }] }],
  ])("refuses %s and leaves every owned byte and the ledger as they were", async (_label, reason, params) => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    await addOnReadFix(host, "tdd", "A red is an assertion diff.", RED);
    mkdirSync(join(referencesDir(host), "tdd"), { recursive: true });
    writeFileSync(join(referencesDir(host), "tdd", "old.md"), "Old recipes.\n");
    changeSkillFile(host, "tdd");
    const before = { files: ownedFiles(host), ledger: readFileSync(host.ledgerFile, "utf8") };

    const result = await host.callTool("observer_resolve", { outcomes: [], ...params });

    expect(result.isError).toBe(true);
    expect((result.details as { failures: string[] }).failures).toEqual([expect.stringContaining(reason)]);
    expect((result.details as { records: unknown[] }).records).toEqual([]);
    expect({ files: ownedFiles(host), ledger: readFileSync(host.ledgerFile, "utf8") }).toEqual(before);
  });
});

describe("migrating legacy amendment rules", () => {
  const legacyRule = (host: ReturnType<typeof loadExtension>, name: string, amends: string, pin: string) => {
    mkdirSync(host.rulesDir, { recursive: true });
    const file = join(host.rulesDir, `${name}.md`);
    writeFileSync(file, `---\ncondition: "skill://${amends}"\nscope: "tool:read"\namends: "${amends}"\n${pin}interruptMode: "never"\nfingerprint: "0123456789ab"\ngeneratedBy: "skill-observer"\n---\n\nKeep this body.\n`);
    return file;
  };
  const migrate = (host: ReturnType<typeof loadExtension>) =>
    amendments.migrateObserverRules({ rulesDir: host.rulesDir, amendmentsDir: host.amendmentsDir }, createProvenanceResolver(host.skillHome.roots));

  it("converts matching pins silently, leaves a mismatched one stale, moves each on-read amendment to the amendments directory, and changes nothing on a second run", async () => {
    const host = loadExtension();
    const lockHash = JSON.parse(readFileSync(host.skillHome.roots.lockFile, "utf8")).skills.tdd.skillFolderHash;
    legacyRule(host, "tdd-amendment", "tdd", `skillFolderHash: "${lockHash}"\n`);
    legacyRule(host, "ce-code-review-amendment", "ce-code-review", `plugin: "${CE_PLUGIN}"\npluginVersion: "3.30.1"\n`);
    legacyRule(host, "ce-commit-amendment", "tdd", 'skillFolderHash: "0000000000000000000000000000000000000001"\n');
    const [upstream, plugin, mismatched] = ["tdd-amendment", "ce-code-review-amendment", "ce-commit-amendment"].map((name) => join(host.amendmentsDir, `${name}.md`));

    expect(migrate(host)).toEqual(["ce-code-review-amendment", "ce-commit-amendment", "tdd-amendment"]);

    expect(readdirSync(host.rulesDir)).toEqual([]);
    expect(readRule(upstream!)).toEqual({
      frontmatter: { amends: "tdd", interruptMode: "never", fingerprint: "0123456789ab", generatedBy: "skill-observer", skillHash: currentSkillHash(host, "tdd") },
      body: "Keep this body.",
    });
    expect(readRule(plugin!).frontmatter).toMatchObject({ skillHash: currentSkillHash(host, "ce-code-review") });
    expect(readRule(plugin!).frontmatter).not.toHaveProperty("plugin");
    expect(readRule(mismatched!).frontmatter.skillHash).toBe("");
    const section = await staleSection(host);
    expect(section).toContain("ce-commit-amendment");
    expect(section).not.toContain("tdd-amendment");
    expect(section).not.toContain("ce-code-review-amendment");

    const after = [upstream!, plugin!, mismatched!].map((file) => readFileSync(file, "utf8"));
    expect(migrate(host)).toEqual([]);
    expect([upstream!, plugin!, mismatched!].map((file) => readFileSync(file, "utf8"))).toEqual(after);
  });

  it("deletes the old file of an on-read amendment whose identical new file a crashed run already wrote", () => {
    const host = loadExtension();
    const old = legacyRule(host, "tdd-amendment", "tdd", `skillHash: "${currentSkillHash(host, "tdd")}"\n`);
    const moved = join(host.amendmentsDir, "tdd-amendment.md");
    mkdirSync(host.amendmentsDir, { recursive: true });
    writeFileSync(moved, `---\namends: "tdd"\nfingerprint: "0123456789ab"\ngeneratedBy: "skill-observer"\n---\n\nKeep this body.\n`);

    expect(migrate(host)).toEqual(["tdd-amendment"]);
    expect(existsSync(old)).toBe(false);
    expect(readRule(moved).body).toBe("Keep this body.");
  });

  it("keeps both files when the old one changed after a crashed run wrote the new one", () => {
    const host = loadExtension();
    const old = legacyRule(host, "tdd-amendment", "tdd", `skillHash: "${currentSkillHash(host, "tdd")}"\n`);
    const moved = join(host.amendmentsDir, "tdd-amendment.md");
    mkdirSync(host.amendmentsDir, { recursive: true });
    const movedText = `---\namends: "tdd"\nfingerprint: "0123456789ab"\ngeneratedBy: "skill-observer"\n---\n\nThe body before the update.\n`;
    writeFileSync(moved, movedText);
    const oldText = readFileSync(old, "utf8");

    expect(migrate(host)).toEqual([]);
    expect(readFileSync(old, "utf8")).toBe(oldText);
    expect(readFileSync(moved, "utf8")).toBe(movedText);
  });

  it("never overwrites a file the user wrote under the new name, and keeps the old one", () => {
    const host = loadExtension();
    const old = legacyRule(host, "tdd-amendment", "tdd", `skillHash: "${currentSkillHash(host, "tdd")}"\n`);
    const foreign = join(host.amendmentsDir, "tdd-amendment.md");
    mkdirSync(host.amendmentsDir, { recursive: true });
    writeFileSync(foreign, "Keep this body.\n");

    expect(migrate(host)).toEqual([]);
    expect(readFileSync(foreign, "utf8")).toBe("Keep this body.\n");
    expect(existsSync(old)).toBe(true);
  });

  it("moves every marked `tool:read` rule, whatever its condition, and leaves other scopes in the rules directory", () => {
    const host = loadExtension();
    mkdirSync(host.rulesDir, { recursive: true });
    writeFileSync(join(host.rulesDir, "vendor-reads.md"), `---\ncondition: "/vendor/"\nscope: "tool:read"\namends: "ce-commit-jj"\nfingerprint: "0123456789ab"\ngeneratedBy: "skill-observer"\n---\n\nRead the package docs instead.\n`);
    const bashText = `---\ncondition: "git commit"\nscope: "tool:bash"\namends: "ce-commit-jj"\nfingerprint: "0123456789ab"\ngeneratedBy: "skill-observer"\n---\n\nUse jj.\n`;
    writeFileSync(join(host.rulesDir, "jj-not-git.md"), bashText);

    expect(migrate(host)).toEqual(["vendor-reads"]);
    expect(readRule(join(host.amendmentsDir, "vendor-reads.md"))).toEqual({
      frontmatter: { amends: "ce-commit-jj", fingerprint: "0123456789ab", generatedBy: "skill-observer" },
      body: "Read the package docs instead.",
    });
    expect(readdirSync(host.rulesDir)).toEqual(["jj-not-git.md"]);
    expect(readFileSync(join(host.rulesDir, "jj-not-git.md"), "utf8")).toBe(bashText);
  });

  it("leaves a file that fails to migrate as it is and migrates the rest", () => {
    const host = loadExtension();
    legacyRule(host, "tdd-amendment", "tdd", `skillHash: "${currentSkillHash(host, "tdd")}"\n`);
    mkdirSync(join(host.rulesDir, "broken.md"));

    expect(migrate(host)).toEqual(["tdd-amendment"]);
    expect(existsSync(join(host.amendmentsDir, "tdd-amendment.md"))).toBe(true);
    expect(existsSync(join(host.rulesDir, "broken.md"))).toBe(true);
  });
});

describe("amendment rules for plugin skills", () => {
  const MODE = "## Mode\n\nName the review mode first.";

  async function withAmendment() {
    const host = loadExtension();
    await addOnReadFix(host, "ce-code-review", "Name the review mode before the findings.", MODE, "plugin");
    return host;
  }

  it("creates the plugin skill's on-read amendment pinned to the skill's content, which reaches reads of the skill after a plugin update", async () => {
    const host = loadExtension();
    const result = await addOnReadFix(host, "ce-code-review", "Name the review mode before the findings.", MODE, "plugin");

    expect(result.isError).toBeFalsy();
    const file = join(host.amendmentsDir, "ce-code-review-amendment.md");
    const { frontmatter, body } = readRule(file);
    expect(frontmatter).toMatchObject({ amends: "ce-code-review", skillHash: currentSkillHash(host, "ce-code-review") });
    expect(frontmatter).not.toHaveProperty("plugin");
    expect(body).toBe(MODE);
    expect(ledgerRecords(host.ledgerFile)).toEqual([
      expect.objectContaining({ skill: "ce-code-review", kind: "plugin", outcome: "applied", rule: file }),
    ]);

    const updated = installPlugin(host.skillHome.roots, CE_PLUGIN, "3.31.0", ["ce-code-review"]);
    host.setBranch(fx.plainUserMessage);
    expect((await readSkill(host, join(updated, "skills/ce-code-review/references/modes.md"))).additionalContext).toBeUndefined();
    expect((await readSkill(host, join(updated, "skills/ce-code-review/SKILL.md"))).additionalContext).toContain(MODE);
  });

  it("appends a later on-read fix for the plugin skill to its amendment", async () => {
    const host = await withAmendment();
    const result = await addOnReadFix(host, "ce-code-review", "Group findings by file.", "## Findings\n\nGroup findings by file.", "plugin");

    const file = join(host.amendmentsDir, "ce-code-review-amendment.md");
    expect(result.isError).toBeFalsy();
    expect(rulesWritten(host)).toEqual(["ce-code-review-amendment.md"]);
    expect(readRule(file).body).toBe(`${MODE}\n\n## Findings\n\nGroup findings by file.`);
    expect(ledgerRecords(host.ledgerFile).map(({ kind, rule }) => ({ kind, rule }))).toEqual([
      { kind: "plugin", rule: file },
      { kind: "plugin", rule: file },
    ]);
  });

  it.skipIf(!ompAvailable)("writes a pattern amendment pinned to the plugin, once its pattern passes the replay check", async () => {
    const host = loadExtension();
    const result = await host.callTool("observer_resolve", { outcomes: await approveRules(host, [
      { skill: "ce-code-review", kind: "plugin", gist: "Name the review mode before the findings.", rule: { ...focusedTestsRule, name: "ce-code-review-no-focused-tests" } },
      { skill: "ce-code-review", kind: "plugin", gist: "Run the whole suite.", rule: { ...bailRule, name: "ce-code-review-no-bail", spares: [{ command: "bun run test --bail" }] } },
    ]) });

    expect(readRule(join(host.rulesDir, "ce-code-review-no-focused-tests.md")).frontmatter).toMatchObject({
      condition: "\\bit\\.only\\(",
      scope: "text",
      skillHash: currentSkillHash(host, "ce-code-review"),
    });
    expect(rulesWritten(host)).toEqual(["ce-code-review-no-focused-tests.md"]);
    expect(ledgerRecords(host.ledgerFile).map((record) => record.outcome)).toEqual(["applied", "later"]);
    expect(result.details).toMatchObject({ deferred: [expect.stringMatching(/spares\[0\]/)] });
  }, 30_000);

  it("prepares no fix whose candidate names another provenance than the plugin skill's", async () => {
    const host = loadExtension();
    const result = await host.callTool("observer_review", { action: "prepare", candidates: [{ kind: "upstream", skill: "ce-code-review",
      gist: "Name the review mode before the findings.", priority: "evidence", remedy: "Fix it", change: { operation: "on-read-append", section: MODE } }] });

    expect(result.isError).toBe(true);
    expect(rulesWritten(host)).toEqual([]);
  });

  it("does not ask about an amendment when its plugin's version changes with identical skill files", async () => {
    const host = await withAmendment();
    installPlugin(host.skillHome.roots, CE_PLUGIN, "3.31.0", ["ce-code-review"]);
    expect(await staleSection(host)).not.toContain("ce-code-review-amendment");
  });

  it("asks about an amendment once its plugin skill's files change", async () => {
    const host = await withAmendment();
    const updated = installPlugin(host.skillHome.roots, CE_PLUGIN, "3.31.0", ["ce-code-review"]);
    writeFileSync(join(updated, "skills/ce-code-review/SKILL.md"), "---\nname: ce-code-review\n---\n\nNew body.\n");
    expect(await staleSection(host)).toMatch(/`ce-code-review-amendment`[^\n]*plugin skill whose files changed[^\n]*Skill file: `[^`]*___3\.31\.0/);
  });

  it("asks about an amendment once its plugin is uninstalled", async () => {
    const host = await withAmendment();
    uninstallPlugin(host.skillHome.roots, CE_PLUGIN);
    expect(await staleSection(host)).toMatch(/`ce-code-review-amendment`[^\n]*no longer installed/);
  });

  it("keep re-pins the amendment to the skill's current hash and leaves its body", async () => {
    const host = await withAmendment();
    const updated = installPlugin(host.skillHome.roots, CE_PLUGIN, "3.31.0", ["ce-code-review"]);
    appendFileSync(join(updated, "skills/ce-code-review/SKILL.md"), "Changed.\n");
    const result = await host.callTool("observer_resolve", { outcomes: [], stale: [{ rule: "ce-code-review-amendment", action: "keep" }] });

    expect(result.isError).toBeFalsy();
    const rule = readRule(join(host.amendmentsDir, "ce-code-review-amendment.md"));
    expect(rule.frontmatter).toMatchObject({ skillHash: currentSkillHash(host, "ce-code-review") });
    expect(rule.body).toBe(MODE);
    expect(await staleSection(host)).not.toContain("ce-code-review-amendment");
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ skill: "ce-code-review", kind: "plugin", outcome: "kept" });
  });

  it("update rewrites the body and re-pins the amendment", async () => {
    const host = await withAmendment();
    const updated = installPlugin(host.skillHome.roots, CE_PLUGIN, "3.31.0", ["ce-code-review"]);
    appendFileSync(join(updated, "skills/ce-code-review/SKILL.md"), "Changed.\n");
    await resolveApproved(host, { stale: [{ rule: "ce-code-review-amendment", skill: "ce-code-review", kind: "plugin", select: "Update", body: "Name the mode in the report header." }] });

    const rule = readRule(join(host.amendmentsDir, "ce-code-review-amendment.md"));
    expect(rule.frontmatter.skillHash).toBe(currentSkillHash(host, "ce-code-review"));
    expect(rule.body).toBe("Name the mode in the report header.");
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ kind: "plugin", outcome: "updated" });
  });

  it("delete removes the amendment of an uninstalled plugin", async () => {
    const host = await withAmendment();
    uninstallPlugin(host.skillHome.roots, CE_PLUGIN);
    await resolveApproved(host, { stale: [{ rule: "ce-code-review-amendment", skill: "ce-code-review", kind: "plugin", select: "Delete" }] });

    expect(rulesWritten(host)).toEqual([]);
    expect(await staleSection(host)).not.toContain("ce-code-review-amendment");
    expect(ledgerRecords(host.ledgerFile).at(-1)).toMatchObject({ kind: "plugin", outcome: "deleted" });
  });
});

describe("amendments for skills started with /skill:", () => {
  /** The expanded text OMP submits for a user-invoked skill prompt. */
  const skillPrompt = (entries: SessionEntry[]) => String(entries[0]?.content);

  async function withDomainModelingAmendment(options?: Parameters<typeof loadExtension>[0]) {
    const host = loadExtension(options);
    splitAmendment(host, "domain-modeling", "dm-define-terms", { body: "Define each term in the glossary before using it." });
    host.setBranch(fx.plainUserMessage);
    return host;
  }

  it("adds one hidden reminder carrying the skill's one on-read amendment, with each section added to it, to the turn the skill starts", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "domain-modeling", "Define each term first.", "## Glossary\n\nDefine each term in the glossary before using it.");
    await addOnReadFix(host, "domain-modeling", "Record decisions as ADRs.", "## Decisions\n\nRecord each settled decision as an ADR.");
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    host.setBranch(fx.plainUserMessage);

    const added = await host.startAgent(skillPrompt(fx.skillPromptUpstream));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ display: false, details: { rules: ["domain-modeling-amendment"] } });
    const content = String(added[0]?.content);
    expect(content).toContain("## Glossary\n\nDefine each term in the glossary before using it.\n\n## Decisions\n\nRecord each settled decision as an ADR.");
    expect(content).not.toContain("Name the seam under test");
  });

  it("finds the skill in a queued batch that joins it to other user messages", async () => {
    const host = await withDomainModelingAmendment();
    const added = await host.startAgent(`${textOf(fx.plainUserMessage)}\n\n${skillPrompt(fx.skillPromptUpstream)}`);
    expect(String(added[0]?.content)).toContain("Define each term in the glossary before using it.");
  });

  /** A branch where `/skill:domain-modeling` already ran and got its reminder, as OMP saved it. */
  const remindedBranch = [...fx.plainUserMessage, ...fx.skillPromptUpstream, ...fx.amendmentReminder];

  it("adds nothing when the skill starts again in the same session", async () => {
    const host = await withDomainModelingAmendment();
    host.setBranch(remindedBranch);
    expect(await host.startAgent(skillPrompt(fx.skillPromptUpstream))).toEqual([]);
  });

  it("adds the reminder again once a compaction has dropped the earlier one", async () => {
    const host = await withDomainModelingAmendment();
    host.setBranch([...remindedBranch, ...fx.compaction]);
    expect(await host.startAgent(skillPrompt(fx.skillPromptUpstream))).toHaveLength(1);
  });

  it("adds nothing when a compaction kept the earlier reminder", async () => {
    const host = await withDomainModelingAmendment();
    const keptFromSkillPrompt = fx.compaction.map((entry) => ({ ...entry, firstKeptEntryId: fx.skillPromptUpstream[0]?.id }));
    host.setBranch([...remindedBranch, ...keptFromSkillPrompt]);
    expect(await host.startAgent(skillPrompt(fx.skillPromptUpstream))).toEqual([]);
  });

  it("adds nothing for a skill without amendments", async () => {
    const host = await withDomainModelingAmendment();
    expect(await host.startAgent(skillPrompt(fx.skillPromptManaged))).toEqual([]);
  });

  it.skipIf(!ompAvailable)("adds nothing for a skill whose only amendments watch the model's output", async () => {
    const host = loadExtension();
    await amend(host, "domain-modeling", noTodoRule);
    host.setBranch(fx.plainUserMessage);
    expect(await host.startAgent(skillPrompt(fx.skillPromptUpstream))).toEqual([]);
  }, 30_000);

  const invocationTemplate = installedInvocationTemplate();

  it.skipIf(!invocationTemplate)("finds the skill in a prompt rendered from the installed OMP's template", async () => {
    const host = await withDomainModelingAmendment();
    const prompt = readFileSync(invocationTemplate!, "utf8")
      .replaceAll("{{name}}", "domain-modeling")
      .replace("{{body}}", "# Domain Modeling")
      .replace("{{baseDir}}", `${host.skillHome.roots.skillsDir}/domain-modeling`);
    expect(await host.startAgent(prompt)).toHaveLength(1);
  });

  it.each([
    ["without UI", { hasUI: false }],
    ["in a subagent session", { agentKind: "sub" }],
  ] as const)("adds the reminder %s", async (_label, options) => {
    const host = await withDomainModelingAmendment(options);
    expect(await host.startAgent(skillPrompt(fx.skillPromptUpstream))).toHaveLength(1);
  });
});

/** The `/skill:` invocation template in the package of the first `omp` on PATH; a compiled binary ships none. */
function installedInvocationTemplate(): string | undefined {
  const bin = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "omp")).find((path) => existsSync(path));
  if (!bin) return undefined;
  for (let dir = dirname(realpathSync(bin)); dir !== dirname(dir); dir = dirname(dir)) {
    const template = join(dir, "src/prompts/skills/user-invocation.md");
    if (existsSync(join(dir, "package.json")) && existsSync(template)) return template;
  }
  return undefined;
}

describe("amendments for skills read with the read tool", () => {
  const ORIGINAL = [{ type: "text", text: "Skill instructions." }];
  const reminderOf = (skill: string) => `<system-reminder reason="skill_amendment" skill="${skill}">`;

  async function withTddAmendment() {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam first.", SEAMS);
    host.setBranch(fx.plainUserMessage);
    return host;
  }
  const deliveries = (host: ReturnType<typeof loadExtension>) =>
    host.getBranch().filter((entry) => entry.customType === AMENDMENT_DELIVERY_TYPE).map((entry) => entry.data);

  it("adds the skill's on-read amendment after a native read as additional context, once per context window", async () => {
    const host = await withTddAmendment();

    const first = await readSkill(host, "skill://tdd");
    expect(first.content).toEqual(ORIGINAL);
    expect(first.additionalContext).toContain(reminderOf("tdd"));
    expect(first.additionalContext).toContain(`<amendment rule="tdd-amendment">\n${SEAMS}\n</amendment>`);
    expect(deliveries(host)).toEqual([{ skill: "tdd", rules: ["tdd-amendment"] }]);

    const second = await readSkill(host, "skill://tdd/SKILL.md:1-40");
    expect(second).toMatchObject({ content: ORIGINAL, isError: false });
    expect(second.additionalContext).toBeUndefined();
    expect(deliveries(host)).toHaveLength(1);
  });

  it("adds it again once a compaction has dropped the earlier delivery", async () => {
    const host = await withTddAmendment();
    await readSkill(host, "skill://tdd");
    host.getBranch().push(...fx.compaction);

    expect((await readSkill(host, "skill://tdd")).additionalContext).toContain(SEAMS);
  });

  it("adds it again after a /clear reset", async () => {
    const host = await withTddAmendment();
    await readSkill(host, "skill://tdd");
    host.getBranch().push({ type: "reset_boundary", id: "reset-1" });

    expect((await readSkill(host, "skill://tdd")).additionalContext).toContain(SEAMS);
    expect(deliveries(host)).toHaveLength(2);
  });

  it("adds it again after a /clear reset that follows a compaction which kept the earlier delivery", async () => {
    const host = await withTddAmendment();
    await readSkill(host, "skill://tdd");
    host.getBranch().push(...fx.compaction.map((entry) => ({ ...entry, firstKeptEntryId: fx.plainUserMessage[0]?.id })));
    expect((await readSkill(host, "skill://tdd")).additionalContext).toBeUndefined();
    host.getBranch().push({ type: "reset_boundary", id: "reset-1" });

    expect((await readSkill(host, "skill://tdd")).additionalContext).toContain(SEAMS);
  });

  it("shares the once-per-window record with /skill: reminders, either way round", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "domain-modeling", "Define each term first.", "## Glossary\n\nDefine each term first.");
    const prompt = String(fx.skillPromptUpstream[0]?.content);

    host.setBranch(fx.plainUserMessage);
    const [reminder] = await host.startAgent(prompt);
    host.getBranch().push({ type: "custom_message", id: "reminder-1", ...reminder });
    expect((await readSkill(host, "skill://domain-modeling")).additionalContext).toBeUndefined();

    host.setBranch(fx.plainUserMessage);
    expect((await readSkill(host, "skill://domain-modeling")).additionalContext).toContain("Define each term first.");
    expect(await host.startAgent(prompt)).toEqual([]);
  });

  it("appends the amendment to the result of a read nested in eval, which has no place for additional context", async () => {
    const host = await withTddAmendment();

    const result = await readSkill(host, "skill://tdd", { nested: true });

    expect(result.additionalContext).toBeUndefined();
    expect(result.content.slice(0, 1)).toEqual(ORIGINAL);
    expect(result.content[1]?.text).toContain(reminderOf("tdd"));
    expect(result.content[1]?.text).toContain(SEAMS);
    expect(deliveries(host)).toEqual([{ skill: "tdd", rules: ["tdd-amendment"] }]);
  });

  it("appends the amendment to the result of a device-dispatched read, whose native call is the outer write", async () => {
    const host = await withTddAmendment();
    const outer = { path: "xd://read", content: '{"path":"skill://tdd"}' };
    await host.toolCall("write", outer, "dispatch");
    host.getBranch().push({ type: "message", id: "dispatching", message: { role: "assistant", content: [{ type: "toolCall", id: "dispatch", name: "write", arguments: outer }] } });
    await host.toolCall("read", { path: "skill://tdd" }, "dispatch");

    const result = await host.toolResult({ toolName: "read", toolCallId: "dispatch", input: { path: "skill://tdd" }, content: ORIGINAL, isError: false });

    expect(result.additionalContext).toBeUndefined();
    expect(result.content.slice(0, 1)).toEqual(ORIGINAL);
    expect(result.content[1]?.text).toContain(SEAMS);
    expect(deliveries(host)).toEqual([{ skill: "tdd", rules: ["tdd-amendment"] }]);
  });

  describe("matches the entry file by every path a read can take, and nothing else", () => {
    /** A host whose `writing-for-agents` skill is installed under another folder name, as skills CLI installs can be, and amended. */
    async function withRenamedSkill() {
      const host = loadExtension();
      writeSkill(join(host.skillHome.roots.skillsDir, "wfa"), "writing-for-agents");
      writeSkill(join(host.skillHome.roots.skillsDir, "wfa-extra"), "writing-for-agents-extra");
      setLockHash(host, "wfa", "1111111111111111111111111111111111111111");
      await addOnReadFix(host, "writing-for-agents", "Prune pointers before bodies.", "## Pointers\n\nPrune the pointer first.");
      host.setBranch(fx.plainUserMessage);
      return host;
    }

    it.each([
      "skill://writing-for-agents",
      "skill://writing-for-agents:10-20",
      "skill://writing-for-agents/SKILL.md",
      "skill://writing-for-agents/SKILL.md:raw",
      "~/.agents/skills/wfa/SKILL.md:1-40",
    ])("delivers for %s", async (path) => {
      const host = await withRenamedSkill();
      expect((await readSkill(host, path)).additionalContext).toContain("Prune the pointer first.");
    });

    it.each([
      "skill://writing-for-agents-extra",
      "skill://writing-for-agents/SKILL-MECHANICS.md",
      "skill://writing-for-agents/references/SKILL.md",
      "~/.agents/skills/wfa/SKILL-MECHANICS.md",
      "~/.agents/skills/wfa/references/SKILL.md",
      "~/.agents/skills/wfa-extra/SKILL.md",
      "https://example.com/skills/wfa/SKILL.md",
    ])("delivers nothing for %s", async (path) => {
      const host = await withRenamedSkill();
      const result = await readSkill(host, path);
      expect(result.additionalContext).toBeUndefined();
      expect(result.content).toEqual(ORIGINAL);
      expect(deliveries(host)).toEqual([]);
    });

    it("delivers nothing for a failed read of the entry file", async () => {
      const host = await withRenamedSkill();
      const result = await readSkill(host, "skill://writing-for-agents", { isError: true });
      expect(result.additionalContext).toBeUndefined();
      expect(deliveries(host)).toEqual([]);
    });
  });

  describe("a copy of an installed skill outside the skill roots", () => {
    /** A host where `name` has an on-read amendment and a copy of its entry file under the project, `extra` longer; returns the copy's path. */
    function withCopy(name: string, extra = "") {
      const host = loadExtension();
      splitAmendment(host, name, `${name}-amendment`, { body: "## Mode\n\nName the mode first." });
      host.setBranch(fx.plainUserMessage);
      const installed = createProvenanceResolver(host.skillHome.roots).byName(name);
      if (installed.kind === "unknown") throw new Error(`${name} is not installed`);
      return { host, copy: copySkillEntry(installed.path, join(host.skillHome.roots.cwd, ".agents/skills", name), extra) };
    }

    it.each([
      ["a plugin", "ce-code-review"],
      ["a local", "ce-commit-jj"],
    ])("delivers the installed skill's on-read amendment when the copy of %s skill holds the same bytes", async (_label, name) => {
      const { host, copy } = withCopy(name);
      expect((await readSkill(host, copy)).additionalContext).toContain("Name the mode first.");
      expect(deliveries(host)).toEqual([{ skill: name, rules: [`${name}-amendment`] }]);
    });

    it("delivers nothing when the copy differs from the installed skill by one byte", async () => {
      const { host, copy } = withCopy("ce-code-review", " ");
      const result = await readSkill(host, copy);
      expect(result.additionalContext).toBeUndefined();
      expect(result.content).toEqual(ORIGINAL);
      expect(deliveries(host)).toEqual([]);
    });
  });

  it("delivers nothing for a direct read of a local skill a same-named plugin skill shadows", async () => {
    const host = loadExtension();
    splitAmendment(host, "ce-code-review", "ce-code-review-amendment", { body: "## Mode\n\nName the mode first." });
    host.setBranch(fx.plainUserMessage);
    const winner = createProvenanceResolver(host.skillHome.roots).byName("ce-code-review");
    if (winner.kind === "unknown") throw new Error("ce-code-review is not installed");
    const shadowed = copySkillEntry(winner.path, join(host.skillHome.roots.skillsDir, "ce-code-review"), "Other instructions.");

    const result = await readSkill(host, shadowed);

    expect(result.additionalContext).toBeUndefined();
    expect(deliveries(host)).toEqual([]);
    expect((await readSkill(host, winner.path)).additionalContext).toContain("Name the mode first.");
  });

  it("leaves the read whole and logs the error when delivering fails", async () => {
    const host = loadExtension();
    // A directory where an amendment file belongs makes reading it throw.
    mkdirSync(join(host.amendmentsDir, "tdd-amendment.md"), { recursive: true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    host.setBranch(fx.plainUserMessage);

    const result = await readSkill(host, "skill://tdd");

    expect(result).toMatchObject({ content: ORIGINAL, isError: false });
    expect(result.additionalContext).toBeUndefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("delivering on-read amendments failed"), expect.anything());
    logged.mockRestore();
  });
});

describe("delivery notices for on-read amendments", () => {
  /** A host whose `tdd` skill carries two on-read amendments. */
  function withTwoTddAmendments(options?: Parameters<typeof loadExtension>[0]) {
    const host = loadExtension(options);
    splitAmendment(host, "tdd", "tdd-afk-seams", { body: SEAMS });
    splitAmendment(host, "tdd", "tdd-red", { body: RED });
    host.setBranch(fx.plainUserMessage);
    return host;
  }
  const deliveries = (host: ReturnType<typeof loadExtension>) =>
    host.getBranch().filter((entry) => entry.customType === AMENDMENT_DELIVERY_TYPE).map((entry) => entry.data);
  const namesBoth = (skill: string) => expect.stringMatching(new RegExp(`\`${skill}\`.*(tdd-afk-seams, tdd-red|tdd-red, tdd-afk-seams)`));

  it("tells the user once per read delivery, naming every rule delivered, and not again within the context window", async () => {
    const host = withTwoTddAmendments();

    await readSkill(host, "skill://tdd");
    expect(deliveries(host)).toEqual([{ skill: "tdd", rules: expect.arrayContaining(["tdd-afk-seams", "tdd-red"]) }]);
    expect(host.noticeEvents).toEqual([{ message: namesBoth("tdd"), type: "info" }]);

    const second = await readSkill(host, "skill://tdd");
    expect(second.additionalContext).toBeUndefined();
    expect(deliveries(host)).toHaveLength(1);
    expect(host.noticeEvents).toHaveLength(1);
  });

  it("tells the user again when a /clear reset makes the read deliver again", async () => {
    const host = withTwoTddAmendments();
    await readSkill(host, "skill://tdd");
    host.getBranch().push({ type: "reset_boundary", id: "reset-1" });

    await readSkill(host, "skill://tdd");

    expect(host.noticeEvents).toEqual([{ message: namesBoth("tdd"), type: "info" }, { message: namesBoth("tdd"), type: "info" }]);
  });

  /** A host whose `domain-modeling` skill carries two on-read amendments, for the `/skill:` route. */
  function withTwoDomainModelingAmendments(options?: Parameters<typeof loadExtension>[0]) {
    const host = loadExtension(options);
    splitAmendment(host, "domain-modeling", "dm-define-terms", { body: "Define each term first." });
    splitAmendment(host, "domain-modeling", "dm-record-adrs", { body: "Record each decision as an ADR." });
    host.setBranch(fx.plainUserMessage);
    return host;
  }

  it("tells the user once which rules a /skill: reminder carries, after the reminder is on the branch", async () => {
    const host = withTwoDomainModelingAmendments();

    const [reminder] = await host.startAgent(String(fx.skillPromptUpstream[0]?.content));
    expect(reminder).toMatchObject({ details: { rules: expect.arrayContaining(["dm-define-terms", "dm-record-adrs"]) } });
    expect(host.noticeEvents).toEqual([]);

    await host.commitMessage(reminder!);
    await host.emit("message_end");

    expect(host.noticeEvents).toEqual([{ message: expect.stringContaining("`domain-modeling`"), type: "info" }]);
    expect(host.notices[0]).toContain("dm-define-terms");
    expect(host.notices[0]).toContain("dm-record-adrs");
  });

  it("tells the user nothing for a /skill: preparation OMP discards", async () => {
    const host = withTwoDomainModelingAmendments();

    await host.startAgent(String(fx.skillPromptUpstream[0]?.content));
    await host.emit("message_end");
    await host.startAgent("An ordinary prompt.");
    await host.emit("message_end");

    expect(host.noticeEvents).toEqual([]);
  });

  it("tells the user once for a /skill: preparation OMP runs again before committing it", async () => {
    const host = withTwoDomainModelingAmendments();

    await host.startAgent(String(fx.skillPromptUpstream[0]?.content));
    const [reminder] = await host.startAgent(String(fx.skillPromptUpstream[0]?.content));
    await host.commitMessage(reminder!);
    await host.emit("message_end");

    expect(host.noticeEvents).toEqual([{ message: expect.stringContaining("`domain-modeling`"), type: "info" }]);
  });

  it("delivers on both routes without a notice in a session without UI", async () => {
    const readHost = withTwoTddAmendments({ hasUI: false });
    expect((await readSkill(readHost, "skill://tdd")).additionalContext).toContain(SEAMS);
    expect(readHost.notices).toEqual([]);

    const promptHost = withTwoDomainModelingAmendments({ hasUI: false });
    const promptReminders = await promptHost.startAgent(String(fx.skillPromptUpstream[0]?.content));
    expect(promptReminders).toHaveLength(1);
    await promptHost.commitMessage(promptReminders[0]!);
    expect(promptHost.notices).toEqual([]);
  });

  it("keeps the delivery and logs the error when the notice fails", async () => {
    const host = withTwoTddAmendments();
    vi.spyOn(host.notices, "push").mockImplementation(() => { throw new Error("notify failed"); });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await readSkill(host, "skill://tdd");

    expect(result).toMatchObject({ isError: false });
    expect(result.additionalContext).toContain(SEAMS);
    expect(deliveries(host)).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("notifying on-read amendment delivery failed"), expect.anything());
    logged.mockRestore();
  });
});

/**
 * Rules the writer produces, checked by OMP's own TTSR engine: `omp ttsr test`
 * with the rule in isolation. Skipped where `omp` is not installed.
 */
describe.skipIf(!ompAvailable)("amendment rules under OMP's TTSR engine", () => {
  /** Whether the rule fires on `snippet`: the model's text, or a tool call's JSON arguments. */
  function fires(rule: string, snippet: string, tool?: string): boolean {
    const source = tool ? ["--source", "tool", "--tool", tool] : ["--source", "text"];
    const run = spawnSync("omp", ["ttsr", "test", "--json", "--rule", rule, ...source, snippet], {
      env: ompEnv,
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(`omp ttsr test failed: ${run.stderr}`);
    return JSON.parse(run.stdout).triggered.length > 0;
  }

  it("fires a pattern amendment on a sample of the mistake", async () => {
    const host = loadExtension();
    await amend(host, "tdd", focusedTestsRule);
    const rule = join(host.rulesDir, "tdd-no-focused-tests.md");

    expect(fires(rule, 'Focus it: it.only("adds", () => {})')).toBe(true);
    expect(fires(rule, 'it("adds", () => {})')).toBe(false);
  }, 30_000);

  it("fires a tool-scoped pattern amendment on that tool's call and not on the model's text", async () => {
    const host = loadExtension();
    await amend(host, "tdd", bailRule);
    const rule = join(host.rulesDir, "tdd-no-bail.md");

    expect(fires(rule, JSON.stringify({ command: "bun run test --bail" }), "bash")).toBe(true);
    expect(fires(rule, JSON.stringify({ command: "bun run test" }), "bash")).toBe(false);
    expect(fires(rule, "Run it with bun run test --bail to stop early.")).toBe(false);
  }, 30_000);
});

/** The text of the first user message in a fixture group. */
function textOf(entries: SessionEntry[]): string {
  const content = entries[0]?.message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => block.text ?? "").join("");
}

describe("evidence-gated instructions", () => {
  const fragments = parseFragments(readFileSync(INSTRUCTIONS_PATH, "utf8"));
  /** A correction with `tdd` (upstream) loaded: no gate's evidence. */
  const base = [...fx.plainUserMessage, ...fx.steeringUserMessage, ...fx.skillUrlRead];
  type Evidence = { branch: SessionEntry[]; note?: string };
  type Setup = (host: ReturnType<typeof loadExtension>) => Evidence | Promise<Evidence>;
  /** An on-read amendment of `skill` with no fix of the ledger in force under it. */
  const amendmentWithoutFix = (host: ReturnType<typeof loadExtension>, skill: string) => {
    splitAmendment(host, skill, `${skill}-amendment`);
    rmSync(host.ledgerFile);
  };
  const appliedManagedEdit = (host: ReturnType<typeof loadExtension>) =>
    host.callTool("observer_resolve", { outcomes: [outcome("implement-spec", "managed", "Run the typecheck before each commit.", "applied")] });

  const table: Array<[string, Gate[], Setup, Setup, { judge?: boolean }?]> = [
    ["stale: an amendment whose skill changed since its pin", ["stale"],
      (host) => { splitAmendment(host, "domain-modeling", "dm-terms"); changeSkillFile(host, "domain-modeling"); return { branch: base }; },
      (host) => { splitAmendment(host, "domain-modeling", "dm-terms"); return { branch: base }; }],
    ["compaction: a loaded upstream skill with an on-read amendment", ["compaction"],
      (host) => { amendmentWithoutFix(host, "tdd"); return { branch: base }; },
      (host) => { amendmentWithoutFix(host, "grill-with-docs"); return { branch: base }; }],
    ["project: a workflow outline", ["project"], () => ({ branch: [...base, ...fx.skillLessTurn] }), () => ({ branch: base })],
    ["project: a tool error", ["project"], () => ({ branch: [...base, ...fx.skillTurnToolError] }), () => ({ branch: base })],
    ["withdrawal: a fix in force for a loaded skill", ["withdrawal"],
      async (host) => { await appliedManagedEdit(host); return { branch: [...base, ...fx.skillPromptManaged] }; },
      () => ({ branch: [...base, ...fx.skillPromptManaged] })],
    ["note and withdrawal: a User note", ["note", "withdrawal"], () => ({ branch: base, note: "tdd should name the seam first" }), () => ({ branch: base })],
    ["ranking: an explicit, available judge role", ["ranking"], () => ({ branch: base }), () => ({ branch: base }), { judge: false }],
    ["observations: a pending observation", ["observations"],
      async (host) => { await host.callTool("observe", { text: "The tdd skill names no seam for HTTP clients." }); return { branch: base }; },
      () => ({ branch: base })],
    ["catalog: a skill catalog observation", ["catalog"],
      async (host) => { host.setBranch(base); await observeCatalog(host, [["seam-finder", "Finds test seams."]]); return { branch: host.getBranch() }; },
      () => ({ branch: base })],
  ];

  /** The fragments of `observer.md` the payload `/observe` sends with `setup`'s evidence holds. */
  async function present(setup: Setup, options?: { judge?: boolean }) {
    const host = loadExtension(options);
    const { branch, note = "" } = await setup(host);
    host.setBranch(branch);
    await host.runCommand("observe", note);
    const content = String(host.sent[0]?.message.content);
    return new Set(fragments.filter(({ text }) => content.includes(text)));
  }

  it.each(table)("%s turns on exactly its gated fragments", async (_label, gates, on, off, offOptions) => {
    // Each host points HOME and the agent dir at its own temp home, so the two assemblies run one after the other.
    const withEvidence = await present(on);
    const without = await present(off, offOptions);
    const gated = fragments.filter(({ gate }) => gate !== undefined && gates.includes(gate));
    expect(gated.length).toBeGreaterThan(0);
    for (const assembly of [withEvidence, without]) {
      expect(fragments.filter(({ gate }) => gate === undefined).every((fragment) => assembly.has(fragment))).toBe(true);
      expect([...assembly].filter(({ gate }) => gate === "tool-result")).toEqual([]);
    }
    expect([...withEvidence].filter((fragment) => !without.has(fragment))).toEqual(gated);
    expect([...without].filter((fragment) => !withEvidence.has(fragment))).toEqual([]);
  });

  it("notifies the pass start with the payload estimate of each non-empty section", async () => {
    const host = loadExtension();
    host.setBranch(base);
    await host.runCommand("observe");
    const content = String(host.sent[0]?.message.content);
    const notice = host.notices.at(-1) ?? "";
    const [, total = "", list = ""] = /^Observation pass started: 1 signal\(s\), 1 loaded skill\(s\), 0 stale amendment\(s\), 0 observation\(s\); payload ≈ (\d+) tokens \((.*); chars\/4 estimate\)\.$/.exec(notice) ?? [];
    const sections = list.split(", ").map((entry) => entry.split(" "));
    expect(sections.map(([name]) => name)).toEqual(["instructions", "digest", "ledger", "rules-in-force"]);
    expect(sections.reduce((sum, [, tokens]) => sum + Number(tokens), 0)).toBe(Number(total));
    expect(Math.abs(Number(total) - content.length / 4)).toBeLessThanOrEqual(sections.length);
  });
});

describe("error-path guidance in tool results", () => {
  const CONDITIONS: readonly ToolResultCondition[] = ["changed-target", "ledger-append-failed", "cleanup-failed", "custom-input", "approval-note"];
  /** Each `## What to do now` section of `text`, as the conditions whose guidance paragraphs it holds, in order; any other paragraph stays text. */
  const whatToDoNow = (text: string) => text.split("\n## What to do now\n\n").slice(1)
    .map((section) => section.split("\n\n").map((paragraph) => CONDITIONS.find((condition) => toolResultGuidance(condition) === paragraph) ?? paragraph));

  it.each<[string, number, (host: ReturnType<typeof loadExtension>) => Promise<Record<string, unknown>>]>([
    ["two on-read appends", 2, async (host) => {
      await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
      const outcomes = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }, { gist: "Test one behaviour per test.", section: ONE_BEHAVIOUR }]);
      appendFileSync(join(host.amendmentsDir, "tdd-amendment.md"), "\n## Mine\n\nThe user's own words.\n");
      return { outcomes };
    }],
    ["a stale Delete, checked again as it is carried out,", 1, async (host) => {
      splitAmendment(host, "tdd", "tdd-afk-seams");
      changeSkillFile(host, "tdd");
      const approved = await approveAll(host, { stale: [{ rule: "tdd-afk-seams", select: "Delete" }] });
      appendFileSync(join(host.amendmentsDir, "tdd-afk-seams.md"), "\nThe user's unrelated line.\n");
      return approved;
    }],
  ])("ends a resolve whose %s hit a changed target with the changed-target guidance once", async (_label, refused, changed) => {
    const host = loadExtension();
    const result = await host.callTool("observer_resolve", await changed(host));
    expect(failures(result)).toEqual(Array.from({ length: refused }, () => expect.stringContaining("changed since Prepare")));
    expect(whatToDoNow(resultText(result))).toEqual([["changed-target"]]);
  });

  it("adds no guidance to a clean resolve, nor to a refusal whose target did not change", async () => {
    const host = loadExtension();
    const clean = await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
    const declined = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }], () => "Decline");
    const refused = await resolve(host, declined);
    expect(failures(refused)).toEqual([expect.stringContaining("selected `Decline`")]);
    expect([whatToDoNow(resultText(clean)), whatToDoNow(resultText(refused))]).toEqual([[], []]);
  });

  it.each<[string, string[], ToolResultCondition[][], boolean?, string?]>([
    ["custom input", ["Other: only for unit tests"], [["custom-input"]]],
    ["custom input beside a plain Apply", ["Apply", "Other: only for unit tests"], [["custom-input"]]],
    ["custom input beside an Apply with a note", ["Apply", "Other: only for unit tests"], [["custom-input", "approval-note"]], true, "Shorter."],
    ["a plain Apply", ["Apply"], []],
    ["an Apply with a note", ["Apply"], [["approval-note"]], true, "Shorter."],
    ["a Later with a note", ["Later"], [["approval-note"]], true, "After the release."],
    ["an Apply with a blank note", ["Apply"], [], true, "  "],
    ["Later and no option", ["Later", ""], []],
    ["custom input, outside a pass", ["Other: only for unit tests"], [], false],
    ["an Apply with a note, outside a pass", ["Apply"], [], false, "Shorter."],
  ])("gives an ask result answered with %s the custom-input and approval-note guidance only during a pass, for custom input and for a note", async (_label, answers, expected, inPass = true, note) => {
    const host = loadExtension();
    if (inPass) startPass(host);
    const details: AskDetails = { answers: answers.map((answer, i) => ({ name: `proposal:${i}`, question: "Apply this change?", answer })),
      ...(note && { notes: [{ name: "proposal:0", question: "Apply this change?", option: answers[0], value: `proposal:0=${answers[0]}`, text: note }] }) };
    const result = await host.toolResult({ toolName: "ask", toolCallId: "ask-answered", content: [{ type: "text", text: "User answers" }], details, isError: false });
    expect(result.content[0]).toEqual({ type: "text", text: "User answers" });
    expect(whatToDoNow(result.content.map((block) => block.text).join("\n"))).toEqual(expected);
  });
});

describe("re-offer conditions on Later entries", () => {
  const reoffer = "a second session where the agent runs the whole suite again, any day now; `tdd` is still installed";
  const projectLater = (root: string) => ({
    kind: "project", target: { scope: "project", root, path: "package.json", mechanism: "Wire the existing typecheck." },
    gist: "Wire the existing typecheck.", outcome: "later",
  });
  function projectHost() {
    const host = loadExtension();
    const root = mkdtempSync(join(host.skillHome.home, "reoffer-project-"));
    host.setCwd(root);
    return { host, root };
  }

  it("records `reoffer` on a skill or project Later, and the next pass shows it under Later", async () => {
    const { host, root } = projectHost();
    const result = await resolve(host, [
      { ...outcome("tdd", "upstream", "Run the one failing test first.", "later"), reoffer },
      { ...projectLater(root), reoffer },
      outcome("grill-with-docs", "upstream", "Ask one question at a time.", "later"),
    ]);
    expect(failures(result)).toEqual([]);
    const byGist = new Map(ledgerRecords(host.ledgerFile).map((record) => [record.gist, record]));
    expect(byGist.get("Run the one failing test first.")).toMatchObject({ outcome: "later", reoffer });
    expect(byGist.get("Wire the existing typecheck.")).toMatchObject({ kind: "project", outcome: "later", reoffer });
    expect(byGist.get("Ask one question at a time.")).not.toHaveProperty("reoffer");

    await host.runCommand("observe", "Review the deferred proposals");
    const message = String(host.sent[0]?.message.content);
    expect(message).toContain(`: Run the one failing test first. Re-offer when: ${reoffer}\n`);
    expect(message).toContain(`: Wire the existing typecheck. Re-offer when: ${reoffer}\n`);
    expect(message).toMatch(/: Ask one question at a time\.$/m);
  });

  it("records an Applied or Declined answer without its `reoffer`", async () => {
    const host = loadExtension();
    const result = await resolve(host, [
      { ...outcome("implement-spec", "managed", "Run the typecheck before each commit.", "applied"), reoffer },
      { ...outcome("grill-with-docs", "upstream", "Ask one question at a time.", "declined"), reoffer },
    ]);
    expect(failures(result)).toEqual([]);
    const records = ledgerRecords(host.ledgerFile);
    expect(records.map((record) => record.outcome)).toEqual(["applied", "declined"]);
    for (const record of records) expect(record).not.toHaveProperty("reoffer");
  });

  it.each(["", " \n\t"])("refuses a Later whose `reoffer` is blank (%j), recording nothing", async (blank) => {
    const { host, root } = projectHost();
    const result = await resolve(host, [
      { ...outcome("tdd", "upstream", "Run the one failing test first.", "later"), reoffer: blank },
      { ...projectLater(root), reoffer: blank },
    ]);
    expect(result.isError).toBe(true);
    expect(failures(result)).toEqual([expect.stringContaining("`reoffer` is blank"), expect.stringContaining("`reoffer` is blank")]);
    expect(result.details).toMatchObject({ records: [] });
  });
});

describe("remedy outcomes in the observation payload", () => {
  /** A host where `tdd` is read and the ledger holds an applied fix for each of `skills` (with its on-read amendment) and, with `project`, an applied project-environment fix; returns the fixes' fingerprints. */
  async function hostWithFixes(skills: readonly string[], project: boolean) {
    const host = loadExtension();
    for (const skill of skills) splitAmendment(host, skill, `${skill}-fix`);
    const fingerprints = skills.map((skill) => proposalFingerprint(skill, `Gist of ${skill}-fix.`));
    if (project) {
      const target = canonicalProjectTarget(host.skillHome.roots.cwd, { scope: "project", root: host.skillHome.roots.cwd, path: "package.json", mechanism: "Wire the typecheck." });
      const fingerprint = projectFingerprint(target);
      appendFileSync(host.ledgerFile, `${JSON.stringify({ fingerprint, kind: "project", target, gist: "Wire the typecheck.", outcome: "applied", timestamp: new Date().toISOString(), sessionId: "fixture-session" })}\n`);
      fingerprints.push(fingerprint);
    }
    host.setBranch(fx.plainUserMessage);
    await readSkill(host, "skill://tdd");
    return { host, fingerprints };
  }

  /** The list under the payload's Remedy outcomes heading, one line per item; `undefined` without the heading. */
  async function payloadOutcomes(host: ReturnType<typeof loadExtension>) {
    await host.runCommand("observe");
    const blocks = String(host.sent[0]?.message.content).split("\n\n");
    const heading = blocks.indexOf("### Remedy outcomes");
    return heading < 0 ? undefined : blocks[heading + 1]!.split("\n");
  }

  it("lists the fixes for loaded skills and the project, and counts the rest as not loaded in this session", async () => {
    const { host, fingerprints: [loaded, unloaded, project] } = await hostWithFixes(["tdd", "domain-modeling"], true);

    const lines = await payloadOutcomes(host);

    expect(lines).toEqual([
      expect.stringMatching(new RegExp(`^- ${loaded}: delivered\\b`)),
      expect.stringMatching(new RegExp(`^- ${project} \\(package\\.json\\): inconclusive\\b`)),
      expect.stringMatching(/\b1\b.*not loaded in this session/),
    ]);
    expect(lines!.join("\n")).not.toContain(unloaded!);
  });

  it("keeps the heading with only the count when no fix's skill was loaded", async () => {
    const { host } = await hostWithFixes(["domain-modeling", "grill-with-docs"], false);
    expect(await payloadOutcomes(host)).toEqual([expect.stringMatching(/\b2\b.*not loaded in this session/)]);
  });

  it.each([
    ["loaded, unloaded and project fixes", ["tdd", "domain-modeling"], true],
    ["only unloaded-skill fixes", ["domain-modeling", "grill-with-docs"], false],
  ] as const)("leaves /observe-report listing every outcome for %s", async (_label, skills, project) => {
    const { host, fingerprints } = await hostWithFixes(skills, project);
    await host.runCommand("observe-report");
    const listed = host.notices.at(-1)!.split("\n").filter((line) => /^- [0-9a-f]+: /.test(line));
    expect(listed.map((line) => line.split(":")[0]!.slice(2)).sort()).toEqual([...fingerprints].sort());
  });
});

describe("/observe-report", () => {
  const TEST_RUN = { type: "message", id: "call-run-tests", message: { role: "assistant", content: [{ type: "toolCall", id: "run-tests", name: "bash", arguments: { command: "bun test" } }] } } as const;
  const TEST_RESULT = { type: "message", id: "result-run-tests", message: { role: "toolResult", toolCallId: "run-tests", toolName: "bash", content: [{ type: "text", text: "12 passed" }] } } as const;

  /**
   * A branch with every signal kind, `tdd` read with two delivered amendments
   * (one of whose fixes then ran clean), a skill read that failed, a managed
   * skill created, and a stale amendment of an unloaded skill; one Later.
   */
  async function richHost() {
    const host = loadExtension();
    splitAmendment(host, "tdd", "tdd-afk-seams", { evidence: [{ quote: 'Tool error in `bash` "bun test": "1 failed"', count: 1 }] });
    splitAmendment(host, "tdd", "tdd-red");
    splitAmendment(host, "domain-modeling", "dm-terms");
    changeSkillFile(host, "domain-modeling");
    appendFileSync(host.ledgerFile, `${JSON.stringify({ fingerprint: "later-fix", skill: "tdd", kind: "upstream", gist: "Later gist.", outcome: "later", timestamp: new Date().toISOString(), sessionId: "fixture-session" })}\n`);
    host.setBranch(fx.plainUserMessage);
    await readSkill(host, "skill://tdd");
    await readSkill(host, "skill://missing-skill", { isError: true });
    host.setBranch([...host.getBranch(), TEST_RUN, TEST_RESULT, ...fx.steeringUserMessage, ...fx.ruleViolationInterrupt, ...fx.askSingleCustomInput,
      ...fx.askSingleOffRecommended, ...fx.skillTurnToolError, ...fx.skillLessTurn, ...fx.managedSkillCreated] as SessionEntry[]);
    // The tdd read's delivery notice belongs to the setup, not to the report.
    host.notices.length = 0;
    host.noticeEvents.length = 0;
    return host;
  }

  it("prints the branch's evidence in one notice and starts, activates and writes nothing", async () => {
    const host = await richHost();
    const branch = structuredClone(host.getBranch());
    const tools = [...host.activeTools()];
    const ledger = readFileSync(host.ledgerFile, "utf8");

    await host.runCommand("observe-report");

    expect(host.sent).toEqual([]);
    expect(host.getBranch()).toEqual(branch);
    expect(host.activeTools()).toEqual(tools);
    expect(readFileSync(host.ledgerFile, "utf8")).toBe(ledger);
    expect(host.noticeEvents).toEqual([{ message: expect.any(String), type: "info" }]);
    const report = host.notices[0]!;
    const fingerprint = (skill: string, rule: string) => proposalFingerprint(skill, `Gist of ${rule}.`);
    expect(report.split("\n")).toEqual([
      "Evidence report (no observation pass started)",
      "Signals: steering 1, rule-violation 1, ask-custom-input 1, ask-off-recommendation 1, tool-error 3, workflow 1; 0 older dropped by the digest cap",
      "Skills loaded:",
      "- tdd: upstream; read; amendments delivered: tdd-afk-seams, tdd-red",
      "- impeccable: unknown; slash-command",
      "Attempted, not loaded: missing-skill",
      "Managed skills created: nested-worktree",
      "Remedy outcomes:",
      `- ${fingerprint("tdd", "tdd-red")}: delivered (tdd)`,
      `- ${fingerprint("tdd", "tdd-afk-seams")}: exercised-clean (tdd)`,
      `- ${fingerprint("domain-modeling", "dm-terms")}: inconclusive (domain-modeling)`,
      "Stale amendments: dm-terms (domain-modeling)",
      expect.stringMatching(/^Payload estimate for \/observe now: ≈ \d+ tokens \(instructions \d+, digest \d+, .*stale \d+; chars\/4 estimate\)$/),
      "Later proposals: 1",
      "Pending observations: 0",
      "Skill catalog observations: none on this branch (unknown)",
    ]);
  });

  it("names no tool arguments, error text, paths or session IDs", async () => {
    const host = await richHost();
    await host.runCommand("observe-report");
    const report = host.notices.join("\n");
    const digest = buildDigest(host.getBranch(), { provenance: createProvenanceResolver(host.skillHome.roots) });
    const args = (digest.toolExercises ?? []).map((exercise) => exercise.args).filter(Boolean);
    const errors = digest.signals.flatMap((signal) => (signal.kind === "tool-error" ? [signal.error] : []));
    expect(args).toContain("bun test");
    expect(errors).toHaveLength(3);
    for (const text of [...args, ...errors, host.skillHome.home, "fixture-session"]) expect(report).not.toContain(text);
  });

  it("counts the older signals the digest cap drops, as the pass's digest does", async () => {
    const host = loadExtension();
    const long = (index: number) => `Correction ${index}: ${"keep the seam named. ".repeat(95)}`;
    host.setBranch(Array.from({ length: 30 }, (_, index): SessionEntry => ({
      type: "message", id: `steer-${index}`, message: { role: "user", steering: true, content: [{ type: "text", text: long(index) }] },
    })));
    await host.runCommand("observe-report");
    await host.runCommand("observe");
    const [, dropped = ""] = /(\d+) older signals were dropped/.exec(String(host.sent[0]?.message.content)) ?? [];
    expect(Number(dropped)).toBeGreaterThan(0);
    expect(host.notices[0]).toContain(`Signals: steering 30, rule-violation 0, ask-custom-input 0, ask-off-recommendation 0, tool-error 0, workflow 0; ${dropped} older dropped by the digest cap`);
  });

  it("says the branch has no skill evidence, without an estimate, and follows a branch switch", async () => {
    const host = await richHost();
    rmSync(host.ledgerFile);
    rmSync(host.amendmentsDir, { recursive: true });
    await host.runCommand("observe-report");
    host.setBranch(fx.plainUserMessage);
    await host.emit("session_switch");
    await host.runCommand("observe-report");
    expect(host.notices[0]).toContain("Signals: steering 1");
    expect(host.notices[1]).toBe("No skill evidence on this branch.");
    expect(host.sent).toEqual([]);
  });

  it.each([
    ["without UI", { hasUI: false }],
    ["in a subagent session", { agentKind: "sub" }],
  ] as const)("prints nothing %s", async (_label, options) => {
    const host = loadExtension(options);
    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage]);
    await host.runCommand("observe-report");
    expect(host.notices).toEqual([]);
    expect(host.sent).toEqual([]);
  });
});

describe("observations", () => {
  const OBSERVATION = "Recalled memories repeat the commit-style fact in twelve entries; merge them into one.";
  const today = () => new Date().toISOString().slice(0, 10);

  /** The list lines of the Observations section of the last payload, once `/observe` has sent exactly `payloads` of them. */
  const observationLines = (host: ReturnType<typeof loadExtension>, payloads: number) => {
    expect(host.sent).toHaveLength(payloads);
    const content = String(host.sent.at(-1)?.message.content ?? "");
    const section = /\n## Observations\n\n([\s\S]*?)(?=\n## |$)/.exec(content)?.[1] ?? "";
    return section.split("\n").filter((line) => line.startsWith("- "));
  };

  /** Records `text` from `cwd` in one session, then runs `/observe` from `observeCwd` in a second session of the same agent dir. */
  async function recordThenObserve(text: string, cwd?: string, observeCwd?: string) {
    const first = loadExtension();
    if (cwd) first.setCwd(cwd);
    const result = await first.callTool("observe", { text });
    expect(result.isError).toBeFalsy();
    const second = loadExtension({ skillHome: first.skillHome });
    if (observeCwd) second.setCwd(observeCwd);
    second.setBranch(fx.plainUserMessage);
    await second.runCommand("observe");
    return second;
  }

  const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], { cwd, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  };

  it("lists an observation recorded in one session in the next session's /observe as one line, marked as the agent's unverified remark", async () => {
    const host = await recordThenObserve(OBSERVATION);
    expect(observationLines(host, 1)).toEqual([`- ${OBSERVATION} (count 1, last recorded ${today()})`]);
    const content = String(host.sent[0]?.message.content);
    const section = content.slice(content.indexOf("\n## Observations"));
    expect(section).toMatch(/unverified/);
    expect(section).toMatch(/another worktree/);
  });

  it("starts a pass on a pending observation alone, counting it in the start notice and naming its section in the estimate", async () => {
    const host = await recordThenObserve(OBSERVATION);
    expect(host.sent).toHaveLength(1);
    expect(host.notices.at(-1)).toMatch(/^Observation pass started: 0 signal\(s\), 0 loaded skill\(s\), 0 stale amendment\(s\), 1 observation\(s\); payload ≈ \d+ tokens \(instructions \d+, digest \d+, observations \d+, /);
  });

  it("says there is nothing to observe without speaking of skill signals only when no observation is pending", async () => {
    const host = loadExtension();
    host.setBranch(fx.plainUserMessage);
    await host.runCommand("observe");
    expect(host.sent).toEqual([]);
    expect(host.notices).toEqual([expect.stringMatching(/observations/)]);
  });

  it("shares observations between worktrees of one repository, its subfolders and a bare repository's worktrees", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-observer-git-")));
    const main = join(root, "main");
    mkdirSync(join(main, "sub"), { recursive: true });
    git(main, "init", "-q", "-b", "main");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", join(root, "linked"));
    expect(observationLines(await recordThenObserve(OBSERVATION, join(main, "sub"), join(root, "linked")), 1)).toHaveLength(1);

    git(root, "init", "-q", "--bare", "bare.git");
    git(join(root, "bare.git"), "worktree", "add", "-q", "--orphan", "-b", "main", join(root, "bare-linked"));
    expect(observationLines(await recordThenObserve(OBSERVATION, join(root, "bare-linked"), join(root, "bare.git")), 1)).toHaveLength(1);
  });

  it("identifies a checkout holding tracked HEAD and objects paths by its git directory, shared with its linked worktree", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-observer-git-")));
    const main = join(root, "main");
    mkdirSync(join(main, "objects"), { recursive: true });
    writeFileSync(join(main, "HEAD"), "not a ref\n");
    writeFileSync(join(main, "objects", "keep"), "");
    git(main, "init", "-q", "-b", "main");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");
    git(main, "worktree", "add", "-q", join(root, "linked"));
    expect(observationLines(await recordThenObserve(OBSERVATION, main, join(root, "linked")), 1)).toHaveLength(1);
  });

  it("keeps a text recorded again while /observe assembles its payload pending for the next pass", async () => {
    const first = loadExtension();
    expect((await first.callTool("observe", { text: OBSERVATION })).isError).toBeFalsy();
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    const pass = second.runCommand("observe");
    expect((await first.callTool("observe", { text: OBSERVATION })).isError).toBeFalsy();
    await pass;
    expect(observationLines(second, 1)).toEqual([`- ${OBSERVATION} (count 1, last recorded ${today()})`]);
    await second.runCommand("observe");
    expect(observationLines(second, 2)).toEqual([`- ${OBSERVATION} (count 2, last recorded ${today()})`]);
  });

  it("keeps a text recorded again pending when the shown row for its earlier recording lands after it", async () => {
    const host = loadExtension();
    await host.callTool("observe", { text: OBSERVATION });
    const [first] = readFileSync(host.observationsFile, "utf8").trim().split("\n");
    await host.callTool("observe", { text: OBSERVATION });
    appendFileSync(host.observationsFile, `${JSON.stringify({ ...JSON.parse(first!), shownAt: new Date().toISOString() })}\n`);
    host.setBranch(fx.plainUserMessage);
    await host.runCommand("observe");
    expect(observationLines(host, 1)).toEqual([`- ${OBSERVATION} (count 2, last recorded ${today()})`]);
  });

  it("keeps both recordings shown when their shown rows land in reverse order", async () => {
    const host = loadExtension();
    await host.callTool("observe", { text: OBSERVATION });
    await host.callTool("observe", { text: OBSERVATION });
    const recordings = readFileSync(host.observationsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const shownAt = new Date().toISOString();
    for (const row of [...recordings].reverse()) appendFileSync(host.observationsFile, `${JSON.stringify({ ...row, shownAt })}\n`);
    host.setBranch(fx.plainUserMessage);
    await host.runCommand("observe");
    expect(host.sent).toEqual([]);
  });

  it("keeps a text recorded again in the same millisecond as its shown recording pending", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const host = loadExtension();
    host.setBranch(fx.plainUserMessage);
    await host.callTool("observe", { text: OBSERVATION });
    await host.runCommand("observe");
    await host.callTool("observe", { text: OBSERVATION });
    await host.runCommand("observe");
    expect(observationLines(host, 2)).toEqual([`- ${OBSERVATION} (count 1, last recorded ${new Date(T0).toISOString().slice(0, 10)})`]);
  });

  it("keeps another project's observations out, and outside git identifies a project by the working directory's real path", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-observer-plain-")));
    for (const dir of ["one", "two"]) mkdirSync(join(root, dir));
    symlinkSync(join(root, "one"), join(root, "one-link"));
    expect(observationLines(await recordThenObserve(OBSERVATION, join(root, "one-link"), join(root, "one")), 1)).toHaveLength(1);
    const other = await recordThenObserve(OBSERVATION, join(root, "one"), join(root, "two"));
    expect(other.sent).toEqual([]);
  });

  it("registers observe active from load, top-level, without approval prompts, with the spec's agent-facing text", () => {
    const host = loadExtension();
    const tool = host.tools.observe!;
    expect(host.activeTools()).toContain("observe");
    expect(tool).toMatchObject({ approval: "read", loadMode: "essential" });
    expect(tool.defaultInactive).toBeFalsy();
    expect(tool.description).toBe(
      "Record an observation for the user's next `/observe` pass: something a skill, a rule or the project setup got wrong, or that cost you a detour. It fixes nothing now; record it and continue.",
    );
    expect(((tool.parameters as FakeSchema).shape?.text as FakeSchema).description).toBe(
      "One problem, up to 500 characters: what happened, where, and the fix you want.",
    );
  });

  const resultText = (result: ToolResult<unknown>) => result.content.map(({ text }) => text).join("\n");
  const DAY = 86_400_000;
  const T0 = Date.parse("2026-10-01T12:00:00Z");

  it("marks observations shown in /observe, so a second /observe no longer lists them, and never in /observe-report", async () => {
    const first = loadExtension();
    await first.callTool("observe", { text: OBSERVATION });
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    await second.runCommand("observe-report");
    await second.runCommand("observe");
    expect(observationLines(second, 1)).toHaveLength(1);
    await second.runCommand("observe");
    expect(second.sent).toHaveLength(1);
    expect(second.notices.at(-1)).toMatch(/^Nothing to observe/);
  });

  it("gives an error notice and continues the pass when marking observations shown fails", async () => {
    const first = loadExtension();
    await first.callTool("observe", { text: OBSERVATION });
    chmodSync(first.observationsFile, 0o444);
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    await second.runCommand("observe");
    expect(observationLines(second, 1)).toHaveLength(1);
    expect(second.activeTools()).toContain("observer_resolve");
    expect(second.noticeEvents).toEqual([
      { message: expect.stringMatching(/^Observations not marked as shown: .+; the next \/observe lists them again\.$/), type: "error" },
      { message: expect.stringMatching(/^Observation pass started: /), type: "info" },
    ]);
  });

  it.each([[31, 0], [29, 1]])("lists an observation last recorded %i days ago %i time(s)", async (days, listed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const first = loadExtension();
    await first.callTool("observe", { text: OBSERVATION });
    vi.setSystemTime(T0 + days * DAY);
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    await second.runCommand("observe");
    expect(observationLines(second, listed)).toHaveLength(listed);
  });

  it("counts a text recorded again in other case, punctuation or spacing as one, and starts again at count 1 once shown or expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const host = loadExtension();
    host.setBranch(fx.plainUserMessage);
    await host.callTool("observe", { text: "Bun test reads the real .env file!" });
    vi.setSystemTime(T0 + DAY);
    await host.callTool("observe", { text: "bun TEST reads the real env-file" });
    await host.runCommand("observe");
    expect(observationLines(host, 1)).toEqual(["- bun TEST reads the real env-file (count 2, last recorded 2026-10-02)"]);

    // Recorded while that pass runs: it waits for the next one.
    await host.callTool("observe", { text: "Bun test reads the real .env file!" });
    await host.runCommand("observe");
    expect(observationLines(host, 2)).toEqual(["- Bun test reads the real .env file! (count 1, last recorded 2026-10-02)"]);

    await host.callTool("observe", { text: "Bun test reads the real .env file!" });
    vi.setSystemTime(T0 + 40 * DAY);
    await host.callTool("observe", { text: "Bun test reads the real .env file!" });
    await host.runCommand("observe");
    expect(observationLines(host, 3)).toEqual(["- Bun test reads the real .env file! (count 1, last recorded 2026-11-10)"]);
  });

  it.each([
    ["empty", " \n\t ", /the observation is empty/],
    ["without a letter or digit", "!!! ??? …", /the observation has no letter or digit/],
    ["over 500 characters", `${"a".repeat(501)}  `, /the observation is 501 characters; the limit is 500/],
  ])("refuses %s text and records nothing", async (_label, text, rule) => {
    const host = loadExtension();
    const result = await host.callTool("observe", { text });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/^Nothing was recorded: /);
    expect(resultText(result)).toMatch(rule);
    expect(existsSync(host.observationsFile)).toBe(false);
  });

  it("accepts text of exactly 500 characters after trimming", async () => {
    const host = loadExtension();
    expect((await host.callTool("observe", { text: ` ${"a".repeat(500)} ` })).isError).toBeFalsy();
  });

  it("refuses a subagent's call and records nothing", async () => {
    const host = loadExtension({ agentKind: "sub" });
    const result = await host.callTool("observe", { text: OBSERVATION });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("Nothing was recorded: only the main agent records observations.");
    expect(existsSync(host.observationsFile)).toBe(false);
  });

  it.each([
    ["a context without agent information", { agentKind: "unknown" }],
    ["a main agent without UI", { hasUI: false }],
  ] as const)("records from %s", async (_label, options) => {
    const first = loadExtension(options);
    expect((await first.callTool("observe", { text: OBSERVATION })).isError).toBeFalsy();
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    await second.runCommand("observe");
    expect(observationLines(second, 1)).toHaveLength(1);
  });

  it("returns a tool error saying nothing was recorded when the append fails", async () => {
    const host = loadExtension();
    await host.callTool("observe", { text: OBSERVATION });
    chmodSync(host.observationsFile, 0o444);
    const before = readFileSync(host.observationsFile, "utf8");
    const result = await host.callTool("observe", { text: "Another remark." });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/^Nothing was recorded: .+/);
    expect(readFileSync(host.observationsFile, "utf8")).toBe(before);
  });

  it("gives a pass started on observations alone their instructions, without the project section or the retro reference", async () => {
    const first = loadExtension();
    mkdirSync(join(first.skillHome.roots.skillsDir, "retro"), { recursive: true });
    writeFileSync(join(first.skillHome.roots.skillsDir, "retro", "SKILL.md"), "---\nname: retro\ndescription: Run a retrospective.\n---\n\nRetro body.\n");
    await first.callTool("observe", { text: OBSERVATION });
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    await second.runCommand("observe");
    const content = String(second.sent[0]?.message.content);
    expect(content).toContain("Each entry under **Observations**");
    expect(content).toContain("may belong to another worktree of the repository");
    expect(content).not.toContain("## Project scope");
    expect(content).not.toContain("## Retrospective reference");
    expect(content).not.toContain("Retro body.");
    expect(second.noticeEvents.filter(({ type }) => type !== "info")).toEqual([]);
  });

  it("hints at pending observations with /observe on a branch without corrections or workflows, and refreshes once /observe marks them shown", async () => {
    const first = loadExtension();
    first.setBranch(fx.plainUserMessage);
    await first.callTool("observe", { text: OBSERVATION });
    await first.callTool("observe", { text: "The pre-commit hook runs the native suite." });
    await first.endTurn();
    expect(first.statusTexts()).toEqual(["2 pending observations · /observe"]);
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    await second.emit("session_start");
    expect(second.statusTexts()).toEqual(["2 pending observations · /observe"]);
    await second.runCommand("observe");
    expect(second.statusTexts()).toEqual([]);
  });

  it("keeps the correction hint ahead of pending observations", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage]);
    await host.callTool("observe", { text: OBSERVATION });
    await host.endTurn();
    expect(host.statusTexts()).toEqual(["1 skill correction · /observe"]);
  });

  it("counts pending observations in /observe-report, never their text, and marks none shown", async () => {
    const first = loadExtension();
    await first.callTool("observe", { text: OBSERVATION });
    const second = loadExtension({ skillHome: first.skillHome });
    second.setBranch(fx.plainUserMessage);
    await second.runCommand("observe-report");
    expect(second.noticeEvents).toEqual([{ message: expect.any(String), type: "info" }]);
    const report = second.notices[0]!;
    expect(report).toContain("\nPending observations: 1");
    expect(report).toMatch(/\nPayload estimate for \/observe now: ≈ \d+ tokens \(.*observations \d+/);
    expect(report).not.toContain("twelve entries");
    await second.runCommand("observe");
    expect(observationLines(second, 1)).toHaveLength(1);
  });

  it("tells the agent the observation was recorded, the project's pending count and that /observe reviews them", async () => {
    const host = loadExtension();
    await host.callTool("observe", { text: OBSERVATION });
    const result = await host.callTool("observe", { text: "The pre-commit hook runs the native suite." });
    expect(resultText(result)).toBe("Observation recorded. 2 observations are pending for this project; the user's `/observe` reviews them.");
  });
});

describe("observer_review inspect and grounded repairs", () => {
  const GUIDE = "sample-guide";
  const GUIDE_TEXT = "---\nname: sample-guide\ndescription: Fixture guide.\n---\n\n## Seams\n\nName the seam before the first test.\n";
  const guideRule: PatternRule = { name: "guide-no-todo", body: "Ask instead of leaving TODO markers.", pattern: "\\bTODO\\b",
    matches: ["Left a TODO for the naming."], spares: ["Asked about the naming instead."] };
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const guidePath = (host: ReturnType<typeof loadExtension>) => join(host.skillHome.roots.skillsDir, GUIDE, "SKILL.md");
  const guideReferences = (host: ReturnType<typeof loadExtension>) => join(referencesDir(host), GUIDE);

  function installGuide(host: ReturnType<typeof loadExtension>) {
    mkdirSync(dirname(guidePath(host)), { recursive: true });
    writeFileSync(guidePath(host), GUIDE_TEXT);
    setLockHash(host, GUIDE, "fixture-lock-hash");
  }

  async function inspect(host: ReturnType<typeof loadExtension>, params: Record<string, unknown> = {}) {
    const result = await host.callTool("observer_review", { action: "inspect", skill: GUIDE, ...params });
    return { result, id: lastCallId(host) };
  }
  type Inspection = { skill: string; kind: string; sources: Array<{ role: string; path: string; status: string; sha256: string; lines: number; sections: string[] }>; referenceInventory: Array<{ path: string }> };
  const inspectionOf = (result: ToolResult<unknown>) => (result.details as { inspection?: Inspection }).inspection;

  it("reports each current guidance source with its status and fingerprint, a stale pin still active, and leaves unrequested references uninspected", async () => {
    const host = loadExtension();
    installGuide(host);
    await addOnReadFix(host, GUIDE, "Name seams.", "## Seam names\n\nName the seam in the test title.");
    await amend(host, GUIDE, guideRule);
    changeSkillFile(host, GUIDE);
    mkdirSync(guideReferences(host), { recursive: true });
    writeFileSync(join(guideReferences(host), "requested.md"), "## Requested\n\nRequested reference text.\n");
    writeFileSync(join(guideReferences(host), "unrequested.md"), "Unrequested reference text.\n");
    const before = observerBytes(host);

    startPass(host);
    const { result } = await inspect(host, { references: ["requested.md"] });

    expect(result.isError).toBeFalsy();
    const amendment = join(host.amendmentsDir, `${GUIDE}-amendment.md`);
    const rule = join(host.rulesDir, "guide-no-todo.md");
    const requested = join(guideReferences(host), "requested.md");
    const unrequested = join(guideReferences(host), "unrequested.md");
    expect(inspectionOf(result)).toEqual({
      skill: GUIDE, kind: "upstream",
      sources: expect.arrayContaining([
        { role: "skill", path: guidePath(host), status: "active", sha256: sha256(guidePath(host)), lines: 9, sections: ["Seams"] },
        expect.objectContaining({ role: "rule", path: amendment, status: "stale", sha256: sha256(amendment), sections: ["Seam names"] }),
        expect.objectContaining({ role: "rule", path: rule, status: "stale", sha256: sha256(rule) }),
        { role: "reference", path: requested, status: "active", sha256: sha256(requested), lines: 3, sections: ["Requested"] },
      ]),
      referenceInventory: [{ path: requested }, { path: unrequested }],
    });
    expect(inspectionOf(result)?.sources).toHaveLength(4);
    const text = resultText(result);
    expect(text).toContain("8| Name the seam before the first test.");
    expect(text).toContain("Name the seam in the test title.");
    expect(text).toContain("Requested reference text.");
    expect(text).not.toContain("Unrequested reference text.");
    expect(text).not.toMatch(/disabled/i);
    expect(observerBytes(host)).toEqual(before);
  });

  it("refuses an inspection whose required source is missing, unreadable or malformed instead of returning an empty document", async () => {
    const cases: Array<[string, (host: ReturnType<typeof loadExtension>) => void, Record<string, unknown>, string]> = [
      ["an unknown skill", () => {}, { skill: "absent-guide" }, "absent-guide"],
      ["a missing requested reference", () => {}, { references: ["absent.md"] }, "absent.md"],
      ["an unreadable skill file", (host) => { rmSync(guidePath(host)); mkdirSync(guidePath(host)); }, {}, "SKILL.md"],
      ["a skill file without frontmatter", (host) => writeFileSync(guidePath(host), "## Seams\n\nNo frontmatter.\n"), {}, "frontmatter"],
      ["a malformed on-read amendment", (host) => { mkdirSync(host.amendmentsDir, { recursive: true }); writeFileSync(join(host.amendmentsDir, `${GUIDE}-amendment.md`), "not a rule\n"); }, {}, `${GUIDE}-amendment.md`],
    ];
    for (const [label, breakIt, params, named] of cases) {
      const host = loadExtension();
      installGuide(host);
      breakIt(host);
      startPass(host);
      const { result } = await inspect(host, params);
      expect(result.isError, label).toBe(true);
      expect(inspectionOf(result), label).toBeUndefined();
      expect(failures(result).join("\n"), label).toContain(named);
    }
  });

  it("refuses an inspection whose existing rules or amendments directory can't be listed, or whose associated rule is malformed, but reads none when the directories are missing", async () => {
    const missing = loadExtension();
    installGuide(missing);
    startPass(missing);
    expect(existsSync(missing.rulesDir) || existsSync(missing.amendmentsDir)).toBe(false);
    expect((await inspect(missing)).result.isError).toBeFalsy();

    for (const dir of ["rulesDir", "amendmentsDir"] as const) {
      const host = loadExtension();
      installGuide(host);
      mkdirSync(host[dir], { recursive: true });
      chmodSync(host[dir], 0o000);
      try {
        startPass(host);
        const { result } = await inspect(host);
        expect(result.isError, dir).toBe(true);
        expect(failures(result).join("\n"), dir).toContain(host[dir]);
      } finally {
        chmodSync(host[dir], 0o755);
      }
    }

    const malformed = loadExtension();
    installGuide(malformed);
    mkdirSync(malformed.rulesDir, { recursive: true });
    writeFileSync(join(malformed.rulesDir, "guide-broken.md"), `---\ngeneratedBy: skill-observer\namends: ${GUIDE}\ndescription: Never closed.\n`);
    writeFileSync(join(malformed.rulesDir, "hand-written.md"), "Someone else's notes.\n");
    startPass(malformed);
    const { result } = await inspect(malformed);
    expect(result.isError).toBe(true);
    expect(failures(result).join("\n")).toContain("guide-broken.md");
    expect(failures(result).join("\n")).not.toContain("hand-written.md");
  });

  it("carries a repair citing its inspection receipt through Prepare, Select, the Ask preview and publication, writing nothing before Apply", async () => {
    const host = loadExtension();
    installGuide(host);
    await addOnReadFix(host, GUIDE, "Name seams.", "## Seam names\n\nName the seam in the test title.");
    const before = observerBytes(host);
    const amendment = join(host.amendmentsDir, `${GUIDE}-amendment.md`);

    startPass(host);
    const { id: inspection } = await inspect(host);
    const diagnosis = {
      inspection, explanation: "The guide names seams but says nothing on fixtures; checked its Seams section and the amendment: neither covers fixtures.",
      delta: "A future agent builds one fixture per seam.",
      citations: [{ source: guidePath(host), lines: { from: 6, to: 8 } }, { source: amendment, section: "Seam names" }],
    };
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [{
      ...onReadCandidate({ skill: GUIDE, gist: "One fixture per seam.", section: "## Fixtures\n\nBuild one fixture per seam." }), diagnosis }] });
    expect(failures(prepared)).toEqual([]);
    const [entry] = reviewEntries(prepared);
    expect(entry?.proposal).toMatchObject({ diagnosis });
    expect(observerBytes(host)).toEqual(before);

    const selection = await host.callTool("observer_review", { action: "select", proposals: [entry!.reference] });
    const selectionToolCallId = lastCallId(host);
    const { askHtml } = JSON.parse(resultText(selection));
    expect(askHtml).toContain(escapeHtmlText(diagnosis.explanation));
    expect(askHtml).toContain(diagnosis.delta);
    expect(askHtml).toContain(`${guidePath(host)} lines 6–8`);
    expect(askHtml).toContain(`${amendment} § Seam names`);
    expect(askHtml.split(diagnosis.delta)).toHaveLength(2);
    expect(askHtml).not.toContain("Name the seam before the first test.");
    expect(observerBytes(host)).toEqual(before);
    expect(readFileSync(guidePath(host), "utf8")).toBe(GUIDE_TEXT);

    const askToolCallId = askUser(host, selection);
    const { skill, kind, fingerprint, gist } = entry!.proposal;
    const resolved = await resolve(host, [{ skill, kind, gist, fingerprint, outcome: "applied", approval: { proposal: entry!.reference, selectionToolCallId, askToolCallId } }]);
    expect(failures(resolved)).toEqual([]);
    expect(readFileSync(amendment, "utf8")).toContain("Build one fixture per seam.");
    expect(readLedger(host.ledgerFile).at(-1)).toMatchObject({ fingerprint, outcome: "applied" });
  });

  it("refuses a skill-text repair whose candidate diagnosis lacks its receipt, explanation or behavior delta, naming what is missing", async () => {
    const host = loadExtension();
    installGuide(host);
    writeSkill(join(host.skillHome.roots.skillsDir, "sample-local"), "sample-local");
    startPass(host);
    const { id: inspection } = await inspect(host);
    const complete = { inspection, explanation: "Checked the Seams section: it has no fixture step.", delta: "A future agent builds fixtures per seam.",
      citations: [{ source: guidePath(host), section: "Seams" }] };
    const drafts = [
      onReadCandidate({ skill: GUIDE, gist: "Fixtures per seam.", section: "## Fixtures\n\nOne per seam." }),
      ruleCandidate({ skill: GUIDE, kind: "upstream", gist: "No TODO markers.", rule: guideRule }),
      { kind: "local", skill: "sample-local", gist: "Edit the local skill.", priority: "evidence", remedy: "Edit it", change: { operation: "direct-edit", preview: "+ step" } },
    ];
    const cases: Array<[unknown, string[]]> = [
      [undefined, ["inspection", "explanation", "delta"]],
      [{ ...complete, inspection: undefined }, ["inspection"]],
      [{ ...complete, explanation: " " }, ["explanation"]],
      [{ ...complete, delta: undefined }, ["delta"]],
    ];
    for (const draft of drafts) {
      for (const [diagnosis, missing] of cases) {
        const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [{ ...draft, diagnosis }] });
        expect(prepared.isError).toBe(true);
        expect(reviewEntries(prepared)).toEqual([]);
        const reason = failures(prepared).join("\n");
        for (const name of missing) expect(reason).toContain(`\`${name}\``);
      }
    }
    const outOfRange = await host.callTool("observer_review", { action: "prepare", candidates: [{ ...drafts[0], diagnosis: { ...complete, citations: [{ source: guidePath(host), lines: { from: 1, to: 99 } }] } }] });
    expect(failures(outOfRange).join("\n")).toContain("lines 1–99");
  });

  it("prepares project proposals without inspection evidence", async () => {
    const host = loadExtension();
    writeFileSync(join(host.skillHome.roots.cwd, "AGENTS.md"), "Guidance.\n");
    startPass(host);
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [
      { kind: "project", target: { scope: "project", root: host.skillHome.roots.cwd, path: "AGENTS.md", mechanism: "navigation" }, gist: "Point at the check.",
        priority: "evidence", remedy: "Add a pointer", change: { operation: "direct-edit", preview: "+ Run bun run check." } },
    ] });
    expect(failures(prepared)).toEqual([]);
    expect(reviewEntries(prepared).map(({ proposal }) => proposal)).toEqual([expect.not.objectContaining({ diagnosis: expect.anything() })]);
    expect(host.getBranch().some((entry) => entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes('"inspect"'))).toBe(false);
  });

  const groundedDraft = (host: ReturnType<typeof loadExtension>, inspection: string, citations: unknown[] = [{ source: guidePath(host), lines: { from: 6, to: 8 } }]) => ({
    ...onReadCandidate({ skill: GUIDE, gist: "One fixture per seam.", section: "## Fixtures\n\nBuild one fixture per seam." }),
    diagnosis: { inspection, explanation: "Checked the Seams section: it has no fixture step.", delta: "A future agent builds one fixture per seam.", citations },
  });

  it("refuses a repair whose receipt is forged, failed, of another skill, from an earlier pass or from an abandoned branch", async () => {
    const cases: Array<[string, (host: ReturnType<typeof loadExtension>) => Promise<string>, string]> = [
      ["a forged receipt", async () => "observer_review-call-999", "observer_review-call-999"],
      ["a failed inspection", async (host) => (await inspect(host, { references: ["absent.md"] })).id, "failed"],
      ["a receipt of another skill", async (host) => {
        writeSkill(join(host.skillHome.roots.skillsDir, "sample-local"), "sample-local");
        return (await inspect(host, { skill: "sample-local" })).id;
      }, "sample-local"],
      ["a receipt of an earlier pass", async (host) => {
        const { id } = await inspect(host);
        startPass(host);
        return id;
      }, "earlier observation pass"],
      ["a receipt of an abandoned branch", async (host) => {
        const kept = [...host.getBranch()];
        const { id } = await inspect(host);
        host.setBranch(kept);
        return id;
      }, "no completed"],
    ];
    for (const [label, receipt, named] of cases) {
      const host = loadExtension();
      installGuide(host);
      startPass(host);
      const inspection = await receipt(host);
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [groundedDraft(host, inspection)] });
      expect(prepared.isError, label).toBe(true);
      expect(reviewEntries(prepared), label).toEqual([]);
      const reason = failures(prepared).join("\n");
      expect(reason, label).toContain(inspection);
      expect(reason, label).toContain(named);
      expect(reason, label).toMatch(/inspect/);
    }
  });

  it("refuses a citation of a source label, an uninspected file, an absent section or no place in the inspected version", async () => {
    const host = loadExtension();
    installGuide(host);
    mkdirSync(guideReferences(host), { recursive: true });
    const unrequested = join(guideReferences(host), "unrequested.md");
    writeFileSync(unrequested, "## Unrequested\n\nUnrequested reference text.\n");
    startPass(host);
    const { id } = await inspect(host);
    const cases: Array<[unknown, string]> = [
      [{ source: "the sample-guide skill", section: "Seams" }, "the sample-guide skill"],
      [{ source: unrequested, section: "Unrequested" }, unrequested],
      [{ source: guidePath(host), section: "Fixtures" }, "Fixtures"],
      [{ source: guidePath(host) }, "`lines` or a `section`"],
    ];
    for (const [citation, named] of cases) {
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [groundedDraft(host, id, [citation])] });
      expect(prepared.isError, named).toBe(true);
      expect(reviewEntries(prepared), named).toEqual([]);
      expect(failures(prepared).join("\n"), named).toContain(named);
    }
  });

  const stashed = new Map<ReturnType<typeof loadExtension>, Buffer>();
  const guidanceChanges: Array<{ label: string; before?: (host: ReturnType<typeof loadExtension>) => void; change: (host: ReturnType<typeof loadExtension>) => void; named: string }> = [
    { label: "a changed skill file", change: (host) => appendFileSync(guidePath(host), "\n## Fixtures\n\nOne per seam.\n"), named: "SKILL.md" },
    { label: "an added amendment", before: (host) => {
      const rule = join(host.rulesDir, "guide-no-todo.md");
      stashed.set(host, readFileSync(rule));
      rmSync(rule);
    }, change: (host) => writeFileSync(join(host.rulesDir, "guide-no-todo.md"), stashed.get(host)!), named: "guide-no-todo.md" },
    { label: "a removed amendment", change: (host) => rmSync(join(host.rulesDir, "guide-no-todo.md")), named: "guide-no-todo.md" },
    { label: "a removed reference file", change: (host) => rmSync(join(guideReferences(host), "requested.md")), named: "requested.md" },
    { label: "an unreadable skill file", change: (host) => { rmSync(guidePath(host)); mkdirSync(guidePath(host)); }, named: "SKILL.md" },
    { label: "an added reference file", change: (host) => writeFileSync(join(guideReferences(host), "unrequested.md"), "Unrequested.\n"), named: "unrequested.md" },
    { label: "a removed unrequested reference file", before: (host) => writeFileSync(join(guideReferences(host), "unrequested.md"), "Unrequested.\n"),
      change: (host) => rmSync(join(guideReferences(host), "unrequested.md")), named: "unrequested.md" },
    { label: "an edited requested reference file", change: (host) => appendFileSync(join(guideReferences(host), "requested.md"), "More.\n"), named: "requested.md" },
    { label: "an edited amendment rule", change: (host) => appendFileSync(join(host.rulesDir, "guide-no-todo.md"), "More.\n"), named: "guide-no-todo.md" },
  ];

  async function inspectedGuide(before?: (host: ReturnType<typeof loadExtension>) => void) {
    const host = loadExtension();
    installGuide(host);
    await amend(host, GUIDE, guideRule);
    mkdirSync(guideReferences(host), { recursive: true });
    writeFileSync(join(guideReferences(host), "requested.md"), "## Requested\n\nRequested reference text.\n");
    before?.(host);
    startPass(host);
    const { id } = await inspect(host, { references: ["requested.md"] });
    return { host, id };
  }

  it.each(guidanceChanges)("refuses preparing a repair once the guidance its receipt read has changed ($label), naming what to inspect again", async ({ label, before, change, named }) => {
    const { host, id } = await inspectedGuide(before);
    change(host);
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [groundedDraft(host, id)] });
    expect(prepared.isError, label).toBe(true);
    expect(reviewEntries(prepared), label).toEqual([]);
    const reason = failures(prepared).join("\n");
    expect(reason, label).toContain(id);
    expect(reason, label).toContain(named);
    expect(reason, label).toContain(`inspect \`${GUIDE}\` again`);
  });

  it.each(guidanceChanges)("produces no Ask form when the guidance a prepared repair's receipt read changes before Select ($label), naming the proposal to refresh", async ({ label, before, change, named }) => {
    const { host, id } = await inspectedGuide(before);
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [groundedDraft(host, id)] });
    expect(failures(prepared), label).toEqual([]);
    const [entry] = reviewEntries(prepared);
    change(host);
    const selection = await host.callTool("observer_review", { action: "select", proposals: [entry!.reference] });
    expect(selection.isError, label).toBe(true);
    expect(JSON.parse(resultText(selection)).askHtml, label).toBeUndefined();
    expect(reviewEntries(selection, "selected"), label).toEqual([]);
    const reason = failures(selection).join("\n");
    expect(reason, label).toContain(entry!.reference.candidateId);
    expect(reason, label).toContain(named);
    expect(reason, label).toContain(`inspect \`${GUIDE}\` again`);
  });

  it("selects a prepared repair whose inspected guidance is unchanged, while unrelated skills change", async () => {
    const { host, id } = await inspectedGuide();
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [groundedDraft(host, id)] });
    writeSkill(join(host.skillHome.roots.skillsDir, "sample-local"), "sample-local");
    const selection = await host.callTool("observer_review", { action: "select", proposals: [reviewEntries(prepared)[0]!.reference] });
    expect(failures(selection)).toEqual([]);
    expect(JSON.parse(resultText(selection)).askHtml).toContain("A future agent builds one fixture per seam.");
  });

  it("keeps a receipt current when an unrequested reference body changes or can't be read, since it was never inspected", async () => {
    const { host, id } = await inspectedGuide((host) => writeFileSync(join(guideReferences(host), "unrequested.md"), "Unrequested.\n"));
    const unrequested = join(guideReferences(host), "unrequested.md");
    writeFileSync(unrequested, "Rewritten unrequested text.\n");
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [groundedDraft(host, id)] });
    expect(failures(prepared)).toEqual([]);
    chmodSync(unrequested, 0o000);
    try {
      const selection = await host.callTool("observer_review", { action: "select", proposals: [reviewEntries(prepared)[0]!.reference] });
      expect(failures(selection)).toEqual([]);
      const again = await inspect(host, { references: ["requested.md"] });
      expect(again.result.isError).toBeFalsy();
      expect(inspectionOf(again.result)?.referenceInventory).toEqual([{ path: join(guideReferences(host), "requested.md") }, { path: unrequested }]);
    } finally {
      chmodSync(unrequested, 0o644);
    }
  });

  it("refuses a repair once its inspected skill changed owner with the same SKILL.md, naming the kind to inspect again", async () => {
    const host = loadExtension();
    const skill = "sample-local";
    writeSkill(join(host.skillHome.roots.skillsDir, skill), skill);
    startPass(host);
    const { id, result } = await inspect(host, { skill });
    expect(inspectionOf(result)?.kind).toBe("local");
    setLockHash(host, skill, "fixture-lock-hash");
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [descriptionFix(skill, "local", id, firstSource(result))] });
    expect(prepared.isError).toBe(true);
    expect(reviewEntries(prepared)).toEqual([]);
    const reason = failures(prepared).join("\n");
    expect(reason).toContain("now an upstream skill");
    expect(reason).toContain(`inspect \`${skill}\` again`);
  });

  it("refuses a Select whose saved candidate diagnosis was replaced after Prepare under the same reference", async () => {
    const host = loadExtension();
    installGuide(host);
    startPass(host);
    const { id } = await inspect(host);
    const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [groundedDraft(host, id)] });
    const [entry] = reviewEntries(prepared);
    const saved = host.getBranch().at(-1)!.message!.details as { eligible: Array<{ proposal: { diagnosis: { explanation: string } } }> };
    saved.eligible[0]!.proposal.diagnosis.explanation = "Swapped explanation.";
    const selection = await host.callTool("observer_review", { action: "select", proposals: [entry!.reference] });
    expect(selection.isError).toBe(true);
    expect(JSON.parse(resultText(selection)).askHtml).toBeUndefined();
    expect(failures(selection).join("\n")).toContain("content hash");
  });

  it("merges same-identity repairs only when every diagnosis holds, keeping the chosen draft's diagnosis and change together", async () => {
    const host = loadExtension();
    installGuide(host);
    startPass(host);
    const { id } = await inspect(host);
    const evidenceDraft = { ...groundedDraft(host, id), evidence: [{ quote: "no fixture again", count: 1 }] };
    const noteDraft = {
      ...onReadCandidate({ skill: GUIDE, gist: "One fixture per seam.", section: "## Fixtures\n\nBuild one fixture per seam, named for it." }),
      priority: "note", evidence: [{ quote: "fixtures, please", count: 1, source: "user" }],
      diagnosis: { inspection: id, explanation: "The user's note asks for named fixtures; Seams says nothing on them.", delta: "A future agent names each fixture after its seam.",
        citations: [{ source: guidePath(host), section: "Seams" }] },
    };

    const merged = await host.callTool("observer_review", { action: "prepare", candidates: [evidenceDraft, noteDraft] });
    expect(failures(merged)).toEqual([]);
    const [entry, ...rest] = reviewEntries(merged);
    expect(rest).toEqual([]);
    expect(entry!.proposal).toMatchObject({ priority: "note", diagnosis: noteDraft.diagnosis });
    expect((entry!.proposal as { preview: string }).preview).toContain("named for it");
    expect(entry!.proposal.evidence.map(({ quote }) => quote).sort()).toEqual(["fixtures, please", "no fixture again"]);

    for (const broken of [{ ...evidenceDraft, diagnosis: { ...evidenceDraft.diagnosis, citations: [{ source: guidePath(host), section: "Absent" }] } },
      { ...evidenceDraft, diagnosis: { ...evidenceDraft.diagnosis, inspection: "observer_review-call-999" } }]) {
      const refused = await host.callTool("observer_review", { action: "prepare", candidates: [broken, noteDraft] });
      expect(refused.isError).toBe(true);
      expect(reviewEntries(refused)).toEqual([]);
    }
  });

  const descriptionFix = (skill: string, kind: string, inspection: string, source: string, explanation = "The description names reviews but not the session's request; checked lines 1–3.") => ({
    kind, skill, gist: "Name the request in the description.", priority: "evidence", remedy: "Edit the description so the skill is selected for this request",
    evidence: [{ quote: "review this diff", count: 1 }],
    change: { operation: "direct-edit", preview: "- description: Fixture guide.\n+ description: Fixture guide. Use when asked to review a diff." },
    diagnosis: { inspection, explanation, delta: "A future agent selects the skill for a diff review.", citations: [{ source, lines: { from: 1, to: 3 } }] },
  });
  const firstSource = (result: ToolResult<unknown>) => inspectionOf(result)!.sources[0]!.path;

  it("refuses a description fix to an upstream or plugin skill as a direct edit, whatever kind it is labelled, and records no applied answer without an approved rule", async () => {
    const host = loadExtension();
    installGuide(host);
    startPass(host);
    const guide = await inspect(host);
    const plugin = await inspect(host, { skill: "ce-code-review" });
    expect(inspectionOf(plugin.result)?.kind).toBe("plugin");
    const before = observerBytes(host);
    const cases: Array<[string, string, typeof guide]> = [
      [GUIDE, "upstream", guide], [GUIDE, "local", guide], ["ce-code-review", "plugin", plugin], ["ce-code-review", "managed", plugin],
    ];
    for (const [skill, kind, { id, result }] of cases) {
      const label = `${skill} as ${kind}`;
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [descriptionFix(skill, kind, id, firstSource(result))] });
      expect(prepared.isError, label).toBe(true);
      expect(reviewEntries(prepared), label).toEqual([]);
      expect(failures(prepared).join("\n"), label).toMatch(/amendment rules/);
      if (kind !== "upstream" && kind !== "plugin") continue;
      const recorded = await resolve(host, [{ skill, kind, gist: "Name the request in the description.", outcome: "applied" }]);
      expect(recorded.isError, label).toBe(true);
    }
    expect(readLedger(host.ledgerFile)).toEqual([]);
    expect(observerBytes(host)).toEqual(before);
    expect(readFileSync(guidePath(host), "utf8")).toBe(GUIDE_TEXT);
  });

  it("records no uncited answer that labels an installed upstream or plugin skill with another kind", async () => {
    const host = loadExtension();
    installGuide(host);
    for (const [skill, kind] of [[GUIDE, "local"], [GUIDE, "managed"], ["ce-code-review", "local"], ["ce-code-review", "managed"]] as const) {
      for (const outcome of ["applied", "declined", "later"] as const) {
        const label = `${skill} as ${kind}, ${outcome}`;
        const recorded = await resolve(host, [{ skill, kind, gist: "Name the request in the description.", outcome }]);
        expect(recorded.isError, label).toBe(true);
        expect(failures(recorded).join("\n"), label).toMatch(/installed as an? (upstream|plugin) skill/);
      }
    }
    expect(readLedger(host.ledgerFile)).toEqual([]);
    const declined = await resolve(host, [{ skill: GUIDE, kind: "upstream", gist: "Name the request in the description.", outcome: "declined" }]);
    expect(failures(declined)).toEqual([]);
    expect(readLedger(host.ledgerFile)).toEqual([expect.objectContaining({ skill: GUIDE, kind: "upstream", outcome: "declined" })]);
  });

  it("asks about a local or managed description fix with its inspection-backed diagnosis and disclosed uncertainty, and records it once applied", async () => {
    for (const kind of ["local", "managed"] as const) {
      const host = loadExtension();
      const skill = "sample-local";
      writeSkill(join(kind === "local" ? host.skillHome.roots.skillsDir : host.skillHome.roots.managedDir, skill), skill);
      startPass(host);
      const { id, result } = await inspect(host, { skill });
      expect(inspectionOf(result)?.kind, kind).toBe(kind);
      const uncertain = "Suspected missed trigger: the catalog observed at the request listed this description, which never mentions diffs; the agent may still have skipped it for another reason.";
      const prepared = await host.callTool("observer_review", { action: "prepare", candidates: [descriptionFix(skill, kind, id, firstSource(result), uncertain)] });
      expect(failures(prepared), kind).toEqual([]);
      const [entry] = reviewEntries(prepared);
      const selection = await host.callTool("observer_review", { action: "select", proposals: [entry!.reference] });
      const { askHtml } = JSON.parse(resultText(selection));
      expect(askHtml, kind).toContain(escapeHtmlText(uncertain));
      expect(askHtml, kind).toContain("Use when asked to review a diff.");
      expect(readLedger(host.ledgerFile), kind).toEqual([]);

      askUser(host, selection);
      const recorded = await resolve(host, [{ proposal: entry!.reference, outcome: "applied" }]);
      expect(failures(recorded), kind).toEqual([]);
      expect(readLedger(host.ledgerFile), kind).toEqual([expect.objectContaining({ skill, kind, outcome: "applied", fingerprint: entry!.proposal.fingerprint })]);
    }
  });
});

describe("observer_review new-skill search", () => {
  const NEW = "sample-new";
  type Search = {
    skill: string; terms: string[]; fingerprint: string;
    coverage: Array<{ source: string; path: string; status: string; reason?: string; supplemental?: true }>;
    matches: Array<{ name: string; source: string; path?: string; matched: string[] }>;
  };
  const searchOf = (result: ToolResult<unknown>) => (result.details as { search?: Search }).search;
  const deployPath = (host: ReturnType<typeof loadExtension>) => join(host.skillHome.roots.skillsDir, "sample-deploy", "SKILL.md");
  const pluginInstall = (host: ReturnType<typeof loadExtension>): string =>
    JSON.parse(readFileSync(host.skillHome.roots.pluginsRegistry, "utf8")).plugins[CE_PLUGIN][0].installPath;

  function passHost(options: Parameters<typeof loadExtension>[0] = {}) {
    const host = loadExtension(options);
    mkdirSync(dirname(deployPath(host)), { recursive: true });
    writeFileSync(deployPath(host), "---\nname: sample-deploy\ndescription: Deploy release notes to staging.\n---\n\nBody.\n");
    startPass(host);
    return host;
  }

  async function search(host: ReturnType<typeof loadExtension>, params: Record<string, unknown> = {}) {
    const result = await host.callTool("observer_review", { action: "inspect", skill: NEW, terms: ["Release Notes"], ...params });
    return { result, id: lastCallId(host) };
  }

  const newDraft = (inspection: string, skill = NEW) => ({
    kind: "new", skill, gist: "Draft release notes from the log.", priority: "evidence", remedy: "New skill",
    change: { operation: "direct-edit", preview: `---\nname: ${skill}\ndescription: Draft release notes from the log.\n---\n` },
    diagnosis: { inspection, explanation: "sample-deploy only deploys notes someone already drafted.", delta: "A future agent drafts release notes from the log with one skill." },
  });
  const prepare = (host: ReturnType<typeof loadExtension>, candidates: unknown[]) => host.callTool("observer_review", { action: "prepare", candidates });

  /** Records a successful `manage_skill` create of `name` on the branch, as OMP saves it. */
  function createInSession(host: ReturnType<typeof loadExtension>, name: string) {
    const id = `manage-${host.getBranch().length}`;
    host.getBranch().push(
      { type: "message", id: `call-${id}`, message: { role: "assistant", content: [{ type: "toolCall", id, name: "manage_skill", arguments: { action: "create", name } }] } },
      { type: "message", id: `result-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "manage_skill", isError: false, details: { action: "create", name },
        content: [{ type: "text", text: `Created ${name}.` }] } },
    );
  }

  it("records an absent target, each source's coverage and identified matches, and carries the new skill through Prepare and Select to Ask", async () => {
    const host = passHost({ systemPrompt: ["Matching skill → MUST read skill://<name> first.\n<skills>\n- sample-deploy: Deploy release notes to staging.\n- prompt-only: Publish release notes elsewhere.\n</skills>"] });
    createInSession(host, "sample-created");
    const before = observerBytes(host);
    const { roots } = host.skillHome;

    const { result, id } = await search(host);
    expect(result.isError).toBe(false);
    const receipt = searchOf(result)!;
    expect(receipt).toMatchObject({ skill: NEW, terms: ["Release Notes"], fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(receipt.coverage).toEqual([
      { source: "skills directory", path: roots.skillsDir, status: "present" },
      { source: "managed skills", path: roots.managedDir, status: "present" },
      { source: "plugin registry", path: roots.pluginsRegistry, status: "present" },
      { source: `plugin ${CE_PLUGIN}`, path: join(pluginInstall(host), "skills"), status: "present" },
      { source: "skills created this session", path: "session branch", status: "present" },
      { source: "prompt catalog", path: "system prompt", status: "present", supplemental: true },
    ]);
    expect(receipt.matches).toEqual([
      expect.objectContaining({ name: "sample-deploy", source: "local", path: deployPath(host), matched: ["Release Notes"] }),
      expect.objectContaining({ name: "sample-deploy", source: "prompt catalog", matched: ["Release Notes"] }),
      expect.objectContaining({ name: "prompt-only", source: "prompt catalog", matched: ["Release Notes"] }),
    ]);
    expect(resultText(result)).toContain(deployPath(host));

    const prepared = await prepare(host, [newDraft(id)]);
    expect(failures(prepared)).toEqual([]);
    const [entry] = reviewEntries(prepared);
    expect(entry?.proposal).toMatchObject({ kind: "new", diagnosis: { inspection: id, search: { terms: ["Release Notes"], matches: ["sample-deploy", "prompt-only"] } } });

    const selection = await host.callTool("observer_review", { action: "select", proposals: [entry!.reference] });
    expect(failures(selection)).toEqual([]);
    const { askHtml } = JSON.parse(resultText(selection));
    expect(askHtml).toContain("sample-deploy only deploys notes someone already drafted.");
    expect(askHtml).toContain(`Searched current skills, inspection ${id}, for: Release Notes; matches: sample-deploy, prompt-only`);
    expect(askUser(host, selection)).toMatch(/^ask-/);
    expect(observerBytes(host)).toEqual(before);
  });

  it("fails the search when a required source exists but can't be read, or a skill already holds the name", async () => {
    const cases: Array<[string, (host: ReturnType<typeof loadExtension>) => void, (host: ReturnType<typeof loadExtension>) => string]> = [
      ["an unreadable skills directory", (host) => { rmSync(host.skillHome.roots.skillsDir, { recursive: true }); writeFileSync(host.skillHome.roots.skillsDir, ""); }, (host) => host.skillHome.roots.skillsDir],
      ["an unreadable managed-skills directory", (host) => { rmSync(host.skillHome.roots.managedDir, { recursive: true }); writeFileSync(host.skillHome.roots.managedDir, ""); }, (host) => host.skillHome.roots.managedDir],
      ["unreadable enabled-plugin skills", (host) => { const skills = join(pluginInstall(host), "skills"); rmSync(skills, { recursive: true }); writeFileSync(skills, ""); }, (host) => join(pluginInstall(host), "skills")],
      ["a plugin registry that is no JSON", (host) => writeFileSync(host.skillHome.roots.pluginsRegistry, "{not json"), (host) => host.skillHome.roots.pluginsRegistry],
      ["a plugin registry of another shape", (host) => writeFileSync(host.skillHome.roots.pluginsRegistry, JSON.stringify({ plugins: { [CE_PLUGIN]: "installed" } })), (host) => host.skillHome.roots.pluginsRegistry],
      ["an enabled plugin entry without an install path", (host) => writeFileSync(host.skillHome.roots.pluginsRegistry, JSON.stringify({ plugins: { [CE_PLUGIN]: [{ version: "1.0.0" }] } })), (host) => host.skillHome.roots.pluginsRegistry],
      ["an enabled plugin entry whose install path is no string", (host) => writeFileSync(host.skillHome.roots.pluginsRegistry, JSON.stringify({ plugins: { [CE_PLUGIN]: [{ installPath: 42, enabled: true }] } })), (host) => host.skillHome.roots.pluginsRegistry],
      ["an installed skill of that name", (host) => writeSkill(join(host.skillHome.roots.managedDir, NEW), NEW), () => "already exists"],
      ["a skill of that name created this session", (host) => createInSession(host, NEW), () => "created this session"],
    ];
    for (const [label, breakIt, named] of cases) {
      const host = passHost();
      breakIt(host);
      const { result, id } = await search(host);
      expect(result.isError, label).toBe(true);
      expect(searchOf(result), label).toBeUndefined();
      expect(failures(result).join("\n"), label).toContain(named(host));
      const prepared = await prepare(host, [newDraft(id)]);
      expect(reviewEntries(prepared), label).toEqual([]);
      expect(failures(prepared).join("\n"), label).toContain("failed");
    }
  });

  it("passes over a disabled plugin entry without an install path, as OMP does", async () => {
    const host = passHost();
    writeFileSync(host.skillHome.roots.pluginsRegistry, JSON.stringify({ plugins: { [CE_PLUGIN]: [{ version: "1.0.0", enabled: false }] } }));
    const { result } = await search(host);
    expect(failures(result)).toEqual([]);
    expect(searchOf(result)?.coverage).toContainEqual({ source: "plugin registry", path: host.skillHome.roots.pluginsRegistry, status: "present" });
  });

  it("reports a missing optional installation or prompt catalog as coverage, without blocking the new skill", async () => {
    const cases: Array<[string, Parameters<typeof loadExtension>[0], (host: ReturnType<typeof loadExtension>) => void, Record<string, string>]> = [
      ["no managed skills or plugin registry", {}, (host) => {
        rmSync(host.skillHome.roots.managedDir, { recursive: true });
        rmSync(host.skillHome.roots.pluginsRegistry);
      }, { "managed skills": "absent", "plugin registry": "absent", "prompt catalog": "unavailable" }],
      ["an enabled plugin whose install is gone", {}, (host) => rmSync(pluginInstall(host), { recursive: true }), { [`plugin ${CE_PLUGIN}`]: "absent" }],
      ["a prompt catalog in neither host form", { systemPrompt: ["<skills>\n* sample-deploy (Deploy release notes.)\n</skills>"] }, () => {}, { "prompt catalog": "unavailable" }],
      ["a prompt without a skills block", { systemPrompt: ["No skills here."] }, () => {}, { "prompt catalog": "absent" }],
    ];
    for (const [label, options, change, statuses] of cases) {
      const host = passHost(options);
      change(host);
      const { result, id } = await search(host);
      expect(result.isError, label).toBe(false);
      const coverage = Object.fromEntries(searchOf(result)!.coverage.map(({ source, status }) => [source, status]));
      expect(coverage, label).toMatchObject({ "skills directory": "present", ...statuses });
      const prepared = await prepare(host, [newDraft(id)]);
      expect(failures(prepared), label).toEqual([]);
      expect(reviewEntries(prepared), label).toHaveLength(1);
    }
  });

  const staleChanges: Array<[string, (host: ReturnType<typeof loadExtension>) => void, string]> = [
    ["an unrelated skill added", (host) => writeSkill(join(host.skillHome.roots.skillsDir, "sample-other"), "sample-other"), "changed"],
    ["an unmatched skill's file edited", (host) => appendFileSync(join(host.skillHome.roots.skillsDir, "tdd", "SKILL.md"), "More.\n"), "changed"],
    ["a matched skill removed", (host) => rmSync(dirname(deployPath(host)), { recursive: true }), "changed"],
    ["an optional plugin registry appearing", (host) => writeFileSync(host.skillHome.roots.pluginsRegistry, JSON.stringify({ version: 2, plugins: {} })), "changed"],
    ["the target installed", (host) => writeSkill(join(host.skillHome.roots.managedDir, NEW), NEW), "already exists"],
    ["the target created this session", (host) => createInSession(host, NEW), "already exists"],
  ];

  it("refuses preparing a new skill once its search is stale or its target exists, naming the search to repeat", async () => {
    for (const [label, change, named] of staleChanges) {
      const host = passHost();
      if (label === "an optional plugin registry appearing") rmSync(host.skillHome.roots.pluginsRegistry);
      const { id } = await search(host);
      change(host);
      const prepared = await prepare(host, [newDraft(id)]);
      expect(prepared.isError, label).toBe(true);
      expect(reviewEntries(prepared), label).toEqual([]);
      const reason = failures(prepared).join("\n");
      expect(reason, label).toContain(named);
      expect(reason, label).toContain("search again with its `terms`");
    }
  });

  it("refuses selecting a prepared new skill once its search is stale or its target exists, producing no form", async () => {
    for (const [label, change, named] of staleChanges) {
      const host = passHost();
      if (label === "an optional plugin registry appearing") rmSync(host.skillHome.roots.pluginsRegistry);
      const { id } = await search(host);
      const [entry] = reviewEntries(await prepare(host, [newDraft(id)]));
      change(host);
      const selection = await host.callTool("observer_review", { action: "select", proposals: [entry!.reference] });
      expect(selection.isError, label).toBe(true);
      expect(JSON.parse(resultText(selection)), label).not.toHaveProperty("askHtml");
      expect(failures(selection).join("\n"), label).toContain(named);
    }
  });

  it("refuses a new skill without a diagnosis citing its own search in this pass", async () => {
    const host = passHost();
    const { id } = await search(host);
    const { id: other } = await search(host, { skill: "sample-other" });
    writeSkill(join(host.skillHome.roots.skillsDir, "sample-local"), "sample-local");
    const { id: inspection } = await search(host, { skill: "sample-local", terms: undefined });
    const { id: fresh } = await search(host);
    const cases: Array<[unknown, string]> = [
      [undefined, "`inspection`"],
      [{ inspection: fresh, explanation: " ", delta: "A future agent drafts notes." }, "`explanation`"],
      [{ inspection: other, explanation: "No match fits.", delta: "A future agent drafts notes." }, "sample-other"],
      [{ inspection, explanation: "No match fits.", delta: "A future agent drafts notes." }, "not a new-skill search"],
      [{ inspection: id, explanation: "No match fits.", delta: "A future agent drafts notes." }, "changed"],
    ];
    for (const [diagnosis, named] of cases) {
      const prepared = await prepare(host, [{ ...newDraft(fresh), diagnosis }]);
      expect(reviewEntries(prepared), named).toEqual([]);
      expect(failures(prepared).join("\n"), named).toContain(named);
    }
  });
});

describe("approval compatibility under the evidence gate", () => {
  const amendment = (host: ReturnType<typeof loadExtension>) => join(host.amendmentsDir, "tdd-amendment.md");
  const tddSkill = (host: ReturnType<typeof loadExtension>) => join(host.skillHome.roots.skillsDir, "tdd", "SKILL.md");
  const prepare = (host: ReturnType<typeof loadExtension>, candidates: unknown[]) => host.callTool("observer_review", { action: "prepare", candidates });
  const DIAGNOSIS_LINE = /<p>(?:Diagnosis: |Behavior change: |Cited guidance, inspection )[^\n]*\n/g;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  function savedBeforeGate(host: ReturnType<typeof loadExtension>) {
    const lists = ["eligible", "selected", "deferred"] as const;
    const savedEntries = (entry: SessionEntry) => entry.message?.role === "toolResult" && entry.message.toolName === "observer_review"
      ? lists.flatMap((list) => (entry.message!.details as Partial<Record<typeof list, Array<{ reference: { contentHash: string }; proposal: { diagnosis?: unknown } }>>>)[list] ?? []) : [];
    const hashes = new Map<string, string>();
    for (const { reference, proposal: { diagnosis: _, ...proposal } } of host.getBranch().flatMap(savedEntries)) hashes.set(reference.contentHash, sha(JSON.stringify(proposal)));
    let json = JSON.stringify(host.getBranch());
    for (const [from, to] of hashes) json = json.replaceAll(from, to);
    const branch = JSON.parse(json) as SessionEntry[];
    for (const entry of branch) {
      for (const saved of savedEntries(entry)) delete saved.proposal.diagnosis;
      if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      for (const block of entry.message.content as Array<{ name?: string; arguments?: { html?: string; candidates?: Array<{ diagnosis?: unknown }> } }>) {
        if (block.name === "ask" && block.arguments?.html) block.arguments.html = block.arguments.html.replace(DIAGNOSIS_LINE, "");
        for (const candidate of block.arguments?.candidates ?? []) delete candidate.diagnosis;
      }
    }
    host.setBranch(branch);
    expect(json).toContain('"diagnosis"');
    expect(JSON.stringify(host.getBranch())).not.toContain('"diagnosis"');
    return <R extends { contentHash: string }>(ref: R): R => ({ ...ref, contentHash: hashes.get(ref.contentHash) ?? ref.contentHash });
  }

  it("gives a repair one identity whatever its diagnosis, so a Later answer is re-offered and a decline suppresses every later draft", async () => {
    const host = loadExtension();
    const draft = onReadCandidate({ gist: "Name the seam", section: SEAMS });
    startPass(host);
    const [first] = reviewEntries(await prepare(host, [draft]));
    const diagnosis = (first!.proposal as { diagnosis?: Record<string, unknown> }).diagnosis;
    expect(diagnosis).toBeDefined();
    const [reworded] = reviewEntries(await prepare(host, [{ ...draft, diagnosis: { ...diagnosis, explanation: "Read Seams again: it never says to name the seam first." } }]));
    expect(reworded!.reference.candidateId).toBe(first!.reference.candidateId);
    expect(reworded!.proposal.fingerprint).toBe(proposalFingerprint("tdd", "Name the seam"));
    expect(first!.proposal.fingerprint).toBe(reworded!.proposal.fingerprint);
    expect(reworded!.reference.contentHash).not.toBe(first!.reference.contentHash);

    expect(failures(await resolve(host, [{ outcome: "later", proposal: reworded!.reference }]))).toEqual([]);
    await host.runCommand("observe", "Look at the seams again.");
    expect(String(host.sent.at(-1)?.message.content)).toContain(proposalFingerprint("tdd", "Name the seam"));
    const [reoffered] = reviewEntries(await prepare(host, [draft]));
    expect(reoffered!.proposal.fingerprint).toBe(first!.proposal.fingerprint);

    expect(failures(await resolve(host, [{ outcome: "declined", proposal: reoffered!.reference }]))).toEqual([]);
    startPass(host);
    const afterDecline = await prepare(host, [draft]);
    expect(failures(afterDecline)).toEqual([]);
    expect(reviewEntries(afterDecline)).toEqual([]);
  });

  it("reconciles a grounded repair whose target changed after approval by a fresh inspection, never a second Ask", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
    const [applied] = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }]);
    const asks = () => host.getBranch().filter((entry) => entry.message?.toolName === "ask").length;
    const askCount = asks();
    const approvedInspection = host.getBranch().flatMap((entry) => entry.message?.role === "assistant" && Array.isArray(entry.message.content)
      ? (entry.message.content as Array<{ id?: string; name?: string; arguments?: { action?: string } }>).filter((block) => block.name === "observer_review" && block.arguments?.action === "inspect").map((block) => block.id!) : []).at(-1)!;
    appendFileSync(amendment(host), "\n## Mine\n\nThe user's own words.\n");
    const revision = {
      ...onReadCandidate({ gist: applied!.gist, section: RED }),
      reconciles: { approval: applied!.approval, changedTarget: "The user appended a Mine section.", reason: "Append the approved section after it.", preserved: "Mine stays as written." },
    };

    const stale = await prepare(host, [{ ...revision, diagnosis: { inspection: approvedInspection, explanation: "Seams says nothing on reds.", delta: "A future agent reads a red as a diff.",
      citations: [{ source: tddSkill(host), lines: { from: 1, to: 1 } }] } }]);
    expect(failures(stale)).toEqual([expect.stringContaining("no longer current")]);
    expect(failures(stale)[0]).toContain("inspect `tdd` again");
    expect(failures(stale)[0]).not.toMatch(/ask/i);

    const fresh = await prepare(host, [revision]);
    expect(failures(fresh)).toEqual([]);
    const [prepared] = reviewEntries(fresh);
    expect((prepared!.proposal as { diagnosis?: { inspection: string } }).diagnosis?.inspection).not.toBe(approvedInspection);
    const result = await resolve(host, [{ ...applied, approval: { ...applied!.approval, revision: prepared!.reference } }]);
    expect(failures(result)).toEqual([]);
    expect(readRule(amendment(host)).body).toBe(`${SEAMS}\n\n## Mine\n\nThe user's own words.\n\n${RED}`);
    expect(asks()).toBe(askCount);
  });

  it("applies an approval saved before the gate under its original contract, labelling nothing evidence-validated", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
    const [applied] = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }]);
    const legacy = savedBeforeGate(host);
    const answer = { ...applied!, approval: { ...applied!.approval, proposal: legacy(applied!.approval.proposal) } };

    const result = await resolve(host, [answer]);

    expect(failures(result)).toEqual([]);
    expect(readRule(amendment(host)).body).toBe(`${SEAMS}\n\n${RED}`);
    expect(JSON.stringify(result)).not.toMatch(/diagnos|inspection|evidence-validated/i);
    const record = ledgerRecords(host.ledgerFile).at(-1)!;
    expect(Object.keys(record).sort()).toEqual(Object.keys(ledgerRecords(host.ledgerFile)[0]!).sort());
    expect(record).toMatchObject({ gist: "A red is an assertion diff.", outcome: "applied", fingerprint: applied!.fingerprint });
  });

  it("produces no Ask form from a repair prepared before the gate and not yet approved, until it is inspected and prepared again", async () => {
    const host = loadExtension();
    startPass(host);
    const prepared = await prepare(host, [onReadCandidate({ gist: "Name the seam", section: SEAMS })]);
    const legacy = savedBeforeGate(host);
    const [entry] = reviewEntries(prepared);

    const selection = await host.callTool("observer_review", { action: "select", proposals: [legacy(entry!.reference)] });

    expect(selection.isError).toBe(true);
    expect(JSON.parse(resultText(selection)).askHtml).toBeUndefined();
    expect(reviewEntries(selection, "selected")).toEqual([]);
    const reason = failures(selection).join("\n");
    expect(reason).toContain(entry!.reference.candidateId);
    expect(reason).toContain("inspect `tdd`");
    expect(reason).toContain("prepare it again");

    const again = await prepare(host, [onReadCandidate({ gist: "Name the seam", section: SEAMS })]);
    const reselected = await host.callTool("observer_review", { action: "select", proposals: reviewEntries(again).map(({ reference }) => reference) });
    expect(failures(reselected)).toEqual([]);
    expect(JSON.parse(resultText(reselected)).askHtml).toContain("Name the seam");
  });

  it("adds no expiry at Resolve when other guidance of the skill changed after approval, while a changed target still refuses", async () => {
    const host = loadExtension();
    await addOnReadFix(host, "tdd", "Name the seam before the first test.", SEAMS);
    const [applied] = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }]);
    appendFileSync(tddSkill(host), "\n## Fixtures\n\nOne fixture per seam.\n");
    expect(failures(await resolve(host, [applied]))).toEqual([]);
    expect(readRule(amendment(host)).body).toBe(`${SEAMS}\n\n${RED}`);

    const other = loadExtension();
    await addOnReadFix(other, "tdd", "Name the seam before the first test.", SEAMS);
    const [changed] = await approveOnRead(other, [{ gist: "A red is an assertion diff.", section: RED }]);
    appendFileSync(amendment(other), "\n## Mine\n\nThe user's own words.\n");
    expect(failures(await resolve(other, [changed]))).toEqual([expect.stringContaining("changed since Prepare")]);
  });

  it("leaves a Select of maintenance and non-skill proposals without a diagnosis as it was", async () => {
    const host = loadExtension();
    splitAmendment(host, "domain-modeling", "dm-define-terms");
    const [fix] = ledgerRecords(host.ledgerFile);
    writeFileSync(join(host.skillHome.roots.cwd, "AGENTS.md"), "Guidance.\n");
    startPass(host);
    const prepared = await prepare(host, [
      withdrawalCandidate({ skill: "domain-modeling", fingerprint: fix!.fingerprint, gist: String(fix!.gist) }),
      { kind: "project", target: { scope: "project", root: host.skillHome.roots.cwd, path: "AGENTS.md", mechanism: "navigation" }, gist: "Point at the check.",
        priority: "evidence", remedy: "Add a pointer", change: { operation: "direct-edit", preview: "+ Run bun run check." } },
    ]);
    expect(failures(prepared)).toEqual([]);
    const selection = await host.callTool("observer_review", { action: "select", proposals: reviewEntries(prepared).map(({ reference }) => reference) });
    expect(failures(selection)).toEqual([]);
    expect(reviewEntries(selection, "selected").map(({ proposal }) => proposal.gist).sort()).toEqual([String(fix!.gist), "Point at the check."].sort());
  });

  it("/observe-report over a grounded pass starts no pass and changes no branch, ledger, observer file or observation", async () => {
    const host = loadExtension();
    await host.callTool("observe", { text: "The seam section repeats itself." });
    const [applied] = await approveOnRead(host, [{ gist: "A red is an assertion diff.", section: RED }]);
    await resolve(host, [{ outcome: "later", proposal: applied!.approval.proposal }]);
    const before = { branch: structuredClone(host.getBranch()), files: observerBytes(host), observations: readFileSync(host.observationsFile, "utf8"), sent: host.sent.length };

    await host.runCommand("observe-report");

    expect({ branch: host.getBranch(), files: observerBytes(host), observations: readFileSync(host.observationsFile, "utf8"), sent: host.sent.length }).toEqual(before);
    expect(host.notices.at(-1)).toContain("Evidence report (no observation pass started)");
  });
});

/** A system prompt in OMP's standard template, its `<skills>` block listing `skills`. */
function catalogPrompt(skills: ReadonlyArray<readonly [string, string]>): string[] {
  return [
    "You are a coding agent.",
    `# Skills & Rules\nMatching skill → MUST read skill://<name> first.\n<skills>\n${skills.map(([name, description]) => `- ${name}: ${description}`).join("\n")}\n</skills>`,
    "# Tools",
  ];
}

/** A system prompt rendered from OMP's bundled custom-prompt template, its `<skills>` block listing `skills`. */
function customCatalogPrompt(skills: ReadonlyArray<readonly [string, string]>): string[] {
  return [
    `You review pull requests.\nSkills are specialized knowledge. Scan descriptions for your task domain.\nIf a skill applies, you MUST read \`skill://<name>\` before proceeding.\n<skills>\n${skills.map(([name, description]) => `<skill name="${name}">\n${description}\n</skill>`).join("\n")}\n</skills>`,
  ];
}

/** A persisted native skill notice as OMP renders and saves it; `details` defaults to what its text announces. */
function skillNotice(id: string, change: { added?: ReadonlyArray<readonly [string, string]>; updated?: ReadonlyArray<readonly [string, string]>; removed?: string[] }, details?: unknown): SessionEntry {
  const { added = [], updated = [], removed = [] } = change;
  const listed = (skills: ReadonlyArray<readonly [string, string]>) => skills.map(([name, description]) => `- ${name}: ${description}`);
  const content = [
    "<system-notice id=\"skills\">",
    "Skills changed this session. Matching skill → MUST read `skill://<name>` first. This lists only what changed; any skill not named here is unaffected.",
    ...(added.length ? ["Now available:", ...listed(added)] : []),
    ...(updated.length ? ["Updated (this description replaces the earlier one):", ...listed(updated)] : []),
    ...(removed.length ? ["No longer available:", ...removed.map((name) => `- \`${name}\``)] : []),
    "</system-notice>",
  ].join("\n");
  const announced = [...added, ...updated].map(([name, description]) => ({ name, description }));
  return { type: "custom_message", id, customType: "skill-notice", content, details: details ?? { announced, removed } } as unknown as SessionEntry;
}

async function observeCatalog(host: ReturnType<typeof loadExtension>, skills: ReadonlyArray<readonly [string, string]>, systemPrompt = catalogPrompt(skills)) {
  await host.startAgent("Write the tests.", { systemPrompt });
  await host.commitPrompt("Write the tests.");
}

const catalogEntries = (host: ReturnType<typeof loadExtension>) =>
  host.getBranch().filter((entry) => entry.type === "custom" && entry.customType?.startsWith("skill-observer-catalog"));

async function lookUp(host: ReturnType<typeof loadExtension>, skill: string) {
  const result = await host.callTool("observer_review", { action: "catalog", skill });
  const { catalog } = result.details as { catalog: { matches: Array<Record<string, unknown>>; gaps: string[] } };
  return { result, text: resultText(result), matches: catalog.matches, gaps: catalog.gaps };
}

describe("skill catalog observations", () => {
  const SEAMS = ["seam-finder", "Finds test seams before writing tests."] as const;
  const NOTES = ["release-notes", "Drafts release notes from merged changes."] as const;

  it("records the hook's catalog once the prompt's user message is on the branch, without touching the prompt or returning a result", async () => {
    const host = loadExtension();
    const systemPrompt = catalogPrompt([SEAMS, NOTES]);
    const before = structuredClone(systemPrompt);
    expect(await host.startAgent("Write the tests.", { systemPrompt })).toEqual([]);
    expect(host.startResults().every((result) => result === undefined)).toBe(true);
    expect(systemPrompt).toEqual(before);
    expect(catalogEntries(host)).toEqual([]);
    await host.commitPrompt("Write the tests.");
    const [definition, binding] = catalogEntries(host);
    expect(definition?.data).toEqual({ catalogId: expect.any(String), format: "standard", coverage: "observed", entries: [{ name: SEAMS[0], description: SEAMS[1] }, { name: NOTES[0], description: NOTES[1] }], limitations: [expect.stringContaining("not proof of what the model received")] });
    expect(binding?.data).toEqual({ catalogId: (definition?.data as { catalogId: string }).catalogId, observedAt: "user-0", boundary: "before_agent_start" });
    expect(catalogEntries(host)).toHaveLength(2);
  });

  it("looks a skill up by exact name as observed, with its position and references, after the skill file changed", async () => {
    const host = loadExtension();
    const skillFile = join(host.skillHome.roots.skillsDir, SEAMS[0], "SKILL.md");
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, `---\nname: ${SEAMS[0]}\ndescription: ${SEAMS[1]}\n---\n\nBody.\n`);
    await observeCatalog(host, [SEAMS, NOTES]);
    writeFileSync(skillFile, `---\nname: ${SEAMS[0]}\ndescription: Rewritten after capture.\n---\n\nBody.\n`);
    const [definition, binding] = catalogEntries(host);
    const { result, text, matches } = await lookUp(host, SEAMS[0]);
    expect(result.isError).toBe(false);
    expect(matches).toEqual([{ skill: SEAMS[0], observedAt: "user-0", bindingId: binding!.id, definitionId: definition!.id, coverage: "observed", at: "user-0", via: "catalog", status: "listed", description: SEAMS[1], limitations: expect.any(Array) }]);
    expect(text).toContain(`listed as "${SEAMS[1]}"`);
    expect(text).toContain("not proof of what the model received");
    expect(text).not.toContain("Rewritten after capture.");
    expect((await lookUp(host, "seam")).matches).toEqual([expect.objectContaining({ status: "not-listed" })]);
  });

  it("writes nothing for an unchanged repeat on the branch and stores a changed catalog as distinguishable content", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS, NOTES]);
    await observeCatalog(host, [SEAMS, NOTES]);
    expect(catalogEntries(host)).toHaveLength(2);
    const changed = [SEAMS[0], "Finds seams."] as const;
    await observeCatalog(host, [changed, NOTES]);
    expect(catalogEntries(host).map(({ customType }) => customType)).toEqual(["skill-observer-catalog", "skill-observer-catalog-binding", "skill-observer-catalog", "skill-observer-catalog-binding"]);
    const ids = catalogEntries(host).filter(({ customType }) => customType === "skill-observer-catalog").map(({ data }) => (data as { catalogId: string }).catalogId);
    expect(new Set(ids).size).toBe(2);
    await observeCatalog(host, [SEAMS, NOTES]);
    expect(catalogEntries(host).at(-1)?.customType).toBe("skill-observer-catalog-binding");
    expect(catalogEntries(host)).toHaveLength(5);
    expect((await lookUp(host, SEAMS[0])).matches.map(({ description }) => description)).toEqual([SEAMS[1], changed[1], SEAMS[1]]);
  });

  it.each([
    ["a subagent", { agentKind: "sub" as const }, undefined],
    ["a session without a UI", { hasUI: false }, undefined],
    ["a revived subagent", {}, "revive" as const],
  ])("captures nothing for %s", async (_label, options, reason) => {
    const host = loadExtension(options);
    await host.startAgent("Write the tests.", { systemPrompt: catalogPrompt([SEAMS]), reason });
    await host.commitPrompt("Write the tests.");
    expect(catalogEntries(host)).toEqual([]);
  });

  it("records only the preparation OMP kept: a re-run replaces it and a switched session drops it", async () => {
    const host = loadExtension();
    await host.startAgent("Write the tests.", { systemPrompt: catalogPrompt([SEAMS]) });
    await host.startAgent("Write the tests.", { systemPrompt: catalogPrompt([NOTES]) });
    await host.commitMessage({ customType: "other-extension", content: "context", display: false });
    expect(catalogEntries(host)).toEqual([]);
    await host.commitPrompt("Write the tests.");
    expect((await lookUp(host, NOTES[0])).matches).toEqual([expect.objectContaining({ status: "listed" })]);
    expect((await lookUp(host, SEAMS[0])).matches).toEqual([expect.objectContaining({ status: "not-listed" })]);

    await host.startAgent("Next.", { systemPrompt: catalogPrompt([SEAMS]) });
    await host.emit("session_switch");
    await host.commitPrompt("Next.");
    expect(catalogEntries(host)).toHaveLength(2);
  });

  it("reports unknown, never absent, without an observation or with no standard skills block", async () => {
    const host = loadExtension();
    const none = await lookUp(host, SEAMS[0]);
    expect(none.result.isError).toBe(false);
    expect(none.matches).toEqual([]);
    expect(none.text).toContain(`whether \`${SEAMS[0]}\` was listed is unknown`);
    await observeCatalog(host, [], ["You are a coding agent with a custom prompt."]);
    const custom = await lookUp(host, SEAMS[0]);
    expect(custom.matches).toEqual([expect.objectContaining({ status: "unknown", coverage: "no-block" })]);
    expect(custom.text).toContain("unknown (the system prompt had no skills block in the standard or bundled custom-prompt form");
    expect(custom.text).not.toMatch(/\bnot listed\b|\babsent\b/);
  });

  it("writes no file: no global catalog store, prompt archive, skill body or ledger row", async () => {
    const host = loadExtension();
    const files = () => readdirSync(host.skillHome.home, { recursive: true }).map(String).sort();
    const before = files();
    await observeCatalog(host, [SEAMS, NOTES]);
    await lookUp(host, SEAMS[0]);
    expect(files()).toEqual(before);
    expect(JSON.stringify(catalogEntries(host))).not.toContain("You are a coding agent");
  });

  it("gives the pass and /observe-report a summary and lookup instructions, never the entries, and counts it in the payload estimate", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage, ...fx.skillUrlRead]);
    await observeCatalog(host, [SEAMS, NOTES]);
    await host.runCommand("observe-report");
    const report = host.notices.at(-1)!;
    expect(report).toContain("\nSkill catalog observations: 1 on this branch; the latest, at entry `user-");
    expect(report).toContain("listed 2 skills");
    expect(report).toMatch(/\nPayload estimate for \/observe now: ≈ \d+ tokens \(.*catalog \d+/);
    expect(report).not.toContain(SEAMS[1]);

    await host.runCommand("observe");
    const content = String(host.sent[0]?.message.content);
    expect(content).toContain("## Skill catalog observations\n\n1 skill catalog observation on this branch");
    expect(content).toContain("`observer_review` `action: \"catalog\"`");
    expect(content).not.toContain(SEAMS[1]);
    expect(content).not.toContain(NOTES[0]);
    expect(host.notices.at(-1)).toMatch(/catalog \d+/);
  });

  it("leaves a branch whose only evidence is a catalog observation with no skill evidence in /observe-report", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS, NOTES]);
    await host.runCommand("observe-report");
    expect(host.notices.at(-1)).toBe("No skill evidence on this branch.");
  });
});

describe("qualified skill catalog capture", () => {
  const SEAMS = ["seam-finder", "Finds test seams before writing tests."] as const;
  const NOTES = ["release-notes", "Drafts release notes from merged changes."] as const;
  type Host = ReturnType<typeof loadExtension>;
  const reply = (id: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }) as SessionEntry;
  const compaction = (id: string, firstKeptEntryId: string, extra: Record<string, unknown> = {}) =>
    ({ type: "compaction", id, firstKeptEntryId, summary: "Earlier work.", ...extra }) as SessionEntry;
  const append = (host: Host, ...entries: SessionEntry[]) => host.setBranch([...host.getBranch(), ...entries]);
  const states = async (host: Host, skill: string) =>
    (await lookUp(host, skill)).matches.map(({ at, via, status, description }) => ({ at, via, status, ...(description !== undefined && { description }) }));

  it("preserves a custom-prompt skills block's descriptions as rendered, including host shortening", async () => {
    const host = loadExtension();
    const shortened = "Finds test seams before writing tests for HTTP clients, queues and…";
    await observeCatalog(host, [], customCatalogPrompt([[SEAMS[0], shortened], NOTES]));
    expect(catalogEntries(host)[0]?.data).toMatchObject({ format: "custom", coverage: "observed", entries: [{ name: SEAMS[0], description: shortened }, { name: NOTES[0], description: NOTES[1] }] });
    const { text } = await lookUp(host, SEAMS[0]);
    expect(await states(host, SEAMS[0])).toEqual([{ at: "user-0", via: "catalog", status: "listed", description: shortened }]);
    expect(text).toContain(`listed as "${shortened}"`);
    expect(await states(host, "missing-skill")).toEqual([{ at: "user-0", via: "catalog", status: "not-listed" }]);
  });

  it.each([
    ["standard", catalogPrompt([])],
    ["bundled custom-prompt", customCatalogPrompt([])],
    ["tag-only", ["You are a coding agent.\n<skills>\n</skills>"]],
  ])("observes an empty %s skills block as listing no skills, claiming no absence beyond it", async (_label, systemPrompt) => {
    const host = loadExtension();
    await observeCatalog(host, [], systemPrompt);
    expect(catalogEntries(host)[0]?.data).toMatchObject({ coverage: "observed", entries: [] });
    const { text } = await lookUp(host, SEAMS[0]);
    expect(await states(host, SEAMS[0])).toEqual([{ at: "user-0", via: "catalog", status: "not-listed" }]);
    expect(text).toContain("another advertisement may still have named it");
    const miss = await host.callTool("observer_review", { action: "catalog", terms: ["seams"] });
    expect(resultText(miss)).toContain("not evidence no such skill existed");

    const unrecognized = loadExtension();
    await observeCatalog(unrecognized, [], ["<skills>\n* seam-finder (Finds seams.)\n</skills>"]);
    expect(catalogEntries(unrecognized)[0]?.data).toMatchObject({ coverage: "unsupported", entries: [] });
  });

  it("applies native skill notice additions, updates and removals after the binding at later points, without copying them", async () => {
    const host = loadExtension();
    // An earlier prompt's notice: a reply follows it, so it was not delivered with the observed prompt.
    append(host, skillNotice("notice-early", { added: [["early-skill", "Announced before any observation."]] }), reply("reply-0"));
    await observeCatalog(host, [SEAMS]);
    const stored = structuredClone(catalogEntries(host));
    const updated = "Finds seams in legacy code.";
    append(host, reply("reply-1"), skillNotice("notice-1", { added: [NOTES] }), reply("reply-2"),
      skillNotice("notice-2", { updated: [[SEAMS[0], updated]] }), skillNotice("notice-3", { removed: [NOTES[0]] }));
    expect(await states(host, NOTES[0])).toEqual([
      { at: "user-2", via: "catalog", status: "not-listed" },
      { at: "notice-1", via: "skill-notice", status: "listed", description: NOTES[1] },
      { at: "notice-3", via: "skill-notice", status: "not-listed" },
    ]);
    expect(await states(host, SEAMS[0])).toEqual([
      { at: "user-2", via: "catalog", status: "listed", description: SEAMS[1] },
      { at: "notice-2", via: "skill-notice", status: "listed", description: updated },
    ]);
    expect((await lookUp(host, SEAMS[0])).text).toContain(`listed as "${updated}"`);
    expect(await states(host, "early-skill")).toEqual([{ at: "user-2", via: "catalog", status: "not-listed" }]);
    expect(catalogEntries(host)).toEqual(stored);
  });

  it("applies a skill notice OMP saved just before its prompt's user message to that prompt's observation", async () => {
    const host = loadExtension();
    await host.startAgent("Write the tests.", { systemPrompt: catalogPrompt([SEAMS]) });
    append(host, skillNotice("notice-0", { added: [NOTES] }));
    await host.commitPrompt("Write the tests.");
    expect(host.getBranch().map(({ id, customType }) => customType ?? id)).toEqual(["skill-notice", "user-1", "skill-observer-catalog", "skill-observer-catalog-binding"]);
    expect(await states(host, NOTES[0])).toEqual([
      { at: "user-1", via: "catalog", status: "not-listed" },
      { at: "notice-0", via: "skill-notice", status: "listed", description: NOTES[1] },
    ]);
    const found = await host.callTool("observer_review", { action: "catalog", terms: ["release notes"] });
    expect((found.details as { catalog: { matches: Array<{ skill: string }> } }).catalog.matches.map(({ skill }) => skill)).toEqual([NOTES[0]]);

    append(host, reply("reply-1"));
    await host.startAgent("Next.", { systemPrompt: catalogPrompt([SEAMS, ["other-skill", "Other work."]]) });
    append(host, skillNotice("notice-1", { removed: [NOTES[0]] }));
    await host.commitPrompt("Next.");
    const second = host.getBranch().findLast((entry) => entry.message?.role === "user")!.id;
    expect(await states(host, NOTES[0])).toEqual([
      { at: "user-1", via: "catalog", status: "not-listed" },
      { at: "notice-0", via: "skill-notice", status: "listed", description: NOTES[1] },
      { at: second, via: "catalog", status: "not-listed" },
      { at: "notice-1", via: "skill-notice", status: "not-listed" },
    ]);
  });

  it("drops a notice outside a compaction's kept range and reports the window before OMP announces the skill again", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS]);
    append(host, skillNotice("notice-1", { added: [NOTES] }), reply("reply-1"), compaction("compaction-1", "reply-1"), reply("reply-2"));
    expect(await states(host, NOTES[0])).toEqual([
      { at: "user-0", via: "catalog", status: "not-listed" },
      { at: "notice-1", via: "skill-notice", status: "listed", description: NOTES[1] },
      { at: "compaction-1", via: "compaction", status: "not-listed" },
    ]);
    expect((await lookUp(host, NOTES[0])).text).toMatch(/compaction-1.*out of context.*next user-queued message/);
    expect(await states(host, SEAMS[0])).toEqual([{ at: "user-0", via: "catalog", status: "listed", description: SEAMS[1] }]);
    append(host, skillNotice("notice-2", { added: [NOTES] }));
    expect((await states(host, NOTES[0])).at(-1)).toEqual({ at: "notice-2", via: "skill-notice", status: "listed", description: NOTES[1] });

    const kept = loadExtension();
    await observeCatalog(kept, [SEAMS]);
    append(kept, reply("reply-1"), skillNotice("notice-1", { added: [NOTES] }), reply("reply-2"), compaction("compaction-1", "notice-1"), compaction("compaction-2", "reply-2"));
    expect(await states(kept, NOTES[0])).toEqual([
      { at: "user-0", via: "catalog", status: "not-listed" },
      { at: "notice-1", via: "skill-notice", status: "listed", description: NOTES[1] },
      { at: "compaction-2", via: "compaction", status: "not-listed" },
    ]);
  });

  it.each([
    ["OpenAI remote compaction", compaction("compaction-1", "", { preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory: [] } } })],
    ["Anthropic server compaction", compaction("compaction-1", "", { preserveData: { anthropicCompaction: { provider: "anthropic", content: "Summary." } }, providerReplayThroughEntryId: "reply-1" })],
    ["a context rollover", compaction("compaction-1", "reply-1", { details: { kind: "experimental-context-rollover" } })],
  ])("reports notice coverage unknown after %s until a notice names the skill again", async (_label, compacted) => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS]);
    append(host, skillNotice("notice-1", { added: [NOTES] }), reply("reply-1"), compacted);
    const held = await lookUp(host, NOTES[0]);
    expect(held.matches.at(-1)).toMatchObject({ at: "compaction-1", via: "compaction", status: "unknown" });
    expect(held.text).toMatch(/compaction-1[^\n]*unknown/);
    expect(await states(host, SEAMS[0])).toEqual([{ at: "user-0", via: "catalog", status: "listed", description: SEAMS[1] }]);
    append(host, skillNotice("notice-2", { updated: [[NOTES[0], "Drafts notes."]] }));
    expect((await states(host, NOTES[0])).at(-1)).toEqual({ at: "notice-2", via: "skill-notice", status: "listed", description: "Drafts notes." });
  });

  it("keeps a notice's rendered description over conflicting structured details and reports the attribution unknown", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS]);
    append(host, skillNotice("notice-1", { added: [NOTES] }, { announced: [{ name: NOTES[0], description: "Structured, not rendered." }], removed: [SEAMS[0]] }));
    const notes = await lookUp(host, NOTES[0]);
    expect((await states(host, NOTES[0])).at(-1)).toEqual({ at: "notice-1", via: "skill-notice", status: "unknown", description: NOTES[1] });
    expect(notes.text).toMatch(/notice-1[^\n]*attribution is unknown/);
    expect(notes.text).not.toContain("Structured, not rendered.");
    expect((await states(host, SEAMS[0])).at(-1)).toEqual({ at: "notice-1", via: "skill-notice", status: "unknown" });
  });

  it("turns unknown templates and malformed or ambiguous entries into coverage gaps, keeping recognizable entries as partial evidence", async () => {
    const host = loadExtension();
    const partialPrompt = catalogPrompt([SEAMS, NOTES]).map((block) => block.replace(`- ${NOTES[0]}:`, `* ${NOTES[0]}:`));
    await host.startAgent("Write the tests.", { systemPrompt: partialPrompt });
    await host.commitPrompt("Write the tests.");
    expect(catalogEntries(host)[0]?.data).toMatchObject({ format: "standard", coverage: "partial", entries: [{ name: SEAMS[0], description: SEAMS[1] }] });
    expect(await states(host, SEAMS[0])).toEqual([{ at: "user-0", via: "catalog", status: "listed", description: SEAMS[1] }]);
    expect(await states(host, NOTES[0])).toEqual([{ at: "user-0", via: "catalog", status: "unknown" }]);

    const continued = skillNotice("notice-3", { added: [["helper-one", "First line"], ["helper-two", "Second skill."]] }, { announced: [{ name: "helper-one", description: "First line\ncontinued here" }, { name: "helper-two", description: "Second skill." }], removed: [] });
    continued.content = String(continued.content).replace("First line", "First line\ncontinued here");
    append(host,
      { type: "custom_message", id: "notice-1", customType: "skill-notice", content: "Skills: release-notes" } as SessionEntry,
      { type: "custom_message", id: "notice-2", customType: "skill-notice" } as SessionEntry,
      continued);
    const notes = await lookUp(host, NOTES[0]);
    expect(notes.result.isError).toBe(false);
    expect(notes.matches.map(({ at, status }) => [at, status])).toEqual([["user-0", "unknown"], ["notice-1", "unknown"], ["notice-2", "unknown"]]);
    expect(await states(host, "helper-two")).toEqual([
      { at: "user-0", via: "catalog", status: "unknown" },
      { at: "notice-1", via: "skill-notice", status: "unknown" },
      { at: "notice-2", via: "skill-notice", status: "unknown" },
      { at: "notice-3", via: "skill-notice", status: "listed", description: "Second skill." },
    ]);
    expect((await states(host, "helper-one")).at(-1)).toEqual({ at: "notice-3", via: "skill-notice", status: "unknown", description: "First line" });
    await observeCatalog(host, [SEAMS]);
    expect(catalogEntries(host)).toHaveLength(4);
  });

  it("reports an observable capture failure in the next pass and rebinds unchanged content after it", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage, ...fx.skillUrlRead]);
    await observeCatalog(host, [SEAMS]);
    expect(catalogEntries(host)).toHaveLength(2);
    host.failAppend(new Error("disk full"));
    await observeCatalog(host, [SEAMS, NOTES]);
    expect(catalogEntries(host)).toHaveLength(2);
    expect((await lookUp(host, SEAMS[0])).gaps).toEqual([expect.stringContaining("disk full")]);
    await host.runCommand("observe-report");
    expect(host.notices.at(-1)).toMatch(/\nSkill catalog observations: [^\n]*capture failed[^\n]*disk full/);

    await observeCatalog(host, [SEAMS]);
    const entries = catalogEntries(host);
    expect(entries).toHaveLength(3);
    expect(entries.at(-1)).toMatchObject({ customType: "skill-observer-catalog-binding", data: { catalogId: (entries[0]!.data as { catalogId: string }).catalogId, afterGap: expect.stringContaining("disk full") } });
    const recovered = await lookUp(host, SEAMS[0]);
    expect(recovered.matches).toHaveLength(2);
    expect(recovered.text).toMatch(/capture failed[^\n]*disk full/);
    await host.runCommand("observe");
    expect(String(host.sent.at(-1)?.message.content)).toMatch(/## Skill catalog observations[\s\S]*capture failed[^\n]*disk full/);
  });

  it("makes no final-delivery claim when a later before_agent_start handler replaces the system prompt", async () => {
    const host = loadExtension();
    host.on("before_agent_start", () => ({ systemPrompt: ["A replacement prompt with no skills."] }));
    await observeCatalog(host, [SEAMS]);
    expect(host.startResults().at(-1)).toEqual({ systemPrompt: ["A replacement prompt with no skills."] });
    expect(catalogEntries(host)[0]?.data).toMatchObject({ limitations: [expect.stringContaining("a later hook may replace the system prompt")] });
    const { text, matches } = await lookUp(host, SEAMS[0]);
    expect(matches).toEqual([expect.objectContaining({ status: "listed", limitations: [expect.stringContaining("not proof of what the model received")] })]);
    expect(text).toContain("not proof of what the model received");
    expect(text).not.toMatch(/\bdelivered\b/);
  });

  it("binds no discarded preparation to a steering message that arrives before a fresh preparation", async () => {
    const host = loadExtension();
    await host.startAgent("Write the tests.", { systemPrompt: catalogPrompt([SEAMS]) });
    await host.commitPrompt("Also update the changelog.");
    expect(catalogEntries(host)).toEqual([]);
    await host.startAgent("Also update the changelog.\n\nAnd the docs.", { systemPrompt: catalogPrompt([NOTES]) });
    await host.commitPrompt("Also update the changelog.");
    expect(await states(host, NOTES[0])).toEqual([{ at: "user-1", via: "catalog", status: "listed", description: NOTES[1] }]);
    expect(await states(host, SEAMS[0])).toEqual([{ at: "user-1", via: "catalog", status: "not-listed" }]);
  });
});

describe("catalog history across the session tree", () => {
  const SEAMS = ["seam-finder", "Finds test seams before writing tests."] as const;
  const NOTES = ["release-notes", "Drafts release notes from merged changes."] as const;
  type Host = ReturnType<typeof loadExtension>;
  const reply = (id: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }) as SessionEntry;
  const append = (host: Host, ...entries: SessionEntry[]) => host.setBranch([...host.getBranch(), ...entries]);
  /** A fresh extension instance, with no warm process state, over `branch` as OMP would load it from the saved session. */
  const restore = async (branch: readonly SessionEntry[]) => {
    const host = loadExtension();
    host.setBranch(structuredClone([...branch]));
    await host.emit("session_start");
    return host;
  };
  const lookups = async (host: Host) => Promise.all([SEAMS[0], NOTES[0], "absent-skill"].map(async (skill) => {
    const { text, matches, gaps } = await lookUp(host, skill);
    return { text, matches, gaps };
  }));

  it("returns the same lookup results from the persisted entries alone after a restore without warm memory", async () => {
    const warm = loadExtension();
    await observeCatalog(warm, [SEAMS]);
    append(warm, reply("reply-1"), skillNotice("notice-1", { added: [NOTES] }), reply("reply-2"),
      { type: "compaction", id: "compaction-1", firstKeptEntryId: "reply-2", summary: "Earlier work." } as SessionEntry);
    await observeCatalog(warm, [SEAMS, NOTES]);
    const saved = warm.getBranch().filter((entry) => !entry.id?.startsWith("result-") && !entry.id?.startsWith("assistant-"));
    warm.setBranch(saved);
    const before = await lookups(warm);
    expect(before[1]!.matches.length).toBeGreaterThan(1);
    const restored = await restore(saved);
    expect(await lookups(restored)).toEqual(before);
  });

  it("applies only the active branch's bindings after branching or rewinding, even when they share a content definition", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS, NOTES]);
    await observeCatalog(host, [SEAMS]);
    const fork = host.getBranch();
    await observeCatalog(host, [SEAMS, NOTES]);
    const first = host.getBranch();
    const firstBinding = catalogEntries(host).at(-1)!;
    expect(firstBinding.customType).toBe("skill-observer-catalog-binding");
    expect(catalogEntries(host)).toHaveLength(5);
    expect((await lookUp(host, NOTES[0])).matches.map(({ status }) => status)).toEqual(["listed", "not-listed", "listed"]);

    host.setBranch([...fork, reply("sibling-reply")]);
    await host.emit("session_tree");
    const sibling = await lookUp(host, NOTES[0]);
    expect(sibling.matches.map(({ status }) => status)).toEqual(["listed", "not-listed"]);
    expect(sibling.text).not.toContain(firstBinding.id!);

    host.setBranch([reply("rewound-reply")]);
    await host.emit("session_branch");
    expect((await lookUp(host, NOTES[0])).matches).toEqual([]);
    await observeCatalog(host, [SEAMS, NOTES]);
    const own = catalogEntries(host);
    expect(own.map(({ customType }) => customType)).toEqual(["skill-observer-catalog", "skill-observer-catalog-binding"]);
    expect((await lookUp(host, NOTES[0])).matches).toEqual([expect.objectContaining({ status: "listed", definitionId: own[0]!.id, bindingId: own[1]!.id })]);

    host.setBranch(first);
    await host.emit("session_tree");
    expect((await lookUp(host, NOTES[0])).matches.map(({ status }) => status)).toEqual(["listed", "not-listed", "listed"]);
  });

  it("still finds observations from ancestry a compaction or handoff summarized away", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS]);
    append(host, reply("reply-1"), reply("reply-2"),
      { type: "compaction", id: "compaction-1", firstKeptEntryId: "reply-2", summary: "Earlier work." } as SessionEntry,
      reply("reply-3"),
      { type: "compaction", id: "handoff-1", firstKeptEntryId: "", summary: "Handoff document." } as SessionEntry);
    await observeCatalog(host, [SEAMS]);
    expect(catalogEntries(host)).toHaveLength(2);
    expect(await lookUp(host, SEAMS[0])).toMatchObject({ gaps: [], matches: [{ observedAt: "user-0", status: "listed", description: SEAMS[1] }] });
  });

  it("reaches a forked session's copied definitions, and reports one the copy lacks unavailable instead of borrowing the source's", async () => {
    const source = loadExtension();
    await observeCatalog(source, [SEAMS]);
    append(source, reply("reply-1"));
    // OMP's branch-into-new-session copies the root-to-leaf path into the new session file.
    const copied = await restore(source.getBranch());
    await copied.emit("session_branch");
    expect(await lookups(copied)).toEqual(await lookups(source));

    const lacking = await restore(source.getBranch().filter((entry) => entry.customType !== "skill-observer-catalog"));
    const dangling = await lookUp(lacking, SEAMS[0]);
    expect(dangling.result.isError).toBe(false);
    expect(dangling.matches).toEqual([]);
    expect(dangling.gaps).toEqual([expect.stringMatching(/user-0[^\n]*definition is not on this branch[^\n]*unavailable/)]);
    expect(dangling.text).toContain("unknown, not absent");
    expect(dangling.text).not.toContain(SEAMS[1]);
    const next = `user-${lacking.getBranch().length}`;
    await observeCatalog(lacking, [SEAMS]);
    expect(catalogEntries(lacking).map(({ customType }) => customType)).toEqual(["skill-observer-catalog-binding", "skill-observer-catalog", "skill-observer-catalog-binding"]);
    expect((await lookUp(lacking, SEAMS[0])).matches).toEqual([expect.objectContaining({ status: "listed", observedAt: next })]);
  });

  it.each(["session_switch", "session_branch", "session_tree"])("leaks no staged observation or capture gap across %s", async (event) => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS]);
    host.failAppend(new Error("disk full"));
    await observeCatalog(host, [SEAMS, NOTES]);
    expect((await lookUp(host, SEAMS[0])).gaps).toEqual([expect.stringContaining("disk full")]);
    await host.startAgent("Write the tests.", { systemPrompt: catalogPrompt([NOTES]) });
    await host.emit(event);
    host.setBranch([reply("other-reply")]);
    await host.commitPrompt("Write the tests.");
    expect(catalogEntries(host)).toEqual([]);
    expect(await lookUp(host, SEAMS[0])).toMatchObject({ matches: [], gaps: [] });
    await host.runCommand("observe-report");
    expect(host.notices.at(-1)).not.toContain("disk full");
  });

  it("reports unknown, with no durability claim, when appended entries are missing after a restore", async () => {
    const warm = loadExtension();
    await observeCatalog(warm, [SEAMS]);
    await observeCatalog(warm, [SEAMS, NOTES]);
    expect((await lookUp(warm, NOTES[0])).matches.at(-1)).toMatchObject({ status: "listed" });
    const saved = warm.getBranch().filter((entry) => entry.type !== "message" || entry.message?.role === "user");

    const lost = await restore(saved.filter((entry) => entry.type !== "custom"));
    const unknown = await lookUp(lost, NOTES[0]);
    expect(unknown).toMatchObject({ matches: [], gaps: [] });
    expect(unknown.text).toContain(`whether \`${NOTES[0]}\` was listed is unknown, not absent`);
    expect(unknown.text).not.toMatch(/durab|persisted|saved/i);

    const laterDefinition = saved.filter((entry) => entry.customType === "skill-observer-catalog").at(-1)!;
    const partial = await lookUp(await restore(saved.filter((entry) => entry !== laterDefinition)), NOTES[0]);
    expect(partial.matches).toEqual([expect.objectContaining({ observedAt: "user-0", status: "not-listed" })]);
    expect(partial.gaps).toEqual([expect.stringMatching(/user-3[^\n]*unavailable/)]);
  });

  it("turns a malformed catalog definition or binding into a coverage gap instead of failing the lookup, summary or capture", async () => {
    const host = loadExtension();
    host.setBranch([...fx.plainUserMessage, ...fx.steeringUserMessage, ...fx.skillUrlRead,
      { type: "custom", id: "bad-definition", customType: "skill-observer-catalog", data: null } as unknown as SessionEntry,
      { type: "custom", id: "bad-binding", customType: "skill-observer-catalog-binding", data: { catalogId: 7 } } as unknown as SessionEntry,
      { type: "custom", id: "bad-entries", customType: "skill-observer-catalog", data: { catalogId: "c1", coverage: "observed", entries: "seam-finder", limitations: [] } } as unknown as SessionEntry,
      { type: "custom", id: "bound-to-bad", customType: "skill-observer-catalog-binding", data: { catalogId: "c1", observedAt: "user-x", boundary: "before_agent_start" } } as unknown as SessionEntry,
    ]);
    const malformed = await lookUp(host, SEAMS[0]);
    expect(malformed.result.isError).toBe(false);
    expect(malformed.matches).toEqual([]);
    expect(malformed.gaps).toEqual([
      expect.stringMatching(/bad-definition[^\n]*malformed/),
      expect.stringMatching(/bad-binding[^\n]*malformed/),
      expect.stringMatching(/bad-entries[^\n]*malformed/),
      expect.stringMatching(/user-x[^\n]*unavailable/),
    ]);
    await host.runCommand("observe-report");
    expect(host.notices.at(-1)).toMatch(/Skill catalog observations: none on this branch[^\n]*bad-definition[^\n]*malformed/);
    await observeCatalog(host, [SEAMS]);
    expect((await lookUp(host, SEAMS[0])).matches).toEqual([expect.objectContaining({ status: "listed" })]);
  });

  it("drops skill notices before a /clear reset boundary and binds the next observation again even when unchanged", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS]);
    append(host, reply("reply-1"), skillNotice("notice-1", { added: [NOTES] }), reply("reply-2"), { type: "reset_boundary", id: "reset-1" } as SessionEntry);
    expect((await lookUp(host, NOTES[0])).matches.map(({ at, via, status }) => [at, via, status])).toEqual([
      ["user-0", "catalog", "not-listed"], ["notice-1", "skill-notice", "listed"], ["reset-1", "reset", "unknown"],
    ]);
    await host.emit("session_clear");
    const next = `user-${host.getBranch().length}`;
    await observeCatalog(host, [SEAMS]);
    expect(catalogEntries(host).map(({ customType }) => customType)).toEqual(["skill-observer-catalog", "skill-observer-catalog-binding", "skill-observer-catalog-binding"]);
    const after = await lookUp(host, NOTES[0]);
    expect(after.matches.at(-1)).toMatchObject({ observedAt: next, via: "catalog", status: "not-listed" });
    expect(after.text).toMatch(/reset-1[^\n]*\/clear/);
  });
});

describe("targeted catalog search", () => {
  const SEAMS = ["seam-finder", "Finds test seams before writing tests."] as const;
  const NOTES = ["release-notes", "Drafts release notes from merged changes."] as const;
  const PLANNER = ["test-planner", "Plans TESTS before any code."] as const;
  const RUNNER = ["tests-before-runner", "Runs the suite."] as const;
  type Host = ReturnType<typeof loadExtension>;
  type Match = { skill: string; observedAt: string; via: string; status: string; description?: string; definitionId: string };
  const reply = (id: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }) as SessionEntry;
  const append = (host: Host, ...entries: SessionEntry[]) => host.setBranch([...host.getBranch(), ...entries]);
  const search = async (host: Host, params: Record<string, unknown>) => {
    const result = await host.callTool("observer_review", { action: "catalog", ...params });
    const catalog = (result.details as { catalog?: { matches: Match[]; gaps: string[]; total: number; next?: string } }).catalog;
    return { result, text: result.content.map((block) => block.text ?? "").join("\n"), matches: catalog?.matches ?? [], gaps: catalog?.gaps ?? [], total: catalog?.total, next: catalog?.next };
  };
  const userIds = (host: Host) => host.getBranch().filter((entry) => entry.message?.role === "user").map(({ id }) => id!);

  it("matches every case-insensitive term in the description only, keeping exact-name lookup separate", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS, NOTES, PLANNER, RUNNER]);
    append(host, reply("reply-1"), skillNotice("notice-1", { added: [["coverage-check", "Checks tests BEFORE merge."]] }));
    const found = await search(host, { terms: ["tests", " Before "] });
    expect(found.result.isError).toBe(false);
    expect(found.matches.map(({ skill, via, description }) => [skill, via, description])).toEqual([
      ["coverage-check", "skill-notice", "Checks tests BEFORE merge."], ["seam-finder", "catalog", SEAMS[1]], ["test-planner", "catalog", PLANNER[1]],
    ]);
    expect(found.matches.every(({ description }) => /tests/i.test(description!) && /before/i.test(description!))).toBe(true);
    expect(found.text).not.toContain(RUNNER[0]);
    expect(found.text).not.toContain(NOTES[0]);

    expect((await search(host, { skill: "test" })).matches).toEqual([expect.objectContaining({ skill: "test", status: "not-listed" })]);
    expect((await search(host, { skill: SEAMS[0], terms: ["tests"] })).result.isError).toBe(true);
  });

  it("resolves a point to the latest observation at or before it, with its real position and only the gaps between", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS]);
    append(host, reply("reply-1"));
    await observeCatalog(host, [SEAMS]);
    host.failAppend(new Error("disk full"));
    await observeCatalog(host, [SEAMS, NOTES]);
    append(host, reply("reply-2"));
    await observeCatalog(host, [SEAMS, NOTES]);
    const [first, unchanged, failed, last] = userIds(host);

    const point = await search(host, { skill: SEAMS[0], at: "reply-2" });
    expect(point.result.isError).toBe(false);
    expect(point.matches.map(({ observedAt, status }) => [observedAt, status])).toEqual([[first, "listed"]]);
    expect(point.gaps).toEqual([expect.stringMatching(new RegExp(`${failed}[^\\n]*disk full`))]);
    expect(point.text).toContain(`latest observation at or before entry \`reply-2\` is at entry \`${first}\``);
    expect(point.text).not.toContain(`\`${unchanged}\``);

    expect(await search(host, { skill: SEAMS[0], at: first })).toMatchObject({ gaps: [], matches: [{ observedAt: first }] });
    expect(await search(host, { skill: NOTES[0], at: last })).toMatchObject({ gaps: [], matches: [{ observedAt: last, status: "listed" }] });
    expect(await search(host, { terms: ["release"], at: unchanged })).toMatchObject({ matches: [] });

    const sibling = host.getBranch();
    host.setBranch(sibling.slice(0, sibling.findIndex(({ id }) => id === "reply-1")));
    for (const at of ["reply-2", "no-such-entry"]) {
      const refused = await search(host, { skill: SEAMS[0], at });
      expect(refused.result.isError).toBe(true);
      expect(refused.text).toContain(at);
    }
  });

  it("keeps each historical observation position without a point, even when they share a definition", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS, NOTES]);
    await observeCatalog(host, [[SEAMS[0], "Finds seams."], NOTES]);
    await observeCatalog(host, [SEAMS, NOTES]);
    const found = await search(host, { terms: ["seams"] });
    expect(found.matches.map(({ observedAt }) => observedAt)).toEqual(userIds(host));
    expect(found.matches[0]!.definitionId).toBe(found.matches[2]!.definitionId);
  });

  it("pages through unchanged evidence in observation then name order, and refuses a continuation after the evidence changed", async () => {
    const host = loadExtension();
    const skills = ["delta", "alpha", "charlie", "bravo"].map((name) => [name, `Helps with tests for ${name}.`] as const);
    await observeCatalog(host, skills);
    await observeCatalog(host, skills.slice(1));
    const all = await search(host, { terms: ["tests"], limit: 100 });
    const [first, second] = userIds(host);
    expect(all.matches.map(({ observedAt, skill }) => [observedAt, skill])).toEqual([
      ...["alpha", "bravo", "charlie", "delta"].map((skill) => [first, skill]),
      ...["alpha", "bravo", "charlie"].map((skill) => [second, skill]),
    ]);
    expect(all).toMatchObject({ total: 7, next: undefined });

    const paged: Match[] = [];
    let page = await search(host, { terms: ["tests"], limit: 3 });
    expect(page.text).toContain("4 more");
    paged.push(...page.matches);
    while (page.next) {
      append(host, reply(`reply-${paged.length}`));
      page = await search(host, { terms: ["tests"], limit: 3, cursor: page.next });
      expect(page.result.isError).toBe(false);
      paged.push(...page.matches);
    }
    expect(paged).toEqual(all.matches);

    const restart = await search(host, { terms: ["tests"], limit: 3 });
    expect((await search(host, { terms: ["helps"], limit: 3, cursor: restart.next })).result.isError).toBe(true);
    await observeCatalog(host, skills);
    const stale = await search(host, { terms: ["tests"], limit: 3, cursor: restart.next });
    expect(stale.result.isError).toBe(true);
    expect(stale.text).toMatch(/changed[^]*without `cursor`/);
  });

  it("refuses a blank query instead of dumping the catalog, and a miss claims no global absence", async () => {
    const host = loadExtension();
    await observeCatalog(host, [SEAMS, NOTES]);
    for (const query of [{}, { terms: [] }, { terms: ["  ", ""] }, { skill: "  " }]) {
      const refused = await search(host, query);
      expect(refused.result.isError).toBe(true);
      expect(refused.text).not.toContain(SEAMS[1]);
    }
    const miss = await search(host, { terms: ["deploy"] });
    expect(miss.result.isError).toBe(false);
    expect(miss.matches).toEqual([]);
    expect(miss.text).toContain("not evidence");
    expect(miss.text).toContain("observed on this branch");
  });
});

const escapeHtmlText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
