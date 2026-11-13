# Changelog

## Unreleased

### Changed

- `/observe` asks through the HTML-form `ask` of OMP 18.18. `observer_review` Select returns `askHtml`, the complete form with one fieldset per selected proposal (target and gist, remedy, evidence, preview, and Apply / Later / Decline, or Keep / Update / Delete for a stale amendment); the model passes it to `ask` unchanged. Nothing is preselected.
- Proposal approval requires the saved Ask's `html` to equal the form rendered from that Select, no timeout, and exactly one answer named by the proposal's `candidateId` holding the approving label. This replaces the per-option preview comparison.
- The form shows previews as wrapped text, because the host's form dialog cuts `<pre>` lines at its width: every word and line break, with the whitespace the form collapses marked, `·` per space of an indent, a trailing run or a repeated run and `→` per tab. The bytes written are the prepared ones.
- A radio's value is `<candidateId>=<Label>`, so text typed into the form's Other row never equals an approving option.
- A pass's `ask` result gets the `tool-result` guidance **Custom input.** when an answer starts with `Other: `, and **An approval note.** when a chosen option carries a note.
- A note on Apply, added with `n` on the option row, is an approval note. The main agent revises the proposal by it as a proposal reconciliation, and `observer_resolve` writes the revision without a second Ask. Its result shows the note, the reason and the text written. A noted Apply without a revision, and a revision identical to the approved change, are refused. A note on a stale Update or Delete, a withdrawal or a compaction makes the answer refused. A note on Later becomes the deferral's `reoffer`; a note on Decline is ignored. A reconciliation's `changedTarget` is required only when the target changed.
- The observation payload lists remedy outcomes only for project-environment fixes and fixes for a skill the session loaded, and counts the rest in one line. `/observe-report` still lists every one.
- Prepare names the `## ` headings of each on-read fix's target amendment as `amendmentSections`.
- Prepare and Select return less text. Prepare returns per proposal its reference, fingerprint, kind, skill or project target, gist and preview (`previews` for a stale proposal); Select returns the references of its selected and deferred proposals beside `askHtml`. The canonical changes and evidence stay in the saved details.
- `observer_resolve` answers cite their prepared proposal, through `approval` or the new `proposal`, instead of carrying skill, kind, gist, fingerprint and evidence. The proposal's evidence is recorded.

### Fixed

- `observer_resolve` records approvals on OMP 18.18 and later; it refused every one because the Ask no longer held `questions[]`.
- The digest's `ask` signals (custom input, an answer off the preselected option) fire for HTML-form results. Results saved before OMP 18.18 are still read.
- A `SKILL.md` that is a byte-identical copy of an installed skill's entry file counts as that skill: the digest shows its provenance and the skill's on-read amendment is delivered on the read. A copy that differs stays provenance unknown.
- A long tool error is quoted from its end, where a failed command states why, instead of its start.
- Select refuses proposals once their observation pass has ended (a later prompt, `/skill:` start or `/clear`) or that an earlier pass prepared, so no form is shown whose answers could approve nothing. Before, Select returned the form and only Resolve or a reconciliation Prepare refused the answer.
- The pass instructions say an Ask interrupted by a message is unanswered: answer the message, then ask the same form again in that turn.

### Removed

- `approval.nonModifyingNote`. A note on Apply is now an approval note, read from the Ask's `details.notes`. Custom input (`Other: ...`) still never approves.

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
