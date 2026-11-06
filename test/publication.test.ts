import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { PathLike } from "node:fs";
import type * as NodeFS from "node:fs";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerResolveTool } from "../src/resolve.js";
import { registerReviewTool } from "../src/review.js";
import { OBSERVATION_MESSAGE_TYPE } from "../src/digest.js";
import type { AskDetails, AskQuestion, ExtensionAPI, ExtensionContext, Schema, SessionEntry, ToolDefinition, ToolResultDetails } from "../src/omp.js";
import { type Evidence, readLedger, type LedgerRecord } from "../src/ledger.js";
import * as amendments from "../src/amendments.js";
import { replaceReferenceFiles } from "../src/references.js";
import { buildDigest } from "../src/digest.js";
import { AMENDMENT_DELIVERY_TYPE } from "../src/reminder.js";
import { remedyOutcomes } from "../src/outcomes.js";
import { INSTRUCTIONS_PATH, toolResultGuidance } from "../src/payload.js";
import { createProvenanceResolver, skillHash } from "../src/provenance.js";
import { makeSkillHome } from "./skill-home.js";

const renameFault = vi.hoisted(() => ({ check: undefined as ((from: PathLike, to: PathLike) => void) | undefined }));
const writeFault = vi.hoisted(() => ({ check: undefined as ((file: unknown, data: unknown) => void) | undefined }));
const appendFault = vi.hoisted(() => ({ check: undefined as ((file: unknown, data: unknown) => void) | undefined }));
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
    appendFileSync(...args: Parameters<typeof actual.appendFileSync>) {
      appendFault.check?.(args[0], args[1]);
      actual.appendFileSync(...args);
    },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      readFault.check?.(args[0]);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const homes: string[] = [];
afterEach(() => {
  renameFault.check = undefined; writeFault.check = undefined; appendFault.check = undefined; readFault.check = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const { home, roots } = makeSkillHome(); homes.push(home);
  mkdirSync(roots.cwd, { recursive: true });
  vi.stubEnv("HOME", home); vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".omp/agent"));
  const schema: Schema = { optional: () => schema, describe: () => schema };
  const zod = Object.fromEntries(["object", "array", "string", "number", "enum", "union", "record", "unknown"].map(name => [name, () => schema]));
  type Selected = { reference: unknown; proposal: { candidateId: string; gist: string; preview: string; alternatives?: Array<{ change: { operation: string }; preview: string }> } };
  type Details = { failures: string[]; deferred: string[]; cleanup: string[]; records: LedgerRecord[]; publications: unknown[]; selected: Selected[]; recording: { rows: string[]; error?: string } };
  const tools: Record<string, ToolDefinition<unknown, Details>> = {};
  const files = { ledgerFile: () => join(home, "ledger.jsonl"), rulesDir: () => join(home, "rules"), amendmentsDir: () => join(home, "amendments"), referencesDir: () => join(home, "refs") };
  const pi = { zod, registerTool: (value: ToolDefinition<unknown, Details>) => { tools[value.name] = value; }, appendEntry: () => {} } as unknown as ExtensionAPI;
  registerResolveTool(pi, files);
  registerReviewTool(pi, files);
  let branch: SessionEntry[] = [{ type: "custom_message", customType: OBSERVATION_MESSAGE_TYPE, content: "Observation pass." }];
  const ctx = { cwd: roots.cwd, sessionManager: { getSessionId: () => "test", getBranch: () => branch } } as unknown as ExtensionContext;
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
   * Prepares and selects `candidates`, then saves an Ask the user answered by
   * selecting `select` on each question (Apply, or a stale amendment's Update
   * or Delete), which is the only synthetic part. Returns each selected
   * proposal's approval, in selection order.
   */
  const approve = async (candidates: unknown[], select = "Apply") => {
    const prepared = await call("observer_review", { action: "prepare", candidates });
    if (prepared.isError) throw new Error(prepared.details.failures.join("; "));
    const selection = await call("observer_review", { action: "select", proposals: (prepared.details as unknown as { eligible: Selected[] }).eligible.map((entry) => entry.reference) });
    const questions: AskQuestion[] = selection.details.selected.map(({ proposal }) => ({ id: proposal.candidateId, question: proposal.gist, options: proposal.alternatives
      ? [{ label: "Keep" }, ...proposal.alternatives.map(({ change, preview }) => ({ label: change.operation === "stale-update" ? "Update" : "Delete", preview }))]
      : ["Apply", "Later", "Decline"].map((label) => ({ label, ...(label === "Apply" && { preview: proposal.preview }) })) }));
    const results = questions.map((question) => ({ id: question.id, question: question.question, options: (question.options ?? []).map((option) => String(option.label)), multi: false, selectedOptions: [select] }));
    const answer: AskDetails = results.length === 1 ? (({ id: _, ...single }) => single)(results[0]!) : { results };
    const askToolCallId = `ask-${branch.length}`;
    branch = [...branch, toolCall(askToolCallId, "ask", { questions }),
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
  return { files, roots, run, add, approve, withdraw, compaction, branch: () => branch };
}
const toolCall = (id: string, name: string, args: Record<string, unknown>): SessionEntry =>
  ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
it.each(["later", "declined"])("binds an existing fingerprint to its skill for %s while accepting a reworded gist", async outcome => {
  const f = fixture(); await f.add("first");
  const original = readLedger(f.files.ledgerFile())[0]!;
  const bad = await f.run({ outcomes: [{ skill: "domain-modeling", kind: "upstream", gist: "reworded", fingerprint: original.fingerprint, outcome }] });
  expect(bad.details.failures).toHaveLength(1);
  expect(readLedger(f.files.ledgerFile())).toHaveLength(1);
  const good = await f.run({ outcomes: [{ skill: "tdd", kind: "upstream", gist: "reworded", fingerprint: original.fingerprint, outcome: "later" }] });
  expect(good.details.failures).toEqual([]);
  expect(readLedger(f.files.ledgerFile()).at(-1)?.gist).toBe("reworded");
});
it("binds a new fingerprint to the first skill claiming it in one batch", async () => {
  const f = fixture();
  const result = await f.run({ outcomes: [
    { skill: "tdd", kind: "upstream", gist: "first", fingerprint: "shared", outcome: "declined" },
    { skill: "domain-modeling", kind: "upstream", gist: "second", fingerprint: "shared", outcome: "later" },
  ] });
  expect(result.details.failures).toHaveLength(1);
  expect(readLedger(f.files.ledgerFile())).toMatchObject([{ fingerprint: "shared", skill: "tdd", outcome: "declined" }]);
});
it("lets a later skill claim a fingerprint whose first claimant failed validation", async () => {
  const f = fixture();
  const result = await f.run({ outcomes: [
    { skill: "tdd", kind: "upstream", gist: "first", fingerprint: "shared", outcome: "applied", rule: { body: "no section heading" } },
    { skill: "domain-modeling", kind: "upstream", gist: "second", fingerprint: "shared", outcome: "later" },
  ] });
  expect(result.details.failures).toHaveLength(1);
  expect(readLedger(f.files.ledgerFile())).toMatchObject([{ fingerprint: "shared", skill: "domain-modeling", outcome: "later" }]);
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
  expect(readLedger(f.files.ledgerFile()).slice(1)).toMatchObject([{ compaction: true, outcome: "later" }]);
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
  const record = readLedger(f.files.ledgerFile())[0]!;
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
  const records = readLedger(f.files.ledgerFile());
  const before = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.body;
  const body = `Remaining; read ${join(f.files.referencesDir(), "tdd", "keep.md")}`;
  const outcomes = await f.withdraw(records, (i) => ({ body: difference === "body" && i ? `${body}\nDifferent` : body,
    references: [{ name: "keep.md", body: difference === "references" && i ? "Different" : "Same" }] }));
  const result = await f.run({ outcomes });
  expect(result.details.failures.join(" ")).toContain("identical final body and references");
  expect(result.details.failures).toHaveLength(2);
  expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.body).toBe(before);
  expect(readLedger(f.files.ledgerFile())).toHaveLength(2);
});
it("accepts identical withdrawals and defers a compaction drafted before them", async () => {
  const f = fixture(); await f.add("first"); await f.add("second");
  const records = readLedger(f.files.ledgerFile());
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
    : { outcomes: await f.withdraw(readLedger(f.files.ledgerFile()), () => ({ body, references })) };
  vi.spyOn(amendments, mode === "stale" ? "repinAmendmentRule" : "rewriteRuleBody").mockImplementation(() => { throw new Error("injected body failure"); });
  const result = await f.run(params);
  expect(result.details.failures.join(" ")).toContain("injected body failure");
  expect(readFileSync(amendment.path, "utf8")).toBe(before);
  expect(readFileSync(oldPath, "utf8")).toBe("Original bytes\n");
  expect(readLedger(f.files.ledgerFile())).toHaveLength(1);
});

/** Has the user approve on-read fixes `gists` of `tdd` in one Ask, then resolves them in one call. */
async function addAll(f: ReturnType<typeof fixture>, gists: string[]) {
  const approvals = await f.approve(gists.map((gist) => ({ kind: "upstream", skill: "tdd", gist, priority: "evidence", remedy: "Fix", change: { operation: "on-read-append", section: `## ${gist}\nFix ${gist}.` } })));
  return f.run({ outcomes: gists.map((gist, i) => ({ skill: "tdd", kind: "upstream", gist, outcome: "applied", approval: approvals[i] })) });
}
/** Makes the next ledger append write `bytes(data)`, as an interrupted append would, then fail; `after` runs once it has. Counts appends. */
function failLedgerAppend(ledger: string, bytes: (data: string) => string, after = () => {}) {
  const appends = { count: 0 };
  appendFault.check = (file, data) => {
    if (file !== ledger) return;
    appends.count++;
    appendFault.check = undefined;
    const written = bytes(String(data));
    if (written) appendFileSync(file, written);
    after();
    appendFault.check = () => { throw new Error("appended again"); };
    throw new Error("ENOSPC: no space left on device");
  };
  return appends;
}
it("reports an applied addition as an unrecorded publication, not later, when the ledger append writes nothing", async () => {
  const f = fixture();
  const ledger = f.files.ledgerFile();
  const appends = failLedgerAppend(ledger, () => "");
  const result = await f.add("first");
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  expect(amendment.body).toContain("## first");
  expect(existsSync(ledger)).toBe(false);
  expect(appends.count).toBe(1);
  expect(result.isError).toBe(true);
  expect(result.details.publications).toEqual([{ operation: "on-read-append", skill: "tdd", rule: amendment.path, fingerprint: expect.any(String) }]);
  expect(result.details.records).toMatchObject([{ outcome: "applied", rule: amendment.path }]);
  expect(result.details.deferred).toEqual([]);
  expect(result.details.recording).toEqual({ rows: ["unrecorded"], error: expect.stringContaining("ENOSPC") });
  const text = result.content.map((part) => part.text).join("\n");
  expect(text).toMatch(/Unrecorded publication[\s\S]*applied `tdd`/);
  expect(text).toContain("Don't call `observer_resolve` again for the outcomes below or redo their changes");
  expect(text.split("## What to do now")).toHaveLength(2);
  expect(text.endsWith(`\n## What to do now\n\n${toolResultGuidance("ledger-append-failed")}`)).toBe(true);
});
it.each([
  ["every row", Infinity, ["recorded", "recorded"], ["first", "second"]],
  ["the first row and part of the second", 21, ["recorded", "unrecorded"], ["first"]],
  ["the first row without its newline", 0, ["recorded", "unrecorded"], ["first"]],
  ["the first row but its last byte", -1, ["unrecorded", "unrecorded"], []],
])("tells the rows an interrupted append wrote whole from the ones it didn't: %s", async (_label, past, rows, gists) => {
  const f = fixture();
  const ledger = f.files.ledgerFile();
  failLedgerAppend(ledger, (data) => data.slice(0, data.indexOf("\n") + past));
  const result = await addAll(f, ["first", "second"]);
  expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.body).toMatch(/## first[\s\S]*## second/);
  expect(result.details.recording.rows).toEqual(rows);
  expect(result.isError).toBe(rows.includes("unrecorded"));
  expect(readLedger(ledger).map((record) => record.gist)).toEqual(gists);
});
it.each([
  ["can't be read back", (ledger: string) => { readFault.check = (file) => { if (file === ledger) throw new Error("EIO: i/o error"); }; }],
  ["holds bytes the append didn't write", (ledger: string) => { writeFileSync(ledger, "{}\n"); }],
])("leaves recording unknown when the ledger after an interrupted append %s", async (_label, after) => {
  const f = fixture();
  const ledger = f.files.ledgerFile();
  failLedgerAppend(ledger, (data) => data.slice(0, data.indexOf("\n") + 1 + 20), () => after(ledger));
  const result = await addAll(f, ["first", "second"]);
  readFault.check = undefined;
  expect(amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!.body).toMatch(/## first[\s\S]*## second/);
  expect(result.details.recording.rows).toEqual(["unknown", "unknown"]);
  expect(result.content.map((part) => part.text).join("\n")).toMatch(/Recording unknown[\s\S]*applied `tdd`/);
});
it("keeps a rolled-back compaction's failure and reference files when the ledger append fails", async () => {
  const f = fixture(); await f.add("first");
  replaceReferenceFiles(f.files.referencesDir(), "tdd", [{ name: "old.md", body: "Original bytes" }]);
  const [approval] = await f.approve([f.compaction(`Read ${join(f.files.referencesDir(), "tdd", "new.md")}`, [{ name: "new.md", body: "Replacement" }])]);
  vi.spyOn(amendments, "rewriteRuleBody").mockImplementation(() => { throw new Error("injected body failure"); });
  failLedgerAppend(f.files.ledgerFile(), () => "");
  const result = await f.run({ outcomes: [{ skill: "domain-modeling", kind: "upstream", gist: "Unrelated", outcome: "declined" }], compactions: [{ skill: "tdd", outcome: "applied", approval }] });
  expect(result.details.failures.join(" ")).toContain("injected body failure");
  expect(readdirSync(join(f.files.referencesDir(), "tdd"))).toEqual(["old.md"]);
  expect(result.details.publications).toEqual([]);
  expect(result.details.recording.rows).toEqual(["unrecorded"]);
});
it("lists a Later replay deferral and a Decline apart from the unrecorded publication when the ledger append fails", async () => {
  const f = fixture();
  const [append, barrier] = await f.approve([
    { kind: "upstream", skill: "tdd", gist: "first", priority: "evidence", remedy: "Fix", change: { operation: "on-read-append", section: "## first\nFix first." } },
    { kind: "local", skill: "ce-commit-jj", gist: "Commit with jj", priority: "evidence", remedy: "Fix", change: { operation: "rule", name: "jj-not-git", body: "Use jj.",
      pattern: "\\bgit commit\\b", scope: "tool:bash", matches: [{ command: "git commit -m x" }], spares: [{ command: "jj commit -m x" }] } },
  ]);
  vi.stubEnv("PATH", "");
  failLedgerAppend(f.files.ledgerFile(), () => "");
  const result = await f.run({ outcomes: [
    { skill: "tdd", kind: "upstream", gist: "first", outcome: "applied", approval: append },
    { skill: "ce-commit-jj", kind: "local", gist: "Commit with jj", outcome: "applied", approval: barrier },
    { skill: "domain-modeling", kind: "upstream", gist: "Unrelated", outcome: "declined" },
  ] });
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
  const params = mode === "withdrawal" ? { outcomes: await f.withdraw(readLedger(f.files.ledgerFile()), () => ({ body: "" })) } : {
    outcomes: [], stale: [{ rule: amendment.name, action: "delete", approval: (await f.approve([{ kind: "upstream", skill: "tdd", gist: "Settle it", priority: "stale",
      remedy: "Settle it", change: { operation: "stale-delete", rule: amendment.name } }], "Delete"))[0] }],
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
  expect(readLedger(f.files.ledgerFile()).map((record) => record.outcome)).toEqual(mode === "withdrawal" ? ["withdrawn", "withdrawn"] : ["deleted", "deleted", "deleted"]);
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
  expect(readLedger(f.files.ledgerFile())).toMatchObject([{ fingerprint: "fp-tdd", skill: "tdd", kind: "upstream", outcome: "kept", rule: path }]);
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
  expect(readLedger(f.files.ledgerFile())).toEqual([]);
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
  failLedgerAppend(f.files.ledgerFile(), () => "", () => {
    readFault.check = (file) => { if (file === INSTRUCTIONS_PATH) throw new Error("EACCES: permission denied"); };
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await f.add("first");
  const amendment = amendments.skillAmendment(f.files.amendmentsDir(), "tdd")!;
  expect(result.isError).toBe(true);
  expect(result.details.publications).toEqual([{ operation: "on-read-append", skill: "tdd", rule: amendment.path, fingerprint: expect.any(String) }]);
  expect(result.details.recording).toEqual({ rows: ["unrecorded"], error: expect.stringContaining("ENOSPC") });
  const text = result.content.map((part) => part.text).join("\n");
  expect(text).toMatch(/Unrecorded publication[\s\S]*applied `tdd`/);
  expect(text.split("\n").at(-1)).toBe("The guidance for this result could not be loaded from observer.md: EACCES: permission denied");
  expect(logged).toHaveBeenCalledWith("skill-observer: loading tool-result guidance failed:", expect.any(Error));
});
