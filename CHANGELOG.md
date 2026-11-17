# Changelog

## Unreleased

### Added

- The main agent records an observation with the new `observe` tool: one remark of up to 500 characters about something a skill, a rule or the project setup got wrong. Observations are stored in `<agent dir>/skill-observer/observations.jsonl` per repository, shared by its worktrees, and survive across sessions. The next `/observe` in that repository lists them in a new `observations` payload section, starts a pass even when they are its only evidence, and then marks them shown; one never shown expires 30 days after it was last recorded. Recording the same text again raises its count. Subagent calls are refused. The status line and `/observe-report` show the pending count, and a new `observations` gate adds pass instructions for checking them.
- Each tool error in the session digest names the tool's supplier: the extension file that registered it, or the MCP server. A built-in tool shows none, and a result copied without one shows `Supplier not recorded.` The label names who supplied the tool, not who caused the failure.
- Every pass gets the remedy ladder: configuration or wiring repair, text or skill edit, amendment, barrier rule, pattern amendment and project check first, then an observer hook, then the companion extension as last resorts.
- Report items: a finding no proposal fits, a capability nothing can provide, or a fix in the code of an extension other than the companion goes into the pass summary with supplier, request and result, expected behaviour, cause status, a scenario and a next action. Report items are not asked about or stored. This replaces the "Unknown target" summary drafts.
- Observer hooks and the companion extension, under the new `harness` target scope. A pass may write or change a hook in `<project>/.omp/hooks/pre/` or `<agent dir>/hooks/pre/`, or change `<agent dir>/extensions/skill-observer-companion/`, after two approvals: the described remedy, then the exact code with its check result. Only the user's latest answer at each stage counts. The files must be written after the code's Apply, and the check rerun after the writes must be the approved command. A hook is removed after one approval that shows the file. Each identity gets one ledger record per pass. A `project` proposal whose file lies in either hooks directory or the companion directory, followed through symlinks, is refused. Changes take effect only after omp restarts.
- `scripts/check-hook.ts` runs a hook against a samples file of mistake and legitimate events on a stand-in host and reports each outcome. A `tool_call` sample and its `tool_result` can share a `toolCallId`. It ships in the package.
- `observer_review` `action: "inspect"` reads a skill's current guidance (its `SKILL.md`, every observer rule amending it and requested on-read reference files, numbered by line with fingerprints) and returns the receipt a repair cites. With `terms` it searches existing skills' names and descriptions before a new skill, and fails when the name is taken or a required source can't be read.
- Skill catalog observations: in main sessions with UI, the extension records which skills the system prompt's `<skills>` block listed, in OMP's standard or bundled custom-prompt form, at `before_agent_start`, once the prompt's user message is on the branch. Each distinct catalog is stored once per session as a custom entry, with a small binding where the branch observed it; an unchanged catalog adds nothing. There is no global store; entries last as long as the session. `observer_review` `action: "catalog"` looks a skill up by exact name or by all-term description words, optionally at an entry, in pages, applying OMP's skill notices, compactions and `/clear` resets. Results are the hook's view, not proof of what the model received, and a miss is unknown, not absence. The payload's new `catalog` section and gate carry only a summary and lookup instructions; `/observe-report` lists the summary.

### Changed

- `observer_resolve` records an applied direct edit of a local, managed or new skill only with the `approval` of its prepared proposal and `publication: { writeToolCallId }`: a successful `edit` or `write` of the local skill's `SKILL.md`, or `manage_skill` `update` of the managed skill or `create` of the new one, made after the user's Apply. Before, an applied direct edit cited only its proposal, or nothing, and was recorded even when no write happened.
- `/observe` asks through the HTML-form `ask` of OMP 18.18. `observer_review` Select returns `askHtml`, the complete form with one fieldset per selected proposal (target and gist, remedy, evidence, preview, and Apply / Later / Decline, or Keep / Update / Delete for a stale amendment); the model passes it to `ask` unchanged. Nothing is preselected.
- Proposal approval requires the saved Ask's `html` to equal the form rendered from that Select, no timeout, and exactly one answer named by the proposal's `candidateId` holding the approving label. This replaces the per-option preview comparison.
- The form shows previews as wrapped text, because the host's form dialog cuts `<pre>` lines at its width: every word and line break, with the whitespace the form collapses marked, `·` per space of an indent, a trailing run or a repeated run and `→` per tab. The bytes written are the prepared ones.
- A radio's value is `<candidateId>=<Label>`, so text typed into the form's Other row never equals an approving option.
- A pass's `ask` result gets the `tool-result` guidance **Custom input.** when an answer starts with `Other: `, and **An approval note.** when a chosen option carries a note.
- A note on Apply, added with `n` on the option row, is an approval note. The main agent revises the proposal by it as a proposal reconciliation, and `observer_resolve` writes the revision without a second Ask. Its result shows the note, the reason and the text written. A noted Apply without a revision is refused. A note that only asks for a check or acknowledges is answered by a revision identical to the approved change, with what was checked as its reason; when the check shows the change should not be written, the proposal is recorded `later` with the note as its `reoffer`. A note on a stale Update or Delete, a withdrawal or a compaction makes the answer refused, and the form's question for each of those says that an answer with a note is asked again. A note on Later becomes the deferral's `reoffer`, recorded by `observer_resolve` when the answer supplies none; a note on Decline is not recorded. A note on Apply asking for something unrelated defers the proposal as `later`; on Later or Decline the answer keeps its option, and a request in the note for another change gets its own proposal and Ask. A reconciliation's `changedTarget` is required only when the target changed.
- The observation payload lists remedy outcomes only for project-environment fixes and fixes for a skill the session loaded, and counts the rest in one line. `/observe-report` still lists every one. A project-environment fix's line names its target path after the fingerprint.
- The pass instructions tell the main agent to read an on-read fix's target amendment at the preview's path before asking when its text is not in context, since headings do not show what a broad section covers.
- Prepare names the `## ` headings of each on-read fix's target amendment as `amendmentSections`.
- Prepare and Select return less text. Prepare returns per proposal its reference, fingerprint, kind, skill or project target, gist and preview (`previews` for a stale proposal); Select returns the references of its selected and deferred proposals beside `askHtml`. The canonical changes and evidence stay in the saved details.
- `observer_resolve` answers cite their prepared proposal, through `approval` or the new `proposal`, instead of carrying skill, kind, gist, fingerprint and evidence. The proposal's evidence is recorded.
- Prepare requires a `diagnosis` on a direct edit of a local or managed skill, an on-read fix, a pattern amendment or barrier rule and a new skill: the inspection or search receipt of this pass and branch, an explanation with its disconfirming check, a one-sentence behavior `delta` and, for repairs, citations of inspected lines or sections. Prepare and Select refuse a missing, forged, failed, foreign-branch, earlier-pass or stale receipt, naming what to inspect again; the form shows the diagnosis beside the preview. Approvals saved earlier keep their contract; an unapproved proposal prepared without a diagnosis must be inspected and prepared again before Select.

### Fixed

- A pattern amendment or barrier rule that fires on legitimate output can be fixed by the observer: a rule proposed under the name of the same skill's rule replaces it, previewed as a rewrite, and records the replaced fix as `withdrawn`. Before, Prepare refused any proposal under the existing name ("already holds another proposal's fix"), so the misfiring pattern could only be edited by hand.
- `observer_resolve` records approvals on OMP 18.18 and later; it refused every one because the Ask no longer held `questions[]`.
- The digest's `ask` signals (custom input, an answer off the preselected option) fire for HTML-form results. Results saved before OMP 18.18 are still read.
- A `SKILL.md` that is a byte-identical copy of an installed skill's entry file counts as that skill: the digest shows its provenance and the skill's on-read amendment is delivered on the read. A copy that differs stays provenance unknown.
- A direct read of an installed skill that a same-named skill shadows (a local `tdd` behind a plugin `tdd`) no longer gets the name winner's on-read amendment. Amendments belong to the skill that wins its name, as their pinned skill hash already did; the digest still shows the shadowed skill with its own provenance.
- A long tool error is quoted by its start and its end around `…`, within about 300 characters, since a failed command may state why at either end. Before, only its start was kept.
- Prepare no longer refuses a revision identical to the approved change under an approval note, so an Apply whose note asks only for a check, or only acknowledges, can be written.
- Decline on a withdrawal keeps the fix: `observer_resolve` records nothing for a `declined` answer whose fix is in force, cited or typed, and says the fix stays in force. Before, citing the withdrawal was refused and the typed retry recorded `declined` under the fix's fingerprint, dropping it from later Prepares and remedy outcomes while its text stayed delivered.
- An answer citing a proposal reference that a later Prepare of the pass holds again is refused, naming the latest reference. Before, it silently recorded the older evidence.
- A refusal of a cited proposal names it once.
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
