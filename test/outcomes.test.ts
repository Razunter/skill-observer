import { describe, expect, it } from "vitest";
import { remedyOutcomes } from "../src/outcomes.js";
import { buildDigest, type SessionDigest, type ToolExercise } from "../src/digest.js";
import type { LedgerRecord } from "../src/ledger.js";
import { AMENDMENT_DELIVERY_TYPE } from "../src/reminder.js";

const record: LedgerRecord = { fingerprint: "fix", gist: "Check before writing", outcome: "applied", skill: "testing", kind: "local", rule: "/rules/check-first.md", timestamp: "2026-01-01", sessionId: "old", evidence: [{ quote: 'Tool error in `bash` "check": "failed"', count: 1 }] };
const empty: SessionDigest = { signals: [], skills: [], createdSkills: [] };
const delivered: SessionDigest = { ...empty, skills: [{ kind: "unknown", name: "testing", via: ["read"], amendmentsDelivered: ["check-first"] }] };

describe("conservative remedy outcomes", () => {
  it("does not call silence success, with or without delivery", () => {
    expect(remedyOutcomes([record], empty)[0]?.status).toBe("inconclusive");
    expect(remedyOutcomes([record], delivered)[0]?.status).toBe("delivered");
  });
  it("does not report withdrawn or compacted remedies as active", () => {
    expect(remedyOutcomes([record, { ...record, outcome: "withdrawn" }], delivered)).toEqual([]);
    expect(remedyOutcomes([{ ...record, compaction: true }], delivered)).toEqual([]);
  });
  it("requires ordered relevant actual receipts and the same failure for recurrence", () => {
    const receipt = { entryId: "actual-result", tool: "bash", args: "check", failed: false, deliveredRules: ["check-first"] };
    expect(remedyOutcomes([record], { ...delivered, toolExercises: [receipt] })[0]?.status).toBe("exercised-clean");
    expect(remedyOutcomes([record], { ...delivered, toolExercises: [{ ...receipt, failed: true, error: "failed" }] })[0]?.status).toBe("recurrence");
    expect(remedyOutcomes([record], { ...delivered, toolExercises: [{ ...receipt, failed: true, error: "network unavailable" }] })[0]?.status).toBe("delivered");
    expect(remedyOutcomes([record], { ...delivered, toolExercises: [{ ...receipt, args: "other" }] })[0]?.status).toBe("delivered");
    expect(remedyOutcomes([record], { ...delivered, toolExercises: [{ ...receipt, deliveredRules: [] }] })[0]?.status).toBe("delivered");
  });
  const env = { provenance: { byName: (name: string) => ({ kind: "unknown" as const, name }),
    byPath: (path: string) => ({ kind: "unknown" as const, name: path }) } };
  const exercise = (details?: unknown) => buildDigest([
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "before", name: "bash", arguments: { command: "check" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "before", toolName: "bash", content: "ok" } },
    { type: "custom", customType: AMENDMENT_DELIVERY_TYPE, data: { skill: "testing", rules: ["check-first"] } },
    // The hook-recorded shape OMP gives a plain bash call: unset options as null or false.
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "after", name: "tool.bash", arguments: { command: "check", timeout: null, cwd: null, pty: false, async: false } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "after", toolName: "tool.bash", content: "ok", details } },
  ] as never, env);
  it("extracts post-delivery exercise through the real digest boundary", () => {
    const digest = exercise();
    expect(digest.toolExercises?.[0]?.deliveredRules).toEqual([]);
    expect(remedyOutcomes([record], digest)[0]).toMatchObject({ status: "exercised-clean", evidence: ["tool-result:after"] });
  });
  it("does not count a command still running in the background as a clean exercise", () => {
    expect(remedyOutcomes([record], exercise({ async: { state: "running", jobId: "bg_1", type: "bash" } }))[0]?.status).toBe("delivered");
  });
});

describe("project-environment remedy outcomes", () => {
  const written = "2026-11-06T12:00:00.000Z";
  const before = "2026-11-06T11:59:00.000Z";
  const after = "2026-11-06T12:01:00.000Z";
  const projectFix: LedgerRecord = {
    fingerprint: "project-fix", gist: "Wire the existing typecheck.", outcome: "applied", kind: "project",
    target: { scope: "project", root: "/repo", path: "package.json", mechanism: "Wire the existing typecheck." },
    timestamp: written, sessionId: "fixture-session",
    evidence: [{ quote: 'Tool error in `bash` "bun run typecheck": "tsc: command not found"', count: 1 }],
  };
  const check = { entryId: "check", tool: "bash", args: "bun run typecheck", failed: false, deliveredRules: [] };
  const failing = { ...check, failed: true, error: "tsc: command not found" };
  const status = (...toolExercises: ToolExercise[]) => remedyOutcomes([projectFix], { ...empty, toolExercises })[0]?.status;

  it("reports recurrence when the quoted mechanism fails the same way after the fix was written", () => {
    expect(status({ ...failing, at: after })).toBe("recurrence");
  });
  it("reports exercised-clean when the quoted mechanism succeeds after the fix was written", () => {
    expect(status({ ...check, at: after })).toBe("exercised-clean");
    expect(status({ ...check, args: "bun run lint", at: after })).toBe("inconclusive");
  });
  it("is inconclusive before any exercise, and never delivered", () => {
    expect(status()).toBe("inconclusive");
  });
  it("counts neither an exercise saved before the fix nor one without a timestamp", () => {
    expect(status({ ...failing, at: before }, { ...check, at: before })).toBe("inconclusive");
    expect(status(failing, check)).toBe("inconclusive");
  });
  it("reads the exercise time from the saved tool result through the real digest boundary", () => {
    const env = { provenance: { byName: (name: string) => ({ kind: "unknown" as const, name }),
      byPath: (path: string) => ({ kind: "unknown" as const, name: path }) } };
    const run = (id: string, timestamp: string) => [
      { type: "message", id: `call-${id}`, timestamp, message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "bun run typecheck" } }] } },
      { type: "message", id: `result-${id}`, timestamp, message: { role: "toolResult", toolCallId: id, toolName: "bash", content: "ok" } },
    ];
    const digest = buildDigest([...run("early", before), ...run("late", after)] as never, env);
    expect(digest.toolExercises?.map((exercise) => exercise.at)).toEqual([before, after]);
    expect(remedyOutcomes([projectFix], digest)[0]).toMatchObject({ status: "exercised-clean", evidence: ["tool-result:late"] });
  });
});
