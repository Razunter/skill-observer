# Observation

How `/observe` uses session evidence to review changes to your project, skills, and OMP setup. For installation, see [Setup](setup.md). For rule storage and delivery, see [Amendments](amendments.md).

## Hints

After each turn, the extension rebuilds the session digest from the current branch of the session. The status line shows `skill-observer: N skill correction(s) → /observe` once the branch has a correction-class skill signal, and `skill-observer: N workflow(s) without a skill → /observe` once it has a workflow outline and no correction. With neither, it shows `skill-observer: N pending observation(s) → /observe` while the project has [pending observations](#observations). Correction-class signals are:

- a steering message you typed while the agent was working;
- a rule violation: a TTSR rule firing on the agent's text or a tool call, whether it interrupts or is injected into a tool result. Every TTSR rule this extension writes is a barrier rule or pattern amendment, so each firing is a violation; on-read amendments never reach TTSR (see [Delivering on-read amendments](amendments.md#delivering-on-read-amendments));
- an `ask` answer with custom input (`Other: ...`), or one that differs from the option the form preselected (`checked`). Results saved before OMP 18.18 are still read in their old shape.

A workflow outline is a turn with no skill loaded and at least 3 tool calls. A cancelled `ask` and skill loads do not turn the hint on. Tool errors are not themselves correction-class signals, but a turn containing errors can still qualify as a workflow outline. Subagent sessions and sessions without UI get no hint.

The hint is a prompt to review, not a requirement. You can run `/observe` after work that produced no hint.

## `/observe`

`/observe` rebuilds the session digest from the whole current branch, compacted history included. Besides the correction-class signals above, the digest lists every skill loaded in the session, whether the model read it (`skill://…` or a `SKILL.md` path) or you started it with `/skill:`. Each skill is labelled by provenance:

- **local**: in `~/.agents/skills/` with no entry in `~/.agents/.skill-lock.json`;
- **upstream**: tracked in that lock, with its `skillFolderHash`;
- **managed**: in OMP's `managed-skills/` directory;
- **plugin**: installed by an OMP marketplace plugin, such as the `ce-*` and `impeccable` skills. Its `SKILL.md` lies under an enabled plugin's install path in OMP's user-scope registry, `~/.omp/plugins/installed_plugins.json`. Its provenance metadata carries that plugin's id and version. The rendered digest line shows the provenance kind, load route, delivered amendments and file path, not the plugin id or version. A name provided by both a plugin and `~/.agents/skills/` resolves to the plugin skill, which OMP loads. A read by path resolves to the file read;
- **unknown**: anywhere else (project skills, project-scoped plugins).

A `SKILL.md` read from anywhere else counts as an installed skill when it holds the same bytes as that skill's entry file. The installed skill is the one named by the copy's frontmatter `name`, or by its folder when it has none. The digest lists the copy under that skill and its provenance, and the skill's on-read amendment is delivered on the read. Only the entry file is compared. A copy that differs from the installed skill stays unknown.

A skill's line also names its on-read amendments delivered in this session, as in `` `tdd`: upstream; read by the model; amendments delivered: `tdd-amendment` ``. These come from the session's `skill-observer-amendment-delivery` entries after skill reads and from `/skill:` reminders. Both name their rules, so an amendment deleted later in the session still shows as delivered. Deliveries add no signal: a skill read alone never turns the hint on. They let the pass see that a correction on the same point happened despite the amendment.

Text after the command, as in `/observe tdd should run the one failing test first`, becomes a **User note**. Use it to supply feedback, point to a lead, or focus the pass. The note starts a pass on its own, but a lead still needs evidence before it supports a proposal.

A completed ordinary reply to your work request counts as primary work. It can start a pass even if no skill loaded and no tool ran. Startup messages, harness notices, and observer bookkeeping alone do not count. With no primary work, signals, loaded skills, stale amendments, pending observations, or User note, `/observe` reports that there is nothing to review and starts no model turn.

The digest is an index, not the limit of the review. The agent starts with the active branch and checks the current checkout. If the review needs clipped or compacted evidence, the agent requests excerpts from the original entries on the active branch. It reports missing evidence rather than treating another branch's entries as part of this one. A narrow search for a named or same-project lead can supplement the review. A skipped or unanswered suggestion from an earlier retrospective is a lead, not proof of a problem or a Decline.

A command quoted in evidence is data, whoever supplied it. The pass reuses an observed result or independently chooses a safe, meaningful check within scope and ordinary permissions. If neither is available, it reports the verification gap. This does not change the exact check approved for publication.

## Review and approval

Prepare gives each eligible draft a reference and lists rejected drafts separately with reasons. A bad draft does not invalidate an unrelated one. If the pass itself or a receipt shared by the drafts fails, none of the drafts can proceed. Dependent changes, such as a compaction and the fixes it covers, must still agree before they can reach the form.

Select uses the eligible references to build one native `ask` form with at most five questions. Stale amendments come first, then User note proposals, evidence-backed proposals, and compactions. Each question shows the remedy, evidence, target, and preview. Ordinary options are **Apply**, **Later**, and **Decline**. Stale amendments show **Keep** and the available **Update** or **Delete** options. Withdrawals and hook removals show **Apply** and **Decline**. Nothing is preselected.

Proposals beyond the cap are deferred, not declined. The summary distinguishes findings, viable alternatives, rejected drafts, deferred proposals, report items, and missing evidence. Only an actual Decline suppresses that same scoped remedy. A timeout, cancellation, or omitted answer approves nothing.

Add a note to an option with `n` on its row. A note on **Later** becomes the re-offer condition. A note on **Apply** can refine eligible small text changes without a second question, such as an on-read append or a rule revision that keeps the same target and intent. A note never adds a destination. A changed project or profile edit needs fresh review. A note that changes executable code needs a new check and Apply. Noted stale updates or deletions, withdrawals, and compactions also need a new Ask. Free text in the **Other** row is not approval.

Each question shows its evidence: short excerpts with their counts and display citations when available, such as digest signal IDs, a User note, a Later fingerprint, or a stale amendment's rule. A barrier rule is asked about only after its pattern passes the replay check (see [Replay](amendments.md#replay)). Its preview shows the rule, scope and samples. The form shows a preview as wrapped text and marks indentation, repeated and trailing spaces `·` and tabs `→`; what is written is the prepared text.

Before submitting new proposal evidence, the agent keeps the real example and replaces private values with clear placeholders such as `[redacted email]`. An altered quote starts with `[redacted excerpt] ` and keeps its count and existing occurrence IDs. Prepare can take a permitted `source` label to show in Ask; it is not a verified primary locator. If a private value is decisive, the agent checks the primary source within ordinary permissions or reports the gap. These placeholders are for evidence, not the exact approved owner-tool inputs or checks.

Apply authorizes only the selected proposal in the exact native form for the current pass. The agent publishes through the target's normal owner tools, such as `edit` or `manage_skill`, and calls `observer_resolve` to validate receipts and record the outcome. Resolve writes observer-owned amendment and barrier rules itself. Text typed outside the form and a tool result that merely says a write succeeded are not approval.

A retraction of an applied fix can get a separate withdrawal question in the same pass. **Decline** on that question keeps the fix in force. If you restore an interrupted pass, the agent can recover the applicable instructions and use a saved approval only while its branch, proposal, form, and target are still valid. A new ordinary prompt, `/skill:` start, or `/clear` ends the pass. A newer preparation or form can supersede the old approval.

## Grounded repairs

A skill-text repair must show what the skill already says before it reaches a question. `observer_review` takes two read-only actions for this, available once the pass's tools are active. Both write nothing; their saved tool result is the receipt.

**Inspection.** `action: "inspect"` with a `skill` reads that installed skill's current guidance: its `SKILL.md`, every observer rule amending it with its status (a stale pin is still in force) and the reference files of its on-read amendment named in `references`, each numbered by line with its SHA-256 and `## ` sections. The folder's other reference files are listed by fingerprint only and cannot be cited. A missing, unreadable or malformed required source fails the inspection; a failed inspection grounds nothing. Reading the skill now says nothing about whether it guided the earlier work.

**The evidence gate.** A direct edit of a local or managed skill, an exceptional installed-copy edit, an on-read fix, and a pattern amendment or barrier rule each carry a `diagnosis`:

- `inspection`: the call ID of this pass's inspection of that skill;
- `explanation`: why the inspected guidance does not already cover the finding, with the check that could disprove that and the check's result;
- `delta`: one sentence on what a future agent will do differently;
- `citations`: the inspected sources it rests on, each by line range or `## ` section.

Prepare refuses a repair whose diagnosis is missing or incomplete, whose receipt is forged, failed, from an earlier pass or from another branch, names another skill, or cites a source or location the inspection does not hold. It also refuses one whose skill file, rules or reference files changed, appeared or disappeared since the inspection. Select checks freshness again right before rendering the form. Each refusal says what to inspect again; nothing repairs a citation silently. The diagnosis is part of the prepared proposal, so its content hash covers it, and the form shows the explanation, delta and citations once beside the preview. The checks are structural: they do not prove the explanation is right.

Other project, profile, and executable remedies have their own target and check requirements. Stale answers, withdrawals, and compactions have separate checks. After the form is rendered, an unrelated change to inspected guidance does not by itself expire an approval. An already saved approval from before the skill diagnosis requirement keeps its contract. A skill repair without a diagnosis cannot reach a new form.

**New-skill search.** `action: "inspect"` with the proposed name in `skill` and the workflow's words in `terms` searches, case-insensitively, the names and descriptions of the skills directory, managed skills, enabled plugins, skills created this session and, when readable, the prompt's skill catalog. It fails when a skill of that name exists, or when one of the first four sources exists but cannot be read; a source that is not installed counts as searched and empty. The result lists each source's coverage and the matches. A new-skill proposal cites the search as its `diagnosis.inspection` and explains why each match does not fit, with no `citations`. Prepare and Select refuse it once a skill of that name exists or any searched source or skill file changed. A fitting match becomes an ordinary repair of that skill, with its own inspection.

## Observations

The main agent records an observation with the `observe` tool: one remark of up to 500 characters about something a skill, a rule or the project setup got wrong, or that cost it a detour. The tool is active as soon as the extension loads and never asks for approval. A subagent's call is refused. Text that is empty, has no letter or digit, or is over 500 characters is refused, and nothing is recorded.

Before calling `observe`, replace private values in `text` with placeholders. Never send the original private value. For example, record that an import rejected `[redacted email]` because the domain was invalid. Start an altered excerpt with `[redacted excerpt] ` and keep the non-sensitive facts. This is authoring guidance, not a filter. The extension does not rewrite earlier observations, proposal records, or OMP session history.

Observations and the proposal ledger share `<agent dir>/skill-observer/observer.sqlite`. An observation belongs to the real path of the repository's shared Git directory, so its worktrees share it. Outside a Git repository the working directory's real path is the project. Project-environment fixes keep their own scope, the working directory.

An observation is pending until a pass shows it or 30 days pass after it was last recorded. Recording the same text before then, ignoring case, punctuation and spacing, raises its count and refreshes its expiry. After a pass shows it, a new recording starts at count one. For 30 days the next pass labels that recording with the prior shown date. The label does not say the user reviewed it or a fix failed. A successful tool call gives the pending count. Only the user starts a pass.

`/observe` lists pending observations with their counts and last-recorded dates. They can start a pass on their own. After sending the payload, the extension marks the listed revisions as shown. A newer recording stays pending, including one made during payload assembly. If acknowledgement fails, the pass continues and shows an error. The agent checks each observation against the session and checkout before treating it as a finding. `/observe-report` only reads observations.

## Skill catalog observations

To diagnose a suspected missed trigger, the pass needs to know which skills the system prompt listed earlier, with their descriptions as rendered then. The skills installed now cannot show that.

**Capture.** For each prompt of a main session with UI, the extension reads the system prompt at the `before_agent_start` hook, without changing it, and parses its `<skills>` block in OMP's standard form or its bundled custom-prompt form. It stages the result and records it at `message_end`, once that prompt's user message is on the branch, so a preparation OMP discards or re-runs records nothing of its own. Subagents, including revived ones, are not captured.

**Storage.** Observations are non-model custom session entries. A `skill-observer-catalog` entry holds one distinct catalog once per session: its format, its coverage (`observed`, `partial`, `no-block` or `unsupported`), each skill's name and rendered description, and its limitations. A small `skill-observer-catalog-binding` entry marks where the branch observed it: the prompt's entry ID and the hook. An unchanged catalog records nothing; a changed one records a binding, plus a definition only when that catalog is new to the session. After a `/clear`, or after a capture failure, the next observation is bound again even when unchanged. The entries exist only in the session file and are deleted with it: there is no global catalog store, retention period or cleanup, and neither full prompts nor skill bodies are kept. OMP's own skill notices are already saved in the session and are not copied.

**Lookup.** `observer_review` `action: "catalog"` searches the active branch's observations by exact skill name in `skill`, or by `terms` that must all appear, case-insensitively and literally, in an observed description. A blank query is refused rather than listing the catalog. With `at`, the exact ID of an entry on the branch, it returns the latest observation at or before that entry, its real position and the known gaps in between; that observation was made at its own prompt, not at every request since. Without `at`, it returns every observation on the branch. Results are ordered by observation, then skill name, 20 to a page by default (`limit`); a page's `next` cursor continues the same query and is refused once the branch's catalog evidence changed. Each result also lists what OMP's later skill notices, compactions and `/clear` resets changed while still in context. Only bindings on the active branch count: a definition reachable from another branch resolves a binding here but is no evidence this branch observed it.

The payload carries only a short **catalog** section: how many observations the branch holds, what the latest listed, any known gaps, and how to look a skill up. A branch with catalog observations alone starts no pass.

**Limits.**

- An observation is the hook's view. A later `before_agent_start` handler or a provider hook may change the request, so it is never proof of what the model received.
- Unknown is not absence. A miss means only that no observation on this branch matched: coverage may be partial, a gap may hide the skill, an older session has no observations, and other wording would not match. A missing or malformed entry reads as unknown, never as another branch's state.
- A capture failure the extension sees is reported as a gap at the next lookup and pass. OMP's append API gives no persistence acknowledgement and the host can swallow a write error, so a lost entry is undetectable: after a restart it reads as unknown.
- Which notices stay in context follows OMP 18.20.3's context build: after a compaction, a notice stays in force only within the kept range; where the provider replays the kept turns from its own payload, or a context rollover keeps only the latest request, its state is unknown. Another OMP version may differ.

## Observation payload

The hidden starting message carries discovery instructions and the evidence needed to find improvements. It includes the session digest and a saved branch locator when available. It adds the User note, pending observations, catalog summary, Later entries, remedy outcomes, rules in force, and stale amendments where applicable. An ordinary completed reply, a workflow outline, or a tool error also adds optional retrospective guidance and project scope information.

The extension reads [`observer.md`](../observer.md) at each stage. An approved edit can affect the next pass. The starting message does not carry the whole procedure:

1. After discovery, the agent requests drafting guidance only if it has proposals or outcomes to record.
2. Prepare returns selection guidance for eligible proposals. Select returns the exact form and instructions for using it.
3. The native `ask` result carries publication or recording guidance for the choices made. The agent can request applicable guidance on restore, but the instructions do not recreate an expired approval.

If required instructions cannot be loaded, the affected stage stops and reports why. Tool results can carry specific guidance for an approval note, a changed target, or a recording or cleanup failure. [Rules in force](#rules-in-force) keep current facts in the starting message. The agent requests older supporting detail only when it matters to a finding.

The pass-start notice estimates the starting message by section. It divides each section's UTF-16 length by four and rounds up before summing. The estimate excludes separators between sections, context outside that message, later tool results, and subsequent turns. It is not a provider token count.

## Evidence report

`/observe-report` prints the current branch's evidence without starting a pass. Like `/observe`, it works in a main session with UI. It calls no model, activates no tool, writes nothing, and marks no observations shown.

1. **Signals** by kind, as distinct occurrences, and how many older signals the digest cap would drop from the pass;
2. **Skills loaded**, each with its provenance kind, load route (`read`, `slash-command`) and the on-read amendments delivered for it; skills a read requested that never loaded; managed skills created;
3. **Remedy outcomes**, one line per applied fix in force, with its fingerprint, status, and skill or target. The report lists every one, including those the payload only counts;
4. **Stale amendments**, by rule name and skill;
5. the **initial payload estimate**, if `/observe` would start now without a User note. It measures the hidden starting message only;
6. the number of **Later** proposals for this project;
7. the number of **pending observations** for this project, without their text. Reporting them marks none shown;
8. the **skill catalog observations** on the branch: their count, what the latest listed, and known gaps. They alone do not make the report non-empty.

The report omits tool arguments, error text, evidence file paths, session IDs, and observation text. A report with no starting payload, signals, loaded skills, stale amendments, remedy outcomes, or pending observations says `No skill evidence on this branch.` Catalog observations alone do not start a pass or make the report nonempty.

## Optional references

For ordinary completed work, a workflow outline, or a tool error, the pass points to the installed [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md) by Matt Pocock. The agent can read its candidate categories if useful. The extension does not inline the skill or run its standalone workflow. If the reference is unavailable, the pass continues with session evidence and the remedy categories it already has.

In the same cases, the pass can use [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md) by Lauren Tan as a reference when installed. With at least two distinct occurrences of the same mistake class, it can offer `/skill:correct` as a separate next action. Only you can invoke it. No observer answer authorizes that skill to run or commit.

## Remedy selection

Choose the least costly remedy that addresses the evidenced mechanism. Repair an existing broken or unwired check before adding another. Use a regression test when the application now behaves correctly but the old failure would still pass the suite. Fix missing information with navigation or documentation, and judgment problems with guidance. Prefer a configuration repair, rule, or amendment to new executable OMP code when it would solve the same problem.

Merge evidence for the same scoped mechanism. Prefer a direct fix to a duplicate reminder, but keep material alternatives visible. A tool's supplier label does not establish the cause of a failure. Inspect owner documentation or source only when the evidence points there.

## Project and profile targets

The current checkout is in scope by default. To add another checkout, put `Include project root: /absolute/canonical/root` on its own line in your current instruction or User note. To add a worktree of the current repository by branch name, use `Include worktree: <branch>`. A path in a transcript, tool result, or scout report is not permission to inspect or edit another repository. Scope does not grant filesystem access.

A project proposal can cover one mechanism affecting multiple files in one or more explicitly scoped checkouts. The form names every destination and shows the before and after text and the check for each file. One Apply covers that set. The agent checks each target's identity and before-state before publishing. If a destination changes, it reports what has already happened and asks again before publishing to revised scope.

For project files, use the normal owner tool for the reviewed write or removal, then run a meaningful foreground check in the target checkout. A deterministic check should exercise the observed mistake and a legitimate counterpart using temporary inputs. For a documentation change, a check that inspects the changed guidance or follows the new pointer can be enough. A generic success or status check is not evidence. The agent reports each destination separately, including untouched files, writes that could not be verified, and verified publications. One failure does not erase another destination's verified result. Apply does not roll back or repeat a write.

Ordinary profile edits stay in the active OMP agent directory. Supported targets include root guidance such as `AGENTS.md`, Markdown in the profile's guidance directories, existing hand-written rules, and the skill controls below. The preview shows the exact replacement, the profile-wide impact, and when OMP will load it:

- For guidance, the check identifies a decisive passage the edit introduces or removes.
- For an existing hand-written rule, the edit preserves user ownership. A pattern change needs a replay of the exact draft against the observed mistake and a legitimate counterpart.
- For a skill setting, `skills.manualSkills` keeps manual invocation available and `disabledExtensions: ["skill:<name>"]` disables the skill. The edit uses the active `config.yml` or `config.yaml` and preserves unrelated settings. Project settings can override profile arrays.

Prefer a suitable setting, an amendment, or a change to owned source over editing an installed skill. If none fits, use `/observe allow-installed-copy <skill>` to let the pass propose an edit to the exact inspected upstream or plugin skill file. This can be outside the active agent directory. The edit still needs a current-guidance inspection and Apply. An update can overwrite it.

## Report items

A report item is a finding in the pass summary that does not get an Apply question. The pass uses this route when no proposal fits, an owner tool or destination is unavailable or denied, or a necessary publication check cannot run safely. The item gives the owner, request and result, expected behavior and its source, what is known about the cause, a useful check, and a next action. Missing information stays unknown. A failed tool call alone is not a confirmed defect. Report items are not decisions and do not go in the proposal ledger.

An extension that accepts lead references can investigate a specific note or a pending observation shown in the pass. It handles its own review and makes any resulting changes. Observer's form and proposal ledger do not record those decisions. If the extension is unavailable or the finding remains unresolved, the pass keeps it as a report item.

## Checked OMP hooks and extension source

When a simpler remedy does not fit, the pass can propose a checked change to a project hook, a global hook, or owned OMP extension source. Project hooks are in `.omp/hooks/pre/` in the active project. Global hooks are in `hooks/pre/` under the active agent directory. Extension targets include owned packages in scoped checkouts and native extension directories in the active profile. The existing companion directory is also supported; a new companion needs a package manifest that declares its OMP entry files. Source outside scope, installed plugin copies, and dependency stores are not eligible extension targets.

The agent drafts in a private temporary directory outside the target. It uses ordinary permissions to run the supported foreground check before the form. The preview shows the exact files and changes, the command and observed result, the sessions affected, and when OMP will load the code. One **Apply** authorizes publication of that checked change. The agent reruns the reviewed command after writing the files. It cannot use an approval for an earlier intent or publish code that differs from what you reviewed. A note that changes the code requires a new checked preview and Apply.

The supported checks are:

- **Hooks.** The bundled [`check-hook.ts`](../scripts/check-hook.ts) replays the observed mistake and a legitimate counterpart against a stand-in host. It checks whether the hook blocks a call, adds context, or leaves an event untouched. A removal uses its `--absent` mode. These checks do not prove how the hook will behave in a running session.
- **Extensions.** The direct test commands are `bun --no-env-file test`, `node --test` (optionally `--test-reporter=tap` or `--test-reporter=spec`), `vitest run`, and `bun --no-env-file --bun x vitest run`. They must report passing tests. `npm test` or `npm run` and `bun run` with `check`, `test` or `typecheck` must name a supported recipe in the checked `package.json`, without matching lifecycle scripts. For a TypeScript-only change, `tsc --project tsconfig.json --noEmit --noCheck false --listFiles` must list each changed source. Use passing tests for declaration files, removals, and changes that typechecking does not cover. Prepare checks the exact scratch tree against the proposed result. A passing check does not prove the extension loads in OMP.

A successful check is not a sandbox. Hook and extension code runs with the runner's existing permissions. Apply does not load the code, restart OMP, commit, or deploy. The change takes effect when OMP next loads the code. If a faulty hook stops the agent from using its tools, remove or restore the reviewed hook file outside OMP, then restart OMP.

## Publication and recording

The pass distinguishes a proposed check from one it observed. It records a publication only after it validates the applicable approval, owner action, and verification. If a write succeeds but verification fails, the summary reports the write as unverified, not Applied. If a verified write cannot be recorded, the summary calls it an **Unrecorded publication** and names the affected target. If the ledger commit is uncertain, the summary says so. It does not repeat the write to obtain a new receipt.

## Rules in force

After the [proposal ledger](development.md#ledger), **Rules in force** lists what is already in force for each skill under **Skills loaded**, with no cap, so the pass neither proposes a duplicate nor misses a repeat. Skills not loaded in this session are left out. For each loaded skill, it lists every marked rule whose `amends` is that skill:

- an on-read amendment by name, body size in characters, the mark `over the compaction limit of 4000` when offered for compaction, `##` section headings and the absolute paths of its reference files;
- a pattern amendment or barrier rule by name, scope and how many times it fired as a rule violation in this session (a delivered on-read amendment is no firing).

Under each rule come the fixes in force whose `rule` names it. The starting message shows each fix's fingerprint, gist, decision, and date. It does not include all historical quotes. The agent can look up supporting evidence and receipts by exact skill name, rule name, or proposal fingerprint through `observer_review`'s `evidence` action, even for a skill that did not load on the current branch. The lookup does not change past decisions.

A fix is in force while its latest outcome is `applied`, `kept` or `updated` and its rule, when it has one, still exists. Removing a rule file some other way drops its fixes without a ledger write. A stale answer about a skill's on-read amendment, recorded under the amendment's own fingerprint, is no fix, and neither is a compaction. Fixes in force without a `rule` (edits to a local or managed skill) follow the skill's rules as edits to its own files.

Rules that fired in this session come first, most firings first; the rest follow by the summed `evidence` counts of their fixes (0 without evidence), then by their newest fix. Fixes under a rule follow the same evidence-then-newest order. A final list names every hand-written rule in the user rules directory, any `.md` file without the marker, by name and `description`, whether or not a loaded skill relates to it.

The pass checks whether an existing rule already covers a finding. If the evidence shows the same skill guidance failed again, it can consider a barrier rule. When a project check would catch the real mechanism, prefer repairing that check.

## Digest

The digest summarizes signals and loaded skills. It also notes whether the branch has primary work. It omits ambient notices and bookkeeping. The pass can inspect the original branch when the summary is not enough.

- **Corrections** carry the ~200 characters of assistant text just before them. Their own text is cut at 2,000 characters, so a pasted log can't fill the digest.
- **Tool errors** show the tool, a short argument summary and the error. A long error keeps its start and its end around `…`, within about 300 characters, since a failed command may state why at either end. They name the skills loaded earlier in the same turn, and end with the tool's [supplier label](#supplier-label). Errors inside an observation pass are left out, and its calls get no outline.
- **Workflow outlines** list one line per tool call (name, argument summary, ok/error), up to 50 calls, so one long turn can't crowd out every other signal. A subagent run shows only its `task` call (task names and agents) and the status its subagents ended with, taken from `wait` results and background-job deliveries.
- **Identical signals** are counted as one, with a `(×N)` count, placed where they last occurred. Each keeps the occurrence IDs it stands for; a tool error's ID nests under its turn's workflow outline (`<workflow>/<event>`), so ranking counts distinct occurrences, not descriptions.
- **Shell tool commands** appear as inner tool calls. The digest omits `bash` only when the trace and hook records show that it did no other work. Older `write xd://<tool>` dispatches count once, as the inner tool.
- A call saved both natively and by the extension's hooks counts once, at its first request and first outcome. Calls nested in `eval` appear through their hook records, and structured parallel calls through their `tool_uses`. Publication receipts use the original records, not the digest.
- **Remedy outcomes** for applied fixes report `delivered`, `exercised-clean` (the same command that failed before later succeeded after delivery, with a finished result), `recurrence` or `inconclusive`. In the payload, a project-environment fix's line names its target path after the fingerprint, as in `- <fingerprint> (<target path>): <status>`. A project-environment fix has no amendment to deliver, so it is never `delivered`: a tool result saved after its ledger record whose call matches a quoted `Tool error in …` mechanism of its evidence counts, as `recurrence` when it fails with the quoted error and `exercised-clean` when it succeeds; a result saved earlier, or without a timestamp, counts for neither. A cut error, one holding `…`, never counts as a recurrence, so a fix whose failure quote was cut shows what its other evidence gives: `delivered` for a delivered skill amendment, `exercised-clean` after a clean exercise, `inconclusive` for a project fix otherwise. A target file reverted after publication is not detected: the record's `afterHash` is not checked again.
  A quote starting with `[redacted excerpt] ` counts for neither exact exercise outcome. A separate unmarked quote can still establish an exact match, and a delivery receipt can still establish `delivered`.
- **Managed skills** created with `manage_skill` in the session are listed, so the pass doesn't propose them again.

The rendered digest is capped at about 12k tokens (estimated as 4 characters per token). Over the cap, the oldest signals are dropped first and the digest says how many. The signals left are numbered `S1`, `S2`, … from the oldest, so proposals can cite them; the ids hold only within one pass.

### Supplier label

When the extension copies a tool result at its tool-result hook, it also stores who supplied the tool. It looks the tool up by name in the host's list of all tools at that moment. A tool error in the digest ends with:

- `` Supplier: `<path>`. `` for a tool an extension registered, naming the extension's file, or the host's placeholder path for an SDK tool;
- `` Supplier: MCP server `<name>`. `` for an MCP tool;
- nothing for a built-in tool;
- `Supplier not recorded.` when the copied result has no supplier: results saved before this version, results the extension did not copy, and lookups that failed.

For a device dispatch (`write xd://<tool>`) the label is the inner tool's, found by call ID on the extension's copy of the result. A failed lookup stores nothing and never fails the hook.

The label names who supplied the tool, never who caused the failure. Another extension can block or change a call and its result. The pass weighs caller error, configuration, another extension's interception and unknown as causes besides the supplier. Commands and hook-only behaviour get no label: the pass reads their owner's documentation when the evidence points there, and "unknown" is a valid owner. The payload lists no installed extensions.
