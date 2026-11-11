import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDigest, DIGEST_TOKEN_CAP, isEmptyDigest, renderDigest } from "../src/digest.js";
import { sessionToolEvidence } from "../src/session-tool-evidence.js";
import type { SessionEntry } from "../src/omp.js";
import { createProvenanceResolver } from "../src/provenance.js";
import { AMENDMENT_DELIVERY_TYPE } from "../src/reminder.js";
import { entries as fx } from "./fixtures.js";
import { copySkillEntry, makeSkillHome } from "./skill-home.js";

const env = { provenance: createProvenanceResolver(makeSkillHome().roots) };

/** The digest of fixture entries recorded under the real home, replayed in a temp skill home. */
function digestFrom(entries: readonly SessionEntry[]) {
  const { roots, relocate } = makeSkillHome();
  return buildDigest(relocate(entries), { provenance: createProvenanceResolver(roots) });
}

describe("correction-class skill signals", () => {
  it("classifies a steering user message as a correction", () => {
    const digest = buildDigest(fx.steeringUserMessage, env);
    expect(digest.signals).toEqual([
      expect.objectContaining({ kind: "steering", correction: true }),
    ]);
  });

  it.each([
    ["a plain user prompt", "plainUserMessage"],
    ["a steering message the agent relayed", "agentSteeringMessage"],
    ["skill loads and harness messages", "harnessNoise"],
  ] as const)("finds no signal in %s", (_label, fixture) => {
    expect(buildDigest(fx[fixture], env).signals).toEqual([]);
  });

  it("counts a rule-violation interrupt once, naming the rules", () => {
    const digest = buildDigest(fx.ruleViolationInterrupt, env);
    expect(digest.signals).toEqual([
      expect.objectContaining({
        kind: "rule-violation",
        correction: true,
        rules: ["use-ask-tool-for-questions"],
      }),
    ]);
  });

  it("counts a rule injected into a tool result, which has no interrupt message", () => {
    const digest = buildDigest(fx.toolSourceRuleViolation, env);
    expect(digest.signals).toEqual([
      expect.objectContaining({
        kind: "rule-violation",
        rules: ["ts-import-type", "ts-no-dynamic-import"],
      }),
    ]);
  });

  it("counts an interrupt message whose ttsr_injection entry is missing", () => {
    const [message] = fx.ruleViolationInterrupt;
    expect(buildDigest([message!], env).signals).toEqual([
      expect.objectContaining({ kind: "rule-violation", rules: ["use-ask-tool-for-questions"] }),
    ]);
  });

  it("flags batched ask answers that use custom input or skip the recommended option", () => {
    const digest = buildDigest(fx.askBatchWithCustomInput, env);
    expect(digest.signals).toEqual([
      expect.objectContaining({
        kind: "ask-off-recommendation",
        correction: true,
        questionId: "trigger",
        recommended: "Both: command + detached fallback",
        selected: ["Explicit /observe command before quitting"],
      }),
      expect.objectContaining({
        kind: "ask-custom-input",
        correction: true,
        questionId: "apply",
        customInput: "Proposals, ask user with `ask` tool.",
      }),
    ]);
  });

  it("flags a single-question answer other than the recommended index", () => {
    const digest = buildDigest(fx.askSingleOffRecommended, env);
    expect(digest.signals).toEqual([
      expect.objectContaining({
        kind: "ask-off-recommendation",
        recommended: "Approve as is",
        selected: ["Merge 06 into 05"],
      }),
    ]);
  });

  it("flags a single-question answer given as custom input", () => {
    const digest = buildDigest(fx.askSingleCustomInput, env);
    expect(digest.signals).toEqual([
      expect.objectContaining({
        kind: "ask-custom-input",
        customInput: "There is a consent confirmation on HTML forms",
      }),
    ]);
  });

  it("treats an option labelled (Recommended) as the recommendation when no index is given", () => {
    const digest = buildDigest(fx.askRecommendedLabelSuffix, env);
    expect(digest.signals).toEqual([
      expect.objectContaining({
        kind: "ask-off-recommendation",
        questionId: "optin_set",
        recommended: "Core set (Recommended)",
        selected: ["Full coverage"],
      }),
    ]);
  });

  it("finds no signal in a cancelled ask", () => {
    expect(buildDigest(fx.askCancelled, env).signals).toEqual([]);
  });
});

describe("skill signals from an HTML-form ask", () => {
  const STORE_FORM =
    '<form><label><input type="radio" name="store" value="sqlite" checked> SQLite</label>' +
    '<label><input type="radio" name="store" value="redis"> Redis</label></form>';

  /** An `ask` call with its saved result, as OMP 18.18 writes them. */
  function asked(
    html: string,
    answers: Array<{ name: string; question: string; answer: string }>,
    submitted: Record<string, unknown>,
    extra: { timedOut?: boolean } = {},
  ): SessionEntry[] {
    const lead = extra.timedOut ? "No answer before the timeout; submitted the form's current values:" : "User answers:";
    return [
      { type: "message", id: "ask-call", message: { role: "assistant", content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: { html } }] } },
      { type: "message", id: "ask-result", message: { role: "toolResult", toolName: "ask", toolCallId: "ask-1",
        content: [{ type: "text", text: `${lead}\n${JSON.stringify(submitted, null, 2)}` }], details: { answers, ...extra } } },
    ];
  }

  it("flags the free text typed into a group's Other row as custom input", () => {
    const entries = asked(STORE_FORM, [{ name: "store", question: "Session store", answer: "Other: I've started it" }], { store: "I've started it" });
    expect(buildDigest(entries, env).signals).toEqual([
      expect.objectContaining({ kind: "ask-custom-input", correction: true, questionId: "store", question: "Session store", customInput: "I've started it" }),
    ]);
  });

  it("flags a submitted option other than the preselected one", () => {
    const entries = asked(STORE_FORM, [{ name: "store", question: "Session store", answer: "Redis" }], { store: "redis" });
    const signals = buildDigest(entries, env).signals;
    expect(signals).toEqual([
      expect.objectContaining({ kind: "ask-off-recommendation", questionId: "store", question: "Session store", recommended: "sqlite", selected: ["redis"] }),
    ]);
  });

  it("reads preselected values from single-quoted, unquoted and entity-escaped attributes", () => {
    const html =
      "<form><input type='checkbox' name='tags' value='a &amp; b' checked><input type=checkbox name=tags value=c CHECKED>" +
      '<input type="checkbox" name="tags" value="d"><input type="radio" name="other" value="x" checked></form>';
    const unchanged = asked(html, [{ name: "tags", question: "Tags", answer: "A & B, C" }], { tags: ["c", "a & b"] });
    expect(buildDigest(unchanged, env).signals).toEqual([]);
    const changed = asked(html, [{ name: "tags", question: "Tags", answer: "A & B, D" }], { tags: ["a & b", "d"] });
    expect(buildDigest(changed, env).signals).toEqual([
      expect.objectContaining({ kind: "ask-off-recommendation", recommended: "a & b, c", selected: ["a & b", "d"] }),
    ]);
  });

  it("decodes numeric character references in a preselected option's name and value", () => {
    const html =
      '<form><input type="radio" name="my&#32;store" value="a&#x20;b&#39;&apos;&#x1F600;" checked>' +
      '<input type="radio" name="my&#32;store" value="c"></form>';
    const unchanged = asked(html, [{ name: "my store", question: "Store", answer: "A" }], { "my store": "a b''😀" });
    expect(buildDigest(unchanged, env).signals).toEqual([]);
    const changed = asked(html, [{ name: "my store", question: "Store", answer: "C" }], { "my store": "c" });
    expect(buildDigest(changed, env).signals).toEqual([
      expect.objectContaining({ kind: "ask-off-recommendation", questionId: "my store", recommended: "a b''😀", selected: ["c"] }),
    ]);
  });

  it.each([
    ["the preselected option was submitted", asked(STORE_FORM, [{ name: "store", question: "Session store", answer: "SQLite" }], { store: "sqlite" })],
    ["the form timed out", asked(STORE_FORM, [{ name: "store", question: "Session store", answer: "Other: later" }], { store: "later" }, { timedOut: true })],
    ["nothing was preselected", asked(STORE_FORM.replace(" checked", ""), [{ name: "store", question: "Session store", answer: "Redis" }], { store: "redis" })],
    ["nothing was chosen", asked(STORE_FORM, [{ name: "store", question: "Session store", answer: "" }], {})],
    ["a text field holds free text", asked('<form><input type="text" name="why" value="because"></form>', [{ name: "why", question: "Why", answer: "Use the other store" }], { why: "Use the other store" })],
  ])("finds no signal when %s", (_label, entries) => {
    expect(buildDigest(entries, env).signals).toEqual([]);
  });

  it("keeps only custom input from an observation pass's ask", () => {
    const pass: SessionEntry = { type: "custom_message", customType: "skill-observer" };
    const choice = asked(STORE_FORM, [{ name: "store", question: "Session store", answer: "Redis" }], { store: "redis" });
    expect(buildDigest([pass, ...choice], env).signals).toEqual([]);
    const custom = asked(STORE_FORM, [{ name: "store", question: "Session store", answer: "Other: neither" }], { store: "neither" });
    expect(buildDigest([pass, ...custom], env).signals.map((signal) => signal.kind)).toEqual(["ask-custom-input"]);
  });
});

describe("skills loaded in the session", () => {
  const digestOf = (...groups: Array<keyof typeof fx>) => {
    const { roots, relocate } = makeSkillHome();
    const provenance = createProvenanceResolver(roots);
    return { digest: buildDigest(relocate(groups.flatMap((g) => fx[g])), { provenance }), roots };
  };

  it("lists a skill the model read through skill://, labelled by provenance", () => {
    const { digest, roots } = digestOf("skillUrlRead");
    expect(digest.skills).toEqual([
      {
        kind: "upstream",
        name: "tdd",
        folder: "tdd",
        path: join(roots.skillsDir, "tdd/SKILL.md"),
        skillFolderHash: "79288be15c67b849f22b6572056601090fd20913",
        via: ["read"],
      },
    ]);
  });

  it("lists a skill the model read by its physical SKILL.md path, ignoring the read selector", () => {
    const { digest } = digestOf("projectSkillRead", "physicalSkillRead");
    expect(digest.skills).toEqual([
      { kind: "unknown", name: "admin-browser-testing", via: ["read"] },
      expect.objectContaining({ kind: "upstream", name: "domain-modeling", via: ["read"] }),
    ]);
  });

  it("lists a managed skill the user started with /skill:", () => {
    const { digest, roots } = digestOf("skillPromptManaged");
    expect(digest.skills).toEqual([
      {
        kind: "managed",
        name: "implement-spec",
        folder: "implement-spec",
        path: join(roots.managedDir, "implement-spec/SKILL.md"),
        via: ["slash-command"],
      },
    ]);
  });

  it("lists a skill once when it was started with /skill: and read by URL and by path", () => {
    const { digest } = digestOf("skillPromptUpstream", "skillUrlReferenceRead", "physicalSkillRead");
    expect(digest.skills).toEqual([
      expect.objectContaining({
        kind: "upstream",
        name: "domain-modeling",
        via: ["slash-command", "read"],
      }),
    ]);
  });

  it("counts a managed skill read by path as managed", () => {
    expect(digestOf("managedSkillRead").digest.skills).toEqual([
      expect.objectContaining({ kind: "managed", name: "worktree-add" }),
    ]);
  });

  it("ignores a SKILL.md fetched from the web", () => {
    expect(digestOf("remoteSkillMdRead").digest.skills).toEqual([]);
  });

  it("lists skill loads apart from the other signals", () => {
    expect(digestOf("skillUrlRead", "skillPromptManaged").digest.signals).toEqual([]);
  });

  it("labels a plugin skill read by skill:// or by its versioned install path as plugin on the Skills loaded line", () => {
    const installed = "/home/user/.omp/plugins/cache/plugins/compound-engineering-plugin___compound-engineering___3.30.1";
    for (const path of ["skill://ce-code-review", `${installed}/skills/ce-code-review/SKILL.md`]) {
      const entries = JSON.parse(JSON.stringify(fx.skillUrlRead).replace("skill://tdd", path)) as SessionEntry[];
      const digest = digestFrom(entries);
      expect(digest.skills).toEqual([
        expect.objectContaining({ name: "ce-code-review", kind: "plugin", via: ["read"] }),
      ]);
      expect(renderDigest(digest)).toMatch(/^- `ce-code-review`: plugin\b/m);
    }
  });

  /** The digest of a read of each path in a temp skill home where `ce-code-review` and `ce-commit-jj` have copies under the project, the second `extra` longer. */
  const digestOfCopyReads = (extra: string, read: (copies: string[]) => string[]) => {
    const { roots } = makeSkillHome();
    const provenance = createProvenanceResolver(roots);
    const copies = ["ce-code-review", "ce-commit-jj"].map((name, at) => {
      const installed = provenance.byName(name);
      if (installed.kind === "unknown") throw new Error(`${name} is not installed`);
      return copySkillEntry(installed.path, join(roots.cwd, ".agents/skills", name), at === 1 ? extra : "");
    });
    const entries = read(copies).flatMap((path, at): SessionEntry[] => [
      { type: "message", id: `call-${at}`, message: { role: "assistant", content: [{ type: "toolCall", id: `read-${at}`, name: "read", arguments: { path } }] } },
      { type: "message", id: `result-${at}`, message: { role: "toolResult", toolCallId: `read-${at}`, toolName: "read", isError: false, content: "Skill instructions." } },
    ]);
    return buildDigest(entries, { provenance });
  };

  it("lists a read of a byte-identical copy of a plugin or local skill as the installed skill, once with its other reads", () => {
    const digest = digestOfCopyReads("", (copies) => [...copies, "skill://ce-code-review"]);
    expect(digest.skills).toEqual([
      expect.objectContaining({ name: "ce-code-review", kind: "plugin", via: ["read"] }),
      expect.objectContaining({ name: "ce-commit-jj", kind: "local", via: ["read"] }),
    ]);
    expect(renderDigest(digest)).toMatch(/^- `ce-commit-jj`: local\b/m);
  });

  it("lists a read of a copy that differs from the installed skill by one byte as provenance unknown", () => {
    expect(digestOfCopyReads(" ", (copies) => copies).skills).toEqual([
      expect.objectContaining({ name: "ce-code-review", kind: "plugin" }),
      { kind: "unknown", name: "ce-commit-jj", via: ["read"] },
    ]);
  });
});

describe("on-read amendments", () => {
  const delivery: SessionEntry = { type: "custom", id: "delivery-1", customType: AMENDMENT_DELIVERY_TYPE, data: { skill: "tdd", rules: ["tdd-amendment"] } };

  it("reads a delivery entry as its amendments delivered on the read skill's line, and the session as worth a pass", () => {
    const digest = digestFrom([...fx.skillUrlRead, delivery]);
    expect(digest.signals).toEqual([]);
    expect(isEmptyDigest(digest)).toBe(false);
    expect(digest.skills).toEqual([
      expect.objectContaining({ name: "tdd", kind: "upstream", via: ["read"], amendmentsDelivered: ["tdd-amendment"] }),
    ]);
    expect(renderDigest(digest).split("\n").find((line) => line.startsWith("- `tdd`:"))).toContain("amendments delivered: `tdd-amendment`");
  });

  it("counts a barrier rule's TTSR injection as a rule violation beside a delivery, which is none", () => {
    const digest = digestFrom([...fx.skillUrlRead, delivery, ...fx.ruleViolationInterrupt]);
    expect(digest.signals).toEqual([
      expect.objectContaining({ kind: "rule-violation", rules: ["use-ask-tool-for-questions"] }),
    ]);
    expect(digest.skills).toEqual([expect.objectContaining({ name: "tdd", amendmentsDelivered: ["tdd-amendment"] })]);
  });
});

describe("tool errors and workflow outlines", () => {
  const withoutPrompt = (entries: readonly SessionEntry[]) =>
    entries.filter((entry) => entry.message?.role !== "user");

  it("keeps a long tool error quoted from its end, in its signal and its tool exercise, attributed to the skill loaded in its turn", () => {
    const digest = digestFrom(fx.skillTurnToolError);
    const [error, ...rest] = digest.signals;
    expect(rest).toEqual([]);
    expect(error).toMatchObject({
      kind: "tool-error",
      correction: false,
      tool: "bash",
      skills: ["impeccable"],
    });
    const text = (error as { error: string }).error;
    expect(text).toMatch(/^….*Command exited with code 127$/);
    expect(text).not.toContain("impeccable: engine 0.1.5 is not installed");
    expect(text.length).toBeLessThanOrEqual(301);
    expect(digest.toolExercises?.find((exercise) => exercise.failed)?.error).toBe(text);
  });

  it("outlines a turn with no skill loaded, one line per tool call, and keeps its tool error unattributed", () => {
    expect(digestFrom(fx.skillLessTurn).signals).toEqual([
      expect.objectContaining({ kind: "tool-error", tool: "write", skills: [] }),
      expect.objectContaining({
        kind: "workflow",
        correction: false,
        calls: [
          'write "xd://wiki_observe" ok',
          'write "xd://wiki_observe" ok',
          'write "xd://wiki_observe" error',
          'write "xd://wiki_observe" ok',
        ],
      }),
    ]);
  });

  it.each([
    ["started with /skill:", [...fx.skillPromptManaged, ...withoutPrompt(fx.skillLessTurn)]],
    ["read mid-turn", [...fx.plainUserMessage, ...fx.skillUrlRead, ...withoutPrompt(fx.skillLessTurn)]],
  ] as const)("outlines no turn with a skill %s", (_label, entries) => {
    const kinds = digestFrom(entries).signals.map((signal) => signal.kind);
    expect(kinds).not.toContain("workflow");
  });

  it("outlines no turn with fewer than 3 tool calls", () => {
    expect(digestFrom([...fx.plainUserMessage, ...fx.askCancelled]).signals).toEqual([]);
  });

  it("ends the user's turn where an observation pass starts, and outlines no pass", () => {
    const workflows = digestFrom([...fx.skillLessTurn, ...fx.observerPass]).signals.filter(
      (signal) => signal.kind === "workflow",
    );
    expect(workflows).toEqual([
      expect.objectContaining({ calls: expect.arrayContaining(['write "xd://wiki_observe" error']) }),
    ]);
    expect(workflows[0]).toMatchObject({ calls: { length: 4 } });
  });

  it("keeps no tool error from an observation pass", () => {
    const [, , ...failingCalls] = fx.skillTurnToolError;
    const pass = [...fx.observerPass, ...failingCalls];
    expect(digestFrom([...fx.skillTurnToolError, ...pass]).signals).toEqual([
      expect.objectContaining({ kind: "tool-error", skills: ["impeccable"], count: 1 }),
    ]);
  });
});

describe("digest cleanup", () => {
  /** Opening characters of every text a session entry carries. */
  const textsOf = (entries: readonly SessionEntry[]) =>
    entries.flatMap((entry) => {
      const raw = entry as SessionEntry & {
        content?: unknown;
        summary?: string;
        message?: { files?: Array<{ content?: string }> };
      };
      const blocks = Array.isArray(raw.message?.content) ? raw.message.content : [];
      return [
        typeof raw.content === "string" ? raw.content : "",
        raw.summary ?? "",
        ...(raw.message?.files ?? []).map((file) => file.content ?? ""),
        ...blocks.map((block) => block.text ?? (block as { thinking?: string }).thinking ?? ""),
      ]
        .map((text) => text.slice(0, 40).trim())
        .filter((text) => text.length > 0);
    });

  it("drops harness noise: reminders, notices, nudges, recall, advisor and bookkeeping entries", () => {
    const noise = [
      ...fx.harnessNoise.filter((entry) => entry.customType !== "skill-prompt"),
      ...fx.moreHarnessNoise,
    ];
    const [prompt, ...turn] = fx.skillLessTurn;
    const noisy = [prompt!, ...noise.slice(0, 8), ...turn.slice(0, 6), ...noise.slice(8), ...turn.slice(6)];

    const digest = digestFrom(noisy);
    expect(digest).toEqual(digestFrom(fx.skillLessTurn));
    const rendered = renderDigest(digest);
    for (const text of textsOf(noise)) expect(rendered).not.toContain(text);
  });

  it("drops thinking blocks", () => {
    const entries = [...fx.skillLessTurn, ...fx.steeringAfterProse];
    const thinking = entries.flatMap((entry) =>
      Array.isArray(entry.message?.content)
        ? entry.message.content.map((block) => (block as { thinking?: string }).thinking ?? "")
        : [],
    ).filter(Boolean);
    expect(thinking).not.toEqual([]);
    const rendered = renderDigest(digestFrom(entries));
    for (const text of thinking) expect(rendered).not.toContain(text.slice(0, 40));
  });

  it("keeps only the ~200 characters of assistant text just before a correction", () => {
    const [steering] = digestFrom(fx.steeringAfterProse).signals;
    expect(steering).toMatchObject({
      kind: "steering",
      text: "Would be nice for the new cache structure be something like <category>/<subcategory>, but this must not hurt performance",
      before:
        "…stay in place; I'll fold that constraint into the grill. A few more facts to pin down before Round 1 (tests touching the epoch key, test env config, responsecache store precedent, catalog config):",
    });
    expect(renderDigest(digestFrom(fx.steeringAfterProse))).not.toContain("Interjection noted");
  });

  it("collapses a subagent run to the task call and the status its subagents finished with", () => {
    const digest = digestFrom([...fx.plainUserMessage, ...fx.subagentRun]);
    expect(digest.signals).toEqual([
      expect.objectContaining({
        kind: "workflow",
        calls: [
          'task "2 tasks: StandardsReview (reviewer), SpecReview (reviewer)" completed',
          expect.stringMatching(/^bash "bun run typecheck/),
          'wait "Waiting for reviewers" ok',
          'wait "Waiting for spec reviewer" ok',
        ],
      }),
    ]);
    const rendered = renderDigest(digest);
    expect(rendered).not.toContain("Standards axis review");
    expect(rendered).not.toContain("## Completed");
  });

  it("takes a background subagent's status from its delivered result", () => {
    const digest = digestFrom([...fx.plainUserMessage, ...fx.backgroundSubagentRun]);
    const [workflow] = digest.signals as Array<{ calls?: string[] }>;
    expect(workflow?.calls).toEqual([
      'context_notes "Recording session progress" ok',
      expect.stringMatching(/^task "4 tasks: BackendDeadline, IdempotencyReplay, .*" 1 completed, 3 pending$/),
      'wait "Waiting for slice results" ok',
    ]);
    expect(renderDigest(digest)).not.toContain("task-result");
  });
});

describe("counting identical signals, autolearn skills and the cap", () => {

  it("counts a rule that fired repeatedly as one signal", () => {
    const digest = digestFrom(fx.repeatedRuleViolation);
    expect(digest.signals).toEqual([
      expect.objectContaining({ kind: "rule-violation", rules: ["ts-no-tiny-functions"], count: 3 }),
    ]);
    expect(renderDigest(digest)).toMatch(/×3.*ts-no-tiny-functions/);
  });

  it("counts identical tool errors and identical workflow outlines across turns as one signal each", () => {
    const repeated = structuredClone(fx.skillLessTurn).map((entry) => {
      if (entry.id) entry.id += "-repeat";
      if (entry.message?.toolCallId) entry.message.toolCallId += "-repeat";
      if (Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) if (block.id) block.id += "-repeat";
      }
      return entry;
    });
    expect(digestFrom([...fx.skillLessTurn, ...repeated]).signals).toEqual([
      expect.objectContaining({ kind: "tool-error", count: 2 }),
      expect.objectContaining({ kind: "workflow", count: 2 }),
    ]);
  });

  it("lists managed skills autolearn created earlier in the session", () => {
    const digest = digestFrom([...fx.plainUserMessage, ...fx.managedSkillCreated]);
    expect(digest.createdSkills).toEqual(["nested-worktree"]);
    expect(renderDigest(digest)).toMatch(/created[^\n]*\n\n- `nested-worktree`/i);
  });

  /** A session of `total` distinct steering corrections, far over the cap, each tagged with its index. */
  function oversizedSession(total: number): SessionEntry[] {
    const [steering] = fx.steeringUserMessage;
    return Array.from({ length: total }, (_, index) => {
      const clone = structuredClone(steering!);
      clone.id = `steer-${index}`;
      clone.message!.content = [{ type: "text", text: `${textOf(steering!)} [correction ${index}]` }];
      return clone;
    });
  }

  it("renders an oversized session within the cap, keeping the newest signals and saying how many it dropped", () => {
    const total = 600;
    const rendered = renderDigest(digestFrom(oversizedSession(total)));
    expect(rendered.length / 4).toBeLessThanOrEqual(DIGEST_TOKEN_CAP);
    const kept = Array.from({ length: total }, (_, index) => index).filter((index) =>
      rendered.includes(`[correction ${index}]`),
    );
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(total);
    expect(kept).toContain(total - 1);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => total - kept.length + i));
    expect([...rendered.matchAll(/^(\d+)\b/gm)].map(([, count]) => Number(count))).toEqual([total - kept.length]);
  });

  it("numbers the kept signals S1, S2, … in render order, counting from the oldest one the cap kept", () => {
    const total = 600;
    const rendered = renderDigest(digestFrom(oversizedSession(total)));
    const numbered = [...rendered.matchAll(/^- (S\d+): .*\[correction (\d+)\]/gm)];
    const firstKept = total - numbered.length;
    expect([...rendered.matchAll(/^(\d+)\b/gm)].map(([, count]) => Number(count))).toEqual([firstKept]);
    expect(numbered.map(([, id, correction]) => [id, Number(correction)])).toEqual(
      Array.from({ length: numbered.length }, (_, index) => [`S${index + 1}`, firstKept + index]),
    );
  });

  it("gives each signal one id, a repeated one included", () => {
    const digest = digestFrom([...fx.repeatedRuleViolation, ...fx.steeringUserMessage]);
    expect(digest.signals).toEqual([
      expect.objectContaining({ kind: "rule-violation", rules: ["ts-no-tiny-functions"], count: 3 }),
      expect.objectContaining({ kind: "steering", count: 1 }),
    ]);
    const numbered = [...renderDigest(digest).matchAll(/^- (S\d+): (.*)$/gm)];
    expect(numbered.map(([, id]) => id)).toEqual(["S1", "S2"]);
    expect(numbered[0]?.[2]).toContain("×3");
    expect(numbered[0]?.[2]).toContain("`ts-no-tiny-functions`");
    const steering = digest.signals[1];
    if (steering?.kind !== "steering") throw new Error("Expected the second signal to be steering");
    expect(numbered[1]?.[2]).toContain(JSON.stringify(steering.text));
  });

  it("keeps older signals when the newest correction is a paste larger than the cap", () => {
    const [steering] = fx.steeringUserMessage;
    const paste = structuredClone(steering!);
    paste.id = "steer-paste";
    paste.message!.content = [{ type: "text", text: `Log:\n${"PROBE_FATAL: worker 0 exit 3\n".repeat(3000)}` }];

    const rendered = renderDigest(digestFrom([...fx.repeatedRuleViolation, paste]));
    expect(rendered.length / 4).toBeLessThanOrEqual(DIGEST_TOKEN_CAP);
    expect(rendered).toContain("ts-no-tiny-functions");
    expect(rendered).toContain("Log: PROBE_FATAL: worker 0 exit 3");
    expect(rendered).not.toMatch(/dropped/);
  });
});

function textOf(entry: SessionEntry): string {
  const content = entry.message?.content;
  return typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("");
}

describe("observation evidence boundaries", () => {
  const call = (id: string, name: string, args: Record<string, unknown>): SessionEntry => ({
    type: "message", id: `call-${id}`, message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
  });
  const result = (id: string, name: string, isError = false): SessionEntry => ({
    type: "message", id: `result-${id}`, message: { role: "toolResult", toolCallId: id, toolName: name, isError, content: "receipt" },
  });

  it("keeps failed and unresolved skill reads as attempts, not loads", () => {
    const entries = [call("failed", "read", { path: "skill://missing" }), result("failed", "read", true),
      call("pending", "read", { path: "skill://pending" })];
    const digest = buildDigest(entries, env);
    expect(digest.skills).toEqual([]);
    expect(digest.attemptedSkills?.map((skill) => skill.name)).toEqual(["missing", "pending"]);
    expect(buildDigest([...entries, result("pending", "read")], env).skills.map((skill) => skill.name)).toEqual(["pending"]);
  });

  it("ignores ordinary observation choices while retaining custom feedback and steering", () => {
    const entries: SessionEntry[] = [
      { type: "custom_message", customType: "skill-observer" },
      call("choice", "ask", { questions: [{ id: "review", question: "Review", recommended: 0, options: [{ label: "Apply" }, { label: "Decline" }] }] }),
      { type: "message", id: "choice", message: { role: "toolResult", toolName: "ask", toolCallId: "choice",
        details: { id: "review", selectedOptions: ["Decline"] } } },
      { type: "message", id: "feedback", message: { role: "toolResult", toolName: "ask",
        details: { customInput: "Use the actual root cause" } } },
      { type: "message", id: "steer", message: { role: "user", steering: true, content: "Stop guessing" } },
    ];
    expect(buildDigest(entries, env).signals.map((signal) => signal.kind)).toEqual(["ask-custom-input", "steering"]);
  });

  it("retains distinct stable occurrence support after identical signals collapse", () => {
    const entries: SessionEntry[] = ["one", "two"].map((id) => ({
      type: "message", id, message: { role: "user", steering: true, content: "Use the check" },
    }));
    const signal = buildDigest(entries, env).signals[0]!;
    expect(signal.count).toBe(2);
    expect(signal.occurrenceIds).toEqual(["one:steering:", "two:steering:"]);
    expect(buildDigest([...entries, entries[0]!], env).signals[0]?.count).toBe(2);
  });

  it("normalizes captured native calls and deduplicates their host IDs without reading executable text", () => {
    const entries: SessionEntry[] = [
      call("read", "functions.read", { path: "skill://example" }),
      { type: "custom", customType: "skill-observer-tool-call", data: { toolCallId: "read", toolName: "read", input: { path: "skill://example" } } },
      result("read", "functions.read"),
      { type: "custom", customType: "skill-observer-tool-result", data: { toolCallId: "read", toolName: "read", isError: false } },
      call("eval", "eval", { code: 'await tool.read({path:\"skill://not-loaded\"})' }),
    ];
    expect(buildDigest(entries, env).skills.map((skill) => skill.name)).toEqual(["example"]);
    expect(buildDigest(entries, env).attemptedSkills?.map((skill) => skill.name)).toEqual(["example"]);
  });

  it("recognizes structured parallel calls and nested host receipts", () => {
    const digest = buildDigest([
      call("parallel", "multi_tool_use.parallel", { tool_uses: [
        { toolCallId: "nested-read", recipient_name: "functions.read", parameters: { path: "skill://nested" } },
      ] }),
      { type: "custom", customType: "skill-observer-tool-call", data: {
        toolCallId: "nested-read", toolName: "read", input: { path: "skill://nested" },
      } },
      { type: "custom", customType: "skill-observer-tool-result", data: {
        toolCallId: "nested-read", toolName: "read", isError: false, content: [{ type: "text", text: "loaded" }],
      } },
    ], env);
    expect(digest.skills.map((skill) => skill.name)).toEqual(["nested"]);
    expect(digest.attemptedSkills?.map((skill) => skill.name)).toEqual(["nested"]);
  });

  it("does not treat wrapper requests without host identities as executed nested tools", () => {
    const digest = buildDigest([
      call("parallel", "multi_tool_use.parallel", { tool_uses: [
        { recipient_name: "functions.read", parameters: { path: "skill://not-executed" } },
      ] }),
      call("eval", "eval", { code: "arbitrary executable source" }),
    ], env);
    expect(digest.skills).toEqual([]);
    expect(digest.attemptedSkills).toEqual([]);
    expect(digest.signals).toEqual([]);
  });

  const hookCall = (id: string, name: string, input: Record<string, unknown>): SessionEntry => ({
    type: "custom", customType: "skill-observer-tool-call", data: { toolCallId: id, toolName: name, input },
  });
  const hookResult = (id: string, name: string, input: Record<string, unknown>, isError = false): SessionEntry => ({
    type: "custom", customType: "skill-observer-tool-result",
    data: { toolCallId: id, toolName: name, input, isError, content: [{ type: "text", text: isError ? "1 failed" : "done" }] },
  });
  const device = { path: "xd://read", content: '{"path":"notes.md"}' };

  it("projects native, hook, device, nested eval and parallel records into one chronology of leaf calls", () => {
    const digest = buildDigest([
      { type: "message", id: "prompt", message: { role: "user", content: "Do the work" } },
      hookCall("check", "bash", { command: "npm test" }),
      hookResult("check", "bash", { command: "npm test" }, true),
      call("check", "functions.bash", { command: "npm test" }),
      result("check", "functions.bash", true),
      hookCall("dispatch", "write", device),
      hookCall("dispatch", "read", { path: "notes.md" }),
      hookResult("dispatch", "read", { path: "notes.md" }),
      hookResult("dispatch", "write", device),
      call("dispatch", "write", device),
      result("dispatch", "write"),
      call("eval", "eval", { code: 'await tool.read({path:"skill://decoy"})' }),
      hookCall("nested", "read", { path: "docs/a.md" }),
      hookResult("nested", "read", { path: "docs/a.md" }),
      hookCall("missing", "read", { path: "skill://missing" }),
      hookResult("missing", "read", { path: "skill://missing" }, true),
      result("eval", "eval"),
      call("parallel", "multi_tool_use.parallel", { tool_uses: [
        { toolCallId: "p1", recipient_name: "functions.grep", parameters: { pattern: "TODO" } },
        { toolCallId: "p2", recipient_name: "functions.find", parameters: { pattern: "*.md" } },
      ] }),
      hookCall("p2", "find", { pattern: "*.md" }),
      hookResult("p2", "find", { pattern: "*.md" }),
      hookCall("p1", "grep", { pattern: "TODO" }),
      hookResult("p1", "grep", { pattern: "TODO" }),
      result("parallel", "multi_tool_use.parallel"),
    ], env);
    expect(digest.signals).toEqual([
      expect.objectContaining({ kind: "tool-error", tool: "bash", args: "npm test", error: "1 failed", count: 1 }),
      expect.objectContaining({ kind: "tool-error", tool: "read", args: "skill://missing", error: "1 failed", count: 1 }),
      expect.objectContaining({ kind: "workflow", entryId: "check", count: 1, calls: [
        'bash "npm test" error', 'read "notes.md" ok', 'read "docs/a.md" ok', 'read "skill://missing" error', 'grep "TODO" ok', 'find "*.md" ok',
      ] }),
    ]);
    expect(digest.toolExercises?.map(({ entryId, tool, failed }) => ({ entryId, tool, failed }))).toEqual([
      { entryId: "tool-result:check", tool: "bash", failed: true },
      { entryId: "tool-result:dispatch", tool: "read", failed: false },
      { entryId: "tool-result:nested", tool: "read", failed: false },
      { entryId: "tool-result:missing", tool: "read", failed: true },
      { entryId: "tool-result:p2", tool: "find", failed: false },
      { entryId: "tool-result:p1", tool: "grep", failed: false },
    ]);
    expect(digest.skills).toEqual([]);
    expect(digest.attemptedSkills?.map((skill) => skill.name)).toEqual(["missing"]);
  });

  it.each([
    ["a device dispatch recorded under one ID by two hook calls", "read", [
      hookCall("read", "write", { path: "xd://read", content: '{"path":"skill://example"}' }),
      hookCall("read", "read", { path: "skill://example" }),
      hookResult("read", "read", { path: "skill://example" }),
      hookResult("read", "write", { path: "xd://read", content: '{"path":"skill://example"}' }),
      call("read", "write", { path: "xd://read", content: '{"path":"skill://example"}' }),
      result("read", "write"),
    ]],
    ["a read with a duplicated native result", "read", [
      call("read", "read", { path: "skill://example" }), result("read", "read"), result("read", "read"),
    ]],
  ] as const)("shows %s in the digest but gives strict lookup no completed call", (_, id, entries) => {
    const digest = buildDigest(entries, env);
    expect(digest.skills.map((skill) => skill.name)).toEqual(["example"]);
    expect(digest.toolExercises?.map((exercise) => exercise.tool)).toEqual(["read"]);
    expect(() => sessionToolEvidence(entries).completedCall(id)).toThrow(`no completed observed tool call for ${id}`);
  });
});
