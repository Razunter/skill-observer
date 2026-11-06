/**
 * On-read amendment delivery (ADR 0009). OMP never loads an on-read amendment:
 * it lives in the amendments directory, and this module adds it to the context
 * whenever its skill enters it, once per context window, by either route.
 * `/skill:<name>` puts the skill in a skill-prompt message without a `read`
 * call, so the amendments ride a hidden reminder on the turn the prompt
 * starts. A `read` of the skill's entry file gets them after its result: as
 * the call's additional context when the model called `read` itself, or
 * appended to the result for a call nested in eval or a device, where OMP has
 * nowhere to put additional context. Barrier rules need nothing: OMP fires
 * them on the mistake however the skill was loaded.
 */

import { type ObserverRule, readOnReadAmendments } from "./amendments.js";
import type { CustomMessage, ExtensionAPI, ExtensionContext, SessionEntry, ToolResultEvent, ToolResultEventResult } from "./omp.js";
import { createProvenanceResolver, defaultSkillRoots, type ProvenanceResolver } from "./provenance.js";
import { AMENDMENT_DELIVERY_TYPE, AMENDMENT_REMINDER_TYPE, amendmentDelivery, renderReminder } from "./reminder.js";
import { sessionToolEvidence } from "./session-tool-evidence.js";

/** Delivers on-read amendments from `amendmentsDir` on both routes. */
export function registerAmendmentDelivery(pi: ExtensionAPI, amendmentsDir: () => string): void {
  // Runs in every session, UI or not: a skill needs its amendments wherever it is loaded.
  pi.on("before_agent_start", (event, ctx) => {
    const message = amendmentReminder(event.prompt, ctx, amendmentsDir());
    return message ? { message } : undefined;
  });
  pi.on("tool_result", (event, ctx) => {
    try {
      return readDelivery(pi, event, ctx, amendmentsDir(), createProvenanceResolver(defaultSkillRoots(ctx.cwd)));
    } catch (error) {
      // The read itself succeeded; a failed delivery must not turn it into an error.
      console.error("skill-observer: delivering on-read amendments failed:", error);
      return undefined;
    }
  });
}

/**
 * The first line of OMP's user-invocation template for a skill prompt. A queued
 * batch joins its user messages with blank lines, so the line can sit mid-prompt.
 */
const INVOKED_SKILL = /^\[IMPORTANT: User invoked the "([^"]+)" skill;/gm;

/**
 * The hidden reminder for a submitted prompt: the on-read amendments of every
 * skill it starts, less those already delivered, with one notice per skill.
 * `undefined` when none are left.
 */
function amendmentReminder(prompt: string, ctx: ExtensionContext, amendmentsDir: string): CustomMessage | undefined {
  const skills = new Set(Array.from(prompt.matchAll(INVOKED_SKILL), (match) => match[1] ?? ""));
  if (skills.size === 0) return undefined;
  const rules = undelivered(readOnReadAmendments(amendmentsDir).filter((rule) => skills.has(rule.amends)), ctx.sessionManager.getBranch());
  if (rules.length === 0) return undefined;
  const deliveries = Array.from(skills).flatMap((skill) => {
    const skillRules = rules.filter((rule) => rule.amends === skill);
    return skillRules.length > 0 ? [{ skill, rules: skillRules }] : [];
  });
  for (const delivery of deliveries) notifyDelivery(ctx, delivery.skill, delivery.rules);
  return {
    customType: AMENDMENT_REMINDER_TYPE,
    content: deliveries.map((delivery) => renderReminder(delivery.skill, delivery.rules)).join("\n\n"),
    display: false,
    attribution: "agent",
    details: { rules: rules.map((rule) => rule.name) },
  };
}

/** `skill://<name>` or `skill://<name>/SKILL.md`, with an optional `read` selector such as `:10-20` or `:raw`. */
const SKILL_ENTRY_URL = /^skill:\/\/([^/:\s]+)(?:\/SKILL\.md)?(?::[^/]*)?$/;
/** A physical `SKILL.md` path, with an optional selector. */
const SKILL_ENTRY_FILE = /^(.*\/SKILL\.md)(?::[^/]*)?$/;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/** The skill whose entry file `path` reads; `undefined` for a reference file, another URL or a path no installed skill owns. */
function entrySkill(path: string, provenance: ProvenanceResolver): string | undefined {
  const url = SKILL_ENTRY_URL.exec(path);
  if (url) return url[1];
  const file = SKILL_ENTRY_FILE.exec(path);
  if (!file || URL_SCHEME.test(path)) return undefined;
  const skill = provenance.byPath(file[1]!);
  return skill.kind === "unknown" ? undefined : skill.name;
}

/** Delivers the read skill's undelivered on-read amendments after a successful `read` of its entry file, and records the delivery. */
function readDelivery(
  pi: ExtensionAPI,
  event: ToolResultEvent,
  ctx: ExtensionContext,
  amendmentsDir: string,
  provenance: ProvenanceResolver,
): ToolResultEventResult | undefined {
  const path = event.input?.path;
  if (event.toolName !== "read" || event.isError || typeof path !== "string") return undefined;
  const skill = entrySkill(path, provenance);
  if (skill === undefined) return undefined;
  const branch = ctx.sessionManager.getBranch();
  const rules = undelivered(readOnReadAmendments(amendmentsDir).filter((rule) => rule.amends === skill), branch);
  if (rules.length === 0) return undefined;
  pi.appendEntry(AMENDMENT_DELIVERY_TYPE, { skill, rules: rules.map((rule) => rule.name) });
  notifyDelivery(ctx, skill, rules);
  const text = renderReminder(skill, rules);
  return sessionToolEvidence(branch).isNativeCall(event.toolCallId, event.toolName)
    ? { additionalContext: text }
    : { content: [...event.content, { type: "text", text }] };
}

/** Tells a user with a UI which on-read amendments of `skill` one delivery added; a failed notice is logged and leaves the delivery standing. */
function notifyDelivery(ctx: ExtensionContext, skill: string, rules: readonly ObserverRule[]): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(`On-read amendment for \`${skill}\`: ${rules.map((rule) => rule.name).join(", ")}`, "info");
  } catch (error) {
    console.error("skill-observer: notifying on-read amendment delivery failed:", error);
  }
}

/** `rules` less those a reminder or a read delivery already put in the current context window. */
function undelivered(rules: readonly ObserverRule[], branch: readonly SessionEntry[]): ObserverRule[] {
  const delivered = deliveredRules(branch);
  return rules.filter((rule) => !delivered.has(rule.name));
}

/**
 * Rules delivered in the model's context, by either route. After a compaction
 * only the entries it kept, from `firstKeptEntryId` on, are still in context;
 * after a reset (`/clear`) only the entries after it, whichever starts later.
 */
function deliveredRules(branch: readonly SessionEntry[]): Set<string> {
  // The last compaction decides what is left; its kept entries sit before it.
  let compacted = 0;
  let reset = 0;
  branch.forEach((entry, index) => {
    if (entry.type === "reset_boundary") reset = index + 1;
    if (entry.type !== "compaction") return;
    const kept = branch.findIndex((candidate, i) => i < index && candidate.id === entry.firstKeptEntryId);
    compacted = kept >= 0 ? kept : index + 1;
  });
  const start = Math.max(compacted, reset);
  const delivered = new Set<string>();
  for (const entry of branch.slice(start)) {
    const rules = entry.type === "custom_message" && entry.customType === AMENDMENT_REMINDER_TYPE
      ? entry.details?.rules
      : amendmentDelivery(entry)?.rules;
    for (const rule of rules ?? []) delivered.add(rule);
  }
  return delivered;
}
