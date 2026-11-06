# Setup

[README](../README.md) · [Observation workflow](observation.md) · [Amendments and replay](amendments.md)

## Requirements

- [OMP](https://github.com/can1357/oh-my-pi), with a configured model and an interactive main session for `/observe` and its approval questions.
- Skills installed where the extension can identify them. User skills are read from `~/.agents/skills/`, managed skills from the active OMP agent directory, and enabled user-scope plugin skills from OMP's plugin registry. Project skills and project-scoped plugins have unknown provenance. See [skill provenance](observation.md#observe).
- The `omp` executable on `PATH` for pattern-rule replay. If it cannot run, pattern rules are deferred; ordinary skill edits and on-read amendments remain available.
- Git on `PATH` to install from the repository.

There are no runtime npm packages to install and no build step. Keep `package.json`, `src/`, and `observer.md` together. The extension reads `observer.md` when an observation pass starts.

## Install from Git

Run from your project directory:

```sh
omp install https://github.com/Razunter/skill-observer.git
omp
```

OMP installs and enables the package for your user. New sessions load `src/skill-observer.ts` through the package's `omp.extensions` entry, with no manual clone or configuration entry. If OMP is already running, restart it to load the extension. Git installs are user-scoped, not project-scoped.

In the interactive OMP session, enter:

```text
/observe
```

With no signals, skills, or stale amendments in a fresh session, it reports `No skill signals in this session: nothing to observe.` and starts no model turn. This confirms the command loaded. A quiet session has no status hint.

After working with a skill and correcting the agent, run `/observe` again. You can add your own focus or feedback:

```text
/observe Focus on the upstream skills I corrected in this session.
```

A note starts a normal model turn without other signals. The extension reports `Observation pass started` with the signal, skill, and stale-amendment counts. The model reviews the evidence and previews eligible changes with Apply, Later, or Decline choices. A note is not evidence of a mistake, so a pass can finish without proposals. See [the observation workflow](observation.md).

OMP loads the source in its own process, with no extension-managed download, service startup, or readiness queue. A pass uses the session's model and can incur normal provider charges. Rule replay launches short-lived `omp ttsr test` processes. No background daemon remains after OMP exits.

## Load once

To try a checkout without installing it, clone this repository with `git clone`, then run from the directory containing the extension's `package.json`:

```sh
omp --version
omp -e "$PWD"
```

This also applies to a checkout inside a larger repository. The extension is not published on npm.

## Load persistently

Add the checkout directory to `extensions` in the active profile's OMP configuration. The default user file is `~/.omp/agent/config.yml`; named profiles use `~/.omp/profiles/<name>/agent/config.yml`. An agent-directory override changes the default-profile location.

For example, for a checkout at `~/src/skill-observer`:

```yaml
extensions:
  - ~/src/skill-observer
```

Use your checkout path and preserve existing entries. OMP settings layers replace extension arrays rather than append to them. A project can instead list the extension in `.omp/config.yml`.

Restart OMP after adding the path. You can then launch from your project without `-e`. OMP's working directory defines project-fix scope; loading the extension does not change it.

### Enable or disable in OMP

For a Git installation, use `omp plugin disable skill-observer` or `omp plugin enable skill-observer`, then restart OMP. The controls below apply to checkout loading.

The YAML configuration loads the extension without adding it to OMP's dashboard catalog. Use `disabledExtensions` below to control that setup.

For dashboard control, place the checkout or a symlink at `<agent dir>/extensions/skill-observer`. The default is `~/.omp/agent/extensions/skill-observer`; other profiles use their active agent directory. Remove the checkout's YAML `extensions` entry, then restart OMP.

Open `/extensions`, select the `skill-observer` extension module, and use Space or Enter to toggle it. The dashboard saves the enabled state. It controls discovered entries; it does not clone or install this repository.

A configuration-file alternative is to add or remove its ID in `disabledExtensions`:

```yaml
disabledExtensions:
  - extension-module:skill-observer
```

Preserve other disabled IDs. Settings changes can suspend or resume an already loaded module. A module excluded at startup needs a fresh OMP launch when enabled. Explicit-only `--no-extensions -e ...` sessions ignore these controls; explicitly configured file paths bypass the name filter. Use the package directory, not its entry file, for persistent loading.

Restart OMP to load source edits. `observer.md` is read on each `/observe`, so edits to those instructions affect the next pass without restarting.

## Optional remote skills

These skills are installed separately, not downloaded or bundled by skill-observer:

- [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), from Matt Pocock's skills, provides retrospective guidance for session-backed project-environment findings. Without it, a pass whose session has a workflow outline or tool error warns and continues ordinary observation.
- [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md), from Lauren Tan's pstack, can be offered as `/skill:correct` after at least two distinct occurrences of the same mistake class. Only you may invoke it. Observer approval does not invoke it or authorize its repairs or commits.
- [`writing-for-agents`](https://github.com/mattpocock/skills), from Matt Pocock's skills, is the drafting reference for agent-facing guidance. If it is unavailable, the pass discloses that and uses its inline drafting checks.

Use each source project's installation instructions. OMP must be able to discover the skill by name. See [optional references](observation.md#optional-references) for how these skills participate in a pass.

## State and upgrades

The extension stores its ledger, on-read amendments, and reference files under the active OMP agent directory's `skill-observer/` directory. Pattern amendments and barrier rules live in the agent directory's `rules/`. Skill decisions are shared across projects in that profile; project decisions are scoped to the canonical OMP working directory.

Loading can migrate marked legacy observer rules to the current layout, separately from proposal approval. Upstream updates preserve separately stored amendments; the next `/observe` checks for staleness. On-read delivery requires the extension to stay loaded in later sessions.

See [amendment storage, delivery, and migration](amendments.md) and [ledger and approval details](development.md#ledger).
