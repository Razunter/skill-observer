import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { PathLike } from "node:fs";
import type * as NodeFS from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerResolveTool } from "../src/resolve.js";
import { registerReviewTool } from "../src/review.js";
import { OBSERVATION_MESSAGE_TYPE } from "../src/digest.js";
import type { AskDetails, ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition, ToolResultDetails } from "../src/omp.js";
import { type Evidence, harnessFingerprint, hookFileKey, projectFingerprint, proposalFingerprint, putLedgerRecords, readLedger, removalFingerprint, type HarnessLedgerRecord, type LedgerRecord } from "../src/ledger.js";
import { readObserverStore, writeObserverStore } from "../src/observer-store.js";
import { markObservationsShown, readPendingObservations, recordObservation } from "../src/observations.js";
import * as amendments from "../src/amendments.js";
import { replaceReferenceFiles } from "../src/references.js";
import { buildDigest } from "../src/digest.js";
import { AMENDMENT_DELIVERY_TYPE } from "../src/reminder.js";
import { remedyOutcomes } from "../src/outcomes.js";
import { HOOK_CHECK_PATH, INSTRUCTIONS_PATH, toolResultGuidance } from "../src/payload.js";
import { createProvenanceResolver, skillHash } from "../src/provenance.js";
import { projectToolAuthorization } from "../src/project-publication.js";
import { observationPassStart } from "../src/proposal-approval.js";
import { recordHookCall, recordHookResult } from "../src/session-tool-evidence.js";
import { groundRepairs } from "./grounding.js";
import { zod } from "./host-schema.js";
import { makeSkillHome } from "./skill-home.js";

const renameFault = vi.hoisted(() => ({ check: undefined as ((from: PathLike, to: PathLike) => void) | undefined }));
const writeFault = vi.hoisted(() => ({ check: undefined as ((file: unknown, data: unknown) => void) | undefined }));
const readFault = vi.hoisted(() => ({ check: undefined as ((file: unknown) => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof NodeFS>();
  return {
    ...actual,
    renameSync(from: PathLike, to: PathLike) {
      renameFault.check?.(from, to);
      actual.renameSync(from, to);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      writeFault.check?.(args[0], args[1]);
      actual.writeFileSync(...args);
    },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      readFault.check?.(args[0]);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const homes: string[] = [];
afterEach(() => {
  renameFault.check = undefined; writeFault.check = undefined; readFault.check = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const { home, roots } = makeSkillHome(); homes.push(home);
  mkdirSync(roots.cwd, { recursive: true });
  vi.stubEnv("HOME", home); vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".omp/agent"));
  type Selected = { reference: unknown; proposal: { candidateId: string; gist: string; preview: string; alternatives?: Array<{ change: { operation: string }; preview: string }> } };
  type Details = { failures: string[]; deferred: string[]; cleanup: string[]; records: LedgerRecord[]; publications: unknown[]; selected: Selected[]; recording: { rows: string[]; error?: string } };
  const tools: Record<string, ToolDefinition<unknown, Details>> = {};
  const files = { storeFile: () => join(home, "observer.sqlite"), rulesDir: () => join(home, "rules"), amendmentsDir: () => join(home, "amendments"), referencesDir: () => join(home, "refs") };
  const pi = { zod, registerTool: (value: ToolDefinition<unknown, Details>) => { tools[value.name] = value; },
    appendEntry: (customType: string, data: SessionEntry["data"]) => { branch.push({ type: "custom", customType, data }); },
    getAllTools: () => ["write", "edit", "bash"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
  } as unknown as ExtensionAPI;
  registerResolveTool(pi, files);
  registerReviewTool(pi, files, () => undefined);
  let branch: SessionEntry[] = [];
  const startPass = () => branch.push({ type: "custom_message", customType: OBSERVATION_MESSAGE_TYPE, content: "Observation pass." });
  startPass();
  const ctx = { cwd: roots.cwd, hasUI: true, sessionManager: { getSessionId: () => "test", getBranch: () => branch } } as unknown as ExtensionContext;
  /** Runs a registered tool, then saves its native call and result on the branch, as OMP does. */
  const call = async (name: string, params: unknown) => {
    const id = `${name}-${branch.length}`;
    const result = await tools[name]!.execute(id, params, undefined, undefined, ctx);
    if (!result.details) throw new Error(`${name} returned no details`);
    branch = [...branch, toolCall(id, name, params as Record<string, unknown>),
      { type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: result.content, details: result.details as unknown as ToolResultDetails, isError: result.isError ?? false } }];
    return { ...result, id, details: result.details };
  };
  const run = (params: unknown) => call("observer_resolve", params);
  /**
   * Prepares and selects `candidates`, then saves an Ask of the form Select
   * returned, answered by choosing `select` in each fieldset. The choice is
   * the only synthetic part. Returns each selected proposal's approval in
   * selection order.
   */
  const approve = async (candidates: unknown[], select = "Apply") => {
    const grounded = await groundRepairs(candidates, (skill) => call("observer_review", { action: "inspect", skill }));
    const prepared = await call("observer_review", { action: "prepare", candidates: grounded });
    if (prepared.isError) throw new Error(prepared.details.failures.join("; "));
    const selection = await call("observer_review", { action: "select", proposals: (prepared.details as unknown as { eligible: Selected[] }).eligible.map((entry) => entry.reference) });
    const { askHtml } = JSON.parse(selection.content[0]!.text) as { askHtml: string };
    const answer: AskDetails = { answers: selection.details.selected.map(({ proposal }) => ({ name: proposal.candidateId, question: proposal.gist, answer: select })) };
    const askToolCallId = `ask-${branch.length}`;
    branch = [...branch, toolCall(askToolCallId, "ask", { html: askHtml }),
      { type: "message", message: { role: "toolResult", toolCallId: askToolCallId, toolName: "ask", content: [], details: answer, isError: false } }];
    return selection.details.selected.map(({ reference }) => ({ proposal: reference, selectionToolCallId: selection.id, askToolCallId }));
  };
  /** Applies an on-read fix through Prepare, Select and an Ask the user answered Apply. */
  const add = async (gist: string, skill = "tdd", evidence?: Evidence[]) => {
    const [approval] = await approve([{ kind: "upstream", skill, gist, priority: "evidence", remedy: "Fix", change: { operation: "on-read-append", section: `## ${gist}\nFix ${gist}.` } }]);
    return run({ outcomes: [{ skill, kind: "upstream", gist, outcome: "applied", ...(evidence && { evidence }), approval }] });
  };
  /** The approved withdrawals of `records`, each rewriting the amendment with the draft `draft` gives it. */
  const withdraw = async (records: readonly LedgerRecord[], draft: (i: number) => { body: string; references?: Array<{ name: string; body: string }> }) => {
    const approvals = await approve(records.map((record, i) => ({ kind: "upstream", skill: "tdd", gist: record.gist, fingerprint: record.fingerprint, priority: "note",
      remedy: "Take it back", change: { operation: "withdrawal", ...draft(i) } })));
    return records.map((record, i) => ({ skill: "tdd", kind: "upstream", gist: record.gist, fingerprint: record.fingerprint, outcome: "withdrawn", approval: approvals[i] }));
  };
  /** A compaction candidate of `tdd`'s on-read amendment, covering no addition of its Prepare. */
  const compaction = (body: string, references: Array<{ name: string; body: string }> = []) =>
    ({ kind: "upstream", skill: "tdd", gist: "Compact tdd", priority: "compaction", remedy: "Keep it short", change: { operation: "compaction", includes: [], body, references } });
  const saveTool = (id: string, name: string, args: Record<string, unknown>, details?: ToolResultDetails) => {
    branch = [...branch, toolCall(id, name, args),
      { type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: "ok", isError: false, ...(details && { details }) } }];
  };
  const saveOwner = (toolCallId: string, toolName: string, input: Record<string, unknown>, details?: ToolResultDetails, run?: () => string | void) => {
    const event = { toolCallId, toolName, input };
    const authorization = projectToolAuthorization(event, roots.cwd, branch, observationPassStart(branch)!);
    expect(authorization).toBeTruthy();
    recordHookCall(pi, event, authorization);
    branch.push(toolCall(toolCallId, toolName, input));
    const output = run?.();
    const content = typeof output === "string" ? [{ type: "text" as const, text: output }] : [];
    recordHookResult(pi, { ...event, details, content, isError: false }, branch);
    branch.push({ type: "message", message: { role: "toolResult", toolCallId, toolName, content, details, isError: false } });
  };
  return { files, roots, run, add, approve, withdraw, compaction, saveTool, saveOwner, startPass, branch: () => branch };
}

async function publishDirectEdit(f: ReturnType<typeof fixture>) {
  const skill = "ce-commit-jj";
  const gist = "Edit the commit skill";
  const [approval] = await f.approve([{
    kind: "local", skill, gist, priority: "evidence", remedy: "Fix",
    change: { operation: "direct-edit", preview: "+ Use jj." },
  }]);
  const path = join(f.roots.skillsDir, skill, "SKILL.md");
  const content = `${readFileSync(path, "utf8")}\nUse jj.\n`;
  writeFileSync(path, content);
  f.saveTool("edit-skill", "write", { path, content });
  return { path, content, outcome: { kind: "local", skill, gist, outcome: "applied", approval, publication: { writeToolCallId: "edit-skill" } } };
}

async function publishProjectEdit(f: ReturnType<typeof fixture>) {
  const target = { scope: "project", root: f.roots.cwd, path: "config.txt", mechanism: "configure build" } as const;
  const path = join(target.root, target.path);
  const content = "new config\n";
  const gist = "Update config";
  const check = "grep -Fx 'new config' config.txt";
  const [approval] = await f.approve([{ kind: "project", target, gist, priority: "evidence", remedy: gist,
    change: { operation: "project-edit", text: content, check } }]);
  f.saveOwner("write-config", "write", { path, content }, undefined, () => writeFileSync(path, content));
  f.saveOwner("check-config", "bash", { command: check, cwd: f.roots.cwd }, { exitCode: 0 });
  return { path, outcome: { kind: "project", target, gist, outcome: "applied", approval,
    publication: { writeToolCallId: "write-config", checkToolCallIds: ["check-config"], afterHash: createHash("sha256").update(content).digest("hex") } } };
}

async function approveHookRemoval(f: ReturnType<typeof fixture>, path: string, checkToolCallId: string) {
  const target = { scope: "harness", root: "project-hooks", project: f.roots.cwd, path, mechanism: "Remove hook" } as const;
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "omp-observe-check."));
  homes.push(scratch);
  const samples = join(scratch, "samples.json");
  writeFileSync(samples, JSON.stringify(["mistake", "legitimate"].map((role) => ({
    name: role, role, event: "tool_call", toolName: "bash", input: { command: role }, expect: "untouched",
  }))));
  const command = `bun --no-env-file '${HOOK_CHECK_PATH}' --absent '${path}' '${samples}'`;
  const check = (id: string, cwd: string) => f.saveOwner(id, "bash", { command, cwd }, { exitCode: 0 }, () => {
    const result = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  });
  check(checkToolCallId, scratch);
  const [approval] = await f.approve([{
    kind: "harness", target, gist: target.mechanism, priority: "evidence", remedy: "Retire fixture hook",
    change: { operation: "harness", stage: "checked", files: [{ path }], checkToolCallId, lowerRungs: "A wording change cannot retire an installed hook." },
    evidence: [{ quote: "Hook no longer needed", count: 1 }],
  }]);
  if (!approval) throw new Error("checked hook removal was not selected");
  return { approval, check };
}
const toolCall = (id: string, name: string, args: Record<string, unknown>): SessionEntry =>
  ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });

async function declinedFixes(f: ReturnType<typeof fixture>, skill: string, gists: string[]) {
  const approvals = await f.approve(gists.map((gist) => ({
    kind: "upstream", skill, gist, priority: "evidence", remedy: "Fix",
    change: { operation: "on-read-append", section: `## ${gist}\n\nFix ${gist}.` },
  })), "Decline");
  expect(approvals).toHaveLength(gists.length);
  return approvals.map(({ proposal }) => ({ proposal, outcome: "declined" }));
}

it("refuses Resolve on an unmigrated profile even when its legacy proposal ledger is empty", async () => {
  const f = fixture();
  writeFileSync(join(f.roots.cwd, "..", "ledger.jsonl"), "");
  const result = await f.run({ outcomes: [{ skill: "tdd", kind: "upstream", gist: "Skip it", outcome: "declined" }] });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("scripts/migrate-observer-store.ts");
  expect(existsSync(f.files.storeFile())).toBe(false);
});
it("does not initialize a fresh store for an empty or refused Resolve", async () => {
  const f = fixture();
  const empty = await f.run({ outcomes: [] });
  expect(empty.isError).toBe(false);
  const refused = await f.run({ outcomes: [], stale: [{ rule: "missing-amendment", action: "keep" }] });
  expect(refused.details.failures).toEqual([expect.stringContaining("no rule named")]);
  expect(refused.details.records).toEqual([]);
  expect(existsSync(f.files.storeFile())).toBe(false);
});
it("binds an existing fingerprint to its skill for Later while accepting a reworded gist", async () => {
  const f = fixture(); await f.add("first");
  const original = readLedger(f.files.storeFile())[0]!;
  const bad = await f.run({ outcomes: [{ skill: "domain-modeling", kind: "upstream", gist: "reworded", fingerprint: original.fingerprint, outcome: "later" }] });
  expect(bad.details.failures).toHaveLength(1);
  expect(readLedger(f.files.storeFile())).toHaveLength(1);
  const good = await f.run({ outcomes: [{ skill: "tdd", kind: "upstream", gist: "reworded", fingerprint: original.fingerprint, outcome: "later" }] });
  expect(good.details.failures).toEqual([]);
  expect(readLedger(f.files.storeFile()).at(-1)?.gist).toBe("reworded");
});
it("refuses a native Decline when another skill has claimed its fingerprint", async () => {
  const f = fixture();
  const [decline] = await declinedFixes(f, "tdd", ["first"]);
  const fingerprint = proposalFingerprint("tdd", "first");
  const other = { skill: "domain-modeling", kind: "upstream", gist: "Other", fingerprint, outcome: "later",
    timestamp: new Date().toISOString(), sessionId: "other-session" } as const;
  writeObserverStore(f.files.storeFile(), new Date(), (db) => putLedgerRecords(db, [other]));
  const result = await f.run({ outcomes: [decline] });
  expect(result.details.failures).toEqual([expect.stringContaining("belongs to another skill")]);
  expect(result.details.records).toEqual([]);
  expect(readLedger(f.files.storeFile())).toEqual([other]);
});
it("binds a new fingerprint to the first skill claiming it in one batch", async () => {
  const f = fixture();
  const [first] = await declinedFixes(f, "tdd", ["first"]);
  const fingerprint = proposalFingerprint("tdd", "first");
  const result = await f.run({ outcomes: [
    first,
    { skill: "domain-modeling", kind: "upstream", gist: "second", fingerprint, outcome: "later" },
  ] });
  expect(result.details.failures).toHaveLength(1);
  expect(readLedger(f.files.storeFile())).toMatchObject([{ fingerprint, skill: "tdd", outcome: "declined" }]);
});
it("lets a later skill claim a fingerprint whose first claimant failed validation", async () => {
  const f = fixture();
  const result = await f.run({ outcomes: [
    { skill: "tdd", kind: "upstream", gist: "first", fingerprint: "shared", outcome: "applied", rule: { body: "no section heading" } },
    { skill: "domain-modeling", kind: "upstream", gist: "second", fingerprint: "shared", outcome: "later" },
  ] });
  expect(result.details.failures).toHaveLength(1);
  expect(readLedger(f.files.storeFile())).toMatchObject([{ fingerprint: "shared", skill: "domain-modeling", outcome: "later" }]);
});
it("rechecks affected decisions after replay without refusing independent answers", async () => {
  const f = fixture();
  await f.add("First fix");
  const file = f.files.storeFile();
  const [first] = readLedger(file);
  if (!first?.skill) throw new Error("missing applied skill fix");
  const other = (fingerprint: string, fields: Partial<typeof first> = {}): typeof first =>
    ({ ...first, fingerprint, gist: fingerprint, rule: undefined, outcome: "later", ...fields });
  const oldEvidence = [{ quote: "before replay", count: 1 }];
  const newEvidence = [{ quote: "during replay", count: 2 }];
  const hookDir = join(f.roots.cwd, ".omp/hooks/pre");
  const hook = join(hookDir, "fixture.ts");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(hook, "export default function () {}\n");
  const hookDecision = (project: string, mechanism: string): HarnessLedgerRecord => {
    const target = { scope: "harness", root: "project-hooks", project, path: "fixture.ts", mechanism } as const;
    return { kind: "harness", target, fingerprint: harnessFingerprint(target), gist: mechanism, outcome: "applied", timestamp: first.timestamp, sessionId: first.sessionId };
  };
  const existingHook = hookDecision(f.roots.cwd, "First hook decision");
  const lateHook = hookDecision(f.roots.cwd, "Second hook decision");
  const outsideHook = hookDecision(join(f.roots.cwd, "..", "another"), "Different project");
  writeObserverStore(file, new Date(), (db) => putLedgerRecords(db, [
    other("evidence", { evidence: oldEvidence }),
    existingHook, outsideHook,
    ...Array.from({ length: 64 }, (_, i) => other(`unrelated-${i}`, { rule: `/old/other-${i}.md` })),
  ]));
  const outcomes = await f.withdraw([first], () => ({ body: "" }));
  const [barrier] = await f.approve([{
    kind: "local", skill: "ce-commit-jj", gist: "Commit with jj", priority: "evidence", remedy: "Fix",
    change: { operation: "rule", name: "jj-not-git", body: "Use jj.", pattern: "\\bgit commit\\b", scope: "tool:bash",
      matches: [{ command: "git commit -m x" }], spares: [{ command: "jj commit -m x" }] },
  }]);
  const { approval: removal, check: checkRemoval } = await approveHookRemoval(f, basename(hook), "scratch-removal");
  f.saveOwner("remove-hook", "edit", { input: `*** Begin Patch\n[${hook}#0000]\nREM\n*** End Patch` }, undefined, () => rmSync(hook));
  checkRemoval("check-removed-hook", hookDir);
  const publication = { writeToolCallIds: ["remove-hook"], checkToolCallIds: ["check-removed-hook"], files: [{ path: basename(hook), afterHash: null }] };
  const direct = await publishDirectEdit(f);
  const project = await publishProjectEdit(f);
  const directFingerprint = proposalFingerprint(direct.outcome.skill, direct.outcome.gist);
  const scopedFingerprint = projectFingerprint(project.outcome.target);
  const declines = await declinedFixes(f, "tdd", ["Keep applied", "Independent"]);
  const appliedFingerprint = proposalFingerprint("tdd", "Keep applied");
  vi.stubEnv("PATH", "");
  const pending = f.run({ outcomes: [
    ...outcomes,
    direct.outcome, project.outcome,
    { kind: "harness", outcome: "applied", approval: removal, publication },
    { skill: "ce-commit-jj", kind: "local", gist: "Commit with jj", outcome: "applied", approval: barrier },
    { skill: "tdd", kind: "upstream", gist: "Wrong owner", fingerprint: "claimed", outcome: "later" },
    declines[0],
    { skill: "tdd", kind: "upstream", gist: "Reuse fresh evidence", fingerprint: "evidence", outcome: "later" },
    declines[1],
  ] });
  // A separate process must be able to commit while Resolve is waiting on replay.
  const concurrent = [
    other("dependent", { outcome: "applied", rule: `/previous/location/${basename(first.rule!)}` }),
    other("claimed", { skill: "domain-modeling" }),
    other(appliedFingerprint, { outcome: "applied" }),
    other("evidence", { evidence: newEvidence }),
    lateHook,
    other(directFingerprint, { evidence: oldEvidence }),
    other(scopedFingerprint, { evidence: oldEvidence }),
  ];
  const writer = spawnSync(process.execPath, ["--no-env-file", "-e", `
    import { putLedgerRecords } from "./src/ledger.ts";
    import { writeObserverStore } from "./src/observer-store.ts";
    const [file, rows] = process.argv.slice(1);
    writeObserverStore(file, new Date(), (db) => putLedgerRecords(db, JSON.parse(rows)));
  `, file, JSON.stringify(concurrent)], { encoding: "utf8" });
  expect(writer.status, writer.stderr).toBe(0);
  const result = await pending;
  expect(result.details.failures).toEqual(expect.arrayContaining([
    expect.stringContaining("belongs to another skill"), expect.stringContaining("also holds `dependent`"),
  ]));
  expect(result.details.deferred).toHaveLength(1);
  const text = result.content[0]!.text;
  expect(text).toMatch(/Unrecorded publication[\s\S]*belongs to another/);
  expect(text).toContain(`\`${direct.path}\``);
  expect(text).toContain(`\`${project.path}\``);
  expect(text).toMatch(/Don.t call `observer_resolve` again[\s\S]*redo/);
  expect(result.details.failures, text).toHaveLength(4);
  expect(readFileSync(direct.path, "utf8")).toBe(direct.content);
  expect(readFileSync(project.path, "utf8")).toBe("new config\n");
  expect(existsSync(hook)).toBe(false);
  expect(text).toContain("1 Decline(s) of a fix in force");
  expect(result.details.records).toMatchObject([
    { fingerprint: existingHook.fingerprint, outcome: "withdrawn", publication }, { fingerprint: lateHook.fingerprint, outcome: "withdrawn", publication },
    { gist: "Commit with jj", outcome: "later" },
    { fingerprint: "evidence", outcome: "later", evidence: newEvidence }, { gist: "Independent", outcome: "declined" },
  ]);
  expect(result.details.recording.rows).toEqual(["recorded", "recorded", "recorded", "recorded", "recorded"]);
  expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")?.body).toContain("First fix");
  const final = readLedger(file);
  for (const fingerprint of [scopedFingerprint, directFingerprint]) {
    expect(final.find((record) => record.fingerprint === fingerprint)).toMatchObject({ skill: "tdd", evidence: oldEvidence });
  }
  expect(final.find(({ fingerprint }) => fingerprint === outsideHook.fingerprint)).toMatchObject({ outcome: "applied" });
  expect(final.slice(-9)).toMatchObject([
    { fingerprint: "claimed", skill: "domain-modeling" }, { fingerprint: appliedFingerprint, outcome: "applied" },
    { fingerprint: directFingerprint }, { fingerprint: scopedFingerprint },
    { fingerprint: existingHook.fingerprint, outcome: "withdrawn" }, { fingerprint: lateHook.fingerprint, outcome: "withdrawn" },
    { gist: "Commit with jj", outcome: "later" }, { fingerprint: "evidence", evidence: newEvidence },
    { gist: "Independent", outcome: "declined" },
  ]);
});

it("does not record past hook approvals or claim publication when an absent hook has no owner receipt", async () => {
  const f = fixture();
  const target = { scope: "harness", root: "project-hooks", project: f.roots.cwd, path: "fixture.ts", mechanism: "Remove hook" } as const;
  const dir = join(f.roots.cwd, ".omp/hooks/pre");
  const path = join(dir, target.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, "export default function () {}\n");
  const { approval: past } = await approveHookRemoval(f, target.path, "past-scratch-removal");
  f.startPass();
  const { approval: current } = await approveHookRemoval(f, target.path, "current-scratch-removal");
  // The reviewed postimage is present, but no approved tool removed the hook.
  rmSync(path);
  const fingerprint = removalFingerprint(hookFileKey(target, "")!);
  const claim = { skill: "tdd", kind: "upstream", gist: "Bind the fingerprint", outcome: "later", fingerprint };
  const publication = { writeToolCallIds: ["missing-write"], checkToolCallIds: ["missing-check"], files: [{ path: target.path, afterHash: null }] };
  const result = await f.run({ outcomes: [
    claim,
    { kind: "harness", outcome: "applied", approval: past, publication },
    { kind: "harness", outcome: "applied", approval: current, publication },
  ] });
  expect(result.isError).toBe(true);
  expect(result.details.failures).toHaveLength(2);
  expect(result.details.failures).toEqual(expect.arrayContaining([
    expect.stringContaining("earlier observation pass"),
    expect.stringContaining(`\`${path}\`: write not confirmed`),
  ]));
  expect(result.details.records).toMatchObject([claim]);
  expect(result.details.recording.rows).toEqual(["recorded"]);
  expect(readLedger(f.files.storeFile())).toMatchObject([claim]);
  expect(result.content[0]?.text).not.toMatch(/Published files:|Unrecorded publication/);
  expect(existsSync(path)).toBe(false);
});
/** Writes half the data to a rule file, as a full disk would, then fails. */
function failRuleWriteMidway(rulesDir: string) {
  writeFault.check = (file, data) => {
    if (typeof file !== "string" || !file.startsWith(rulesDir) || typeof data !== "string") return;
    writeFault.check = undefined;
    writeFileSync(file, data.slice(0, data.length / 2));
    throw new Error("ENOSPC: no space left on device");
  };
}
it("keeps an amendment intact when appending a section fails midway", async () => {
  const f = fixture(); await f.add("first");
  const path = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.path;
  const before = readFileSync(path, "utf8");
  failRuleWriteMidway(f.files.amendmentsDir());
  const result = await f.add("second");
  expect(result.details.failures).toHaveLength(1);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readdirSync(f.files.amendmentsDir())).toEqual([basename(path)]);
});
it("does not count an addition whose append failed toward the coverage of a compaction in the same call", async () => {
  const f = fixture(); await f.add("first");
  const path = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.path;
  const before = readFileSync(path, "utf8");
  const [addition, compaction] = await f.approve([
    { kind: "upstream", skill: "tdd", gist: "second", priority: "evidence", remedy: "Fix", change: { operation: "on-read-append", section: "## second\nFix second." } },
    { ...f.compaction("## Short\n\nFix first and second."), change: { operation: "compaction", includes: ["second"], body: "## Short\n\nFix first and second.", references: [] } },
  ]);
  failRuleWriteMidway(f.files.amendmentsDir());
  const result = await f.run({
    outcomes: [{ skill: "tdd", kind: "upstream", gist: "second", outcome: "applied", approval: addition }],
    compactions: [{ skill: "tdd", outcome: "applied", approval: compaction }],
  });
  expect(result.details.failures).toEqual([expect.stringContaining("ENOSPC")]);
  expect(result.details.deferred).toEqual([expect.stringContaining("includes additions this call didn't apply")]);
  expect(result.details.publications).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readLedger(f.files.storeFile()).slice(1)).toMatchObject([{ compaction: true, outcome: "later" }]);
});
it("keeps a rule intact when rewriting it fails midway", () => {
  const f = fixture();
  const rule = { name: "check-first", path: join(f.files.rulesDir(), "check-first.md"), description: "Check first", condition: "x", scope: "tool:bash", amends: "tdd", fingerprint: "fp", body: "Old body." };
  amendments.writeObserverRule(rule);
  const before = readFileSync(rule.path, "utf8");
  failRuleWriteMidway(f.files.rulesDir());
  expect(() => amendments.writeObserverRule({ ...rule, body: "New body." })).toThrow(/ENOSPC/);
  expect(readFileSync(rule.path, "utf8")).toBe(before);
  expect(readdirSync(f.files.rulesDir())).toEqual(["check-first.md"]);
});
it("rewrites a symlinked rule through its link", () => {
  const f = fixture();
  const real = join(f.files.rulesDir(), "..", "dotfiles", "check-first.md");
  const rule = { name: "check-first", path: real, description: "Check first", condition: "x", scope: "tool:bash", amends: "tdd", fingerprint: "fp", body: "Old body." };
  amendments.writeObserverRule(rule);
  const linked = { ...rule, path: join(f.files.rulesDir(), "check-first.md") };
  mkdirSync(f.files.rulesDir(), { recursive: true });
  symlinkSync(real, linked.path);
  amendments.writeObserverRule({ ...linked, body: "New body." });
  expect(lstatSync(linked.path).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, "utf8")).toContain("New body.");
});
it("classifies a resolver-published remedy by the rule name its delivery carries", async () => {
  const f = fixture();
  const evidence = [{ quote: 'Tool error in `bash` "check": "failed"', count: 1 }];
  await f.add("check", "tdd", evidence);
  const record = readLedger(f.files.storeFile())[0]!;
  const name = basename(record.rule!, ".md");
  const env = { provenance: { byName: (skill: string) => ({ kind: "unknown" as const, name: skill }), byPath: (path: string) => ({ kind: "unknown" as const, name: path }) } };
  const digest = buildDigest([
    { type: "custom", customType: AMENDMENT_DELIVERY_TYPE, data: { skill: "tdd", rules: [name] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "after", name: "bash", arguments: { command: "check" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "after", toolName: "bash", content: "ok" } },
  ], env);
  expect(remedyOutcomes([record], digest)[0]).toMatchObject({ status: "exercised-clean", evidence: ["tool-result:after"] });
});
it.each(["body", "references"])("rejects conflicting same-amendment withdrawal %s before either writes", async difference => {
  const f = fixture(); await f.add("first"); await f.add("second");
  const records = readLedger(f.files.storeFile());
  const before = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.body;
  const body = `Remaining; read ${join(f.files.referencesDir(), "tdd", "keep.md")}`;
  const outcomes = await f.withdraw(records, (i) => ({ body: difference === "body" && i ? `${body}\nDifferent` : body,
    references: [{ name: "keep.md", body: difference === "references" && i ? "Different" : "Same" }] }));
  const result = await f.run({ outcomes });
  expect(result.details.failures.join(" ")).toContain("identical final body and references");
  expect(result.details.failures).toHaveLength(2);
  expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.body).toBe(before);
  expect(readLedger(f.files.storeFile())).toHaveLength(2);
});
it("accepts identical withdrawals and defers a compaction drafted before them", async () => {
  const f = fixture(); await f.add("first"); await f.add("second");
  const records = readLedger(f.files.storeFile());
  const approvals = await f.approve([...records.map((record) => ({ kind: "upstream", skill: "tdd", gist: record.gist, fingerprint: record.fingerprint, priority: "note",
    remedy: "Take it back", change: { operation: "withdrawal", body: "Remaining.", references: [] } })), f.compaction("Resurrected fixes.")]);
  const outcomes = records.map((record, i) => ({ skill: "tdd", kind: "upstream", gist: record.gist, fingerprint: record.fingerprint, outcome: "withdrawn", approval: approvals[i] }));
  const result = await f.run({ outcomes, compactions: [{ skill: "tdd", outcome: "applied", approval: approvals[2] }] });
  expect(result.details.failures).toEqual([]);
  expect(result.details.records.filter(record => record.outcome === "withdrawn")).toHaveLength(2);
  expect(result.details.records.at(-1)?.outcome).toBe("later");
  expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.body).toBe("Remaining.");
});
it.each(["stale", "withdrawal", "compaction"])("restores previous references after %s body publication fails", async mode => {
  const f = fixture(); await f.add("first");
  const oldPath = join(f.files.referencesDir(), "tdd", "old.md");
  replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "old.md", body: "Original bytes" }]);
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  amendments.rewriteRuleBody(amendment, `Read ${oldPath}`);
  const before = readFileSync(amendment.path, "utf8");
  const body = `Read ${join(f.files.referencesDir(), "tdd", "new.md")}`;
  const references = [{ name: "new.md", body: "Replacement" }];
  const stale = mode === "stale" && await f.approve(["stale-update", "stale-delete"].map((operation) => ({ kind: "upstream", skill: "tdd", gist: "Settle it", priority: "stale", remedy: "Settle it",
    change: { operation, rule: amendment.name, ...(operation === "stale-update" && { body, references }) } })), "Update");
  const params = stale ? { outcomes: [], stale: [{ rule: amendment.name, action: "update", approval: stale[0] }] }
    : mode === "compaction" ? { outcomes: [], compactions: [{ skill: "tdd", outcome: "applied", approval: (await f.approve([f.compaction(body, references)]))[0] }] }
    : { outcomes: await f.withdraw(readLedger(f.files.storeFile()), () => ({ body, references })) };
  vi.spyOn(amendments, mode === "stale" ? "repinAmendmentRule" : "rewriteRuleBody").mockImplementation(() => { throw new Error("injected body failure"); });
  const result = await f.run(params);
  expect(result.details.failures.join(" ")).toContain("injected body failure");
  expect(readFileSync(amendment.path, "utf8")).toBe(before);
  expect(readFileSync(oldPath, "utf8")).toBe("Original bytes\n");
  expect(readLedger(f.files.storeFile())).toHaveLength(1);
});

/** Has the user approve on-read fixes `gists` of `tdd` in one Ask, then resolves them in one call. */
async function addAll(f: ReturnType<typeof fixture>, gists: string[]) {
  const approvals = await f.approve(gists.map((gist) => ({ kind: "upstream", skill: "tdd", gist, priority: "evidence", remedy: "Fix", change: { operation: "on-read-append", section: `## ${gist}\nFix ${gist}.` } })));
  return f.run({ outcomes: gists.map((gist, i) => ({ skill: "tdd", kind: "upstream", gist, outcome: "applied", approval: approvals[i] })) });
}

/** A separate read transaction allows writes to begin but blocks their commit. */
async function withReadLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  if (!existsSync(file)) writeObserverStore(file, new Date(), () => {});
  const reader = new Database(file, { readonly: true });
  try {
    reader.run("BEGIN");
    reader.query("SELECT count(*) FROM proposals").get();
    return await action();
  } finally {
    reader.close();
  }
}

it("rolls back a busy batch, preserving both publications and independent answers", async () => {
  const f = fixture();
  const file = f.files.storeFile();
  writeObserverStore(file, new Date(), (db) => putLedgerRecords(db, [{
    skill: "domain-modeling", kind: "upstream", gist: "before", fingerprint: proposalFingerprint("domain-modeling", "before"),
    outcome: "declined", timestamp: new Date().toISOString(), sessionId: "historical-session",
  }]));
  const result = await withReadLock(file, () => addAll(f, ["first", "second"]));
  expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")?.body).toMatch(/## first[\s\S]*## second/);
  expect(result.isError).toBe(true);
  expect(result.details.publications).toHaveLength(2);
  expect(result.details.recording).toEqual({ rows: ["unrecorded", "unrecorded"], error: expect.stringMatching(/locked|busy/i) });
  expect(readLedger(file).map((record) => record.gist)).toEqual(["before"]);
  expect(existsSync(`${file}-journal`)).toBe(false);
  expect((await f.run({ outcomes: await declinedFixes(f, "domain-modeling", ["after"]) })).details.recording.rows).toEqual(["recorded"]);
  expect(readLedger(file).map((record) => record.gist)).toEqual(["before", "after"]);
  const text = result.content[0]!.text;
  expect(text).toMatch(/Unrecorded publication[\s\S]*applied `tdd`/);
  expect(text).toContain("Don't call `observer_resolve` again for the outcomes below or redo their changes");
  expect(text.endsWith(`\n## What to do now\n\n${toolResultGuidance("ledger-recording-failed")}`)).toBe(true);
});

it("does not call an already-present on-read section an unrecorded publication", async () => {
  const f = fixture();
  await f.add("first");
  const result = await withReadLock(f.files.storeFile(), () => f.add("first"));
  expect(result.isError).toBe(true);
  expect(result.details.publications).toEqual([]);
  expect(result.details.recording.rows).toEqual(["unrecorded"]);
  expect(result.content[0]?.text).toMatch(/Wrote nothing, not in the ledger[\s\S]*applied `tdd`/);
  expect(result.content[0]?.text).not.toContain("Carried out, not in the ledger");
});

it("reports unknown recording if SQLite commits before an exception reaches Resolve", async () => {
  const f = fixture();
  writeObserverStore(f.files.storeFile(), new Date(), () => {});
  const run = Database.prototype.run;
  const calls = vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, ...args) {
    const result = run.apply(this, args);
    if (args[0] === "COMMIT") throw new Error("injected exception after commit");
    return result;
  });
  const result = await addAll(f, ["first", "second"]);
  expect(calls.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
  expect(result.isError).toBe(true);
  expect(result.details.recording.rows).toEqual(["unknown", "unknown"]);
  expect(result.content[0]?.text).toMatch(/Recorded 0 outcome[\s\S]*Recording unknown[\s\S]*applied `tdd`/);
  expect(readLedger(f.files.storeFile()).map((record) => record.gist)).toEqual(["first", "second"]);
});

it("rolls back a deletion's record and all its generated records without restoring the file", async () => {
  const f = fixture();
  await addAll(f, ["first", "second"]);
  const file = f.files.storeFile();
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  const [approval] = await f.approve(["stale-update", "stale-delete"].map((operation) => ({ kind: "upstream", skill: "tdd", gist: "Settle it", priority: "stale",
    remedy: "Settle it", change: { operation, rule: amendment.name, ...(operation === "stale-update" && { body: amendment.body }) } })), "Delete");
  const result = await withReadLock(file, () => f.run({ outcomes: [], stale: [{ rule: amendment.name, action: "delete", approval }] }));
  expect(existsSync(amendment.path)).toBe(false);
  expect(result.details.recording.rows).toEqual(["unrecorded", "unrecorded", "unrecorded"]);
  expect(result.content[0]?.text).toMatch(/Carried out, not in the ledger, 1 outcome[\s\S]*Wrote nothing, not in the ledger, 2 outcome/);
  expect(readLedger(file).map((record) => [record.gist, record.outcome])).toEqual([["first", "applied"], ["second", "applied"]]);
  expect(existsSync(`${file}-journal`)).toBe(false);
});

it("reports the current withdrawal path when commit fails without changing the saved historical path", async () => {
  const f = fixture();
  await f.add("first");
  const file = f.files.storeFile();
  const [record] = readLedger(file);
  if (!record?.rule) throw new Error("missing applied rule");
  const actual = record.rule;
  const historical = join(f.files.rulesDir(), basename(actual));
  writeObserverStore(file, new Date(), (db) => putLedgerRecords(db, [{ ...record, rule: historical }]));
  const outcomes = await f.withdraw(readLedger(file), () => ({ body: "" }));
  const result = await withReadLock(file, () => f.run({ outcomes }));
  expect(existsSync(actual)).toBe(false);
  expect(result.details.records).toMatchObject([{ outcome: "withdrawn", rule: historical }]);
  expect(readLedger(file)).toMatchObject([{ outcome: "applied", rule: historical }]);
  expect(result.content[0]?.text).toContain(`\`${actual}\``);
  expect(result.content[0]?.text).toContain("Unrecorded publication");
  expect(result.content[0]?.text).not.toContain("Wrote nothing");
});

it.each(["corrupt", "locked", "writer locked"])("reports a verified external publication but makes no rule changes on a %s store", async (fault) => {
  const f = fixture();
  const file = f.files.storeFile();
  const [approval] = await f.approve([{ kind: "upstream", skill: "tdd", gist: "first", priority: "evidence", remedy: "Fix", change: { operation: "on-read-append", section: "## first\nFix first." } }]);
  const project = await publishProjectEdit(f);
  let lock: Database | undefined;
  if (fault === "corrupt") writeFileSync(file, "invalid database");
  else {
    writeObserverStore(file, new Date(), () => {});
    lock = new Database(file, { create: false });
    lock.run(fault === "writer locked" ? "BEGIN IMMEDIATE" : "BEGIN EXCLUSIVE");
  }
  try {
    const result = await f.run({ outcomes: [
      project.outcome,
      { skill: "tdd", kind: "upstream", gist: "first", outcome: "applied", approval },
    ] });
    expect(result.isError).toBe(true);
    expect(result.details.publications).toEqual([]);
    expect(result.details.recording.rows).toEqual(["unrecorded"]);
    const text = result.content[0]?.text;
    expect(text).toMatch(/Unrecorded publication[\s\S]*config\.txt/);
    if (fault === "writer locked") {
      expect(result.details.recording.error).toMatch(/locked|busy/i);
      expect(result.details.failures).toEqual([expect.stringContaining("not attempted")]);
      expect(text).not.toContain("Could not read the observer store");
    } else {
      expect(text).toContain("Could not read the observer store");
    }
    expect(readFileSync(project.path, "utf8")).toBe("new config\n");
    expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")).toBeUndefined();
  } finally {
    lock?.close();
  }
});

it("prunes expired pending observations and shown markers on a ledger-only write", async () => {
  const f = fixture();
  const file = f.files.storeFile(), cwd = f.roots.cwd;
  const old = new Date("2020-01-01T00:00:00Z");
  const pending = (now: Date) => readObserverStore(file, (db) => readPendingObservations(db, cwd, now));
  recordObservation(file, cwd, "Fresh observation", new Date());
  recordObservation(file, cwd, "Old shown observation", old);
  markObservationsShown(file, pending(old)!.filter(({ text }) => text === "Old shown observation"), old);
  recordObservation(file, cwd, "Old pending observation", old);
  expect(pending(old)?.map(({ text }) => text)).toEqual(["Old pending observation", "Fresh observation"]);
  expect(pending(new Date())?.map(({ text }) => text)).toEqual(["Fresh observation"]);
  const result = await f.run({ outcomes: await declinedFixes(f, "tdd", ["No need"]) });
  expect(result.details.recording.rows).toEqual(["recorded"]);
  expect(pending(old)?.map(({ text }) => text)).toEqual(["Fresh observation"]);
  recordObservation(file, cwd, "Old shown observation", old);
  expect(pending(old)?.find(({ text }) => text === "Old shown observation")?.priorShownAt).toBeNull();
});

it("keeps a rolled-back compaction's failure and reference files when the ledger commit fails", async () => {
  const f = fixture(); await f.add("first");
  replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "old.md", body: "Original bytes" }]);
  const [approval] = await f.approve([f.compaction(`Read ${join(f.files.referencesDir(), "tdd", "new.md")}`, [{ name: "new.md", body: "Replacement" }])]);
  vi.spyOn(amendments, "rewriteRuleBody").mockImplementation(() => { throw new Error("injected body failure"); });
  const declined = await declinedFixes(f, "domain-modeling", ["Unrelated"]);
  const result = await withReadLock(f.files.storeFile(), () => f.run({ outcomes: declined, compactions: [{ skill: "tdd", outcome: "applied", approval }] }));
  expect(result.details.failures.join(" ")).toContain("injected body failure");
  expect(readdirSync(join(f.files.referencesDir(), "tdd"))).toEqual(["old.md"]);
  expect(result.details.publications).toEqual([]);
  expect(result.details.recording.rows).toEqual(["unrecorded"]);
});

it.each(["unreadable", "other skill"])("leaves a compaction's body and references unchanged when its fingerprint is %s", async fault => {
  const f = fixture();
  await f.add("first");
  const file = f.files.storeFile();
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  const before = readFileSync(amendment.path);
  replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "old.md", body: "Original bytes" }]);
  const [approval] = await f.approve([f.compaction("Compacted body", [])]);
  const fingerprint = amendments.compactionFingerprint("tdd", amendment.body);
  const claim = { skill: "domain-modeling", kind: "upstream", gist: "Other skill", fingerprint, outcome: "later" };
  await f.run({ outcomes: [claim] });
  if (fault === "unreadable") writeObserverStore(file, new Date(), (db) =>
    db.query("UPDATE proposals SET record = '{' WHERE fingerprint = ?").run(fingerprint));
  const result = await f.run({ outcomes: [], compactions: [{ skill: "tdd", outcome: "applied", approval }] });
  expect(result.isError).toBe(true);
  expect(result.details.publications).toEqual([]);
  expect(readFileSync(amendment.path)).toEqual(before);
  expect(readFileSync(join(f.files.referencesDir(), "tdd", "old.md"), "utf8")).toBe("Original bytes\n");
  if (fault === "other skill") expect(readLedger(file).at(-1)).toMatchObject(claim);
});
it("lists a Later replay deferral and a Decline apart from the unrecorded publication when the ledger commit fails", async () => {
  const f = fixture();
  const [append, barrier] = await f.approve([
    { kind: "upstream", skill: "tdd", gist: "first", priority: "evidence", remedy: "Fix", change: { operation: "on-read-append", section: "## first\nFix first." } },
    { kind: "local", skill: "ce-commit-jj", gist: "Commit with jj", priority: "evidence", remedy: "Fix", change: { operation: "rule", name: "jj-not-git", body: "Use jj.",
      pattern: "\\bgit commit\\b", scope: "tool:bash", matches: [{ command: "git commit -m x" }], spares: [{ command: "jj commit -m x" }] } },
  ]);
  const [declined] = await declinedFixes(f, "domain-modeling", ["Unrelated"]);
  vi.stubEnv("PATH", "");
  const result = await withReadLock(f.files.storeFile(), () => f.run({ outcomes: [
    { skill: "tdd", kind: "upstream", gist: "first", outcome: "applied", approval: append },
    { skill: "ce-commit-jj", kind: "local", gist: "Commit with jj", outcome: "applied", approval: barrier },
    declined,
  ] }));
  expect(result.details.records.map((record) => record.outcome)).toEqual(["applied", "later", "declined"]);
  expect(result.details.deferred).toEqual([expect.stringContaining("omp")]);
  const text = result.content.map((part) => part.text).join("\n");
  const published = text.slice(text.indexOf("Carried out, not in the ledger"), text.indexOf("Wrote nothing, not in the ledger"));
  expect(published).toMatch(/Unrecorded publication[\s\S]*applied `tdd`/);
  expect(published).not.toContain("ce-commit-jj");
  expect(text.slice(text.indexOf("Wrote nothing, not in the ledger"))).toMatch(/later `ce-commit-jj`[\s\S]*declined `domain-modeling`/);
});
it.each(["withdrawal", "stale Delete"])("reports a %s that deleted the amendment as made, and its failed reference cleanup apart, keeping its ledger records", async (mode) => {
  const f = fixture(); await f.add("first"); await f.add("second");
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  const folder = join(f.files.referencesDir(), "tdd");
  replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "old.md", body: "Original" }]);
  const params = mode === "withdrawal" ? { outcomes: await f.withdraw(readLedger(f.files.storeFile()), () => ({ body: "" })) } : {
    outcomes: [], stale: [{ rule: amendment.name, action: "delete", approval: (await f.approve(["stale-update", "stale-delete"].map((operation) => ({
      kind: "upstream", skill: "tdd", gist: "Settle it", priority: "stale", remedy: "Settle it",
      change: { operation, rule: amendment.name, ...(operation === "stale-update" && { body: amendment.body }) },
    })), "Delete"))[0] }],
  };
  renameFault.check = (from) => { if (String(from) === folder) throw new Error("EACCES: injected cleanup failure"); };
  const result = await f.run(params);
  renameFault.check = undefined;
  expect(existsSync(amendment.path)).toBe(false);
  expect(readFileSync(join(folder, "old.md"), "utf8")).toBe("Original\n");
  expect(result.isError).toBe(true);
  expect(result.details.failures).toEqual([]);
  expect(result.details.publications).toEqual([{ operation: mode === "withdrawal" ? "withdrawal" : "stale-delete", skill: "tdd", rule: amendment.path, fingerprint: expect.any(String) }]);
  expect(result.details.cleanup).toEqual([expect.stringContaining("EACCES: injected cleanup failure")]);
  // The ledger reads back the latest record per fingerprint: the withdrawals, or the deletion and its tombstones, replace the applied records.
  expect(readLedger(f.files.storeFile()).map((record) => record.outcome)).toEqual(mode === "withdrawal" ? ["withdrawn", "withdrawn"] : ["deleted", "deleted", "deleted"]);
  const text = result.content.map((part) => part.text).join("\n");
  expect(text).toContain("inspect");
  expect(text).not.toContain("call again");
  expect(text.split("## What to do now")).toHaveLength(2);
  expect(text.endsWith(`\n## What to do now\n\n${toolResultGuidance("cleanup-failed")}`)).toBe(true);
});

/** An on-read amendment of `tdd` pinned to an outdated skill hash, its body and reference file rich in whitespace and CRLF line ends. */
function staleAmendment(files: { rulesDir: () => string; amendmentsDir: () => string; referencesDir: () => string }) {
  const dirs = { rulesDir: files.rulesDir(), amendmentsDir: files.amendmentsDir() };
  const path = join(dirs.amendmentsDir, "tdd-amendment.md");
  const reference = join(files.referencesDir(), "tdd", "spacing.md");
  mkdirSync(dirs.amendmentsDir, { recursive: true });
  mkdirSync(join(files.referencesDir(), "tdd"), { recursive: true });
  writeFileSync(path, "---\r\nname: tdd-amendment\r\ndescription: Fixes.\r\namends: tdd\r\nskillHash: outdated\r\nfingerprint: fp-tdd\r\ngeneratedBy: skill-observer\r\n---\r\n" +
    `\r\n\r\n## Seams  \r\n\r\n\r\n\tTake seams from the ticket.\t \r\nRead ${reference}\r\n\r\n\r\n`);
  writeFileSync(reference, "\n  Indented line  \r\n\r\n\r\n\ttab-led\n\n\n");
  return { dirs, path, reference };
}
it("re-pins a stale Keep from the file's own bytes, leaving body and reference bytes and the kept outcome, without an Ask", async () => {
  const f = fixture();
  const { dirs, path, reference } = staleAmendment(f.files);
  const provenance = createProvenanceResolver(f.roots);
  const before = readFileSync(path, "utf8");
  const referenceBefore = readFileSync(reference);
  expect(amendments.findStaleAmendments(dirs, provenance).map((rule) => rule.name)).toEqual(["tdd-amendment"]);
  const result = await f.run({ outcomes: [], stale: [{ rule: "tdd-amendment", action: "keep" }] });
  expect(result.details.failures).toEqual([]);
  expect(f.branch().some((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "ask")).toBe(false);
  expect(readFileSync(path, "utf8").replace(/^skillHash:.*$/m, "skillHash: outdated")).toBe(before);
  expect(amendments.readObserverRule(dirs, "tdd-amendment").skillHash).toBe(skillHash(provenance.byName("tdd")));
  expect(readFileSync(reference)).toEqual(referenceBefore);
  expect(amendments.findStaleAmendments(dirs, createProvenanceResolver(f.roots))).toEqual([]);
  expect(readLedger(f.files.storeFile())).toMatchObject([{ fingerprint: "fp-tdd", skill: "tdd", kind: "upstream", outcome: "kept", rule: path }]);
});

it.each(["unreadable", "other skill", "same batch"])("does not re-pin a stale amendment when the fingerprint is %s", async fault => {
  const f = fixture();
  const { path } = staleAmendment(f.files);
  const before = readFileSync(path);
  const claim = { skill: "domain-modeling", kind: "upstream", gist: "Other skill", fingerprint: "fp-tdd", outcome: "later" };
  if (fault !== "same batch") await f.run({ outcomes: [claim] });
  if (fault === "unreadable") {
    writeObserverStore(f.files.storeFile(), new Date(), (db) => db.run("UPDATE proposals SET record = '{' WHERE fingerprint = 'fp-tdd'"));
  }
  const result = await f.run({ outcomes: fault === "same batch" ? [claim] : [], stale: [{ rule: "tdd-amendment", action: "keep" }] });
  expect(result.isError).toBe(true);
  expect(readFileSync(path)).toEqual(before);
  expect(result.details.publications).toEqual([]);
  if (fault !== "unreadable") expect(readLedger(f.files.storeFile())).toMatchObject([claim]);
});

it("reports a verified direct edit when a withdrawal dependency cannot be decoded", async () => {
  const f = fixture();
  await f.add("first");
  const file = f.files.storeFile();
  const [record] = readLedger(file);
  if (record?.kind !== "upstream" || !record.rule) throw new Error("missing amendment");
  const outcomes = await f.withdraw([record], () => ({ body: "" }));
  const direct = await publishDirectEdit(f);
  writeObserverStore(file, new Date(), (db) => {
    putLedgerRecords(db, [{ ...record, fingerprint: "dependent" }]);
    db.run("UPDATE proposals SET record = '{' WHERE fingerprint = 'dependent'");
  });
  const result = await f.run({ outcomes: [...outcomes, direct.outcome] });
  expect(result.details.recording.error).toBeTruthy();
  expect(result.content[0]?.text).toMatch(/Unrecorded publication[\s\S]*SKILL\.md/);
  expect(result.content[0]?.text).toContain(`\`${direct.path}\``);
  expect(existsSync(record.rule)).toBe(true);
  expect(readFileSync(direct.path, "utf8")).toBe(direct.content);
});
it.each([
  ["a body", { body: "## Seams\n\nRewritten." }],
  ["references", { references: [{ name: "spacing.md", body: "Rewritten." }] }],
])("refuses a stale Keep carrying %s, leaving the amendment stale and every byte as it was", async (_label, change) => {
  const f = fixture();
  const { dirs, path, reference } = staleAmendment(f.files);
  const before = [readFileSync(path), readFileSync(reference)];
  const result = await f.run({ outcomes: [], stale: [{ rule: "tdd-amendment", action: "keep", ...change }] });
  expect(result.details.failures).toHaveLength(1);
  expect([readFileSync(path), readFileSync(reference)]).toEqual(before);
  expect(amendments.findStaleAmendments(dirs, createProvenanceResolver(f.roots))).toHaveLength(1);
  expect(readLedger(f.files.storeFile())).toEqual([]);
});

it("retains a failed reference rollback backup and refuses to overwrite it on retry", () => {
  const f = fixture();
  replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "old.md", body: "Original" }]);
  renameFault.check = from => {
    if (String(from).endsWith(".tdd.old")) throw new Error("injected rollback failure");
  };
  const thrown = (() => {
    try {
      replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "new.md", body: "New" }], () => {
        throw new Error("injected body failure");
      });
    } catch (error) {
      return error;
    }
  })();
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as Error).message).toMatch(/may be missing or partial.*inspect both and restore the folder before calling observer_resolve again/);
  const backup = join(f.files.referencesDir(), ".tdd.old", "old.md");
  expect(readFileSync(backup, "utf8")).toBe("Original\n");
  expect(() => replaceReferenceFiles(f.files.referencesDir(), "tdd", [])).toThrow("reference recovery is pending");
  expect(readFileSync(backup, "utf8")).toBe("Original\n");
});

it("keeps the previous body when its staged replacement cannot commit", async () => {
  const f = fixture(); await f.add("first");
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  const before = readFileSync(amendment.path, "utf8");
  renameFault.check = (_from, to) => {
    if (String(to) === amendment.path) throw new Error("injected commit failure");
  };
  expect(() => amendments.rewriteRuleBody(amendment, "Replacement")).toThrow("injected commit failure");
  expect(readFileSync(amendment.path, "utf8")).toBe(before);
});

it("restores previous references without writing the body when reference installation fails", () => {
  const f = fixture();
  replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "old.md", body: "Original" }]);
  renameFault.check = from => {
    if (String(from).endsWith(".tdd.staged")) throw new Error("injected reference install failure");
  };
  const writeBody = vi.fn();
  expect(() => replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "new.md", body: "New" }], writeBody))
    .toThrow("injected reference install failure");
  expect(writeBody).not.toHaveBeenCalled();
  expect(readFileSync(join(f.files.referencesDir(), "tdd", "old.md"), "utf8")).toBe("Original\n");
});
it("keeps the result of a carried-out publication when its guidance can't be loaded", async () => {
  const f = fixture();
  const [approval] = await f.approve([{
    kind: "upstream", skill: "tdd", gist: "first", priority: "evidence", remedy: "Fix",
    change: { operation: "on-read-append", section: "## first\nFix first." },
  }]);
  readFault.check = (file) => {
    if (file === INSTRUCTIONS_PATH && amendments.skillAmendment(f.files.amendmentsDir(), "tdd")) {
      throw new Error("EACCES: permission denied");
    }
  };
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await withReadLock(f.files.storeFile(), () => f.run({ outcomes: [{ outcome: "applied", approval }] }));
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  expect(result.isError).toBe(true);
  expect(result.details.publications).toEqual([{ operation: "on-read-append", skill: "tdd", rule: amendment.path, fingerprint: expect.any(String) }]);
  expect(result.details.recording).toEqual({ rows: ["unrecorded"], error: expect.stringMatching(/locked|busy/i) });
  const text = result.content.map((part) => part.text).join("\n");
  expect(text).toMatch(/Unrecorded publication[\s\S]*applied `tdd`/);
  expect(text.split("\n").at(-1)).toBe("The guidance for this result could not be loaded from observer.md: EACCES: permission denied");
  expect(logged).toHaveBeenCalledWith("skill-observer: loading tool-result guidance failed:", expect.any(Error));
});
