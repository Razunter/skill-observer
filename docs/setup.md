# Setup

[README](../README.md) · [Observation workflow](observation.md) · [Amendments and replay](amendments.md)

## Requirements

- [OMP](https://github.com/can1357/oh-my-pi), with a configured model and an interactive main session for `/observe` and its approval questions.
- Skills installed where the extension can identify them. User skills are read from `~/.agents/skills/`, managed skills from the active OMP agent directory, and enabled user-scope plugin skills from OMP's plugin registry. Project skills and project-scoped plugins have unknown provenance. See [skill provenance](observation.md#observe).
- The `omp` executable on `PATH` for pattern-rule replay. If it cannot run, pattern rules are deferred; ordinary skill edits and on-read amendments remain available.

There are no runtime npm packages to install and no build step. Keep `package.json`, `src/`, and `observer.md` together. The extension reads `observer.md` when an observation pass starts.

## Load once

The extension is not published on npm. Clone this repository with `git clone` using its clone URL, then open a shell at the checkout root:

```sh
omp --version
omp -e "$PWD"
```

OMP loads `src/skill-observer.ts` through the package's `omp.extensions` entry. For a checkout inside a larger repository, run these commands from the directory containing this extension's `package.json`.

In the interactive OMP session, enter:

```text
/observe
```

With a fresh session and no signals, skills, or stale amendments, it reports `No skill signals in this session: nothing to observe.` and starts no model turn. That response also confirms that the command loaded. No status hint in a quiet session is expected.

After working with a skill and correcting the agent, run `/observe` again. You can add your own focus or feedback:

```text
/observe Focus on the upstream skills I corrected in this session.
```

A note starts a normal model turn even without other signals. The extension reports `Observation pass started` with the signal, skill, and stale-amendment counts. The model reviews the evidence and offers eligible changes with previews and Apply, Later, or Decline choices. A note is not evidence that a mistake occurred, so a pass can finish without proposals. See [the observation workflow](observation.md).

There is no extension-managed download, service startup, or readiness queue. OMP loads the source in its own process. An observation pass uses the session's model and can incur its normal model-provider charges. Rule replay launches short-lived `omp ttsr test` processes; there is no background daemon to stop after OMP exits.

## Load persistently

Add the checkout directory to the `extensions` list in the active profile's OMP configuration. The default user file is `~/.omp/agent/config.yml`. Named profiles use `~/.omp/profiles/<name>/agent/config.yml`; an agent-directory override changes the default-profile location.

For example, for a checkout at `~/src/skill-observer`:

```yaml
extensions:
  - ~/src/skill-observer
```

Use your actual checkout path and preserve any other entries already in the list. OMP settings layers replace extension arrays rather than appending them. A project can instead list the extension in its `.omp/config.yml`.

Restart OMP after adding a new extension path. You can then launch from your project's directory without passing `-e`. The directory OMP is working in defines the scope of project-fix proposals; loading the extension does not change that directory.

### Enable or disable in OMP

The YAML configuration above loads the extension but does not add it to the installed OMP dashboard's catalog. Use `disabledExtensions` below for that setup.

For dashboard control, instead place the checkout, or a symlink to it, at `<agent dir>/extensions/skill-observer`. The default-profile location is `~/.omp/agent/extensions/skill-observer`; use the active profile's agent directory if it differs. Remove the checkout's YAML `extensions` entry when switching to this discovery route, then restart OMP.

Open `/extensions`, select the `skill-observer` extension module, and use Space or Enter to toggle it. The dashboard saves the enabled state. It controls discovered entries; it does not clone or install this repository.

A configuration-file alternative is to add or remove its ID in `disabledExtensions`:

```yaml
disabledExtensions:
  - extension-module:skill-observer
```

Preserve other disabled IDs. A module already loaded in the running session can be suspended or resumed when these settings change. If it was excluded at startup, enabling it requires a fresh OMP launch. Explicit-only `--no-extensions -e ...` sessions ignore these settings controls, and explicitly configured file paths bypass the name filter. Use the package directory, rather than its entry file, for the persistent setup above.

Restart OMP to load source edits. `observer.md` is read on each `/observe`, so edits to those instructions affect the next pass without restarting.

## Optional remote skills

These skills are installed separately, not downloaded or bundled by skill-observer:

- [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), from Matt Pocock's skills, provides retrospective guidance for session-backed project-environment findings. Without it, `/observe` warns and continues ordinary observation.
- [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md), from Lauren Tan's pstack, can be offered as `/skill:correct` after at least two distinct occurrences of the same mistake class. Only you may invoke it. Observer approval does not invoke it or authorize its repairs or commits.
- [`writing-for-agents`](https://github.com/mattpocock/skills), from Matt Pocock's skills, is the drafting reference for agent-facing guidance. If it is unavailable, the pass discloses that and uses its inline drafting checks.

Use each source project's installation instructions. OMP must be able to discover the skill by name. See [optional references](observation.md#optional-references) for how these skills participate in a pass.

## State and upgrades

The extension stores its ledger, on-read amendments, and reference files under the active OMP agent directory's `skill-observer/` directory. Pattern amendments and barrier rules live in the agent directory's `rules/`. Skill decisions are shared across projects in that profile; project decisions are scoped to the canonical OMP working directory.

Loading can migrate marked legacy observer rules to the current layout. This is separate from approving new proposals. Upstream skill updates leave separately stored amendments intact; the next `/observe` checks whether those amendments are stale. On-read amendment delivery requires this extension to stay loaded, including in later sessions.

See [amendment storage, delivery, and migration](amendments.md) and [ledger and approval details](development.md#ledger).
