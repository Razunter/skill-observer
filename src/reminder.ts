/**
 * The records of on-read amendment deliveries: the markup of the reminder that
 * carries a skill's amendments, the hidden reminder message of a `/skill:`
 * prompt, and the session entry of a delivery after a `read`. The delivery
 * module writes them and the digest reads deliveries back from them, so a rule
 * deleted since still shows as delivered.
 */

import type { ObserverRule } from "./amendments.js";
import type { SessionEntry } from "./omp.js";

/** The `customType` of the hidden reminder that carries the on-read amendments of a skill started with `/skill:`. */
export const AMENDMENT_REMINDER_TYPE = "skill-observer-amendments";

/** The `customType` of the session entry that records on-read amendments delivered after a `read` of their skill. */
export const AMENDMENT_DELIVERY_TYPE = "skill-observer-amendment-delivery";

/** The data of a delivery entry: the skill read and the on-read amendments delivered with it, by name. */
export interface AmendmentDelivery {
  skill: string;
  rules: string[];
}

/** The delivery a session entry records; `undefined` for any other entry. */
export function amendmentDelivery(entry: SessionEntry): AmendmentDelivery | undefined {
  if (entry.type !== "custom" || entry.customType !== AMENDMENT_DELIVERY_TYPE) return undefined;
  const { skill, rules } = (entry.data ?? {}) as { skill?: unknown; rules?: unknown };
  if (typeof skill !== "string" || !Array.isArray(rules)) return undefined;
  return { skill, rules: rules.filter((rule): rule is string => typeof rule === "string") };
}

/** One skill's section of a reminder, holding that skill's on-read amendments. */
export function renderReminder(skill: string, rules: readonly Pick<ObserverRule, "name" | "body">[]): string {
  return [
    `<system-reminder reason="skill_amendment" skill="${skill}">`,
    `Amendments to the \`${skill}\` skill above, approved by the user. Where an amendment differs from the skill text, follow the amendment.`,
    ...rules.map((rule) => `\n<amendment rule="${rule.name}">\n${rule.body}\n</amendment>`),
    "</system-reminder>",
  ].join("\n");
}

const REMINDER_SECTION = /<system-reminder reason="skill_amendment" skill="([^"]+)">([\s\S]*?)<\/system-reminder>/g;
const REMINDED_RULE = /<amendment rule="([^"]+)">/g;

/** The amendments a reminder's content delivers, in order, each with the skill whose section holds it. */
export function remindedAmendments(content: string): Array<{ rule: string; skill: string }> {
  return Array.from(content.matchAll(REMINDER_SECTION)).flatMap(([, skill = "", section = ""]) =>
    Array.from(section.matchAll(REMINDED_RULE), ([, rule = ""]) => ({ rule, skill })),
  );
}
