/** The skill kinds and operations whose drafts Prepare refuses without a candidate diagnosis. */
const SKILL_KINDS = new Set(["local", "managed", "upstream", "plugin"]);
const SKILL_TEXT_OPERATIONS = new Set(["direct-edit", "on-read-append", "rule"]);

type Draft = { kind?: unknown; skill?: unknown; change?: { operation?: unknown } } & Record<string, unknown>;
/** A completed `observer_review` inspect as a harness returns it: its call ID and result. */
export type Inspected = { id: string; isError?: boolean; details?: unknown };

/**
 * Grounds each skill-text repair draft as a pass would before Prepare: its
 * skill inspected once, and a candidate diagnosis citing that receipt's first
 * source. A draft holding a `diagnosis` key, even an undefined one, is sent as
 * written, and so is one whose inspection fails, so Prepare's own refusal shows.
 */
export async function groundRepairs(candidates: readonly unknown[], inspect: (skill: string) => Promise<Inspected>): Promise<unknown[]> {
  const receipts = new Map<string, Inspected>();
  const grounded: unknown[] = [];
  for (const candidate of candidates) {
    const draft = candidate as Draft;
    const needsDiagnosis = typeof draft?.skill === "string" && SKILL_KINDS.has(String(draft.kind)) &&
      SKILL_TEXT_OPERATIONS.has(String(draft.change?.operation)) && !("diagnosis" in draft);
    if (!needsDiagnosis) {
      grounded.push(candidate);
      continue;
    }
    const skill = draft.skill as string;
    if (!receipts.has(skill)) receipts.set(skill, await inspect(skill));
    const receipt = receipts.get(skill)!;
    const source = (receipt.details as { inspection?: { sources: Array<{ path: string }> } } | undefined)?.inspection?.sources[0];
    grounded.push(receipt.isError || !source ? candidate : {
      ...draft,
      diagnosis: {
        inspection: receipt.id,
        explanation: "The inspected guidance does not cover this; its sections hold no such step.",
        delta: "A future agent takes the drafted step.",
        citations: [{ source: source.path, lines: { from: 1, to: 1 } }],
      },
    });
  }
  return grounded;
}
