import { describe, expect, it } from "vitest";
import { remedyOutcomes } from "../src/outcomes.js";
import { buildDigest, type SessionDigest } from "../src/digest.js";
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
