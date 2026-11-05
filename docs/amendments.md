# Amendments and barrier rules

This reference describes the files `observer_resolve` writes, how amendments reach the context, and how pattern rules are checked. [Observation](observation.md) covers [hints](observation.md#hints), the [session digest](observation.md#digest), and the review pass. [Development](development.md) covers [proposal approval](development.md#proposal-approval) and the [ledger](development.md#ledger). Return to the [README](../README.md) for an overview.

## Rules

`observer_resolve` writes each rule an applied answer carries. There are two kinds:

- An **amendment rule** fixes an upstream or plugin skill. The fix is never written into the installed skill, because the next skill or plugin update would overwrite it. With a pattern it is a **pattern amendment**, the barrier rule for an upstream or plugin skill, a TTSR rule in a file of its own, `<agent dir>/rules/<name>.md`. Without a pattern it is an on-read fix, a section of the skill's **on-read amendment**, which the extension adds to the context whenever the skill is loaded. On-read amendments live in `<agent dir>/skill-observer/amendments/<name>.md`, next to the ledger and outside the rules directory, so OMP never loads them as TTSR rules.
- A **barrier rule** fixes a local or managed skill when an instruction of that skill has failed twice. It is a TTSR rule in `<agent dir>/rules/<name>.md`. Any other approved fix to those skills is an edit to the skill, so a rule for one without a pattern is refused.

An upstream skill is tracked in `~/.agents/.skill-lock.json`. A plugin skill comes from an enabled plugin in OMP's user-scope registry. A local skill is in `~/.agents/skills/` without a lock entry. A managed skill is in OMP's `managed-skills/` directory. The [observation reference](observation.md#observe) describes provenance resolution. `<agent dir>` is OMP's agent directory.

A rule name is unique across both directories. A write that would take a name a file in the other directory holds is reported as not recorded.

A barrier rule's pattern watches where the mistake shows, as its `scope` says: `text`, the default, for the agent's text, or `tool:<name>` with a lowercase tool name, as in `tool:bash`, for one tool's calls. For a tool, TTSR matches the pattern against the call's arguments as JSON, and for `edit` and `write` against the resulting file content. Other scope forms, including path globs, lists, `thinking`, and any tool, are refused.

## The skill's on-read amendment

Each upstream or plugin skill has at most one on-read amendment, `<skill>-amendment.md`. An applied on-read fix carries the user's `approval` of its prepared proposal. The section written is the one that proposal holds, a `## ` heading line and its text. See [Proposal approval](development.md#proposal-approval).

`observer_resolve` appends the section after a blank line to the skill's amendment, or creates the amendment with the section as its body when the skill has none. On append, it removes trailing whitespace from the existing file with `trimEnd()`, adds two newlines, appends the trimmed section, and ends the file with a newline. The existing content before that trailing whitespace stays unchanged. A section the body already holds verbatim, when the pass answers the same applied fix again, is not appended twice. The answer still records.

A skill whose one marked on-read amendment has another name gets the section appended to that file. A skill with two or more marked on-read amendments gets none. Prepare refuses the proposal, and the resolver reports an approved one as not recorded, asking you to join them into one by hand. Nothing changes. Each fix is its own proposal with its own `applied` record, whose `rule` is the amendment. Writes to the skill's own amendment, including append, withdrawal, and stale answers, go through whatever fingerprint the amendment stores, as long as it carries the marker, no pattern, and that skill in `amends`. Every other write keeps the fingerprint and foreign-file checks. A pattern amendment named `<skill>-amendment` is refused.

A created amendment's frontmatter holds `description` "Approved fixes to the `<skill>` skill, added whenever it is read." and `fingerprint`, the first 12 hex digits of the SHA-256 of `on-read amendment\n<skill>`. This fingerprint is the file's own identity, under which stale answers about it are recorded, never a fix's. An append leaves the frontmatter, pin included, as it is, so a stale amendment stays stale until its stale answer.

### Rule frontmatter

The rule's frontmatter holds:

- `description`: the proposal's gist. For a skill's on-read amendment, see above.
- `condition` and `scope`: the pattern and its scope, for a pattern amendment or barrier rule. An on-read amendment has neither.
- `amends`: the skill the rule fixes.
- `skillHash`: for amendment rules of upstream and plugin skills, the SHA-256 of the skill's folder when the rule was written. Every regular file is included recursively, sorted by relative path, each hashed as `relpath\0bytes\0`. Symlinks are skipped. The pin is empty when the skill was no longer an upstream or plugin skill. Barrier rules for local and managed skills carry no pin.
- `fingerprint`: the ledger fingerprint of the proposal. For a skill's on-read amendment, see above.
- `generatedBy: "skill-observer"`: the marker. The tool rewrites and deletes only rule files that carry it, and reports any other file in its way.

## Stale amendments

On every `/observe` the extension compares the `skillHash` of each marked rule that carries one with the skill's folder as installed now. A rule whose skill's files changed, or whose skill is no longer an upstream or plugin skill, is listed under **Stale amendments** in the message with the skill's provenance kind. A lock hash change or a plugin version bump that leaves the files identical does not make it stale. A rule whose skill folder can't be read is logged and skipped. It is neither listed nor re-pinned, and `/observe` goes on.

The pass reads the rule and the updated skill and gives it a verdict. A Keep verdict is re-pinned without a question. The pass sends a `keep` stale answer to `observer_resolve` and names the rule in its summary, so you can object. An Update or Delete verdict becomes a Keep / Update / Delete question that counts toward the cap of 5, ranked first.

Keep re-pins the rule to the current hash and changes nothing else. Every other byte of the file, the body's whitespace and line ends included, and every reference file stay as they are. A `keep` answer carrying a `body`, `references`, or `approval` is refused, since a content change is an update.

An Update or Delete answer carries the `approval` of the option the user selected. See [Proposal approval](development.md#proposal-approval). Update rewrites the body its alternative prepared and re-pins the rule. For an on-read amendment, it first replaces the reference files when the alternative carries `references`. Delete removes the file and, for an on-read amendment, its reference files. Deleting a skill's on-read amendment also records each fix in force in it as `deleted`, so an on-read fix added later creates the amendment afresh without them.

`observer_resolve` carries out stale answers before the call's other answers. An on-read fix in the same call is appended to the updated body, or creates the amendment again after a delete. A re-pin leaves the rest of the frontmatter as it is on disk, so keys added by hand survive. A stale amendment starts a pass even in a session without signals. Barrier rules for local and managed skills are never stale, and a stale answer naming one is refused.

## Startup migration

When the extension loads, it converges marked rules on the current layout. First it rewrites rules that still carry the earlier pins, `skillFolderHash`, or `plugin` and `pluginVersion`, to `skillHash`. The value is the current hash when the old pin still matches the lock or the installed plugin version, else empty, so the next `/observe` asks about them.

Then it moves each marked rule in the rules directory with scope `tool:read`, an older on-read amendment, to the amendments directory without its `condition` and `scope`. Barrier rules may not take that scope. The new file is created whole by hard-linking a staged copy, so it never replaces an existing file. When one is already there, the old file is deleted only if the existing one is a marked on-read amendment of the same skill with the same body. Otherwise both stay, and the conflict is logged with both paths. Body and other frontmatter stay as they are. The ledger is not touched. A second run changes nothing. A file that fails is logged and left as it is, and the other files still migrate.

## Delivering on-read amendments

The extension delivers a skill's on-read amendments itself, by either route the skill can take into the context. It renders a hidden `<system-reminder reason="skill_amendment" skill="<skill>">` holding one `<amendment rule="<name>">` per amendment:

- **`/skill:<name>`** puts the skill in the conversation without a `read`. When a submitted prompt starts an amended skill, the extension appends a hidden `skill-observer-amendments` message after it, on the same turn.
- **A `read` of the skill's entry file** can use `skill://<name>`, `skill://<name>/SKILL.md`, or the skill's `…/SKILL.md` path, any of them with a read selector such as `:1-40` or `:raw`. Reference files, longer skill names, other URLs, and failed reads get nothing. When the model called `read` itself, which the saved transcript shows by the time the result arrives, the amendments go out as the call's additional context, which OMP adds after the tool results. A read nested in `eval` or a device dispatch has nowhere to put additional context, so the amendments are appended to its result text instead. The extension's hook copy of such a read, or a native outer `write xd://read` under the same call ID, does not make it native. Each delivery is recorded as a `skill-observer-amendment-delivery` session entry naming the skill and rules. A failed delivery is logged and leaves the read as it was.

Each amendment goes out once per context window across both routes. A `/skill:` reminder suppresses a later read delivery and the other way round, until a compaction or a `/clear` reset drops the earlier one from the context. Barrier rules need no delivery, since they fire on the mistake however the skill was loaded. Delivery also runs in sessions without UI and in subagents. A subagent without the `read` tool gets no read delivery.

## Compaction and reference files

An on-read amendment whose body is over 4,000 characters, about 1k tokens, is marked under **Rules in force** as over the compaction limit. Reference files don't count toward this limit. The pass proposes a **compaction** for it. The pass also proposes one for an amendment that this pass's on-read fixes would bring over the limit. The draft covers the body with all of this pass's on-read fixes for the skill appended. Its question names them by gist, or says 'none'.

The draft keeps every instruction, states each once per `writing-for-agents`, and moves topical sections that are still over the limit into **reference files**. Each moved section, heading included, is replaced with the one pointer line "When <condition>, read <absolute path>." The preview shows the new body and every reference file. A compaction ranks last against the cap of 5, since it comes back on its own.

Reference files live in `<agent dir>/skill-observer/references/<skill>/`, next to the ledger and outside the rules directory, so OMP never loads them as rules. `/observe` names the directory, as it names the amendments directory. They belong to the skill's on-read amendment. A reference file's `name` is a plain file name, a letter or digit, then letters, digits, `.`, `_`, and `-`, so none can leave its skill's folder.

### Approval and coverage

`observer_resolve` takes compactions in `compactions`: the skill, the answer, and for an applied one the `approval` of its prepared compaction. See [Proposal approval](development.md#proposal-approval). Prepare holds the compaction's new body, its complete set of `{ name, body }` reference files with the folder's files it deletes, and `includes`, the fingerprints of this Prepare's on-read appends it covers. It refuses a body that lacks the absolute path of one of its reference files.

The resolver carries out the call's stale answers, withdrawals, and additions first. It writes an applied compaction only when every fix its prepared `includes` names was applied in the same call, every on-read fix the call applied for the skill is among them, and no stale update or delete or withdrawal in the call changed the amendment. Then it replaces the folder's contents with exactly the prepared files and, after that, the amendment's body, leaving the frontmatter, pin included, as it is. Otherwise it records the compaction as `later`, writes nothing for it, and says why. The next pass drafts it again from the body actually written.

A compaction's fingerprint is the first 12 hex digits of the SHA-256 of `compaction`, the skill, and the SHA-256 of the amendment's body as Prepare read it. The approval holds that body unchanged until the call's own writes. A declined compaction suppresses that version of the body only. The amendment loses its mark until any change to its body brings the offer back. Compaction records are never fixes in force and never Later or Declined entries. See the [ledger reference](development.md#ledger).

### Reference replacement and deletion

Deleting the amendment, by a stale delete or by withdrawing its last fix, deletes the skill's reference folder once the skill has no marked on-read amendment left. Only a deletion prepared as the skill's last on-read amendment may do this. One prepared beside another on-read amendment of the skill that would now release a folder holding files, as when one call deletes both of a split pair, is refused before it deletes anything, for a fresh Prepare and Ask.

A stale update and a withdrawal may be prepared with `references`, which replace the folder's contents before the body is written. The new body names each file by its absolute path, or Prepare refuses it. Without `references` the reference files stay as they are.

The new reference set is written into the hidden sibling folder `.<skill>.staged`. The previous folder is renamed to `.<skill>.old`, the staged folder is renamed into place, and the amendment body is written before the previous references are discarded. If publication fails, the code attempts to remove the new folder and restore the old references. If rollback also fails, it reports an `AggregateError`: the current folder may be missing or partial, and the previous references remain at `.<skill>.old`. Both folders need inspection and the reference folder needs restoration before another `observer_resolve`. A retained `.old` folder, including one left by failed cleanup after successful publication, blocks further replacement until it is reconciled. These sibling folders are under `<agent dir>/skill-observer/references/`. Restoration is not guaranteed.

Reference files are plain files directly in the folder. A folder that also holds anything else, such as a subfolder, can't be shown in a preview, so Prepare refuses a change that would replace it. A change prepared before such an entry appeared writes nothing.

## Replay

Every barrier rule carries two sets of samples: `matches`, samples of the mistake, each of which the pattern must fire on, and `spares`, legitimate counterparts, none of which it may fire on. A pattern without at least one of each is refused. A sample takes the shape of what TTSR matches in the rule's scope:

- `text`: a string of the agent's prose.
- `tool:edit` and `tool:write`: a string of the resulting file content, one sample per touched file.
- Any other tool: the call's arguments as an object, which the extension serializes with `JSON.stringify`, so a pattern has to match JSON escaping. A quote in a `bash` command reads `\"`.

`observer_check` takes pattern drafts, including name, pattern, scope, `matches`, and `spares`, and replays them through OMP's own TTSR engine. It writes the draft's condition and scope, exactly as they would be written, to a temporary rule file, and runs `omp ttsr test --rule <tmp> --json` once per sample, all in parallel, with the sample on stdin. It reports per draft whether it passed and which samples misfired, and writes nothing. The pass asks about a barrier rule only once it passes. The mistake sample comes from the conversation, or from a reconstruction the preview marks as one when compaction dropped it. The model writes the legitimate counterpart.

`observer_resolve` repeats the check for every applied rule with a pattern before writing it, over the pattern and samples of the prepared proposal the user approved, or of its reconciliation. A rule that fails is not written. The answer is recorded as `later`, and the result names the misfiring samples, which the pass reports instead of redrafting. The approval is checked again after the check, right before the write. One that no longer holds records nothing, not even `later`.

The check uses the `omp` on PATH, with no fallback. When it can't run, `observer_check` says so and the pass offers no barrier rule. Each barrier candidate is recorded as `later`, the summary says why, and `observer_resolve` likewise records an applied barrier answer as `later` without writing its rule. Skill edits, on-read amendments, and new skills are unaffected.

Replay checks complete samples, while live TTSR also checks the growing prefixes of a streamed output, so a pattern using end anchors or lookaheads can behave differently mid-stream. A pass proves only that the pattern agrees with its own samples.
