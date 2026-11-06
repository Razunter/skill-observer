import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRAGMENTS_DIR, fragmentFiles } from "../scripts/generate-fragments.js";
import { type LedgerRecord, renderLedger } from "../src/ledger.js";
import {
  type Gate,
  INSTRUCTIONS_PATH,
  instructionText,
  joinFragments,
  parseFragments,
  payloadEstimate,
  toolResultGuidance,
} from "../src/payload.js";

const observerMd = readFileSync(INSTRUCTIONS_PATH, "utf8");
const fragments = parseFragments(observerMd);
const ALL_GATES = new Set<Gate>(["stale", "compaction", "project", "withdrawal", "ranking", "note", "tool-result"]);

describe("observer.md fragments", () => {
  it("keeps the committed observer/ files in step with observer.md", () => {
    const committed = Object.fromEntries(readdirSync(FRAGMENTS_DIR).map((name) => [name, readFileSync(join(FRAGMENTS_DIR, name), "utf8")]));
    expect(committed).toEqual(fragmentFiles(observerMd));
  });

  it("loses no text: the fragments joined are observer.md without its markers", () => {
    const unmarked = observerMd.split("\n").filter((line) => !/^<!-- (when: \S+|end) -->$/.test(line)).join("\n");
    expect(joinFragments(fragments)).toBe(unmarked.replace(/\n{3,}/g, "\n\n").trimEnd());
    expect(joinFragments(fragments)).toContain("Adapted from task-observer by Eoghan Henn");
  });

  it.each([
    ["an unknown gate", "Intro.\n\n<!-- when: someday -->\nText.\n<!-- end -->\n", /line 3: unknown gate `someday`/],
    ["a block never closed", "Intro.\n\n<!-- when: stale -->\nText.\n", /line 3: the `stale` block is never closed/],
    ["an end without an opening", "Intro.\n\nText.\n<!-- end -->\n", /line 4: .*without an open gate marker/],
    ["a nested block", "<!-- when: stale -->\nA.\n\n<!-- when: note -->\nB.\n<!-- end -->\n<!-- end -->\n", /line 4: gate marker inside the `stale` block/],
    ["a marker sharing its line", "Intro. <!-- when: stale -->\n", /line 1: a gate marker must sit alone/],
    ["a block splitting a paragraph", "First sentence.\n<!-- when: stale -->\nSecond sentence.\n<!-- end -->\n", /line 2: .*whole paragraph or list item/],
    ["a block splitting a list item", "- Item\n<!-- when: stale -->\n  continued.\n<!-- end -->\n", /line 2: .*inside a list item/],
    ["a block ending mid-paragraph", "<!-- when: stale -->\nFirst sentence.\n<!-- end -->\nSecond sentence.\n", /line 3: .*whole paragraph or list item/],
  ])("rejects %s, naming the line", (_label, markdown, error) => {
    expect(() => parseFragments(markdown)).toThrow(error);
  });

  it("joins gated list items into the list around them", () => {
    const parsed = parseFragments("Intro:\n\n- One\n<!-- when: stale -->\n- Two\n<!-- end -->\n- Three\n\nAfter.\n");
    expect(parsed.map(({ gate, text }) => [gate, text])).toEqual([
      [undefined, "Intro:\n\n- One"], ["stale", "- Two"], [undefined, "- Three\n\nAfter."],
    ]);
    expect(joinFragments(parsed.filter(({ gate }) => gate === undefined))).toBe("Intro:\n\n- One\n- Three\n\nAfter.");
  });
});

describe("instructionText", () => {
  const alwaysOn = fragments.filter(({ gate }) => gate === undefined);
  const gated = fragments.filter(({ gate }) => gate !== undefined);

  it.each([
    ["no gate", new Set<Gate>()],
    ["every gate, tool-result included", ALL_GATES],
  ])("with %s holds every always-on fragment, in document order, and no tool-result fragment", (_label, gates) => {
    const text = instructionText(gates);
    const positions = alwaysOn.map(({ text: fragment }) => text.indexOf(fragment));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(fragments.filter(({ gate, text: fragment }) => gate === "tool-result" && text.includes(fragment))).toEqual([]);
  });

  it("holds no gated fragment without its gate", () => {
    const text = instructionText(new Set());
    expect(gated.filter(({ text: fragment }) => text.includes(fragment))).toEqual([]);
  });
});

describe("toolResultGuidance", () => {
  it("maps each error-path condition to its own tool-result paragraph of observer.md", () => {
    const guidance = (["changed-target", "ledger-append-failed", "cleanup-failed", "apply-note"] as const).map(toolResultGuidance);
    const toolResult = fragments.filter(({ gate }) => gate === "tool-result").map(({ text }) => text);
    expect(new Set(guidance)).toEqual(new Set(toolResult));
    expect(guidance[0]).toMatch(/^\*\*A changed target\.\*\*/);
  });
});

describe("payloadEstimate", () => {
  it("estimates each named section as ceil(chars/4) and sums them", () => {
    expect(payloadEstimate([
      { name: "instructions", text: "x".repeat(9) },
      { name: "digest", text: "x".repeat(8) },
      { name: "stale", text: "x" },
    ])).toEqual({ total: 6, bySection: { instructions: 3, digest: 2, stale: 1 } });
  });
});

describe("renderLedger", () => {
  const record = (gist: string, outcome: string, extra: Record<string, unknown> = {}) =>
    ({ fingerprint: `fp-${gist}`, skill: "tdd", kind: "upstream", gist, outcome, timestamp: "2026-11-06T00:00:00.000Z", sessionId: "s", ...extra }) as LedgerRecord;

  it("lists Later entries with their fingerprints and no Declined section", () => {
    const text = renderLedger([record("Name the seam.", "later"), record("Ask one question.", "declined"), record("Compact tdd.", "later", { compaction: true })]);
    expect(text).toBe("## Proposal ledger\n\n### Later\n\n- `tdd` (upstream), fingerprint `fp-Name the seam.`: Name the seam.");
  });
});
