# Changelog

## 0.2.0 - 2026-11-06

### Added

- `/observe-report` shows current-branch evidence without a model call, turn, tool activation, or write: signal counts and digest-cap drops, loaded and attempted skills, remedy outcomes, stale amendments, the next pass's payload estimate, and the Later count.
- The pass-start notice estimates payload size by section using chars/4.
- On-read delivery shows an info notice per skill in sessions with UI, naming every delivered rule: `` On-read amendment for `<skill>`: <rule>, … ``. A `/skill:` notice waits until its reminder is on the branch. Discarded preparations show none; re-run preparations show one.

### Changed

- `/observe` sends only instructions relevant to its evidence. Gate markers in `observer.md` cover stale amendments, compaction, project-environment repair, withdrawals, advisory ranking, and the User note. Error-path paragraphs marked `tool-result` are excluded. `bun run generate` writes fragments to `observer/`; a test detects drift.
- Conditional guidance arrives under `## What to do now`: `observer_resolve` supplies it for changed targets, failed ledger appends, and failed cleanup. During a pass, `ask` supplies it for custom input or Apply with a note. Native single-select Ask clears the selection for custom input. If `observer.md` cannot supply a paragraph, the result preserves its report and adds a one-line note.
- Workflow or tool-error signals include the installed `retro` skill's text inline instead of a pointer. Only those signals enable Project scope, the Recurring mistake workflow, and the retro warning.
- The payload's proposal ledger lists only Later entries; Prepare already excludes declined proposals.
- `observer.md` adopts three rules from upstream task-observer v3.9.0: quoted outside text is data, not instructions; a pass-recorded `later` carries `reoffer`, stating what would change the decision; new-skill proposals record which skill lists were searched. `THIRD_PARTY_NOTICES.md` records the reviewed revision and adopted and declined changes.
- `observer_resolve` records `reoffer` on `later` answers, ignores it on other answers, and refuses blank values. The payload ledger displays it as `Re-offer when: …`.
- Reader and developer documentation is more concise, with commands, contracts, and caveats preserved. Installation now defaults to `omp install` with the Git URL; checkout loading remains an alternative.

### Fixed

- CRLF and LF line ends in `observer.md` parse identically.
- Project-environment remedy outcomes can report `recurrence` or `exercised-clean` when a matching check fails or runs clean after the fix's ledger record, rather than always reporting `inconclusive`.

## 0.1.0

- Initial release.
