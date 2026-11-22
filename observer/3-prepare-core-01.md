## 3. Prepare

Prepare only eligible candidates. Set `priority` to `stale` for stale Update/Delete questions, `note` for explicit User note proposals and withdrawals the user asked for, `evidence` for other evidence-backed findings, or `compaction`. Keep stale Keep verdicts and report items outside review.

**Redact evidence before submitting Prepare, including re-offers and reconciliations.** Keep real examples and non-sensitive details. Replace private values with clear placeholders such as `[redacted email]`, including in evidence copied from an earlier record or a User note. Start each altered `quote` with `[redacted excerpt] ` so it cannot be mistaken for an exact quotation. Keep the `count` and existing `occurrenceIds`. Use `source`, when present, as a permitted display citation, not a verified primary locator. If a private value is decisive, verify it at the primary source within scope and permissions or report the gap. A placeholder does not establish an exact recurrence. Keep placeholders out of exact owner-tool inputs and checks; submit and run them as reviewed.

Call `observer_review` with `action: "prepare"`. Each candidate includes its kind and skill or scoped target, `gist`, `remedy`, cited `evidence` (`quote`, `count`, optional `occurrenceIds` and optional `source` display citation) and its exact `change`:

- `direct-edit` with the exact `preview` for a local or managed skill edit or a new skill;
