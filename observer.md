# Observation pass

The user ran `/observe`. Turn this session's evidence into concrete skill improvements and project-environment fixes the user reviews before publication. Work from the current session branch, the digest below (including compacted history), the conversation still available and the User note. This is one observation pass: consult the retrospective reference inlined under **Retrospective reference**, when present, as guidance, then use the review and recording steps here.

## 1. Find candidates

Read every signal and correction, including when a skill was loaded. Keep each finding tied to its source entry/signal or User note, decisive quote and count. If compacted evidence is insufficient to identify the failure, retrieve the relevant primary session evidence through normal tools; when it is unavailable, disclose the gap and set the unsupported finding aside. A broad note requests inspection, not proof that an error happened. Skill findings include:

- **Improve**: the agent broke a rule a loaded skill documents; a user correction exposes a missing rule or edge case; a tool error in a turn with a skill loaded traces back to that skill's method; a better workflow emerged than the skill recommends; a skill's assumption proved wrong; new tooling made a step obsolete.
- **Simplify**: two rules contradict each other; the agent keeps failing a rule, which then becomes a barrier or goes.
- **New skill**: a multi-step workflow done by hand that no skill covers, visible as similar tool outlines across turns; a method the user explained ("I always do it this way").

**Choose the remedy before its scope.** Inspect only session-relevant project context and checks through normal discovery. First read the existing check command, script and its hook/CI wiring: a missing wire or broken existing check gets a repair proposal, not a replacement check plus a skill reminder. A mechanical mistake gets the cheapest fitting deterministic check; missing information gets a navigation/reference fix; a judgment problem gets review guidance. Review oversized or ineffective steering and tool economy only where this session supplies evidence. An information-access remedy is an explicit permission request, not an automatic service/credential read.

<!-- when: project -->
For the retrospective branch, use the reference inlined under **Retrospective reference** when available.
<!-- end -->

**Choose scope.** A project remedy names the exact root-relative target under **Project scope** and may solve a one-project problem. A skill remedy must generalise: would it hold in another project and another task using the skill, and does it name a missing rule, step or principle? Mostly no means it is not global guidance; keep an evidence-backed project repair instead. Write reusable skill guidance in its general form.

**Merge evidence before review.** One proposal fixes one mechanism at one scoped target. Combine observer signals, retrospective findings and User note evidence for that mechanism into one proposal, preserving each distinct quote/count/source without counting the same occurrence twice. Prefer its direct project repair to a duplicate global reminder about the same failure. Independent mechanisms remain separate, so declining one leaves the other standing. Dismiss preferences already covered by effective guidance and findings unrelated to session evidence.
Carry the digest's `occurrenceIds` into proposal evidence and resolver outcomes. Recurrence counts distinct occurrence IDs for the same mechanism, not descriptions, quotes or dispatch layers of one event. An ID of the form `<workflow ID>/<event ID>` happened inside that workflow's turn: a workflow cited with events from its turn adds no occurrence beyond those events. Preserve older evidence without IDs as uncertain historical support rather than inventing IDs.

**Second skill failure means barrier.** When a skill rule or instruction fails a second time (the same rule firing twice, a correction of something a loaded skill already says, or a signal repeating a fix under **Rules in force**), consider a barrier rule for that skill of any provenance; for upstream/plugin it is a pattern amendment. First distinguish a project-environment failure that an existing project check can catch: repair that check rather than adding a competing skill barrier for the same mechanism.

The **Proposal ledger** holds earlier answers, already filtered to global decisions and this project only. Re-offer Later entries using their recorded identity and fingerprint.

**Rules in force**, after the ledger, lists each loaded skill's rules with the fixes recorded into them: its on-read amendment with the amendment's section headings, size and reference files, a pattern amendment or barrier rule with its scope and its firings this session, then the hand-written rules in the user rules directory by name and description. Dismiss a candidate that a listed rule already covers.
**Remedy outcomes** distinguish instruction delivery from exercised behavior. Cite the supplied receipt IDs: `exercised-clean` means the relevant tool behavior was actually exercised successfully after delivery; `recurrence` means the same evidenced failure happened after delivery. `delivered` alone and `inconclusive` are not success. Keep missing exercise evidence visible when considering another remedy.

<!-- when: compaction -->
**Compaction.** An on-read amendment whose line says `over the compaction limit` is a compaction candidate. So is one whose body will be over 4,000 characters once this pass's on-read fixes for its skill are appended.
<!-- end -->

<!-- when: note -->
A **User note** ahead of the digest, when present, is text the user typed after `/observe`: feedback on a skill, a correction the digest missed, or a steer for this pass. Each point in it that names a change is a candidate, weighed like a correction-class signal; a steer, such as a skill to focus on, applies to the whole pass.
<!-- end -->

<!-- when: stale -->
Each entry under **Stale amendments** is a candidate too: an amendment rule whose upstream or plugin skill's files changed since it was pinned, or whose skill is no longer an upstream or plugin skill. Read its rule file, and the skill file when the entry names one.
<!-- end -->

Done when every signal and relevant note point is either an evidence-backed candidate with one mechanism, exact target, scope, remedy and verification method, or dismissed with its reason; cross-source duplicates are merged, gaps are disclosed, and every Later entry, stale amendment and marked compaction is accounted for.

## 2. Draft

Skill, rule and agent-guidance drafts follow `skill://writing-for-agents`: read it before drafting those texts, then apply its no-op and negation tests. If unavailable, say so and delete instructions the agent would obey untold; state the positive behavior, keeping prohibitions only as hard guardrails. Project code/configuration repairs follow the target's existing conventions.

<!-- when: project -->
- **Project remedy**: read the exact target and relevant existing checks/wiring. Draft the smallest exact diff and target-specific verification: for a deterministic check, both the session's known mistake and its nearest legitimate counterpart, using temporary inputs so verification preserves user data. For a navigation/review-guidance repair, verify the actual pointer resolves or the reviewed guidance is present. Keep every target under **Project scope**; an outside path in a note is context, not authority to change scope. Information-access requests stay permission proposals until explicitly granted.
<!-- end -->
- **Local or managed skill**: draft the exact lines to change.
- **Upstream or plugin skill**: its files are overwritten on every skills or plugin update, so every fix to it is a rule. A barrier is drafted as the next item says. Any other fix is an on-read fix: draft it as one section, a `## ` heading naming what the section adds and the text under it. `observer_resolve` appends the section to the skill's on-read amendment, in the on-read amendments directory, which the extension adds to the context whenever the skill is loaded, so write the section as an addition to the skill.
- **Barrier rule**: first decide where the mistake shows, in your text or in one tool's call. That picks the scope: `text`, or `tool:<name>` with the tool's lowercase name, as in `tool:bash`; `tool:read` is reserved and refused, so a fix for how a skill is read is an on-read fix. Then draft the rule's name, its body, its samples and the pattern. Each sample takes the form the scope sees, as `observer_check` describes under `matches`. `matches` holds the mistake as it happened, taken from the conversation; when compaction dropped it, write a faithful reconstruction from the digest's evidence and mark it as one. `spares` holds the legitimate counterpart: the nearest correct output or call. The pattern is a regex matching the mistake as TTSR sees it, which for a tool other than `edit` and `write` is the arguments as JSON, where a quote reads `\"`.
- **Replay**: pass every drafted pattern with its scope and samples to `observer_check` in one call. A draft is done once it passes; for each one reported misfiring, fix the pattern or a sample and check again. When the check can't run, the pass has no barrier rules: each barrier candidate goes to the ledger as `later` in step 5, unasked.
- **New skill**: search the skills listed in your system prompt, the skills and managed-skills directories, and the digest's **Managed skills created this session**. A fitting skill turns the candidate into an edit of it. Otherwise draft the name, description and body.
<!-- when: stale -->
- **Stale amendment**: pick your verdict. Keep, when the rule still adds what the updated skill lacks; update, with the rewritten body, when the rule still helps but no longer fits the skill; delete, when the updated skill covers or contradicts it, or the skill is no longer installed as an upstream or plugin skill.
<!-- end -->
<!-- when: compaction -->
- **Compaction**: read the amendment file, `<on-read amendments directory>/<name>.md`, and its reference files. Draft the new body from the amendment's body with this pass's on-read fixes for the skill appended; the draft includes every one of them. Keep every instruction, state each once, and group them under short `## ` headings. While the body is still over 4,000 characters, move a topical section into a reference file, `<reference files directory>/<skill>/<name>.md`, and replace the section, heading included, with the one pointer line `When <condition>, read <the file's absolute path>.` The draft's reference files are the amendment's complete set, the existing ones included, each named by its absolute path in a pointer line of the body.
<!-- end -->
- **Unknown target**: draft the fix for the summary, outside the `ask` batch.

Done when every proposal has an exact preview, supporting evidence and target-specific verification, skill/guidance drafts pass the writing tests, every barrier has passed replay (or is set aside as Later), every stale amendment has a verdict, and every compaction holds all prior instructions within its existing size/reference contract.

## 3. Ask

First call `observer_review` with `action: "prepare"` and the exact eligible candidates: `priority` is `stale` for stale Update/Delete questions, `note` for explicit User note proposals and withdrawals the user asked for, `evidence` for other evidence-backed findings, or `compaction`. Keep stale Keep verdicts and unknown-target summaries outside review. Each candidate includes its global skill/kind/gist or project kind/target/gist, `remedy`, cited `evidence` (`quote`, `count`, and optional source locator) and its exact `change`:

- `direct-edit` with the exact `preview` for a local or managed skill edit, a new skill or a project repair;
- `on-read-append` with the `section` of an upstream or plugin on-read fix;
- `rule` with the `name`, `body`, `pattern`, `scope`, `matches` and `spares` of a pattern amendment or barrier rule, as `observer_check` passed it;
<!-- when: stale -->
- `stale-update` with the `rule` name, new `body` and, when they change, the complete `references`; `stale-delete` with the `rule` name. For a stale amendment you ask about, send both: Prepare joins them into one stale proposal;
<!-- end -->
<!-- when: withdrawal -->
- `withdrawal` of the applied fix named by the candidate's `fingerprint`, with the fix's skill, kind and recorded gist, and for a fix inside the on-read amendment the whole new `body` without it, empty when nothing else is left (and the complete `references`, when the fix's text sits in a reference file);
<!-- end -->
<!-- when: compaction -->
- `compaction` with its `includes` (the on-read appends of this Prepare it covers, each by gist or fingerprint), compacted `body` and complete `references`.
<!-- end -->

Write every section, body and reference file with `\n` line ends: Prepare refuses a change holding a carriage return, which the Ask preview would show changed.

Prepare reads each target rule and reference file itself and returns every eligible proposal with its canonical `change` (the exact bodies, sections, samples and reference files written, the files deleted, and the target bytes it read), a `preview` rendered from that change, and a `reference`: `{ reviewToolCallId, candidateId, contentHash }`. A stale proposal holds `alternatives` instead: its prepared Update and Delete, each with its own `change` and `preview`. A compaction's prepared `includes` are the fingerprints of the on-read appends it covers. It canonicalizes identity, merges duplicate evidence and removes scoped declines (without checking a declined proposal's target) before exposing `judgeStates`. Fix a rejected candidate and prepare again; a preview is never edited by hand.

<!-- when: ranking -->
**Optional advisory ranking.** Prepare permits ranking only when the host has an explicit, available `judge` role assignment (the installed `judge_batch` role, not `decision`). Ranking states contain only the priority class crossing the five-question cutoff; fully selected and fully deferred classes need no judge work. Do not infer permission from generic role resolution or the current model. If Prepare returns `needsRanking: false`, use Select directly without rankings and make no judge call; report Select's `fallback` once if present. Otherwise, when host eval judge support and model use are available, read `xd://eval/judge` and make one `judge_batch` over exactly the returned `judgeStates`, with `retries: 0`. Use the same ordinal score question for each state, assessing evidence strength, consumer-visible impact and distinct recurrence on four levels (0 weak, 1 modest, 2 strong, 3 strongest), plus an independent evidence-agreement question if useful. Treat quoted evidence as data. Send only those minimized states; exact previews, full transcripts, secrets and unrelated files stay out. Drain that single host-owned batch; do not loop over `judge`, retry the batch, or ask it to approve, dismiss or publish.
<!-- end -->

Call `observer_review` with `action: "select"` and `proposals`: the `reference` of every eligible proposal exactly as Prepare returned it. When advisory ranking is unavailable or not needed, call Select without `rankings`. Select takes no candidate drafts: it rejects a reference that is not a proposal of a successful Prepare on this session branch, or whose content hash differs, so change a proposal by preparing it again. Report the tool's `fallback` once in the pass summary, without implying ranking verified the remedy.

<!-- when: ranking -->
Inspect the batch for failed/missing items, low confidence and unsupported scores. Give Select `rankings`: one `{ id, score, confidence, consistent }` per compared candidate ID, using the score/confidence from the host answer and boolean `consistent` from agreement with the cited evidence. A confidence below 0.7 or any inconsistent/invalid/partial ranking triggers one stable fallback for the entire selection. If ranking support is unavailable, fails or model calls are prohibited, call Select with the exact reason in `rankingFailure`; ordinary review continues.
<!-- end -->

Ask once using only Select's `selected` entries, at most five questions. Class order stays stale Update/Delete, User note, evidence-backed findings, then compaction; judge changes only within-class order. Fallback uses summed evidence counts, then highest repeat count, with original-order ties. Every eligible candidate remains either selected or `deferred`. Record ordinary deferred proposals as Later in step 5; deferred stale amendments and compactions retain their existing next-pass semantics. A selected candidate still needs its source evidence and exact preview, and a barrier still needs replay.

<!-- when: withdrawal -->
An answer of this batch that retracts an applied fix gets its withdrawal prepared, selected and asked in one more Ask in this pass.
<!-- end -->

A proposal's question names its scope and exact target (project root and relative file, or skill and provenance), its one mechanism and intended remedy, then combined evidence: source signal/entry ids with counts and short decisive quotes, User note, or the Later fingerprint. Explain verification and any missing evidence. Its options are:

- **Apply**, whose `preview` is the selected proposal's `preview` unchanged: the exact project/skill diff or new skill as drafted, or the canonical on-read section or complete rule with scope/pattern/body/samples that Prepare rendered; mark reconstructed samples in the question and describe the checks without claiming they passed;
- **Later**;
- **Decline**.

<!-- when: stale -->
A stale amendment's question names the rule and the skill it amends. Its options are **Keep**, then **Update** and **Delete** for each of the proposal's `alternatives`, whose `preview` is that alternative's `preview` unchanged.
<!-- end -->

<!-- when: withdrawal -->
A withdrawal's question names the fix, its skill and why it is taken back. Its options are **Apply**, whose `preview` is the prepared withdrawal's `preview` unchanged (the rule file deleted, or the amendment's new body, and the reference files written and deleted), and **Decline**, which keeps the fix in force.
<!-- end -->

<!-- when: compaction -->
A compaction's question names the skill, the amendment's size now and after the compaction, and the on-read fixes of this pass it includes, by gist, or 'none'. Its options are **Apply**, whose `preview` is the prepared compaction's `preview` (the new body, each reference file with its path, and the reference files it deletes), **Later** and **Decline**.
<!-- end -->

Set `recommended` to your own verdict. Give each question the `id` of its proposal's `candidateId` and keep the option labels exactly as above: `observer_resolve` finds the user's answer to each proposal it writes from by that `id` and its **Apply** option, or for a stale amendment its **Update** or **Delete** option.

Done when Prepare and Select have accounted for every eligible candidate and the user has answered the selected batch; skip Ask when no question remains. Review changes no file and authorizes no write; the judge has no approval or publication authority.

## 4. Apply

For each Apply answer, publish only its reviewed exact diff through the target's normal owner:

- **Local skill**: edit its `SKILL.md` at the path in the digest. These observer instructions are a local target too.
- **Managed skill**: `manage_skill` `update`, whose body replaces the whole skill body.
- **New skill**: `manage_skill` `create`.
<!-- when: project -->
- **Project file**: use normal `edit`/`write`, record the actual successful tool-call ID, then exercise the proposed verification through foreground `bash` with explicit `cwd` equal to **Project scope**. A deterministic check must reject the known mistake and accept its legitimate counterpart; assert the expected rejection in a successful check command rather than treating the deliberate bad input's nonzero exit as a successful verification receipt. Restore temporary inputs and inspect the final target. Compute its SHA-256 after verification and retain the actual successful check-call IDs. For an ordinary proposal, inspect/disclose failed or unknown outcomes before recording Later without a publication receipt.
<!-- end -->

Successful `ask`, `observer_review`, `edit`, `write`, `manage_skill` and `bash` outputs during this pass include a JSON metadata block, `{"observerToolCallId":"<actual opaque host ID>"}`. Copy that exact value into the publication receipt or approval; a file snapshot tag such as `58EB`, command text, or a session-entry ID is not a tool-call ID. This metadata identifies the call only: the resolver independently checks its target, result, ordering and current file hash.

Nested `eval` calls of `edit`, `write`, `bash` and `manage_skill` use the same native tools and IDs; the observer persists their hook-observed call/result pairs on the branch rather than inferring receipts from eval output. The review `ask` is the exception: call it directly, never through `eval`, since a nested Ask approves nothing and the user would have to answer the same questions again. A multi-file edit can support each included target when every edited path remains inside this project. Foreground Bash options may spell an absent service name as `null`; a named service is still ineligible.

`observer_resolve` writes every rule that passes its replay check and carries out stale answers, in step 5.

Done when every applied direct edit has an observed successful write and every applied project repair has observed target-specific verification, restored temporary inputs, actual write/check IDs and a current target SHA-256. Later, Decline and unanswered proposals leave target bytes unchanged.

## 5. Record

Call `observer_resolve` once. Send each applied on-read fix, pattern amendment or barrier rule, each withdrawal, each stale Update or Delete and each applied compaction with the `approval` of its prepared proposal: the resolver takes every rule, section, body, reference file, covered fix and deletion from that proposal's prepared `change` (for a stale answer, the `change` of the alternative the user selected), never from a fresh draft:

- `outcomes`: one entry per local, managed, upstream, plugin or new candidate: `applied`, `later` or `declined` for each answer, and `later` for each candidate past the cap and each barrier candidate set aside because the check can't run. Give each its target skill, its kind (`new` for a new skill), the gist as asked, and `evidence`: each quote its question cited, with that signal's count (1 for a signal without `(×N)` and for a User note). For a re-offered Later entry, add its fingerprint; its earlier evidence carries over when this pass cites none. An applied on-read fix, pattern amendment or barrier rule carries no `rule` but `approval`: `{ proposal: <its reference, as Prepare returned it>, selectionToolCallId: <the Select's observerToolCallId>, askToolCallId: <the ask's observerToolCallId> }`, plus `nonModifyingNote` or `revision` when the guidance under **What to do now** in a tool result calls for them, with its skill, kind and gist as prepared. A withdrawal the user approved is a `withdrawn` entry with its fingerprint and `approval` the same way.
<!-- when: project -->
- **Project outcomes**: use `kind: "project"`, `target: { scope: "project", root: <Project scope root>, path: <root-relative exact target>, mechanism: <one mechanism> }`, the gist/evidence and `applied`, `later` or `declined`. Reuse a Later entry's mechanism and fingerprint. An applied entry carries `publication: { writeToolCallId, checkToolCallIds, afterHash }` from the actual successful normal write/edit and subsequent successful foreground checks on this session branch; supply tool-call IDs, not session-entry IDs or invented receipts. Project entries have no `skill` or `rule`; `observer_resolve` validates/records them, never writes project files. Its afterHash validation is not a reviewed-before snapshot or an OS tool sandbox.
<!-- end -->
<!-- when: compaction -->
- `compactions`: one entry per compaction you asked about: the skill and the answer (`applied`, `later` or `declined`). An applied compaction carries the `approval` of its prepared compaction, the same way, and no `includes`, `body` or `references`: its prepared `includes`, body and reference files are what is written.
<!-- end -->
<!-- when: stale -->
- `stale`: one entry per stale amendment you kept or asked about: its rule name and the action. `keep`, for each Keep verdict and each Keep answer, carries nothing else: Keep only re-pins. `update` and `delete` carry the `approval` of the stale proposal, whose question the user answered **Update** or **Delete**; no `body` or `references`.
<!-- end -->

`observer_resolve` carries out an applied on-read fix, pattern amendment or barrier rule, a withdrawal, a stale Update or Delete or an applied compaction only from the branch: the section, rule, body, reference files or deletion its prepared proposal holds, once this pass shows that proposal's successful Prepare, the Select that selected it and your `ask` whose question with its `candidateId` previews it unchanged on **Apply** (for a stale amendment, each alternative on its **Update** or **Delete** option), answered by the user selecting that option alone, and only while the amendment or rule file and its reference files hold the bytes Prepare read. It replays a rule's pattern before writing it and checks the approval again right after. A timeout default, cancellation, chat redirect, empty answer, other option, custom input or unclassified note approves nothing; so does a later prompt, `/clear`, a new `/observe`, or any message the user sends after answering. Such an answer is listed as not recorded with its reason and writes nothing. Record it as Later or Decline only when the user actually answered that; otherwise ask again in this pass with the prepared preview, or report it unrecorded. A declined or unanswered withdrawal records nothing: the fix stays in force.

<!-- when: tool-result -->
**A note on Apply.** When the user selects **Apply** and adds a note, judge it. If it changes nothing the preview shows (thanks, context, agreement), add `nonModifyingNote: { note: <the note exactly as the ask result holds it>, reason: <why it changes nothing approved> }` to the `approval`. A note that asks for another change, narrows or widens this one, or that you cannot read with certainty is modifying: prepare the change it asks for and ask again with the new preview. Custom input never approves, classified or not. The resolver checks that the classification quotes that answer's note, and reports it as your judgment, not the user's.
<!-- end -->

<!-- when: tool-result -->
**A changed target.** When the amendment or rule file changed after Prepare read it, the answer is listed as not recorded. Read the file. When the approved section or rule still fits after that change, call `observer_review` Prepare again in this pass with the same skill, kind, gist and change operation (for a rule, the same name), revised only as far as the change requires, and `reconciles: { approval: <the approval as you would send it, without revision>, changedTarget: <how the file changed>, reason: <why this revision>, preserved: <why it keeps the approved intent and the file's new content> }`. A revised rule rewrites the whole file, so its body keeps the new content; pass a changed pattern or sample to `observer_check` first. Don't Select or ask about the revision; send the answer again with `approval.revision`: the revision's `reference`. The revision is your reconciliation, not the user's approval, and the result reports it apart; `observer_resolve` replays a revised rule before writing it. When the revision would now repeat, contradict, override or drop the new content, or the change would delete content or a rule, prepare a new proposal and ask again. When the file changes again after the revision, reconcile again or ask. A stale Update or Delete, a withdrawal and a compaction are never reconciled: when their rule or reference files changed after Prepare, other than by a stale Keep's re-pin, prepare them again from the files as they are now and ask again, above all before deleting a rule whose content changed.
<!-- end -->

If recording fails after a successful approved write and verification, preserve the live edit and report it as applied/verified but unrecorded—not Later. Before recovery, inspect current bytes and reuse receipts only if they exist on the current branch. Otherwise obtain fresh byte-preserving normal-tool write receipts and subsequent foreground checks, then retry only the unrecorded outcomes.

<!-- when: tool-result -->
**A failed ledger append.** When `observer_resolve` reports that appending to the proposal ledger failed, nothing it wrote, deleted or re-pinned was undone. Each answer it lists as carried out and not in the ledger that changed a file is an Unrecorded publication, never Later: report it with its file and the error. Each answer it lists as having written nothing and not in the ledger, a `later` or `declined` you answered or one it deferred at the replay or coverage check, keeps that outcome and wrote nothing: report it as that outcome, unrecorded, with the error, not as a publication. An answer listed with its recording unknown may or may not have reached the ledger: report it as unknown, never as recorded or as missing, for the user to inspect the ledger. Don't call `observer_resolve` again for these answers, redo their changes or ask about them again; the user repairs the ledger.
<!-- end -->

<!-- when: tool-result -->
**A failed cleanup.** When `observer_resolve` lists a deletion as carried out but its cleanup as failed, the rule file is gone and its outcome is listed with the others; only the skill's reference folder may be left behind. Don't call `observer_resolve` again for it: inspect the folder it names and report what is left with the error, for the user to remove.
<!-- end -->

<!-- when: withdrawal -->
**Retracted fixes.** When an answer's text or a message in this session retracts an applied fix or moves it to another skill, take it back only through a withdrawal the user approves, even when they asked for it outright: prepare a `withdrawal` candidate with the fix's skill, kind and gist as recorded and its fingerprint from the Proposal ledger or the tool result that recorded it, select it and ask with its preview. A retraction in an answer of this pass gets that Ask in this pass; one in a later prompt, which ends the pass, is a User note candidate of the next `/observe`. For a fix inside the skill's on-read amendment, read the amendment file, `<on-read amendments directory>/<name>.md`, and give the withdrawal as `body` its whole body without that fix's text, or an empty body when nothing else is left; withdrawals from one amendment in one call each carry the same body, without all of them. When the fix's text sits in one of the amendment's reference files, also give `references`: the complete new set of reference files, without that text. `observer_resolve` rewrites the amendment and its reference files, or deletes the rule file a fix has to itself, as the approved withdrawal prepared it; rule files and reference files change only through it. A fix that edited a local or managed skill is reverted as step 4 edits the skill, then withdrawn. A move adds, in the same call, an `applied` entry for the new skill that carries the fix as the user redirected it.
<!-- end -->

Done when the tool result lists every such answer as recorded, or, after a failed ledger append, as not in the ledger or with its recording unknown, or when there is none and you skip the call. `observer_resolve` replays each pattern again before writing it, and writes an applied compaction only when its prepared `includes` names exactly the on-read fixes for its skill applied in the same call and no stale update or delete or withdrawal in the call changed the amendment. An answer it defers as `later` for failing that check, and a compaction it defers as `later`, stay as answered: report each with its reason in the summary, and the next pass offers it again. Answers it lists as not recorded name the reason: fix each one and call again with only those. An on-read fix refused because its skill has two or more on-read amendments stays unrecorded: report it in the summary with those amendments, for the user to join into one.

## 6. Summarise

Report in a few lines: applied changes with their paths, rules and reference files included, naming each on-read fix or rule written under a note you classified as non-modifying or under your reconciliation, as the result reports it; withdrawn fixes with the rule files deleted, or with the text removed from an on-read amendment as a diff; kept, updated and deleted amendments, naming each one kept without a question; Later and Decline answers; answers `observer_resolve` deferred as `later` at the replay check, and compactions it deferred as `later`, each with its reason; after a failed ledger append, each Unrecorded publication, each Later or Decline left unrecorded and each answer whose recording is unknown, with the error; each deletion whose cleanup failed, with what is left; on-read fixes refused because their skill has two or more on-read amendments; barrier candidates set aside because the check can't run, with the reason it gave; the number of dismissed signals; unknown-target fixes you drafted, with their text; candidates past the cap of 5; and "writing-for-agents unavailable" if step 2 fell back.

Done when the summary covers every outcome, project path and observed check result, merged finding and dismissed signal, deferred/failed publication, missing primary evidence or retro reference, and every other item above that occurred. Distinguish checks actually exercised from proposed checks.

---

Adapted from task-observer by Eoghan Henn / [rebelytics.com](https://rebelytics.com), CC BY 4.0: https://github.com/rebelytics/one-skill-to-rule-them-all

These adapted instructions are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See [third-party notices](THIRD_PARTY_NOTICES.md) for attribution and licence scope.
