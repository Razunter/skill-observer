# Development and implementation reference

For installation, see [Setup](setup.md). For the user-facing observation pass and session digest, see [Observation](observation.md). For amendment storage, delivery, staleness and replay, see [Amendments](amendments.md). The [README](../README.md) gives the extension overview.

## Advisory proposal selection

`observer_review` activates with the other observer tools on the first explicit pass. Prepare canonicalizes project/global identities, merges duplicate evidence and removes prior scoped declines. Each candidate carries its exact change.

For an observer-owned rule or reference mutation (on-read append, pattern amendment or barrier rule, stale Update/Delete, withdrawal, compaction), Prepare builds the operation `observer_resolve` would carry out. This includes the rule identity; the trimmed body, section or samples it would write; the reference files it would write or delete; the rule and reference bytes it read itself (as SHA-256); and a deterministic preview rendered from that operation.

Prepare refuses a change whose preview holds a carriage return. The Ask form renders line breaks as `<br>` and cannot show a carriage return, so the user would approve bytes other than those written. A stale Keep writes no new content, is not prepared and keeps a file's CRLF line ends. Deleting a skill's last on-read amendment holds the skill's reference folder as Prepare read it, even when empty. A direct edit of a local, managed, new or project target keeps the pass's own exact preview and its normal owner.

Each eligible proposal has a reference `{ reviewToolCallId, candidateId, contentHash }`; the successful Prepare result on the session branch is its only record. Prepare returns minimized `judgeStates` and `needsRanking: true` only for the priority class crossing the five-question cutoff, and only with an explicitly assigned, available host `judge` model. A class is compared only when it has some slots available but more eligible candidates than slots. Fully selected and fully deferred classes need no ranking. Exact previews and full transcripts are not ranking inputs.

Active tools belong to the running process, so a session that starts, switches or branches onto a branch still inside an observation pass gets the observer tools back. That lets a restored turn resolve the approvals its saved branch already holds.

Prepare drops a scoped decline once its identity is known, before validating or reading the proposal's target. A declined proposal whose skill was removed or whose target is no longer writable therefore does not fail the call. A stale amendment's Update and Delete drafts form one proposal holding both as `alternatives`, each with its own prepared change and preview. That Keep/Update/Delete question takes one of the five slots.

An on-read append whose section the amendment already holds verbatim is prepared with effect `record` and previewed as a ledger-only change, since publication leaves the file unchanged. A compaction's `includes` resolve to the fingerprints of the on-read appends prepared in the same call. A re-offered Later fix with a reworded gist therefore keeps its recorded identity at `observer_resolve`. An inclusion naming no such append, or more than one, fails Prepare.

Select takes only those references. It resolves each through the branch's strict completed-call lookup to a successful `observer_review` Prepare and requires exactly one saved proposal with that candidate ID. It rejects a duplicated reference, a content hash that differs from the saved proposal, or a saved proposal that no longer matches its own hash. It accepts no candidate drafts, so a changed proposal must be prepared again. Neither action writes or authorizes a file. During a pass, both outputs carry their own `observerToolCallId`, which an approval cites.

Select also returns `askHtml`, the whole Ask form rendered from its `selected` proposals in order; the model writes no question text, option or default. Each proposal is one `<fieldset>`: a `<legend>` naming the target and gist, the remedy, the evidence (quote, count, source) as a list, the preview, a bold question line, then one required radio group whose `name` is the proposal's `candidateId`. Each radio's label text is its label: `Apply`, `Later`, `Decline`; `Apply`, `Decline` for a withdrawal; `Keep`, then `Update` and/or `Delete` for a stale proposal's `alternatives`, each alternative's preview under its own bold heading. Its `value` is `<candidateId>=<Label>`: the host reports text typed into the group's Other row as an option's label when it equals that option's value, so a bare label as the value would let typed text approve. No option is `checked`: OMP's `ask` submits a form's current values on timeout, and a default is not Proposal approval.

The form shows a preview in a `<p>`, each line HTML-escaped and lines joined by `<br>`, because the host's form dialog cuts `<pre>` lines at the dialog width. Every word and line break shows as wrapped text. The form collapses whitespace, so indentation, tabs, repeated and trailing spaces are marked: `·` per space of a leading run, a trailing run or a run of two or more, and `→` per tab. Single spaces between words stay. The bytes written are the prepared ones.

The gate reads the effective explicit assignment through `pi.pi.settings.getModelRole("judge")`. It then uses the host's exported `resolveScopedModels` helper against authenticated `ctx.modelRegistry.getAvailable("all")` models of kind chat, tiny or judge, with discovery disabled. The installed host's `judge_batch` uses the `judge` role, not `decision`. Generic role resolution can select built-in defaults without an explicit assignment, while `ctx.models.resolve` only sees chat models and misses native judges.

Missing configuration, unavailable models, unreadable settings or missing host APIs mean no ranking request and empty `judgeStates`. Select rechecks this gate. When unavailable, it ignores caller-supplied rankings and returns one truthful fallback explanation for compared classes.

With that gate open, the pass may use one installed host `judge_batch` with a shared ordinal evidence/impact/recurrence rubric and no retry. No provider client is added, no new settings are enabled, and no ranking/model call occurs inside the extension tool. A class outside that cutoff comparison, including a singleton, needs no judge or fallback disclosure. If judge support/model use is unavailable, a batch fails, answers are missing/invalid, confidence is below 0.7 or scores contradict their evidence, Select returns one fallback explanation and uses stable evidence/repeat ordering.

Selection always preserves stale Update/Delete, explicit User note, evidence-backed finding and compaction priority, with at most five questions in the main batch. An answer retracting an applied fix can require a separate prepared and selected withdrawal question in the same pass, as described in [Observation](observation.md#observe). Advisory scores reorder only within classes; they cannot resurrect declines, dismiss eligible findings, approve publication or bypass barrier replay. Overflow remains deferred: ordinary project/skill proposals are recorded as Later, while stale amendments and compactions retain existing re-offer behavior. Questions still show exact previews and combined supporting evidence, not merely a judge score.

## Proposal approval

`observer_resolve` writes an applied on-read fix, pattern amendment or barrier rule only when the saved session branch shows the user explicitly approved its prepared proposal in the current observation pass. The answer carries `approval`: the proposal's Prepare `reference`, the Select call ID and the `ask` call ID. The resolver uses them only to locate evidence. Through the strict completed-call lookup, it checks that Prepare succeeded and still holds the proposal under its content hash, and that a successful Select after it selected exactly that reference.

It also checks that a later successful `ask` the model made natively carries as `html` exactly the form rendered from that Select's saved `selected` proposals. The result's `details.timedOut` must be unset, and `details.answers` must hold exactly one entry whose `name` is the proposal's `candidateId`, with `answer` exactly `Apply`. The resolver writes the prepared section or rule: an on-read append's section, or a rule's name, body, pattern, scope and samples. It replays the rule before writing. The answer carries no `rule`, and its skill, kind, gist and any fingerprint must match the proposal.

The resolver writes only while the target holds the bytes Prepare read, or, for an on-read amendment, already holds the section verbatim, so the write adds nothing.

Stale Update and Delete answers and every withdrawal are guarded the same way. A stale amendment's proposal holds its prepared Update and Delete as `alternatives`. Its fieldset offers `Update` and/or `Delete` beside `Keep`, and shows each alternative's preview. An answer of exactly `Update` or `Delete` approves that alternative only. A `stale` answer with `action: "update"` or `"delete"` carries that `approval`. The resolver writes the alternative's body and reference files, or deletes the rule and releases its reference files, exactly as prepared.

A `withdrawn` answer carries the `approval` of its prepared withdrawal, answered `Apply`, whatever the withdrawal does: only record it, delete the rule file, or rewrite the on-read amendment with the prepared body and reference files. Neither answer carries its own `body`, `references` or `rule`; one that does is refused. A withdrawal requested in prose is still prepared, shown and asked.

Stale Keep stays outside approval: it only re-pins. A `keep` answer carrying a `body`, `references` or `approval` is refused. The resolver writes only while the rule file and the skill's reference folder hold the bytes Prepare read. Re-pinning a stale Keep's `skillHash` line alone does not count as a change, since it adds no instruction content. Any other change, such as text added to a rule after its deletion was previewed, writes nothing until prepared and asked again. Stale answers and withdrawals take no reconciliation.

An applied compaction is guarded the same way. Its `compactions` entry carries the `approval` of its prepared compaction, answered `Apply`, and no `body`, `includes` or `references` of its own. An entry carrying any of them is refused. The resolver writes the prepared body and replaces the skill's reference folder with the prepared set, removing the files the preview lists as deleted. It checks coverage against the prepared `includes`: the fingerprints of the on-read appends of the same Prepare it covers.

It writes only while the amendment and reference folder hold the bytes Prepare read, a re-pin aside. A compaction takes no reconciliation either. It rewrites the whole body, so it cannot keep content added after Prepare; a changed amendment needs a new compaction and question.

A raw section or rule draft, a forged or mismatched reference, a result or text claiming consent, a hook-only or nested `ask`, a form that differs from the rendered one, a cancelled, failed, duplicated or misordered receipt, a timeout, nothing chosen (`""`), any other label, and custom input approve nothing. Each is refused with its own reason.

Custom input is the user's only free text: an answer of `Other: ...`, from the free-text row the host adds to every radio group. It never approves. The pass prepares a new proposal for what it asks, and asks again.

A failed approval writes and records nothing. Its reason appears under the call's not-recorded answers; it never becomes Later or Decline, even for a rule whose replay failed.

When the target changed after Prepare, for instance by the user's own edit, the answer writes nothing until the main agent reconciles it. A **proposal reconciliation** is a revised on-read append or rule prepared through `observer_review` in the same pass. Its candidate carries `reconciles`: the approval exactly as `observer_resolve` would cite it, how the target changed, the reason, and the agent's judgment that the revision keeps the approved intent and the target's unrelated content.

Prepare checks that the cited approval still holds and the target did change. The revision must make the same operation on the same target (the same amendment, or the same rule name) for the same skill under the same ledger identity. The resolver rechecks these conditions, that the revision was prepared after the user's answer and cites exactly that answer's approval, and that the target still holds the bytes the revision read. The answer then carries `approval.revision`, the revision's reference, and the resolver writes the revised content.

An append preserves the amendment's current content except for trailing whitespace, so newly added content survives. The writer trims trailing whitespace before adding the section separator. A rule write replaces the whole file, so a revised rule's body carries the new content. The resolver replays the revised pattern and samples before writing it; a revision that fails replay is recorded as `later` like any rule.

A revision that would delete a changed amendment or rule, or rewrite one as a stale update, withdrawal or compaction, needs a new proposal and question. Whether the revision keeps the approved intent and new content is the agent's trusted judgment, not something the code proves. For each section, rule or compaction written, the result's `approvals` (and its text) lists the user's approval and any reconciliation. The last is named as the agent's revision, not approved by the user.

Authority comes from the branch alone; there is no approval journal or cache. The current pass starts at the latest `/observe` message and ends at a later prompt the user types, a `/skill:` start or a `/clear` reset. A new `/observe` starts another. An approval lasts while its whole chain stays on the branch inside the current pass and the user has sent no message (prompt or steering) since answering, which may retract it.

Compaction, a resumed session, agent and harness messages and tool results leave approval intact, so a retry in the same pass may reuse it. An already-present section is not appended twice. The resolver checks approval and the target's bytes when validating the call and again after the replay wait, with nothing awaited before the writes. Later changes to a target within the call are its own answers'.

This is trusted-host enforcement of the recorded correspondence, not a filesystem permission. Every rule and reference change `observer_resolve` makes rests on such an approval, with three exceptions that keep their own checks: a stale Keep's re-pin of the `skillHash` line; local, managed and new-skill edits, which the main agent makes with normal tools and the resolver only records; and project publication, which the resolver validates from write and check receipts and never writes.


## Ledger

`observer_resolve` appends one record per proposal to `<agent dir>/skill-observer/ledger.jsonl` (global, not per project). Each record holds the fingerprint, target skill, kind (`local`, `managed`, `upstream`, `plugin` or `new`), gist, outcome, timestamp and session id. It also holds `rule`, the rule file, for every answer that wrote one, and `evidence`, the quotes the question cited, each as `{ quote, count }` with the quoted signal's repeat count. An answer citing nothing keeps the evidence last recorded under its fingerprint, so re-offering a proposal or settling its stale amendment preserves its evidence.

A `later` answer, skill or project, may carry `reoffer`: which observation would change the decision, when it could arrive, and whether the deferred action is still possible. The pass writes one on each `later` it records itself (past the cap, or a barrier set aside because the check can't run). It writes one on a user's Later only from the user's own custom input. The tool can't tell the two apart, since a Later carries no approval. It keeps `reoffer` on `later` answers only, drops it from any other, and refuses a blank one.

Proposal outcomes are `applied`, `later` or `declined`; `withdrawn` takes back an earlier applied fix (see [Withdrawals](#withdrawals)). Stale-amendment answers are `kept`, `updated` or `deleted`, recorded under the fingerprint the rule carries. For a skill's on-read amendment, this is its own fingerprint (see [The skill's on-read amendment](amendments.md#the-skills-on-read-amendment)). A stale delete of a skill's on-read amendment also records each fix in force in it as `deleted`. A compaction's record carries `compaction: true` (see [Compaction and reference files](amendments.md#compaction-and-reference-files)).

Older ledgers also hold `merged` records, which passes before ADR 0003 wrote for an on-read amendment they folded into another; a `merged` record is no fix in force. Ordinary project and skill proposals past the cap of 5 are recorded as `later` without being asked. Stale amendments and compactions keep their existing re-offer behavior. The fingerprint hashes the target skill and gist with case, punctuation and spacing removed. A re-offered proposal is recorded under its earlier fingerprint, so rewording keeps its identity. The latest record per fingerprint wins. The tool joins the model's tools at the session's first `/observe`, so sessions that never observe don't carry it.

Prepare refuses a rule, section or compaction that can't be written: a rule name in use; a skill missing from the lock or of another provenance than the candidate names; an invalid pattern, scope or sample set; a barrier rule without a pattern; an on-read fix whose body doesn't open with a `## ` heading; a rule for a new skill; a reference file name that isn't a plain file name; or a body with reference files that doesn't name each by its absolute path. Nothing can approve it.

An answer the tool can't carry out is reported and not recorded. This includes those conditions, checked again at write time; an applied or withdrawn answer carrying a `rule` instead of `approval`; a stale answer carrying a `body` or `references`; a compaction carrying a `body`, `includes` or `references`; an approval that doesn't hold; an on-read fix for a skill with two or more on-read amendments; or a withdrawal that fails its checks.

### Withdrawals

A `withdrawn` answer cites the fingerprint of a fix whose latest outcome is `applied`, `kept` or `updated`, names that fix's skill, and carries the `approval` of its prepared withdrawal (see **Proposal approval**). The withdrawal candidate names the fix by `fingerprint`. When the fix's rule still exists and is the skill's on-read amendment, the candidate carries as `body` the amendment's new body without the fix's text. The tool rewrites the body and leaves the frontmatter unchanged; an empty body deletes the amendment and its reference files.

When the fix's text sat in a reference file, the candidate also carries `references`, the complete new set. This replaces the folder's contents before the body is rewritten; without it the reference files stay. Several withdrawals from one amendment in one call carry the same body. Withdrawals run before the call's additions, so a new body drafted from the file on disk keeps the sections the call adds. The tool deletes any other rule file, but only if it carries the marker and that fingerprint.

Prepare refuses a withdrawal of a hand-written rule, a rule holding another fix, an amendment holding other fixes with no new body, a fingerprint with no applied fix, a compaction's fingerprint, or another skill's fix. The resolver reports as not recorded, changing nothing, a withdrawal that would delete a rule file while other fixes in force, not withdrawn in the same call, still point at it. The result names those fixes. It also refuses a withdrawal carrying a body for an amendment that a stale update or delete changed in the same call, since that body was drafted from the file before the stale answer.

A fix whose rule is already gone, or that wrote none (an edit to a local or managed skill, which the pass reverts itself), is only recorded. The `withdrawn` record keeps the skill, kind, gist and `rule` of the fix it takes back. Moving a fix to another skill is one call with a `withdrawn` answer for the old skill and an `applied` answer for the new one. The pass asks about a fix you retract or redirect this way, whether in an answer's text or a later message, and records it once you approve the withdrawal.

A record's `rule` is the path the file had when the record was written; ledger rows are never rewritten. A fix's rule is the one named by that path's file name, looked up in the amendments directory, then the rules directory, so the fixes of an on-read amendment that moved out of the rules directory stay attached to it.

### Publication phases and recording failures

One call's changes run in fixed phases across every skill it names: stale answers, then withdrawals, then the other answers in the order sent (on-read additions with pattern amendments and barrier rules where they fall among them), then compactions. Every pattern is replayed before the first change. A change that fails, or whose approval no longer holds, is reported and writes and records nothing. The others in the call still apply. A later phase acts only on what earlier changes actually did, so a failed addition counts toward no compaction.

The exception is a deletion that removed its rule file and then failed to delete the skill's reference folder. The deletion is listed as made, with its records, tombstones included. The result's `cleanup` names what remains, for the pass to inspect and report without calling again.

The result's `publications` lists each change the call carried out, in order: its `operation` (`stale-keep`, `stale-update`, `stale-delete`, `withdrawal`, `on-read-append`, `rule` or `compaction`), skill, rule file and the fingerprint its record carries. An on-read addition whose section the amendment already held verbatim changed no file and is not listed. Neither is a deferred, refused or record-only answer. [`src/on-read-amendment-transitions.ts`](../src/on-read-amendment-transitions.ts) owns these phases; `observer_resolve` validates each answer, runs the replays, appends the records and reports.

Rule, amendment and reference file changes and the ledger append are separate writes; no call is a transaction. When the append fails, the call still returns what it carried out. For each record in order, `recording` says whether it reached the ledger: `recorded`, `unrecorded` or `unknown`, with the error. The append reads the ledger once beforehand. A failure before writing starts leaves every record `unrecorded`.

After a failed write, one read of the file settles each record. A record written whole (its JSON complete, with or without its newline) is `recorded`; one cut short or not reached is `unrecorded`. If the file can't be read or no longer starts with its earlier bytes followed by a prefix of the append, every record is `unknown`. The exception alone settles nothing.

An applied change whose record didn't reach the ledger is an Unrecorded publication. The result lists it as made, never as `later`, and tells the pass to report it and leave the ledger to the user, without calling again or redoing it. A `later` or `declined` record that didn't reach the ledger, answered so or deferred by the replay or coverage check, is listed separately. It wrote nothing and keeps its outcome, unrecorded. Nothing is retried, repaired or replayed at startup.

The result text ends with `## What to do now` holding the `tool-result` paragraph of `observer.md` for each of three reported conditions: a failed ledger append, a failed cleanup, and an answer refused because its target changed since Prepare or the reconciliation. The last is decided by type. `checkTarget` in [`src/proposal-approval.ts`](../src/proposal-approval.ts) throws `TargetChangedError`, and the resolution's `targetChanged` flag records that one reached the failures. The failure text is never matched.

During a pass, the `ask` result hook in [`src/skill-observer.ts`](../src/skill-observer.ts) adds the `custom-input` paragraph under the same heading when an answer starts with `Other: `. `toolResultGuidance` reads the paragraphs from `observer.md` on each call, keeping a single source. `whatToDoNow` never throws: these results may report changes already made, so a paragraph it cannot load becomes a logged error and a one-line note.

`/observe` adds the ledger to its message: deferred proposals, which the pass offers again, each with its fingerprint and, when its record has one, its `reoffer` as `Re-offer when: …`. Declined proposals are left out because Prepare already drops a scoped decline. A withdrawn fix is not listed, and neither is a compaction.

### Project-local decisions

The same ledger also stores project answers as `kind: "project"` with `target: { scope: "project", root, path, mechanism }`, without a skill name or rule path. The project root is the canonical current working directory supplied by OMP, not a discovered Git root or a caller-selected directory. Launch from the intended project directory.

Project fingerprints hash an unambiguous tuple of the project namespace, canonical root, canonical root-relative target and mechanism normalized by removing case, punctuation and spacing. Historical global fingerprints are unchanged. Symlink aliases of a root or target share an identity. Targets must be file paths below that root; traversal, absolute paths, dangling symlinks and symlink escapes are refused. Safe missing leaf files and directories are permitted for proposed new files.

`/observe` receives global decisions plus only the current project's decisions. Project rows never participate in skill Rules in force, compaction, stale-amendment ownership, or skill withdrawal. Earlier evidence is carried forward when a new answer does not cite evidence. Project answers offer `applied`, `later` or `declined`; they cannot carry a skill amendment.

Project publication uses normal `write` or `edit` tools, not the rule writer. An applied answer needs `publication: { writeToolCallId, checkToolCallIds, afterHash }`. The successful write/edit and subsequent successful foreground `bash` checks must be present on the actual current OMP session branch. The write must target this canonical file; each check must use an explicit `cwd` equal to the canonical project root. `afterHash` is the SHA-256 of the file's current bytes.

Native hashline edit receipts and structured path-based edits are supported; delete/rename receipts and background/service checks are not. OMP's successful foreground bash results omit `exitCode`; nonzero exit codes, errors, timeouts and unfinished jobs are refused. Missing or invalid observations record no applied outcome.

During an active observation turn, successful `ask`, `edit`, `write`, `manage_skill` and `bash` outputs retain their original content/details and append `{"observerToolCallId":"<actual opaque host ID>"}` for exact review and publication receipts. Copy that exact value, rather than a file snapshot tag, command string or session-entry ID. Errors and ordinary turns keep their outputs unchanged. An exposed ID is only call metadata; the resolver still requires matching successful branch evidence and rejects unfinished/background checks.

Nested `eval` calls retain branch-local hook receipts for their actual tool arguments, completion and result details; IDs or JSON printed by eval are not receipts. Multi-file edits are accepted for each included target only after every path passes canonical project containment. An absent Bash service name can be omitted or `null`; named services remain rejected.

The extension's tool hooks save a copy of every call they see, native or not: the model's assistant message reaches the branch only after a call's `tool_call` hooks, so a copy is never dropped as redundant there. An outcome is copied only when its call was. The resolver prefers a complete native pair while rejecting duplicate IDs within either source and conflicting receipt status. Hook receipts require unchanged execution input from the result hook. A missing or revised input leaves publication unaccepted; the write must be reconciled rather than reported as applied.

Project receipts validate ledger scope and observed tool evidence; they do not attest that a successful command proves the remedy correct. These checks are trusted-host checks, not an OS sandbox or an atomic filesystem transaction. Reconcile unknown outcomes rather than inventing applied receipts.

## Extension entry

OMP loads [`src/skill-observer.ts`](../src/skill-observer.ts) through the `omp.extensions` entry in [`package.json`](../package.json). The extension has no runtime dependencies. OMP names an extension after its entry file, or after the entry's folder when the file is `index.ts`. The `skill-observer.ts` entry gives this module the name `skill-observer` and the settings ID `extension-module:skill-observer`; an entry at `src/index.ts` would instead be named `src`. Configured module paths are deduplicated by real file path, so a symlink and its target load once.

## Develop

Run these commands from a source checkout's extension root, the directory containing `package.json`. Package tarballs omit tests and development configuration.

```sh
bun install
SKILL_OBSERVER_NATIVE_TESTS=0 bun run test
bun run typecheck
```

This runs ordinary tests without launching the native OMP checks. See [Testing](#testing) for explicit native checks.

### Instruction fragments

[`observer.md`](../observer.md) is the one maintained source of the pass instructions. Gate markers in it name the evidence a part needs (see [Observation payload](observation.md#observation-payload)):

```md
<!-- when: stale -->
- **Stale amendment**: pick your verdict. …
<!-- end -->
```

A marker sits alone on its line and wraps whole paragraphs or list items, never part of a sentence or item. Gates are `stale`, `compaction`, `project`, `withdrawal`, `ranking`, `note` and `tool-result`; blocks don't nest. One parser, `parseFragments` in [`src/payload.ts`](../src/payload.ts), splits the file at its `##` headings and markers. It throws on an unknown gate, an unbalanced or nested marker, or a block that splits a paragraph or list item. `/observe` runs it on every pass, so a malformed marker stops the pass with an error notice.

After editing `observer.md`, regenerate the committed fragment files:

```sh
bun run generate
```

It writes `observer/<section>-<gate|core>-<n>.md`, one file per fragment, where `n` is the fragment's position in its section. Readers can browse the gated parts. `/observe` assembles from `observer.md` itself, not these files, so an approved edit to `observer.md` applies to the next pass without regenerating. A test in `test/payload.test.ts` regenerates the files in memory and fails when `observer/` differs.

### Package a local tarball

```sh
bun pm pack
```

Run this from the source checkout's extension root. It creates `skill-observer-0.2.0.tgz` using the `files` allowlist in `package.json`: runtime source, `observer.md` and its generated `observer/` fragments, reader documentation, the licence and third-party notices, the README, and changelog. It excludes tests, development configuration, and installed dependencies. Packing creates a local archive for distribution checks; it does not publish the package. Normal setup uses `omp install` with the repository URL.

### Modules

| File | Owns |
| --- | --- |
| [`src/skill-observer.ts`](../src/skill-observer.ts) | Entry: wires hooks, the status hint, `/observe` with its observation payload assembly, `/observe-report` and the startup migration |
| [`src/payload.ts`](../src/payload.ts) | Observation payload: the `observer.md` fragment parser, gates from pass evidence, gated instruction text, `tool-result` guidance and the chars/4 payload estimate |
| [`scripts/generate-fragments.ts`](../scripts/generate-fragments.ts) | `bun run generate`: writes `observer/` from `observer.md` |
| [`src/delivery.ts`](../src/delivery.ts) | On-read amendment delivery on both routes (`/skill:` reminder, `read` of the entry file) and the once-per-context-window rule |
| [`src/reminder.ts`](../src/reminder.ts) | Delivery records: reminder markup, reminder message type, delivery entry type and their parsers |
| [`src/amendments.ts`](../src/amendments.ts) | Observer rule files in both directories: reading, writing, pins, staleness and the load-time migration |
| [`src/provenance.ts`](../src/provenance.ts) | Where a skill comes from (local, upstream, managed, plugin) and the skill-folder `skillHash` |
| [`src/digest.ts`](../src/digest.ts) | Session digest: skill signals, loaded skills and deliveries rebuilt from the branch |
| [`src/ledger.ts`](../src/ledger.ts) | Proposal ledger: append-only JSONL, latest answer per fingerprint |
| [`src/resolve.ts`](../src/resolve.ts) | `observer_resolve`: validates and records answers, and replays pattern rules before the call's changes |
| [`src/on-read-amendment-transitions.ts`](../src/on-read-amendment-transitions.ts) | On-read amendment transitions: one call's stale settlements, withdrawals, additions and rules, and compactions in their phases, with withdrawal checks, compaction coverage and reference release |
| [`src/publication.ts`](../src/publication.ts) | Builds and validates the rule of an applied fix from its approved section or rule |
| [`src/project-publication.ts`](../src/project-publication.ts) | Project-fix publication receipts checked against the session branch |
| [`src/session-tool-evidence.ts`](../src/session-tool-evidence.ts) | Session tool evidence: writes the hook records and indexes them with native tool records by call ID for the lossy digest view, the strict completed-call pairing receipts use and native placement for delivery |
| [`src/review.ts`](../src/review.ts) | `observer_review`: canonical prepared proposals with previews and target snapshots, reference-verified selection with the rendered Ask form, and advisory judge ranking |
| [`src/proposal-approval.ts`](../src/proposal-approval.ts) | Proposal approval: the current observation pass, the user's branch-backed Prepare → Select → native Ask approval of an on-read append, pattern amendment, barrier rule, stale Update or Delete, withdrawal or compaction, read from the form's answers, and the proposal reconciliation of an append or rule |
| [`src/replay.ts`](../src/replay.ts) | `observer_check`: replays barrier-rule samples through `omp ttsr test` |
| [`src/rules-in-force.ts`](../src/rules-in-force.ts) | The Rules in force section of the `/observe` message |
| [`src/references.ts`](../src/references.ts) | Reference files of an on-read amendment and their atomic replacement |
| [`src/outcomes.ts`](../src/outcomes.ts) | Remedy outcomes of applied skill and project-environment fixes |
| [`src/report.ts`](../src/report.ts) | The `/observe-report` evidence report and its rendering |
| [`src/omp.ts`](../src/omp.ts) | The structural slice of OMP's extension API and session shapes |

### Testing

`test/setup.ts` points `PI_CODING_AGENT_DIR` at a temp dir for the whole suite, so no test or spawned `omp` reaches the live agent dir.

When the installed Bun provides the native checker, `bun check` uses the same project configuration without emitting files. The `typecheck` script remains `tsc --noEmit` for compatibility; see [Bun's checker documentation](https://bun.com/docs/runtime/check).

Tests cover digest/provenance, observer selection and publication, and amendment delivery through the extension's hooks. Prompt assertions check identities, evidence, counts and required markers rather than explanatory sentences.

Unit tests create their own temporary skills, lockfile, managed directory and plugin registry. Historical names such as `ce-commit-jj` identify fixture files, not dependencies on your installed local skills. Filesystem and subprocess fixtures do not establish model gain or effective instruction-loading parity.

### Explicit native checks

Native checks require Bun and an installed `omp` that responds successfully to `omp --version`. With `SKILL_OBSERVER_NATIVE_TESTS` unset or set to a value other than `0`, the suite enables its OMP-backed tests when that binary is available. To request those checks explicitly, run this from the extension root:

```sh
SKILL_OBSERVER_NATIVE_TESTS=1 bun run test
```

The installed OMP host loads `test/native-schema.ts` without a model prompt to verify actual tool-schema registration. It uses a temp agent dir so the extension's startup migration never touches your rules. The amendment/replay suites use `omp ttsr test` for native trigger checks. These OMP-backed checks are skipped when OMP is unavailable or `SKILL_OBSERVER_NATIVE_TESTS=0`; requesting them with `1` does not turn a missing prerequisite into a passing check.

The `/skill:` reminder finds the skill by the first line of OMP's user-invocation template. One test renders `src/prompts/skills/user-invocation.md` from the package of the first `omp` on `PATH` (an npm or Bun global install), so a reworded template in the installed OMP fails the suite. It is skipped, independently of the native-test flag, when `omp` is missing or is a compiled binary that ships no template. Native checks still require their OMP or Bun prerequisites.

### Pre-commit hook

Enable the bundled hook in each clone with `git config core.hooksPath hooks`. It rejects unstaged or untracked files so verification matches the index. It sets `SKILL_OBSERVER_NATIVE_TESTS=0` so native OMP checks stay explicit-only, and runs `bun run check` (typecheck, then tests). Missing Bun/dependencies or a failing check blocks the commit.
