# Development and implementation reference

For installation, see [Setup](setup.md). For the user-facing observation pass and session digest, see [Observation](observation.md). For amendment storage, delivery, staleness and replay, see [Amendments](amendments.md). The [README](../README.md) gives the extension overview.

## Staged observation pass

The main agent starts a pass only when the user runs `/observe` in an interactive session. A truly empty branch returns before starting a model turn. A completed response to real work can start discovery even without a tool failure or loaded skill. Use the digest as an index. Recover decisive clipped or compacted evidence from the active branch's saved session and entry locators. A User note, observation or earlier `retro` suggestion can point to primary evidence. If you cannot recover that evidence, report the gap instead of treating the lead as verified. Optional `retro` categories do not control eligibility.

The initial message contains discovery instructions and evidence. It keeps current rule identities, amendment headings, firings, remedy outcomes and maintenance cues visible. `observer_review` `action: "evidence"` retrieves historical details by `key.skill`, `key.rule` or `key.fingerprint`. Prefer a direct read. Use a read-only scout only when a bounded lookup in named or narrowly scoped same-project sessions would cost materially more to do directly. The main agent validates the excerpts. Neither the transcript nor a scout can authorize scope.

At a fresh `/observe` pass, the extension activates `observer_review` and leaves `observer_check` and `observer_resolve` inactive. The existing `observe` tool and unrelated active tools are unchanged. When a finding needs a proposal or recording, call `observer_review` with `action: "draft"`. A successful Draft delivers drafting and preparation guidance and enables `observer_check`. Prepare supplies Select guidance when it has eligible proposals. Select supplies Ask guidance with the rendered form.

When an exact native Ask result delivers publication or recording guidance, it also enables `observer_resolve`. A successful `observer_review` with `action: "record"` enables `observer_resolve` and delivers guidance for outcomes that need no Ask, such as stale Keep or pending Later outcomes. Record can also recover guidance after restore. It grants no approval. Missing required guidance stops the affected step.

`/observe-report` is model-free, does not consume observations, and does not change active tools. It estimates the initial message only, as UTF-16 code units divided by four and rounded up per section.

## Advisory proposal selection

Prepare canonicalizes identities, merges duplicate evidence and removes prior scoped declines. Each candidate carries its exact change. A rejected draft gets an input index, gist and reason, but no reference. An independent valid draft stays eligible. If shared state or shared receipts are invalid, Prepare rejects the entire batch. Dependent stale alternatives and compaction inputs must be complete before they can advance.

For an observer-owned rule or reference mutation (on-read append, pattern amendment or barrier rule, stale Update/Delete, withdrawal, compaction), Prepare builds the operation `observer_resolve` would carry out. This includes the rule identity; the trimmed body, section or samples it would write; the reference files it would write or delete; the rule and reference bytes it read itself (as SHA-256); and a deterministic preview rendered from that operation.

Prepare refuses a change whose preview holds a carriage return. The Ask form renders line breaks as `<br>` and cannot show a carriage return, so the user would approve bytes other than those written. A stale Keep writes no new content, is not prepared and keeps a file's CRLF line ends. Deleting a skill's last on-read amendment holds the skill's reference folder as Prepare read it, even when empty. A direct local, managed or new skill edit keeps the draft's preview and uses its normal owner. Exact project, profile and executable changes use previews built from the proposed operations and the observed before-state.

Each eligible proposal has a reference `{ reviewToolCallId, candidateId, contentHash }`; the successful Prepare result on the session branch is its only record. Prepare returns minimized `judgeStates` and `needsRanking: true` only for the priority class crossing the five-question cutoff, and only with an explicitly assigned, available host `judge` model. A class is compared only when it has some slots available but more eligible candidates than slots. Fully selected and fully deferred classes need no ranking. Exact previews and full transcripts are not ranking inputs.

Prepare's text result holds each eligible reference, fingerprint, kind, target, gist and preview. A stale proposal has `previews` for its alternatives. An on-read append has `amendmentSections` with the current `## ` headings, which are outside the content hash. The result includes `needsRanking`, `judgeStates`, `rejected` and `failures`. Saved tool details hold the canonical changes and merged evidence for Select, approval and reconciliation.

Skill-text repairs still need a current `inspect` receipt with the relevant skill, amendments and reference files, plus a diagnosis, citations and intended behavior change. A new skill needs evidence of a search for existing guidance. Prepare and Select recheck freshness; one stale inspection does not invalidate unrelated drafts. Historical `catalog` lookup is separate. It describes what the extension could observe at a qualified session point, not what a provider received. Treat incomplete capture as unknown, and do not use an on-read amendment to repair pre-read discoverability.

Active tools belong to the running process. When a session starts, switches or branches onto a branch with a live observation pass, the extension restores `observer_review`, `observer_check`, and `observer_resolve`. Resolve still checks the current pass start and the approvals on the active branch.

Prepare drops a scoped decline once its identity is known, before validating or reading the proposal's target. A declined proposal whose skill was removed or whose target is no longer writable therefore does not fail the call. A stale amendment's Update and Delete drafts form one proposal holding both as `alternatives`, each with its own prepared change and preview. That Keep/Update/Delete question takes one of the five slots.

An on-read append whose section the amendment already holds verbatim is prepared with effect `record` and previewed as a ledger-only change. A compaction's `includes` resolve to fingerprints of on-read appends prepared in the same call. A re-offered Later fix with a reworded gist keeps its recorded identity. An inclusion that does not name exactly one eligible append makes the dependent compaction ineligible.

Select takes only those references. It resolves each through the branch's strict completed-call lookup to a successful `observer_review` Prepare and requires exactly one saved proposal with that candidate ID. It rejects a duplicated reference, a content hash that differs from the saved proposal, or a saved proposal that no longer matches its own hash. It accepts no candidate drafts, so a changed proposal must be prepared again. Neither action writes or authorizes a file. During a pass, both outputs carry their own `observerToolCallId`, which an approval cites.

Select's text result holds the references of its `selected` and `deferred` proposals, any `fallback`, `failures`, and `askHtml`, the whole Ask form rendered from its `selected` proposals in order; the proposals themselves stay in its saved details. The model writes no question text, option or default. Each proposal is one `<fieldset>`, laid out so the user can decide from its first lines:

1. a `<legend>` naming the action and target, such as `Add on-read fix · tdd (upstream)`, `Rewrite barrier rule` or `Stale amendment`;
2. the gist, bold;
3. the question as an `<h4>` heading (`Apply this change?`; for a stale amendment, `Keep, update or delete this stale amendment?`), directly above the radios, because the host takes the text block right before a radio group as its question;
4. one required radio group whose `name` is the proposal's `candidateId`;
5. where required, an italic line explaining when a note requires a fresh Ask;
6. the details as labelled paragraphs: `Problem` and `Effect` from the candidate diagnosis, `Remedy`, `Evidence` as a list (quote, bold count, source), and `Grounds`, the cited guidance grouped by source (its last two path segments, then each place as `L34`, `L34–44` and/or `§ Section`), or `Searched` for a new skill;
7. a `Change` heading, then the preview.

Each radio's label text is its label: `Apply`, `Later`, `Decline`; `Apply`, `Decline` for a withdrawal or a hook removal; `Keep`, then `Update` and/or `Delete` for a stale proposal's `alternatives`, each alternative's preview under its own bold heading. Its `value` is `<candidateId>=<Label>`: the host reports text typed into the group's Other row as an option's label when it equals that option's value, so a bare label as the value would let typed text approve. No option is `checked`: OMP's `ask` submits a form's current values on timeout, and a default is not Proposal approval.

The legend, gist, remedy, explanation and delta render inline markup: `` `code` ``, `**bold**`, and `*italic*` only where the stars hug a phrase at word boundaries, so a glob such as `personas/*.md` stays literal. Prepare refuses a candidate whose `remedy`, `diagnosis.explanation` or `diagnosis.delta` bolds more than two phrases. Evidence quotes and previews show their text verbatim.

The form shows a preview in a `<p>`, each line HTML-escaped and lines joined by `<br>`, because the host's form dialog cuts `<pre>` lines at the dialog width. Every word and line break shows as wrapped text. The form collapses whitespace, so indentation, tabs, repeated and trailing spaces are marked: `·` per space of a leading run, a trailing run or a run of two or more, and `→` per tab. Single spaces between words stay. A path the preview names under the home directory shows as `~/…`, and each `Matches:`/`Spares:` sample line of a rule is cut to 200 characters, since samples feed only the replay check. The bytes written are the prepared ones.

The gate reads the effective explicit assignment through `pi.pi.settings.getModelRole("judge")`. It then uses the host's exported `resolveScopedModels` helper against authenticated `ctx.modelRegistry.getAvailable("all")` models of kind chat, tiny or judge, with discovery disabled. The installed host's `judge_batch` uses the `judge` role, not `decision`. Generic role resolution can select built-in defaults without an explicit assignment, while `ctx.models.resolve` only sees chat models and misses native judges.

Missing configuration, unavailable models, unreadable settings or missing host APIs mean no ranking request and empty `judgeStates`. Select rechecks this gate. When unavailable, it ignores caller-supplied rankings and returns one truthful fallback explanation for compared classes.

With that gate open, the pass may use one installed host `judge_batch` with a shared ordinal evidence/impact/recurrence rubric and no retry. No provider client is added, no new settings are enabled, and no ranking/model call occurs inside the extension tool. A class outside that cutoff comparison, including a singleton, needs no judge or fallback disclosure. If judge support/model use is unavailable, a batch fails, answers are missing/invalid, confidence is below 0.7 or scores contradict their evidence, Select returns one fallback explanation and uses stable evidence/repeat ordering.

Selection always preserves stale Update/Delete, explicit User note, evidence-backed finding and compaction priority, with at most five questions in the main batch. An answer retracting an applied fix can require a separate prepared and selected withdrawal question in the same pass, as described in [Observation](observation.md#observe). Advisory scores reorder only within classes; they cannot resurrect declines, dismiss eligible findings, approve publication or bypass barrier replay. Overflow remains deferred: ordinary project/skill proposals are recorded as Later, while stale amendments and compactions retain existing re-offer behavior. Questions still show exact previews and combined supporting evidence, not merely a judge score.

## Proposal approval

`observer_resolve` writes an applied on-read fix, pattern amendment or barrier rule only when the saved session branch shows the user explicitly approved its prepared proposal in the current observation pass. The answer carries `approval`: the proposal's Prepare `reference`, the Select call ID and the `ask` call ID. The resolver uses them only to locate evidence. Through the strict completed-call lookup, it checks that Prepare succeeded and still holds the proposal under its content hash, and that a successful Select after it selected exactly that reference.

It also checks that a later successful `ask` the model made natively carries as `html` exactly the form rendered from that Select's saved `selected` proposals. The result's `details.timedOut` must be unset, and `details.answers` must hold exactly one entry whose `name` is the proposal's `candidateId`, with `answer` exactly `Apply`. The resolver writes the prepared section or rule: an on-read append's section, or a rule's name, body, pattern, scope and samples. It replays the rule before writing. The answer carries no `rule`. It may leave out skill, kind, gist and fingerprint, which the resolver takes from the proposal; any it supplies must match the proposal.

The resolver writes only while the target holds the bytes Prepare read, or, for an on-read amendment, already holds the section verbatim, so the write adds nothing.

Stale Update and Delete answers and every withdrawal are guarded the same way. A stale amendment's proposal holds its prepared Update and Delete as `alternatives`. Its fieldset offers `Update` and/or `Delete` beside `Keep`, and shows each alternative's preview. An answer of exactly `Update` or `Delete` approves that alternative only. A `stale` answer with `action: "update"` or `"delete"` carries that `approval`. The resolver writes the alternative's body and reference files, or deletes the rule and releases its reference files, exactly as prepared.

A `withdrawn` answer carries the `approval` of its prepared withdrawal, answered `Apply`, whatever the withdrawal does: only record it, delete the rule file, or rewrite the on-read amendment with the prepared body and reference files. Neither answer carries its own `body`, `references` or `rule`; one that does is refused. A withdrawal requested in prose is still prepared, shown and asked.

Stale Keep stays outside approval: it only re-pins. A `keep` answer carrying a `body`, `references` or `approval` is refused. The resolver writes only while the rule file and the skill's reference folder hold the bytes Prepare read. Re-pinning a stale Keep's `skillHash` line alone does not count as a change, since it adds no instruction content. Any other change, such as text added to a rule after its deletion was previewed, writes nothing until prepared and asked again. Stale answers and withdrawals take no reconciliation.

An applied compaction is guarded the same way. Its `compactions` entry carries the `approval` of its prepared compaction, answered `Apply`, and no `body`, `includes` or `references` of its own. An entry carrying any of them is refused. The resolver writes the prepared body and replaces the skill's reference folder with the prepared set, removing the files the preview lists as deleted. It checks coverage against the prepared `includes`: the fingerprints of the on-read appends of the same Prepare it covers.

It writes only while the amendment and reference folder hold the bytes Prepare read, a re-pin aside. A compaction takes no reconciliation either. It rewrites the whole body, so it cannot keep content added after Prepare; a changed amendment needs a new compaction and question.

A raw section or rule draft, a forged or mismatched reference, a result or text claiming consent, a hook-only or nested `ask`, a form that differs from the rendered one, a cancelled, failed, duplicated or misordered receipt, a timeout, nothing chosen (`""`), any other label, and custom input approve nothing. Each is refused with its own reason.

Custom input is the user's own text in the free-text row the host adds to every radio group: an answer of `Other: ...`. It never approves. The pass prepares a new proposal for what it asks, and asks again.

An **approval note** is the host's option note on the chosen `Apply`, which the user adds with `n` on the option row. The host saves option notes apart from the answers, in `details.notes`, one `{ name, question, option, value, text }` per noted chosen option, so custom-input detection is unaffected. The note whose `name` is the proposal's `candidateId` and whose `option` is the selected label belongs to that answer. It is trimmed; a blank note is no note. A host without option notes reports none, so every approval is then note-free.

An Apply note can guide a small revision to an on-read append, generated rule or direct local, managed or new skill edit. An applied append or generated rule with a note needs the prepared `approval.revision` below. Stale Update and Delete, withdrawal and compaction do not take reconciliation. For an exact project, profile or executable owner change, only a verify-only note keeps the exact approval. A note that changes the work needs fresh Prepare and Ask. Changed executable content needs a fresh scratch check first. A note cannot add a destination.

A note on `Later` or `Decline` approves nothing. Resolve can use the `Later` note as the re-offer condition. A note asking for a different change does not approve that change. For a supported skill-text reconciliation, a verification or acknowledgement note can leave the text unchanged. For exact owner changes, a verify-only note does not expand scope or waive the reviewed verification.

A failed approval writes and records nothing. Its reason appears under the call's not-recorded answers; it never becomes Later or Decline, even for a rule whose replay failed.

For an on-read append or generated rule, an Apply note or a target change can require reconciliation before Resolve writes. A **proposal reconciliation** is a revised append or rule prepared through `observer_review` in the same pass. In `reconciles`, cite the original approval as Resolve expects it. In the same object, state why the revision is needed and explain how it preserves the approved intent and unrelated content. Include `changedTarget` only if the target changed. Prepare reads the note from the saved Ask instead of taking the agent's copy.

Prepare checks that the cited approval still holds and that the revision rests on a note, a changed target or both. With no note, an unchanged target is refused. With a note, a revision equal to the approved change is accepted: a note that asks for a check or only acknowledges leaves the approved text standing, and the reconciliation's `reason` states what was checked. A note may change an on-read fix's section and a rule's body, pattern and samples, but not a rule's name, which fixes its target. The revision must make the same operation on the same target (the same amendment, or the same rule name) for the same skill under the same ledger identity. The resolver rechecks these conditions, that the revision was prepared after the user's answer and cites exactly that answer's approval, and that the target still holds the bytes the revision read. The answer then carries `approval.revision`, the revision's reference, and the resolver writes the revised content.

An append preserves the amendment's current content except for trailing whitespace, so newly added content survives. The writer trims trailing whitespace before adding the section separator. A rule write replaces the whole file, so a revised rule's body carries the new content. The resolver replays the revised pattern and samples before writing it; a revision that fails replay is recorded as `later` like any rule.

A revision that would delete a changed amendment or rule, or rewrite one as a stale update, withdrawal or compaction, needs a new proposal and question. Whether the revision follows the note and keeps the approved intent and new content is the agent's trusted judgment, not something the code proves. For each section, rule or compaction written, the result's `approvals` (and its text) lists the user's approval, its note, and any reconciliation with its reason, its `changedTarget` when the target changed, and its preview. The reconciliation is named as the agent's revision, not approved by the user. For a change written under a note, the text quotes the note, the reason and the full preview of what was written.

Authority comes from the branch alone; there is no approval journal or cache. The current pass starts at the latest `/observe` message and ends at a later prompt the user types, a `/skill:` start or a `/clear` reset. A new `/observe` starts another. An approval lasts while its whole chain stays on the branch inside the current pass and the user has sent no message (prompt or steering) since answering, which may retract it.

Compaction, a resumed session and non-user messages do not themselves revoke approval. A later Prepare or Ask of the same owner proposal, or a newer review of an overlapping owner destination, supersedes the earlier approval. Resolve rechecks receipts and target state. An already-present on-read section is not appended twice. Check saved receipts before resuming publication. Do not repeat a successful write.

These are trusted-host checks, not a filesystem permission grant. Resolve owns the observer's rule and reference changes, including the limited stale Keep re-pin. The main agent uses normal tools for local, managed and new skill, project, profile and checked executable changes. Resolve verifies their evidence and records their outcomes. It does not make those writes.


## Ledger

`observer_resolve` records accepted decisions in `<agent dir>/skill-observer/observer.sqlite`. The proposal ledger holds the latest answer per fingerprint in answer order. Each record includes its target and kind, gist, outcome, timestamp and session ID. It retains rule paths, publication receipts and evidence when supplied. The same database holds pending observations and short-lived recurrence markers, not catalog or session history.

Prepare and Select read by fingerprint. Resolve also reads decisions bound to an affected rule or hook and checks ledger dependencies again after replay, within the transaction that records the answers. `/observe-report` uses one read-only snapshot for the evidence and estimate, and releases it before waiting. Writes prune expired observations and markers. SQLite reclaims free pages at commit.

A skill answer may cite its prepared proposal of the current pass instead of carrying skill, kind, gist, fingerprint and evidence: an approved one through `approval`, any other answer to a prepared on-read fix, rule or direct edit (Later, Decline or deferred by Select) through `proposal`, the proposal's `reference`. The resolver fills the answer from that proposal before any other check, and records the proposal's evidence without its source label. Values the answer supplies must still match the proposal. An answer citing no prepared proposal carries its skill, kind and gist. An answer with no evidence of its own or from its proposal keeps the evidence last recorded under its fingerprint, so re-offering a proposal or settling its stale amendment preserves its evidence.

Before supplying new evidence to Prepare or Resolve, including when quoting an earlier decision again, the agent replaces private values and prefixes each altered `quote` with `[redacted excerpt] `. The evidence merge uses the full `source` and `quote` as its key, so unmarked and marked copies stay distinct. Resolve does not edit quote text when it records prepared or inherited evidence. Neither tool filters private values or rewrites old rows. The remedy outcome matcher ignores marked quotes only for exact tool exercise evidence. This does not alter delivery receipts, observation deduplication, or approval and publication inputs.

Prepare's optional `source` is a display citation for Ask, not a verified historical locator. In the recorded same-project session, historical lookup checks occurrence IDs when present. Without IDs it can search for unmarked quote text. For a marked quote with no IDs it reports a primary-evidence gap, since an exact text match might only find a later copy.

The main agent makes an applied direct edit of a local, managed or new skill itself, so the resolver records it `applied` only with evidence the edit was made. The answer carries the `approval` of its prepared direct edit and `publication: { writeToolCallId }`. `approvedDirectEdit` in [`src/proposal-approval.ts`](../src/proposal-approval.ts) checks the approval like any other, once when the answer is validated and again right before recording, and refuses an Apply superseded by a later Prepare or Ask of the same proposal; a note on Apply revises the edit the agent makes and approves it. `checkSkillEditPublication` in [`src/project-publication.ts`](../src/project-publication.ts) requires a successful call after that Apply: `edit` or `write` of the local skill's `SKILL.md` as installed now (a leading `~/` expanded as the native tools do), or `manage_skill` `update` of the managed skill or `create` of the new one, named in the result details. It does not compare the written bytes with the preview. An applied direct edit citing only `proposal`, or nothing, is refused.

A `later` answer, skill or project, may carry `reoffer`: which observation would change the decision, when it could arrive, and whether the deferred action is still possible. The pass writes one on each `later` it records itself (past the cap, or a barrier set aside because the check can't run). On a user's Later it writes one only from the user's own custom input; the resolver takes a note on `Later` as the `reoffer` itself. It keeps `reoffer` on `later` answers only, drops it from any other, and refuses a blank one.

A Decline of a withdrawal keeps the fix: a `declined` answer whose fingerprint's latest record is a fix in force (`applied`, `kept` or `updated`) records nothing, and the result says the fix stays in force. An answer citing `proposal` uses the reference from the pass's latest successful Prepare that holds that `candidateId`; an older one is refused with the latest named.

Proposal outcomes are `applied`, `later` or `declined`; `withdrawn` takes back an earlier applied fix (see [Withdrawals](#withdrawals)). Stale-amendment answers are `kept`, `updated` or `deleted`, recorded under the fingerprint the rule carries. For a skill's on-read amendment, this is its own fingerprint (see [The skill's on-read amendment](amendments.md#the-skills-on-read-amendment)). A stale delete of a skill's on-read amendment also records each fix in force in it as `deleted`. A compaction's record carries `compaction: true` (see [Compaction and reference files](amendments.md#compaction-and-reference-files)).

Older ledgers also hold `merged` records, which passes before ADR 0003 wrote for an on-read amendment they folded into another; a `merged` record is no fix in force. Ordinary project and skill proposals past the cap of 5 are recorded as `later` without being asked. Stale amendments and compactions keep their existing re-offer behavior. The fingerprint hashes the target skill and gist with case, punctuation and spacing removed. A re-offered proposal is recorded under its earlier fingerprint, so rewording keeps its identity. The latest record per fingerprint wins.

Prepare refuses a rule, section or compaction that can't be written: a rule name in use, except by a pattern amendment or barrier rule of the same skill, which the new rule replaces (see [Rules](amendments.md#rules)); a skill missing from the lock or of another provenance than the candidate names; an invalid pattern, scope or sample set; a barrier rule without a pattern; an on-read fix whose body doesn't open with a `## ` heading; a rule for a new skill; a reference file name that isn't a plain file name; or a body with reference files that doesn't name each by its absolute path. Nothing can approve it.

An answer the tool can't carry out is reported and not recorded. This includes those conditions, checked again at write time; an applied or withdrawn answer carrying a `rule` instead of `approval`; a stale answer carrying a `body` or `references`; a compaction carrying a `body`, `includes` or `references`; an approval that doesn't hold, or whose note the answer leaves without a revision; an answer citing its proposal through both `approval` and `proposal`, or through `proposal` for a proposal of an earlier pass, a stale amendment, a compaction, a withdrawal or a project, or with values that differ from the proposal's; an answer citing no proposal without its skill, kind and gist; an on-read fix for a skill with two or more on-read amendments; or a withdrawal that fails its checks.

### Withdrawals

A `withdrawn` answer carries the `approval` of its prepared withdrawal (see **Proposal approval**), which supplies the fingerprint of a fix whose latest outcome is `applied`, `kept` or `updated` and that fix's skill. The withdrawal candidate names the fix by `fingerprint`. When the fix's rule still exists and is the skill's on-read amendment, the candidate carries as `body` the amendment's new body without the fix's text. The tool rewrites the body and leaves the frontmatter unchanged; an empty body deletes the amendment and its reference files.

When the fix's text sat in a reference file, the candidate also carries `references`, the complete new set. This replaces the folder's contents before the body is rewritten; without it the reference files stay. Several withdrawals from one amendment in one call carry the same body. Withdrawals run before the call's additions, so a new body drafted from the file on disk keeps the sections the call adds. The tool deletes any other rule file, but only if it carries the marker and that fingerprint.

Prepare refuses a withdrawal of a hand-written rule, a rule holding another fix, an amendment holding other fixes with no new body, a fingerprint with no applied fix, a compaction's fingerprint, or another skill's fix. The resolver reports as not recorded, changing nothing, a withdrawal that would delete a rule file while other fixes in force, not withdrawn in the same call, still point at it. The result names those fixes. It also refuses a withdrawal carrying a body for an amendment that a stale update or delete changed in the same call, since that body was drafted from the file before the stale answer.

A fix whose rule is already gone, or that wrote none (an edit to a local or managed skill, which the pass reverts itself), is only recorded. The `withdrawn` record keeps the skill, kind, gist and `rule` of the fix it takes back. Moving a fix to another skill is one call with a `withdrawn` answer for the old skill and an `applied` answer for the new one. The pass asks about a fix you retract or redirect this way, whether in an answer's text or a later message, and records it once you approve the withdrawal.

A record's `rule` is the path the file had when the answer was recorded. Moving the file does not update that path. A fix's rule is the one named by the path's file name, looked up in the amendments directory, then the rules directory. Fixes stay attached to an on-read amendment that moved out of the rules directory.

### Publication phases and recording failures

One call's changes run in fixed phases across every skill it names: stale answers, then withdrawals, then the other answers in the order sent (on-read additions with pattern amendments and barrier rules where they fall among them), then compactions. Every pattern is replayed before the first change. A change that fails, or whose approval no longer holds, is reported and writes and records nothing. The others in the call still apply. A later phase acts only on what earlier changes actually did, so a failed addition counts toward no compaction.

The exception is a deletion that removed its rule file and then failed to delete the skill's reference folder. The deletion is listed as made, with its records, tombstones included. The result's `cleanup` names what remains, for the pass to inspect and report without calling again.

The result's `publications` lists each rule or reference change the call carried out, in order: its `operation` (`stale-keep`, `stale-update`, `stale-delete`, `withdrawal`, `on-read-append`, `rule` or `compaction`), skill, rule file and the fingerprint its record carries. An on-read addition whose section the amendment already held verbatim changed no file and is not listed. Neither is a deferred, refused or record-only answer. [`src/on-read-amendment-transitions.ts`](../src/on-read-amendment-transitions.ts) owns these phases.

The transaction commits all accepted records from one Resolve call together, including generated withdrawal and deletion records. Replay finishes before the transaction starts. SQLite rollback cannot undo rule, amendment, reference or other file changes. For each record in order, `recording` reports `recorded`, `unrecorded` or `unknown`, with the error if recording failed.

A known rollback leaves every record in the batch unrecorded. If the extension cannot determine whether the commit succeeded, it reports the batch as unknown.

A verified file change whose record did not reach the ledger is an Unrecorded publication. Distinguish it from a write whose verification failed and from a target the pass did not write. Preserve the changes and report the error. Do not retry Resolve or redo the publication.

The result text ends with `## What to do now` holding the `tool-result` paragraph of `observer.md` for each of three reported conditions: a ledger recording failure, a failed cleanup, and an answer refused because its target changed since Prepare or reconciliation. The last is decided by type. `checkTarget` in [`src/proposal-approval.ts`](../src/proposal-approval.ts) throws `TargetChangedError`, and the resolution's `targetChanged` flag records that one reached the failures. The failure text is never matched.

During a pass, the `ask` result hook in [`src/skill-observer.ts`](../src/skill-observer.ts) adds the `custom-input` paragraph under the same heading when an answer starts with `Other: `, and the `approval-note` paragraph when `details.notes` holds a note that is not blank. `toolResultGuidance` reads the paragraphs from `observer.md` on each call, keeping a single source. `whatToDoNow` never throws: these results may report changes already made, so a paragraph it cannot load becomes a logged error and a one-line note.

`/observe` adds the ledger to its message: deferred proposals, which the pass offers again, each with its fingerprint and, when its record has one, its `reoffer` as `Re-offer when: …`. Declined proposals are left out because Prepare already drops a scoped decline. A withdrawn fix is not listed, and neither is a compaction.

### Exact project and profile changes

`project-edit` carries complete resulting `text` (omit it for removal) and one meaningful foreground Bash `check`. Use a single command of fixed words, not a shell sequence, informational command or option that skips the check. Prepare pins the canonical root, file identity, original bytes and approved postimage. The current OMP directory is the default root, not a discovered Git root. An explicit current User note or instruction can bring another checkout into scope. Old notes, archive excerpts, assistant echoes and tool output do not. Targets are canonical root-relative file paths. Traversal and symlink escapes do not qualify.

Use `project-edits` for one mechanism affecting multiple files in one or more scoped checkouts. It uses the same `kind: "project"` outcome and one Apply. Before each write, check the remaining destinations against their reviewed before-states. Changed scope requires new review. Resolve checks every destination, records verified targets under their per-root, per-file mechanism identities and reports failures separately. It does not roll back successful writes.

Use ordinary `write` with the exact canonical path and approved bytes for a create or replacement. For removal, use the exact single-file hashline `REM`. A project receipt binds the owner call after Apply, exact completed foreground Bash check after the write in the reviewed root, and verified resulting bytes or absence. A single-file answer supplies `publication: { writeToolCallId, checkToolCallIds, afterHash }`. `afterHash` is the reviewed SHA-256 or `null` for removal. For multiple files, Resolve derives each receipt from observed calls. A shared check can verify multiple approved writes if each completed before it ran.

An ordinary `profile-edit` has `kind: "profile"` and a destination under the active agent directory. Verification checks reviewed content, host skill control, or pattern replay. A hand-written rule keeps its ownership, and a pattern edit needs a replay against the mistake and a legitimate counterpart. The user's `/observe allow-installed-copy <skill>` opt-in permits a last-resort edit to the exact inspected installed file. Keep the active agent directory as the target root and use the absolute inspected skill path. Explain why durable options do not fit and show the overwrite risk. Resolve checks the owner call and verified resulting bytes.

### Tool receipts

During an active pass, successful `ask`, `edit`, `write`, `manage_skill`, `bash` and observer review or check outputs can expose `observerToolCallId`. Use that opaque ID, not a command string, file snapshot tag or text a tool printed. For exact owner changes, the call hook records the authorized proposal hash. The result hook records the executed input and outcome. A path, hash or successful-looking result alone is not a receipt.

The extension saves hook copies even for native calls because `tool_call` fires before the assistant message lands on the branch. Receipt lookup rejects duplicate IDs in either source and conflicts between sources. A native Ask must match Select's exact HTML. Calls inside `eval` can leave hook evidence of an actual owner write or check. IDs printed by `eval` do not prove one. Missing or changed execution input, a different check or root, a failed check, and an unfinished, timed-out or background job cannot verify publication. Executable scratch proof specifically requires a native Bash call and corroborating hook evidence.

### Checked hooks and extensions

`kind: "harness"` targets `project-hooks`, `global-hooks`, the dedicated `companion`, or an owned `extension` source directory in the active profile or scoped checkout. An extension must declare owned OMP entries or be a native extension directory with an index. An ordinary project proposal cannot bypass checked review of an executable target.

Draft and check the exact postimage in a private `omp-observe-check.*` directory under the system temporary directory. Prepare takes `change: { operation: "harness", stage: "checked", files, checkToolCallId, lowerRungs }`. List every changed file with its exact text, or omit its text for removal. Use `lowerRungs` to explain why a simpler remedy does not fit. Prepare checks the current-pass Bash receipt and captured inputs against the reviewed files. Choose a command from [the supported checks](observation.md#checked-omp-hooks-and-extension-source). If a necessary check cannot run, give a report item and next action instead of Apply.

There is no intent Ask. One native Apply in the main form can approve the checked exact change. The preview shows the files before and after, the scratch check and observed result, how to verify the change at the destination, what the change affects, and when OMP will load it. Publish with normal tools, then run the exact approved foreground check in the target root. Resolve expects `publication: { writeToolCallIds, checkToolCallIds, files: [{ path, afterHash }] }`, with one exact owner call and result per file and a check after all writes. A verified hook removal withdraws the in-force records for that hook. The pass grants no permissions and does not activate or restart OMP, commit or deploy.

An incomplete executable change gets no applied record. Resolve distinguishes a written but unverified file, a file untouched by the pass and a file whose write was not confirmed. It reports that changed code may take effect on the next OMP load even when verification did not finish. Preserve the actual files and report the partial result. Do not repeat successful writes to obtain a receipt.

[`scripts/check-hook.ts`](../scripts/check-hook.ts) is the hook check. It loads a hook's default-exported factory against a stand-in host with no UI, with `ctx.cwd` set to the working directory, and feeds a samples file's events to the handlers it registered. See [The check](observation.md#the-check) for usage. [`test/hook-check.test.ts`](../test/hook-check.test.ts) covers it.

## Remedy ladder, supplier label and report items

The remedy ladder and dispositions are instructions in [`observer.md`](../observer.md). Prepare and Resolve enforce the relevant target and receipt contracts. The supplier label is recorded data, not a diagnosis.

**Remedy ladder.** Check existing configuration, wiring and checks first. Compare direct project repairs, skill and text edits, amendments and rules as the evidence warrants. Use a checked hook or owned extension change when a cheaper remedy does not fix the mechanism. A tool that rightly rejected a misuse stays unchanged. See [Remedy ladder](observation.md#remedy-ladder).

**Supplier label.** `recordHookResult` in [`src/session-tool-evidence.ts`](../src/session-tool-evidence.ts) looks the tool up by name in the host's tool list when it copies a result and stores its `ToolSupplier` (`source`, `path`, `mcpServerName`) on the copy. A lookup that throws or finds nothing stores none. `supplierLabel` in [`src/digest.ts`](../src/digest.ts) prints the extension or SDK path, the MCP server, nothing for a built-in tool, or `Supplier not recorded.` when the copy has no supplier. A device dispatch gets the inner tool's label. The label names the supplier, never the cause. See [Supplier label](observation.md#supplier-label).

**Report items.** Report a grounded problem with no eligible proposal, for example a denied destination or unavailable necessary check. Name the owner, observed behavior, expected behavior and its source, the known cause or evidence gap, and the next action. A report item gets no Ask or ledger decision. See [Report items](observation.md#report-items).

## Extension entry

OMP loads [`src/skill-observer.ts`](../src/skill-observer.ts) through the `omp.extensions` entry in [`package.json`](../package.json). The extension has no runtime dependencies. OMP names an extension after its entry file, or after the entry's folder when the file is `index.ts`. The `skill-observer.ts` entry gives this module the name `skill-observer` and the settings ID `extension-module:skill-observer`; an entry at `src/index.ts` would instead be named `src`. Configured module paths are deduplicated by real file path, so a symlink and its target load once.

## Develop

Run these commands from a source checkout's extension root, the directory containing `package.json`. Package tarballs omit tests and development configuration.

```sh
bun install
bun run test
bun run typecheck
```

This runs ordinary tests without launching the native OMP checks. See [Testing](#testing) for explicit native checks.

To print the report for a saved session without starting OMP, run `bun --no-env-file scripts/observe-report.ts <session.jsonl>`. It takes a read-locked snapshot of the database in a temp directory. It reports a locked or unreadable store without changing the original.

### Instruction fragments

[`observer.md`](../observer.md) is the maintained, attributed source. Stages locate the relevant procedure, and evidence gates control fragments inside the stages. See [Observation payload](observation.md#observation-payload).

```md
<!-- when: stale -->
- **Stale amendment**: pick your verdict. …
<!-- end -->
```

A marker sits alone on its line and wraps whole paragraphs or list items. Gates are `stale`, `compaction`, `project`, `withdrawal`, `ranking`, `note`, `observations`, `catalog` and `tool-result`. Blocks do not nest. `parseFragments` in [`src/payload.ts`](../src/payload.ts) splits at headings and markers and rejects unknown, unbalanced, nested or partial-item blocks. A malformed or missing required section stops the affected stage.

After editing `observer.md`, regenerate the committed fragment files:

```sh
bun run generate
```

It writes `observer/<section>-<gate|core>-<n>.md`, one file per fragment, where `n` is the fragment's position in its section. Readers can browse the gated parts. `/observe` assembles from `observer.md` itself, not these files, so an approved edit to `observer.md` applies to the next pass without regenerating. A test in `test/payload.test.ts` regenerates the files in memory and fails when `observer/` differs.

### Package a local tarball

```sh
bun pm pack
```

Run this from the source checkout's extension root. It creates `skill-observer-0.3.0.tgz` using the `files` allowlist in `package.json`: runtime source, the hook check script, `observer.md` and its generated `observer/` fragments, reader documentation, the licence and third-party notices, the README, and changelog. It excludes tests, development configuration, and installed dependencies. Packing creates a local archive for distribution checks; it does not publish the package. Normal setup uses `omp install` with the repository URL.

### Modules

| File | Owns |
| --- | --- |
| [`src/skill-observer.ts`](../src/skill-observer.ts) | Entry: wires hooks, the status hint, `/observe` with its observation payload assembly, `/observe-report` and the startup migration |
| [`src/payload.ts`](../src/payload.ts) | Initial evidence assembly and estimate, fragment parsing, evidence gates and staged guidance |
| [`scripts/generate-fragments.ts`](../scripts/generate-fragments.ts) | `bun run generate`: writes `observer/` from `observer.md` |
| [`scripts/check-hook.ts`](../scripts/check-hook.ts) | The hook check: runs an observer hook against sample events on a stand-in host |
| [`scripts/migrate-observer-store.ts`](../scripts/migrate-observer-store.ts) | Standalone preview and one-time import of legacy JSONL files |
| [`src/observer-store.ts`](../src/observer-store.ts) | Profile database initialization, read snapshots, and write transactions with observation pruning |
| [`src/delivery.ts`](../src/delivery.ts) | On-read amendment delivery on both routes (`/skill:` reminder, `read` of the entry file) and the once-per-context-window rule |
| [`src/reminder.ts`](../src/reminder.ts) | Delivery records: reminder markup, reminder message type, delivery entry type and their parsers |
| [`src/amendments.ts`](../src/amendments.ts) | Observer rule files in both directories: reading, writing, pins, staleness and the load-time migration |
| [`src/provenance.ts`](../src/provenance.ts) | Where a skill comes from (local, upstream, managed, plugin, or a byte-identical copy of one) and the skill-folder `skillHash` |
| [`src/digest.ts`](../src/digest.ts) | Session digest: skill signals, loaded skills and deliveries rebuilt from the branch |
| [`src/ledger.ts`](../src/ledger.ts) | Current decisions and canonical project, profile, hook and extension identities |
| [`src/observations.ts`](../src/observations.ts) | Pending observations and recurrence markers; repository identity and payload rendering |
| [`src/resolve.ts`](../src/resolve.ts) | `observer_resolve`: validates and records answers, and replays pattern rules before the call's changes |
| [`src/on-read-amendment-transitions.ts`](../src/on-read-amendment-transitions.ts) | On-read amendment transitions: one call's stale settlements, withdrawals, additions and rules, and compactions in their phases, with withdrawal checks, compaction coverage and reference release |
| [`src/publication.ts`](../src/publication.ts) | Builds and validates the rule of an applied fix from its approved section or rule |
| [`src/project-publication.ts`](../src/project-publication.ts) | Owner-tool authorization and exact publication receipts checked against the branch and disk |
| [`src/profile-publication.ts`](../src/profile-publication.ts) | Exact profile edits, content and skill-control checks, and hand-written rule replay evidence |
| [`src/executable-check.ts`](../src/executable-check.ts) | Scratch input proof, supported checks and executable postimages |
| [`src/executable-publication.ts`](../src/executable-publication.ts) | Canonical executable target snapshots and checked previews |
| [`src/session-tool-evidence.ts`](../src/session-tool-evidence.ts) | Session tool evidence: writes the hook records and indexes them with native tool records by call ID for the lossy digest view, the strict completed-call pairing receipts use and native placement for delivery |
| [`src/review.ts`](../src/review.ts) | `observer_review`: current-guidance inspection and new-skill search receipts, catalog lookup, canonical prepared proposals with previews, target snapshots and the diagnosis gate, reference-verified selection with the rendered Ask form, and advisory judge ranking |
| [`src/catalog.ts`](../src/catalog.ts) | Skill catalog observations: capture at `before_agent_start`, recording at `message_end`, session-local definitions and branch bindings, capture gaps, and lookup with skill notices, compactions and resets applied |
| [`src/proposal-approval.ts`](../src/proposal-approval.ts) | Current pass, exact Prepare/Select/native Ask correspondence, supersession and limited skill-text reconciliation |
| [`src/replay.ts`](../src/replay.ts) | `observer_check`: replays barrier-rule samples through `omp ttsr test` |
| [`src/rules-in-force.ts`](../src/rules-in-force.ts) | The Rules in force section of the `/observe` message |
| [`src/references.ts`](../src/references.ts) | Reference files of an on-read amendment and their atomic replacement |
| [`src/outcomes.ts`](../src/outcomes.ts) | Remedy outcomes of applied skill and project-environment fixes, and their payload rendering, which lists only project fixes and fixes for loaded skills |
| [`src/report.ts`](../src/report.ts) | The `/observe-report` evidence report and its rendering |
| [`src/omp.ts`](../src/omp.ts) | The structural slice of OMP's extension API and session shapes |

### Testing

`test/setup.ts` points `PI_CODING_AGENT_DIR` at a temp dir for the whole suite, so no test or spawned `omp` reaches the live agent dir.

When the installed Bun provides the native checker, `bun check` uses the same project configuration without emitting files. The `typecheck` script remains `tsc --noEmit` for compatibility; see [Bun's checker documentation](https://bun.com/docs/runtime/check).

Tests cover digest/provenance, observer selection and publication, and amendment delivery through the extension's hooks. Prompt assertions check identities, evidence, counts and required markers rather than explanatory sentences.

Unit tests create their own temporary skills, lockfile, managed directory and plugin registry. Historical names such as `ce-commit-jj` identify fixture files, not dependencies on your installed local skills. Filesystem and subprocess fixtures do not establish model gain or effective instruction-loading parity.

### Explicit native checks

Native checks require Bun and an installed `omp` that responds successfully to `omp --version`. The suite enables its OMP-backed tests only when `SKILL_OBSERVER_NATIVE_TESTS=1` and that binary is available. Run this from the extension root:

```sh
SKILL_OBSERVER_NATIVE_TESTS=1 bun run test
```

The installed OMP host loads `test/native-schema.ts` without a model prompt to verify actual tool-schema registration. It uses a temp agent dir so the extension's startup migration never touches your rules. The amendment/replay suites use `omp ttsr test` for native trigger checks. These OMP-backed checks are skipped when OMP is unavailable or `SKILL_OBSERVER_NATIVE_TESTS` is not `1`; requesting them with `1` does not turn a missing prerequisite into a passing check.

The `/skill:` reminder finds the skill by the first line of OMP's user-invocation template. One test renders `src/prompts/skills/user-invocation.md` from the package of the first `omp` on `PATH` (an npm or Bun global install), so a reworded template in the installed OMP fails the suite. It is skipped, independently of the native-test flag, when `omp` is missing or is a compiled binary that ships no template. Native checks still require their OMP or Bun prerequisites.

One check stays manual and outside the suite: that OMP loads a hook file from the global hooks directory and the hook acts. To run it:

1. Copy your agent dir's auth and config to a temp dir.
2. Write a hook into its `hooks/pre/` that blocks one `bash` command, and confirm it with `scripts/check-hook.ts` and a samples file.
3. Start a new `omp` with `PI_CODING_AGENT_DIR` set to the temp dir, and ask it to run the blocked command and a legitimate one.

Do not pass `--no-extensions`: it also turns off hook discovery. The check shows that OMP loads hooks; it is run once, not for each hook a pass writes.

### Git hooks

Enable the bundled hooks in each clone with `git config core.hooksPath hooks`. `pre-commit` exports the staged files to a temp folder, links the clone's `node_modules` there, and runs `bun run check` (typecheck, then tests) on that export, so unstaged edits and untracked files neither block the commit nor reach the check. It sets `SKILL_OBSERVER_NATIVE_TESTS=0` so a `1` inherited from the shell cannot enable native OMP checks. Missing Bun/dependencies or a failing check blocks the commit. `commit-msg` refuses a subject without a conventional type, as in `fix: …` or `feat(scope): …`.

For a handoff after staging your changes, run `hooks/pre-commit --typecheck` from the extension root. It typechecks the same staged export without running tests.
