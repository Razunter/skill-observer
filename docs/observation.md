# Observation

How `/observe` uses session evidence to review skills and project-environment fixes. For installation, see [Setup](setup.md). For rule storage and delivery, see [Amendments](amendments.md). For the extension overview, see the [README](../README.md).

## Hints

After each turn, the extension rebuilds the session digest from the current branch of the session. The status line shows `N skill correction(s) · /observe` once the branch has a correction-class skill signal, and `N workflow(s) without a skill · /observe` once it has a workflow outline and no correction. With neither, it shows `N pending observation(s) · /observe` while the project has [pending observations](#observations). Correction-class signals are:

- a steering message you typed while the agent was working;
- a rule violation: a TTSR rule firing on the agent's text or a tool call, whether it interrupts or is injected into a tool result. Every TTSR rule this extension writes is a barrier rule or pattern amendment, so each firing is a violation; on-read amendments never reach TTSR (see [Delivering on-read amendments](amendments.md#delivering-on-read-amendments));
- an `ask` answer with custom input (`Other: ...`), or one that differs from the option the form preselected (`checked`). Results saved before OMP 18.18 are still read in their old shape.

A workflow outline is a turn with no skill loaded and at least 3 tool calls. A cancelled `ask` and skill loads do not turn the hint on. Tool errors are not themselves correction-class signals, but a turn containing errors can still qualify as a workflow outline. Subagent sessions and sessions without UI get no hint.

## `/observe`

`/observe` rebuilds the session digest from the whole current branch, compacted history included. Besides the correction-class signals above, the digest lists every skill loaded in the session, whether the model read it (`skill://…` or a `SKILL.md` path) or you started it with `/skill:`. Each skill is labelled by provenance:

- **local**: in `~/.agents/skills/` with no entry in `~/.agents/.skill-lock.json`;
- **upstream**: tracked in that lock, with its `skillFolderHash`;
- **managed**: in OMP's `managed-skills/` directory;
- **plugin**: installed by an OMP marketplace plugin, such as the `ce-*` and `impeccable` skills. Its `SKILL.md` lies under an enabled plugin's install path in OMP's user-scope registry, `~/.omp/plugins/installed_plugins.json`. Its provenance metadata carries that plugin's id and version. The rendered digest line shows the provenance kind, load route, delivered amendments and file path, not the plugin id or version. A name provided by both a plugin and `~/.agents/skills/` resolves to the plugin skill, which OMP loads. A read by path resolves to the file read;
- **unknown**: anywhere else (project skills, project-scoped plugins).

A `SKILL.md` read from anywhere else counts as an installed skill when it holds the same bytes as that skill's entry file. The installed skill is the one named by the copy's frontmatter `name`, or by its folder when it has none. The digest lists the copy under that skill and its provenance, and the skill's on-read amendment is delivered on the read. Only the entry file is compared. A copy that differs from the installed skill stays unknown.

A skill's line also names its on-read amendments delivered in this session, as in `` `tdd`: upstream; read by the model; amendments delivered: `tdd-amendment` ``. These come from the session's `skill-observer-amendment-delivery` entries after skill reads and from `/skill:` reminders. Both name their rules, so an amendment deleted later in the session still shows as delivered. Deliveries add no signal: a skill read alone never turns the hint on. They let the pass see that a correction on the same point happened despite the amendment.

Text after the command, as in `/observe tdd should run the one failing test first`, goes into the pass as a **User note** ahead of the digest: feedback the digest can't show, or a steer such as a skill to focus on. The model weighs each change it names like a correction-class signal. A note starts a pass even in a session without signals.

With no note, no signals, no loaded skills, no stale amendments and no pending observations, `/observe` says so and starts no turn. Otherwise it sends one hidden message, the [observation payload](#observation-payload), that starts a normal turn.

The model asks about at most 5 proposals, stale amendments it would update or delete, and compactions in one main `ask`. The extension renders that Ask as one form, which `observer_review` Select returns and the model passes on unchanged: one fieldset per proposal with its target and gist, remedy, evidence and preview, and the choices Apply / Later / Decline, or Keep / Update / Delete for a stale amendment. Nothing is preselected. Stale amendments come first, then User note points, then correction-class signals and repeats, then compactions. Each proposal fixes one mechanism; a candidate bundling two independent fixes becomes two questions.

An option can carry a note, which you add with `n` on its row. A note on **Apply** is an approval note: it approves the proposal as the model revises it by that note. The revision is written without a second question, and `observer_resolve`'s result shows the note, the model's reason for the revision and the text written. When the note only asks for a check, or only acknowledges, the model writes the approved text unchanged and gives what it checked as its reason; when the check shows the change should not be written, the model defers the proposal as Later with your note as its re-offer condition. A note on **Later** becomes that deferral's re-offer condition, in your words, even when the model sends none. A note on **Decline** is not recorded. A note on a stale amendment's **Update** or **Delete**, a withdrawal or a compaction approves nothing: the pass prepares the changed proposal and asks again, and the form says so on those questions. A note on **Apply** that asks for something unrelated to its proposal defers that proposal as Later and becomes a question of its own; on **Later** or **Decline** the answer stands, and a request in the note for another change becomes a question of its own. Custom input (`Other: ...`) still approves nothing. See [Proposal approval](development.md#proposal-approval).

Each question shows its evidence: digest signal ids with their `(×N)` counts and a short exact quote, or `User note`, a Later entry's fingerprint or a stale amendment's rule. A barrier rule is asked about only after its pattern passes the replay check (see [Replay](amendments.md#replay)). Its preview shows the rule, scope and samples. The form shows a preview as wrapped text and marks indentation, repeated and trailing spaces `·` and tabs `→`; what is written is the prepared text.

The model applies approved edits to local skills directly and to managed or new skills through `manage_skill`. It then records every answer with `observer_resolve`, which also writes every rule: amendment rules for upstream skills and barrier rules for local and managed ones. `observer_resolve` and `observer_check` join the model's tools at the session's first `/observe`. [`observer.md`](../observer.md) is read on every run, so it is a local proposal target too.

If an answer in the main batch retracts an applied fix, the pass prepares and selects its withdrawal, then asks about it in a separate follow-up `ask` in the same pass. **Decline** on a withdrawal keeps the fix: `observer_resolve` records nothing for it and says the fix stays in force. An answer cites its proposal by the reference of the pass's latest Prepare holding it; an older reference is refused with the latest one named. See [Proposal approval](development.md#proposal-approval) and [Ledger](development.md#ledger) for the approval and recording rules.

## Observations

The main agent records an observation with the `observe` tool: one remark of up to 500 characters about something a skill, a rule or the project setup got wrong, or that cost it a detour. The tool is active as soon as the extension loads and never asks for approval. A subagent's call is refused. Text that is empty, has no letter or digit, or is over 500 characters is refused, and nothing is recorded.

Observations are stored in `<agent dir>/skill-observer/observations.jsonl`, one file shared by every project. Each belongs to the repository it was recorded in, identified by the real path of the repository's shared git directory, so all worktrees of a repository share them. Outside a git repository the working directory's real path is the project. Project-environment fixes keep their own scope, the working directory.

An observation is pending until a pass shows it, or until 30 days after it was last recorded. Recording the same text again, ignoring case, punctuation and spacing, raises its count and restarts its 30 days; recording a text already shown or expired starts again at count 1. A successful call tells the agent how many observations are pending and that `/observe` reviews them; the agent may mention the command, but only the user starts a pass.

`/observe` lists the project's pending observations in the payload's **observations** section and starts a pass even when they are its only evidence. Right after sending the payload it marks the listed ones shown, so the next pass does not list them, even when this one is interrupted. If marking fails, an error notice says so and the pass continues. An observation recorded during a pass, or recorded again while `/observe` assembled the payload, waits for the next one. The pass checks each observation against the session and the checkout, turns it into a proposal when a proposal kind fits, and otherwise reports it as a [report item](#report-items). Pending observations do not turn on the `project` gate.

## Observation payload

The message that starts a pass holds these sections, in this order, leaving out any without text:

- **instructions**: the parts of [`observer.md`](../observer.md) the session's evidence can reach, then the path of `observer.md` and the skills, managed-skills, user rules, on-read amendments and reference files directories, then the project hooks, global hooks and companion extension directories (see [Observer hooks and the companion extension](#observer-hooks-and-the-companion-extension));
- **note**: the User note;
- **digest**: the [session digest](#digest);
- **observations**: the project's [pending observations](#observations), one line each with its count and the date it was last recorded;
- **ledger**: the proposal ledger's Later entries, each with its re-offer condition (`Re-offer when: …`) when its record has one;
- **outcomes**: the remedy outcomes of applied fixes. Only project-environment fixes and fixes for a skill the digest loaded are listed. One closing line counts the rest, whose skills were not loaded in this session;
- **rules-in-force**: the [rules in force](#rules-in-force);
- **project**: Project scope and the Recurring mistake workflow, under the `project` gate;
- **retro**: the Retrospective reference, under the `project` gate;
- **stale**: the stale amendments, when there are any.

`observer.md` is parsed on every run, so an approved edit applies to the next pass. Gate markers, `<!-- when: <gate> -->` and `<!-- end -->` on their own lines, wrap paragraphs and list items only some passes need. The rest is always on. `/observe` decides each gate from evidence it already has; no instruction asks the model to read more of them on demand:

| Gate | On when | Covers |
|---|---|---|
| `stale` | an amendment is stale | finding, drafting, asking about and recording stale amendments |
| `compaction` | a loaded upstream or plugin skill has an on-read amendment | compaction candidates, drafts, questions and records |
| `project` | the digest has a workflow outline or a tool error | the retrospective branch, project remedies, project files and project outcomes; the project and retro sections |
| `withdrawal` | a fix is in force for a loaded skill, or there is a User note | withdrawal candidates and questions, and retracted fixes |
| `ranking` | the host has an explicit, available `judge` role assignment | advisory ranking and Select's `rankings`; without it the pass calls Select without rankings |
| `note` | there is a User note | how to weigh the User note |
| `observations` | the project has a pending observation | checking observations; those no proposal kind fits become report items |
| `tool-result` | never in the payload | what to do after a changed target, a failed ledger append or a failed cleanup, with custom input and with an approval note; see below |

Under the `project` gate, the Retrospective reference includes the installed `retro` skill's text inline, without its frontmatter. A preceding line says which parts apply: its candidate categories do; its own steps and Files section describe a standalone retrospective and do not. Without `retro`, the section says the reference is unavailable and the UI warns. Without the gate, neither the section nor the warning appears.

The `tool-result` paragraphs reach the model in the tool result that reports their condition, under a closing `## What to do now` heading. An `observer_resolve` result carries one paragraph per reported condition, regardless of how many answers hit it: an answer not recorded because its rule, amendment or reference files changed since Prepare or the reconciliation, a failed ledger append, or a failed cleanup.

During a pass, an `ask` result carries the custom-input paragraph when an answer starts with `Other: `, the form's free-text row, and the approval-note paragraph when a chosen option has a note that is not blank. Any other result carries none. When `observer.md` cannot supply a paragraph, the result keeps everything it reports and ends with a one-line note naming the error instead.

A malformed gate marker in `observer.md` stops `/observe` with an error notice; no pass starts. CRLF line ends parse the same as LF.

The pass-start notice estimates the payload's size by section, as in `Observation pass started: 1 signal(s), 1 loaded skill(s), 0 stale amendment(s); payload ≈ 5848 tokens (instructions 5702, digest 110, ledger 9, rules-in-force 27; chars/4 estimate).` Each section counts ⌈characters / 4⌉, so the figure is an estimate, not the model's token count. Only the sections the message holds are listed.

## Evidence report

`/observe-report` prints a model-free evidence report of the current branch in one notice: what `/observe` would work from, without starting a pass. It has the same gate as `/observe` (a main session with UI; elsewhere it prints nothing). It rebuilds everything from the current branch on each run, so a session switch or branch change shows in the next report. It calls no model, activates no tool and writes nothing. In order, it shows:

1. **Signals** by kind, as distinct occurrences, and how many older signals the digest cap would drop from the pass;
2. **Skills loaded**, each with its provenance kind, load route (`read`, `slash-command`) and the on-read amendments delivered for it; skills a read requested that never loaded; managed skills created;
3. **Remedy outcomes**, one line per applied fix in force for this project, as `fingerprint: status (skill or project target path)`, delivered first, then exercised-clean, recurrence and inconclusive. The report lists every one, including those the payload only counts;
4. **Stale amendments**, by rule name and skill;
5. the **payload estimate** of the pass `/observe` would start now, from the same assembly and gates (without a User note);
6. the number of **Later** proposals for this project;
7. the number of **pending observations** for this project, without their text. Reporting them marks none shown.

The report names tools, signal kinds, skills, rule names and project target paths only: no tool arguments, error text, evidence file paths, session IDs or observation text. A branch with no signals, loaded skills, stale amendments, applied fixes or pending observations reports `No skill evidence on this branch.` and no estimate.

## Optional references

The extension can use separately installed remote skills. The same pass reviews session-backed project-environment findings, even when a skill was loaded. When the digest has a workflow outline or a tool error, the pass carries the installed [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), from Matt Pocock's skills, inline as its retrospective reference rather than launching a separate retrospective (see [Observation payload](#observation-payload)). If that reference is unavailable then, the UI warns and ordinary observation remains usable. Quiet lifecycle events still only refresh the hint; they initiate no retrospective scan or model call.

When [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md), from Lauren Tan's pstack, is installed, a pass whose digest has a workflow outline or a tool error names it as reference. With at least two distinct occurrences of the same agent mistake class, the pass may offer `/skill:correct` as a separate next action citing their occurrence IDs. This skill favors architecture changes, types and enforceable checks, then tests, with docs last. Only the user may invoke it. Apply/Later/Decline grant no remediation or commit. Without `correct`, the pass says so and offers nothing.

## Remedy selection

Remedy selection starts with the relevant existing project checks and their wiring: repair an unwired or broken check before proposing another one. Mechanical mistakes favor deterministic checks, missing information favors navigation/reference fixes, and judgment problems favor review guidance. Project-specific repairs stay under the canonical OMP working directory; reusable global skill guidance still needs to generalize. An outside path named in a note does not broaden project scope or grant access.

Findings about the same scoped mechanism merge their observer, retrospective and note evidence into one review question; a direct project repair takes precedence over a duplicate skill reminder for the same failure. Missing primary session evidence is disclosed rather than reconstructed as fact. The main review batch retains the five-question cap and Apply/Later/Decline choices. A retraction in an answer can require the separate withdrawal follow-up described in [`/observe`](#observe).

For an approved project check repair, the model publishes the exact reviewed diff with normal tools and exercises the known mistake plus a legitimate counterpart using temporary inputs. Expected rejection is asserted by a successful verification command; temporary inputs are restored. Only then can actual write/check tool-call IDs and the current target SHA-256 support an applied project record. A failed or unknown write/check remains deferred and is reported truthfully.

## Remedy ladder

The pass ranks remedies by cost, cheapest first, not by who owns the failing component:

1. A configuration or wiring repair, a text or skill edit, an amendment, a barrier rule, a pattern amendment or a project check: the remedies above and in [Amendments](amendments.md).
2. An [observer hook](#observer-hooks-and-the-companion-extension): one hook file in the project's hooks directory or in your global hooks directory.
3. The [companion extension](#observer-hooks-and-the-companion-extension): the one user-level extension the pass may edit, for a remedy that needs a registered tool, several modules or a dependency.

Rungs 2 and 3 are last resorts. When the needed capability exists but is off or misconfigured, the pass proposes the configuration repair. A tool that rightly rejected a misuse stays unchanged; the misuse gets the cheapest fitting remedy on the agent's side. The pass reads an owner's documentation or source only for components the evidence touches.

## Report items

A report item is a finding the pass tells you about in its summary instead of asking about it. Three kinds of finding become report items:

- an evidenced finding no proposal kind fits, a checked observation included;
- a capability no rung can provide. The item names the event or tool it would need, who would own its state, the benefit and the risks;
- a fix in the behavioural code of any extension other than the companion extension, wherever that code lives, even under the project root. Configuration and check wiring of such an extension stay ordinary proposals.

Each item gives the supplier or owner, what was requested and what resulted, the expected behaviour with its source or "undocumented", the cause status (confirmed, suspected or unknown), a scenario that would show the fix with its legitimate counterpart, and a next action. A part the evidence does not settle reads "unknown". A failed tool call is not presented as a confirmed extension defect.

Report items are not asked about, not stored in the ledger and not offered again. You act on the summary. The rule against editing another extension's code is an instruction, not a check: Prepare cannot tell extension code from other project files by path.

## Observer hooks and the companion extension

An **observer hook** is a hook file a pass wrote after your approval. The **companion extension** is the one user-level extension a pass may edit. Both live in fixed directories, which the payload's directory line names:

| Target | Directory |
|---|---|
| Project hook | `<project>/.omp/hooks/pre/` |
| Global hook | `<agent dir>/hooks/pre/` |
| Companion extension | `<agent dir>/extensions/skill-observer-companion/` |

`<project>` is the real path of OMP's working directory. `<agent dir>` is `~/.omp/agent` unless `PI_CODING_AGENT_DIR` or a profile names another. OMP discovers hooks only in a `pre` or `post` subfolder, and observer hooks go in `pre`.

A hook is one self-contained file. It may register event handlers and commands and keep state. A project hook fixes a mistake specific to this project. A global hook must generalise the way global skill guidance must. A new hook's file is named `skill-observer-<fingerprint>.ts`, so a project hook and a global hook never share a name. OMP loads only the first hook file of a given name. A pass may also change or remove any hook file in the two hooks directories, ones you wrote by hand included.

The companion extension is for a remedy that needs a registered tool, several modules or a dependency, or that rewrites a call or its result. The first approved change creates it. Its `package.json` declares its entry files under `omp.extensions`, because OMP loads nothing else in that directory. Every change keeps a test file there, and `bun test` in the directory is its check.

### Two approvals

A new or changed hook and every companion change take two approvals:

1. **Intent.** The form shows the target, the event, the predicate, the action, the mistake sample, the legitimate sample, the scope, and why each cheaper remedy does not fit. It is one question of the main batch. Apply authorises drafting only.
2. **Code.** A subagent drafts the code and a samples file in a temporary directory, never in the target, and runs the check. Without a subagent tool, the main agent drafts the same way. The form shows each file's exact text, the check command and its unedited output. This question gets its own Select and Ask, apart from every other question.

Nothing is written before the code Apply. An Apply with a note, at either stage, approves nothing: the main agent revises the description or the code by your note, reruns the check for code, and asks again. Only your latest answer at a stage counts: a later Prepare or Ask of the same proposal supersedes an earlier Apply. A hook's check command names the hook by its path in the hooks directory, so the command the form shows is the one rerun on the written file. After the code Apply, the main agent writes each file with the `write` tool and reruns that command in the foreground, with the target's directory as working directory. `observer_resolve` records the change as applied only when the session holds those write calls after your Apply, runs of the approved command after them, and each file holds its approved text. It never writes these files itself.

The ledger gets one record per hook or companion identity, at the end of the pass. It is `applied` when the code was approved and published, `declined` when either stage was declined, and `later` when either stage was answered Later, drafting or its check failed, or the code was never asked. A Later comes back as an intent question, and its re-offer condition says a draft existed. A record holds no file text, description or draft. A project hook's records show only in its project; global hook and companion records show in every project. Remedy outcomes count exercises after a record's timestamp, as for a project fix.

A project proposal whose file lies in either hooks directory or the companion directory, followed through symlinks, is refused, so no hook or companion file is written with one approval.

### Removal

Removing a hook takes one approval. The form shows the file as it stands, with Apply and Decline. On Apply the agent deletes the file with its own tools. `observer_resolve` records the removal only once the file is gone and its path still resolves to the same file inside the hooks directory. When the ledger holds an applied record of the hook, the removal is recorded as its withdrawal. The companion extension is not removed this way.

### The check

[`scripts/check-hook.ts`](../scripts/check-hook.ts) ships in the package:

```sh
bun --no-env-file scripts/check-hook.ts <hook-file> <samples-file>
```

It loads the hook's default-exported factory against a stand-in host with no UI, feeds the samples' events in file order and prints one `PASS` or `FAIL` line per sample, then a verdict. It exits 0 only when every sample got its expected outcome: `blocked`, `context` (added context only) or `untouched`. A hook that changes a call or its result fails the check, so a hook's action is to block or add context. The samples file is a JSON array that holds at least one `mistake` sample and one `legitimate` sample. A hook that keeps state gets the sequence its state needs; a `tool_call` sample and its `tool_result` share a call ID through `toolCallId`. Run the script without arguments for the full sample format.

The check shows that the hook's predicate separates the samples. It does not show that the hook loads and behaves in a real session.

### Activation

A written, changed or deleted hook or companion file takes effect only after you restart omp. A new session in the same process keeps the hooks and extensions it started with. The code and removal forms say so.

### Risks and manual removal

Hook and companion code runs inside the omp process, with your permissions, without a sandbox, permission model or automatic disable. A `tool_call` handler that throws or times out blocks the call. A faulty observer hook can therefore block the tools a pass needs to remove it. If that happens, delete the file by hand and restart omp:

- a project hook: `<project>/.omp/hooks/pre/skill-observer-<fingerprint>.ts`;
- a global hook: `<agent dir>/hooks/pre/skill-observer-<fingerprint>.ts`;
- the companion extension: move or delete `<agent dir>/extensions/skill-observer-companion/`.

A hand-written hook keeps its own file name. The intent and removal forms show its full path.

## Rules in force

After the [proposal ledger](development.md#ledger), **Rules in force** lists what is already in force for each skill under **Skills loaded**, with no cap, so the pass neither proposes a duplicate nor misses a repeat. Skills not loaded in this session are left out. For each loaded skill, it lists every marked rule whose `amends` is that skill:

- an on-read amendment by name, body size in characters, the mark `over the compaction limit of 4000` when offered for compaction, `##` section headings and the absolute paths of its reference files;
- a pattern amendment or barrier rule by name, scope and how many times it fired as a rule violation in this session (a delivered on-read amendment is no firing).

Under each rule come the fixes in force whose `rule` names it, each with its fingerprint, gist, outcome and date, and quotes. Fixes are not tied to sections: the amendment is delivered as a whole, and its headings help spot duplicates.

A fix is in force while its latest outcome is `applied`, `kept` or `updated` and its rule, when it has one, still exists. Removing a rule file some other way drops its fixes without a ledger write. A stale answer about a skill's on-read amendment, recorded under the amendment's own fingerprint, is no fix, and neither is a compaction. Fixes in force without a `rule` (edits to a local or managed skill) follow the skill's rules as edits to its own files.

Rules that fired in this session come first, most firings first; the rest follow by the summed `evidence` counts of their fixes (0 without evidence), then by their newest fix. Fixes under a rule follow the same evidence-then-newest order. A final list names every hand-written rule in the user rules directory, any `.md` file without the marker, by name and `description`, whether or not a loaded skill relates to it.

The pass dismisses a candidate that a listed rule already covers. A signal repeating a listed fix is a second failure, and the pass proposes a barrier rule for it.

## Digest

The digest keeps signals and drops everything else: harness messages (wiki recall, status notices, advisor, reminders and nudges, background-job and IRC deliveries, file mentions, `developer` messages), bookkeeping entries and thinking blocks.

- **Corrections** carry the ~200 characters of assistant text just before them. Their own text is cut at 2,000 characters, so a pasted log can't fill the digest.
- **Tool errors** show the tool, a short argument summary and the error. A long error keeps its start and its end around `…`, within about 300 characters, since a failed command may state why at either end. They name the skills loaded earlier in the same turn, and end with the tool's [supplier label](#supplier-label). Errors inside an observation pass are left out, and its calls get no outline.
- **Workflow outlines** list one line per tool call (name, argument summary, ok/error), up to 50 calls, so one long turn can't crowd out every other signal. A subagent run shows only its `task` call (task names and agents) and the status its subagents ended with, taken from `wait` results and background-job deliveries.
- **Identical signals** are counted as one, with a `(×N)` count, placed where they last occurred. Each keeps the occurrence IDs it stands for; a tool error's ID nests under its turn's workflow outline (`<workflow>/<event>`), so ranking counts distinct occurrences, not descriptions.
- **Device dispatch** (`write xd://<tool>`) is recorded once, as the inner tool. A call saved both natively and by the extension's hooks also counts once, at its first request and first outcome; calls nested in `eval` appear only through their hook records, and structured parallel calls through their `tool_uses`. This view is deliberately lossy: publication receipts never rely on it.
- **Remedy outcomes** for applied fixes report `delivered`, `exercised-clean` (the same command that failed before later succeeded after delivery, with a finished result), `recurrence` or `inconclusive`. In the payload, a project-environment fix's line names its target path after the fingerprint, as in `- <fingerprint> (<target path>): <status>`. A project-environment fix has no amendment to deliver, so it is never `delivered`: a tool result saved after its ledger record whose call matches a quoted `Tool error in …` mechanism of its evidence counts, as `recurrence` when it fails with the quoted error and `exercised-clean` when it succeeds; a result saved earlier, or without a timestamp, counts for neither. A cut error, one holding `…`, never counts as a recurrence, so a fix whose failure quote was cut shows what its other evidence gives: `delivered` for a delivered skill amendment, `exercised-clean` after a clean exercise, `inconclusive` for a project fix otherwise. A target file reverted after publication is not detected: the record's `afterHash` is not checked again.
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
