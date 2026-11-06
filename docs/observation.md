# Observation

How `/observe` uses session evidence to review skills and project-environment fixes. For installation, see [Setup](setup.md). For rule storage and delivery, see [Amendments](amendments.md). For the extension overview, see the [README](../README.md).

## Hints

After each turn, the extension rebuilds the session digest from the current branch of the session. The status line shows `N skill correction(s) · /observe` once the branch has a correction-class skill signal, and `N workflow(s) without a skill · /observe` once it has a workflow outline and no correction. Correction-class signals are:

- a steering message you typed while the agent was working;
- a rule violation: a TTSR rule firing on the agent's text or a tool call, whether it interrupts or is injected into a tool result. Every TTSR rule this extension writes is a barrier rule or pattern amendment, so each firing is a violation; on-read amendments never reach TTSR (see [Delivering on-read amendments](amendments.md#delivering-on-read-amendments));
- an `ask` answer with custom input, or with a selection other than the recommended option (the `recommended` index, or an option labelled "(Recommended)").

A workflow outline is a turn with no skill loaded and at least 3 tool calls. A cancelled `ask` and skill loads do not turn the hint on. Tool errors are not themselves correction-class signals, but a turn containing errors can still qualify as a workflow outline. Subagent sessions and sessions without UI get no hint.

## `/observe`

`/observe` rebuilds the session digest from the whole current branch, compacted history included. Besides the correction-class signals above, the digest lists every skill loaded in the session, whether the model read it (`skill://…` or a `SKILL.md` path) or you started it with `/skill:`. Each skill is labelled by provenance:

- **local**: in `~/.agents/skills/` with no entry in `~/.agents/.skill-lock.json`;
- **upstream**: tracked in that lock, with its `skillFolderHash`;
- **managed**: in OMP's `managed-skills/` directory;
- **plugin**: installed by an OMP marketplace plugin, such as the `ce-*` and `impeccable` skills: its `SKILL.md` lies under the install path of an enabled plugin in OMP's user-scope registry, `~/.omp/plugins/installed_plugins.json`, and its provenance metadata carries that plugin's id and version. The rendered digest line shows the provenance kind, load route, delivered amendments and file path, not the plugin id or version. A skill name that both a plugin and `~/.agents/skills/` provide resolves to the plugin skill, which OMP loads; a read by path resolves to the file read;
- **unknown**: anywhere else (project skills, project-scoped plugins).

A skill's line also names the on-read amendments delivered for it in this session, as in `` `tdd`: upstream; read by the model; amendments delivered: `tdd-amendment` ``: those delivered after a read of the skill, from the session's `skill-observer-amendment-delivery` entries, and those the `/skill:` reminder carried. Both name their rules themselves, so an amendment deleted later in the session still shows as delivered. They add no signal, so a skill read alone never turns the hint on, but they let the pass see that a correction on the same point happened despite the amendment.

Text after the command, as in `/observe tdd should run the one failing test first`, goes into the pass as a **User note** ahead of the digest: feedback the digest can't show, or a steer such as a skill to focus on. The model weighs each change it names like a correction-class signal. A note starts a pass even in a session without signals.

With no note, no signals, no loaded skills and no stale amendments, `/observe` says so and starts no turn. Otherwise it sends one hidden message, the [observation payload](#observation-payload), that starts a normal turn. The model asks about at most 5 proposals, stale amendments it would update or delete, and compactions in one main `ask` batch (Apply / Later / Decline, or Keep / Update / Delete, with a preview), ranked stale amendments first, then User note points, then correction-class signals and repeats, then compactions. Each proposal fixes one mechanism, so a candidate that bundles two independent fixes is asked as two. Each proposal's question cites its evidence: the ids of the digest signals it rests on with their `(×N)` counts and a short exact quote, or `User note`, a Later entry's fingerprint or a stale amendment's rule. A barrier rule is asked about only once its pattern has passed the replay check (see [Replay](amendments.md#replay)), and its preview shows the rule, its scope and its samples. The model applies approved edits to local skills directly and to managed or new skills through `manage_skill`, then records every answer with `observer_resolve`, which also writes every rule: amendment rules for upstream skills and barrier rules for local and managed ones. `observer_resolve` and `observer_check` join the model's tools at the session's first `/observe`. [`observer.md`](../observer.md) is read on every run, so it is a local proposal target too. If an answer in the main batch retracts an applied fix, the pass prepares and selects its withdrawal, then asks about it in a separate follow-up `ask` in the same pass. See [Proposal approval](development.md#proposal-approval) and [Ledger](development.md#ledger) for the approval and recording rules.

## Observation payload

The message that starts a pass holds these sections, in this order, leaving out any without text:

- **instructions**: the parts of [`observer.md`](../observer.md) the session's evidence can reach, then the path of `observer.md` and the skills, managed-skills, user rules, on-read amendments and reference files directories;
- **note**: the User note;
- **digest**: the [session digest](#digest);
- **ledger**: the proposal ledger's Later entries;
- **outcomes**: the remedy outcomes of applied fixes;
- **rules-in-force**: the [rules in force](#rules-in-force);
- **project**: Project scope and the Recurring mistake workflow, under the `project` gate;
- **retro**: the Retrospective reference, under the `project` gate;
- **stale**: the stale amendments, when there are any.

`observer.md` is parsed on every run, so an approved edit to it applies to the next pass. Gate markers in it, `<!-- when: <gate> -->` and `<!-- end -->` on their own lines, wrap the paragraphs and list items only some passes need; the rest is always on. `/observe` decides each gate from evidence it already has, and no instruction asks the model to read more of them on demand:

| Gate | On when | Covers |
|---|---|---|
| `stale` | an amendment is stale | finding, drafting, asking about and recording stale amendments |
| `compaction` | a loaded upstream or plugin skill has an on-read amendment | compaction candidates, drafts, questions and records |
| `project` | the digest has a workflow outline or a tool error | the retrospective branch, project remedies, project files and project outcomes; the project and retro sections |
| `withdrawal` | a fix is in force for a loaded skill, or there is a User note | withdrawal candidates and questions, and retracted fixes |
| `ranking` | the host has an explicit, available `judge` role assignment | advisory ranking and Select's `rankings`; without it the pass calls Select without rankings |
| `note` | there is a User note | how to weigh the User note |
| `tool-result` | never in the payload | what to do after a changed target, a failed ledger append or a failed cleanup, and with a note on Apply; see below |

Under the `project` gate the Retrospective reference holds the installed `retro` skill's text inline, without its frontmatter, after one line saying which parts apply: its candidate categories do; its own steps and Files section describe a standalone retrospective and do not. Without `retro` the section says the reference is unavailable and the UI warns. Without the gate neither the section nor the warning appears.

The `tool-result` paragraphs reach the model in the tool result that reports their condition, under a closing `## What to do now` heading. An `observer_resolve` result carries the paragraph for each condition it reports, once however many answers hit it: an answer not recorded because its rule, amendment or reference files changed since Prepare or the reconciliation, a failed ledger append, a failed cleanup. During a pass, an `ask` result in which the user selected **Apply** and added a note or custom input carries the note paragraph. A clean result, and a plain Apply, carry none.

A malformed gate marker in `observer.md` stops `/observe` with an error notice; no pass starts.

The pass-start notice estimates the payload's size by section, as in `Observation pass started: 1 signal(s), 1 loaded skill(s), 0 stale amendment(s); payload ≈ 5848 tokens (instructions 5702, digest 110, ledger 9, rules-in-force 27; chars/4 estimate).` Each section counts ⌈characters / 4⌉, so the figure is an estimate, not the model's token count. Only the sections the message holds are listed.

## Optional references

The extension can use separately installed remote skills. The same pass reviews session-backed project-environment findings, even when a skill was loaded. When the digest has a workflow outline or a tool error, the pass carries the installed [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), from Matt Pocock's skills, inline as its retrospective reference rather than launching a separate retrospective (see [Observation payload](#observation-payload)). If that reference is unavailable then, the UI warns and ordinary observation remains usable. Quiet lifecycle events still only refresh the hint; they initiate no retrospective scan or model call.

When [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md), from Lauren Tan's pstack, is installed, a pass whose digest has a workflow outline or a tool error names it as reference and, for at least two distinct occurrences of the same agent mistake class, may offer `/skill:correct` as a separate next action citing their occurrence IDs. This skill favors architecture changes, types and enforceable checks, then tests, with docs last. Only the user may invoke it. Apply/Later/Decline grant no remediation or commit. Without `correct`, the pass says so and offers nothing.

## Remedy selection

Remedy selection starts with the relevant existing project checks and their wiring: repair an unwired or broken check before proposing another one. Mechanical mistakes favor deterministic checks, missing information favors navigation/reference fixes, and judgment problems favor review guidance. Project-specific repairs stay under the canonical OMP working directory; reusable global skill guidance still needs to generalize. An outside path named in a note does not broaden project scope or grant access.

Findings about the same scoped mechanism merge their observer, retrospective and note evidence into one review question; a direct project repair takes precedence over a duplicate skill reminder for the same failure. Missing primary session evidence is disclosed rather than reconstructed as fact. The main review batch retains the five-question cap and Apply/Later/Decline choices. A retraction in an answer can require the separate withdrawal follow-up described in [`/observe`](#observe).

For an approved project check repair, the model publishes the exact reviewed diff with normal tools and exercises the known mistake plus a legitimate counterpart using temporary inputs. Expected rejection is asserted by a successful verification command; temporary inputs are restored. Only then can actual write/check tool-call IDs and the current target SHA-256 support an applied project record. A failed or unknown write/check remains deferred and is reported truthfully.

## Rules in force

After the [proposal ledger](development.md#ledger), **Rules in force** lists what is already in force for each skill under **Skills loaded**, with no cap, so the pass neither proposes a duplicate nor misses a repeat. Skills not loaded in this session are left out. Under each loaded skill it lists every marked rule whose `amends` is that skill: an on-read amendment by name, body size in characters, the mark `over the compaction limit of 4000` when it is offered for compaction, `##` section headings and the absolute paths of its reference files; a pattern amendment or barrier rule by name, scope and how many times it fired as a rule violation in this session (a delivered on-read amendment is no firing). Under each rule come the fixes in force whose `rule` names it, each with its fingerprint, gist, outcome and date, and quotes. Fixes are not tied to sections: the amendment is delivered as a whole, and its headings are there for spotting duplicates. A fix is in force while its latest outcome is `applied`, `kept` or `updated` and its rule, when it has one, still exists: a rule file removed some other way drops its fixes without a write to the ledger. A stale answer about a skill's on-read amendment, recorded under the amendment's own fingerprint, is no fix, and neither is a compaction. Fixes in force without a `rule` (edits to a local or managed skill) follow the skill's rules as edits to its own files.

Rules that fired in this session come first, most firings first; the rest follow by the summed `evidence` counts of their fixes (0 without evidence), then by their newest fix. Fixes under a rule follow the same evidence-then-newest order. A final list names every hand-written rule in the user rules directory, any `.md` file without the marker, by name and `description`, whether or not a loaded skill relates to it.

The pass dismisses a candidate that a listed rule already covers. A signal repeating a listed fix is a second failure, and the pass proposes a barrier rule for it.

## Digest

The digest keeps signals and drops everything else: harness messages (wiki recall, status notices, advisor, reminders and nudges, background-job and IRC deliveries, file mentions, `developer` messages), bookkeeping entries and thinking blocks.

- **Corrections** carry the ~200 characters of assistant text just before them. Their own text is cut at 2,000 characters, so a pasted log can't fill the digest.
- **Tool errors** show the tool, a short argument summary and the error cut to about 300 characters, and name the skills loaded earlier in the same turn. Errors inside an observation pass are left out, and its calls get no outline.
- **Workflow outlines** list one line per tool call (name, argument summary, ok/error), up to 50 calls, so one long turn can't crowd out every other signal. A subagent run shows only its `task` call (task names and agents) and the status its subagents ended with, taken from `wait` results and background-job deliveries.
- **Identical signals** are counted as one, with a `(×N)` count, placed where they last occurred. Each keeps the occurrence IDs it stands for; a tool error's ID nests under its turn's workflow outline (`<workflow>/<event>`), so ranking counts distinct occurrences, not descriptions.
- **Device dispatch** (`write xd://<tool>`) is recorded once, as the inner tool. A call saved both natively and by the extension's hooks also counts once, at its first request and first outcome; calls nested in `eval` appear only through their hook records, and structured parallel calls through their `tool_uses`. This view is deliberately lossy: publication receipts never rely on it.
- **Remedy outcomes** for applied fixes report `delivered`, `exercised-clean` (the same command that failed before later succeeded after delivery, with a finished result), `recurrence` or `inconclusive`.
- **Managed skills** created with `manage_skill` in the session are listed, so the pass doesn't propose them again.

The rendered digest is capped at about 12k tokens (estimated as 4 characters per token). Over the cap, the oldest signals are dropped first and the digest says how many. The signals left are numbered `S1`, `S2`, … from the oldest, so proposals can cite them; the ids hold only within one pass.
