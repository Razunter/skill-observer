# skill-observer

An [OMP](https://github.com/can1357/oh-my-pi) extension that reviews session evidence for improvements to your project, skills, and OMP setup.

Adjust upstream skill guidance with separate **amendments** that survive skill updates. The extension delivers them when you invoke `/skill:<name>` or the agent reads the skill's `SKILL.md`.

Run `/observe` after ordinary work, even if no skill loaded and no tool failed. The pass can propose a regression test, a configuration fix, or a change to guidance. It checks existing skill guidance before proposing a repair and searches for existing skills before proposing a new one. When an upstream skill changes, the next pass checks whether its amendments still fit.

**Status:** vibe-coded experiment.

## Requirements and first run

Requires [OMP](https://github.com/can1357/oh-my-pi) with a configured model and Git on `PATH`. Install from the repository, then start OMP in your project:

```sh
omp install https://github.com/Razunter/skill-observer.git
omp
```

OMP installs and enables the extension for your user; no manual clone or configuration entry is needed. The extension is not published on npm and needs no runtime npm packages or build step. See [setup](docs/setup.md) for checkout loading, OMP's `/extensions` controls, and state locations.

Upgrading a profile with existing observer state? [Migrate its JSONL files](docs/setup.md#migrate-existing-observer-state) before you start the upgraded extension.

## Use it

After completing a task or correcting the agent, enter:

```text
/observe
```

The pass starts with discovery. It loads drafting, approval, and publication instructions only when needed. The form shows up to five proposals with **Apply**, **Later**, or **Decline**. The summary explains findings and alternatives that did not reach the form. A fresh session with nothing to review starts no model turn.

You can add feedback or a focus:

```text
/observe Focus on the upstream skills I corrected in this session.
```

A note starts a pass without other signals, but the evidence still has to support a proposal. `/observe` runs only on request. To include a second checkout in the same review, add `Include project root: /absolute/canonical/root` or name a worktree with `Include worktree: <branch>` in your note. See [target scope](docs/observation.md#project-and-profile-targets).

To see what the extension knows about the current branch without starting a review, enter:

```text
/observe-report
```

It lists signal counts, loaded skills, remedy outcomes, stale amendments, pending observations, the skill catalog summary, and the Later count. Its size estimate covers only the next pass's hidden starting message, not model usage or the full pass. It calls no model and writes nothing.

While it works, the agent can record an **observation** with its `observe` tool when a skill, a rule, or the project setup causes a problem. Observations survive across sessions and are shared by worktrees of the same repository. The next `/observe` lists pending observations and marks those revisions as shown. A repeat within 30 days names the date it was last shown. An observation expires if no pass shows it within 30 days of its last recording. See [observations](docs/observation.md#observations).

### Optional remote skills

- [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), from Matt Pocock's skills, adds retrospective guidance for project-environment findings.
- [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md), from Lauren Tan's pstack, can be offered as `/skill:correct` after at least two evidenced occurrences of a mistake class. Only you may invoke it; observer approval neither launches its repairs nor authorizes commits.

Install these skills separately. Ordinary observation works without them. See [optional references](docs/observation.md#optional-references) for their behavior and [setup](docs/setup.md#optional-remote-skills) for source links.

## Defaults and limits

- **Interactive review:** `/observe` requires a main session with UI. Amendment delivery also runs in subagents and headless sessions, but requires the extension to stay loaded.
- **Exact approval:** one native **Apply** covers only the reviewed changes at the named destinations. Project edits can span explicitly scoped checkouts. Ordinary profile edits stay in the active OMP profile. Hooks and owned extension source need a passing scratch check before the form. Apply grants no new permissions and does not restart OMP, commit, or deploy.
  If a necessary check or owner tool is unavailable, the pass reports the blocker instead of asking you to approve.
- **Installed skills:** prefer configuration, amendments, or an owned source checkout. Edit an installed upstream or plugin skill only as a last resort, only if you opt in, and only in the exact file inspected. Updates can overwrite the edit.
- **Instruction delivery, not guaranteed compliance:** amendments add guidance to the model's context. Pattern rules are checked against their supplied samples, not proven correct for every possible output.
- **Existing state:** the extension does not import old proposal or observation files on load. Use the [one-time migration](docs/setup.md#migrate-existing-observer-state). Loading may still [migrate legacy amendment files](docs/amendments.md).

## Documentation

- [Setup](docs/setup.md) covers first use, persistent loading, optional skills, and state locations.
- [Observation workflow](docs/observation.md) explains discovery, proposal review, scoped publication, and what verification can show.
- [Amendments and replay](docs/amendments.md) covers storage, delivery, upstream updates, reference files, and pattern checks.
- [Development and tool contracts](docs/development.md) covers proposal approval, the ledger, module responsibilities, and development checks.
- [Changelog](CHANGELOG.md) records package changes.

## License

The TypeScript implementation, tests, and project documentation are licensed under [MIT](LICENSE). The adapted [`observer.md`](observer.md) instructions remain under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See [third-party notices](THIRD_PARTY_NOTICES.md) for attribution and licence scope.

## Origins and inspiration

Adapted from [task-observer / One Skill to Rule Them All](https://github.com/rebelytics/one-skill-to-rule-them-all) by [Eoghan Henn](https://rebelytics.com) and contributors, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Its approach of finding skill improvements in real work and user corrections is the starting point. This adaptation uses OMP's session history, an explicit `/observe` command, and separate skill amendments.

[ASSERT](https://github.com/responsibleai/ASSERT), from Microsoft Responsible AI, inspired the feedback checks: proposals cite session evidence, pattern rules are replayed against both mistake and legitimate examples, and observation passes check whether earlier fixes failed again.
