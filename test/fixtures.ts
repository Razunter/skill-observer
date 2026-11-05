import type { SessionEntry } from "../src/omp.js";
import json from "./fixtures/entries.json";

/**
 * Trimmed copies of entries from real OMP session files, grouped by the
 * situation they show. JSON imports lose the literal shapes, so the groups are
 * re-typed as session entries here once.
 */
export const entries = json as unknown as Record<keyof typeof json, SessionEntry[]>;

// These load scenarios include a successful receipt; a request alone only proves an attempt.
for (const group of ["skillUrlRead", "skillUrlReferenceRead", "physicalSkillRead", "projectSkillRead", "managedSkillRead"] as const) {
  entries[group] = entries[group].flatMap((entry) => {
    const reads = Array.isArray(entry.message?.content)
      ? entry.message.content.filter((block) => block.type === "toolCall" && block.name === "read" && block.id)
      : [];
    return [entry, ...reads.map((block): SessionEntry => ({
      type: "message", id: `receipt-${block.id}`,
      message: { role: "toolResult", toolCallId: block.id, toolName: "read", isError: false,
        content: [{ type: "text", text: "Fixture skill content successfully read." }] },
    }))];
  });
}
