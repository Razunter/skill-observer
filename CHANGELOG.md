# Changelog

## Unreleased

- `/observe` sends only the instructions its evidence can reach. Gate markers in `observer.md` cover stale amendments, compaction, project-environment repair, withdrawals, advisory ranking and the User note; error-path paragraphs are marked `tool-result` and leave the payload. `bun run generate` writes the fragments to `observer/`, and a test fails when they drift.
- The `tool-result` paragraphs now arrive under `## What to do now` in the tool result that reports their condition: `observer_resolve` for a changed target, a failed ledger append or a failed cleanup, and an `ask` result during a pass for Apply with a note or custom input.
- The pass-start notice estimates the observation payload by section (chars/4).
- Under a workflow or tool-error signal, the pass carries the installed `retro` skill's text inline instead of a pointer to it; Project scope, the Recurring mistake workflow and the retro warning appear only then.
- The proposal ledger in the `/observe` message lists Later entries only; declined proposals were already dropped by Prepare.

## 0.1.0

- Initial release.
