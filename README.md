# skill-observer

An [OMP](https://github.com/can1357/oh-my-pi) extension for adjusting upstream skills without editing their installed files.

Your adjustments live in separate **amendments** that survive skill updates. The extension delivers them when you invoke `/skill:<name>` or the agent reads the skill's `SKILL.md`.

Run `/observe` to review session corrections and proposed fixes. After an upstream skill changes, the next `/observe` checks whether its amendments still apply. It can also propose local skill improvements and project checks.

**Status:** vibe-coded experiment.

## Requirements and first run

Requires [OMP](https://github.com/can1357/oh-my-pi) with a configured model and Git on `PATH`. Install from the repository, then start OMP in your project:

```sh
omp install https://github.com/Razunter/skill-observer.git
omp
```

OMP installs and enables the extension for your user; no manual clone or configuration entry is needed. The extension is not published on npm and needs no runtime npm packages or build step. See [setup](docs/setup.md) for checkout loading, OMP's `/extensions` controls, and state locations.

## Use it

After working with a skill and correcting the agent, enter:

```text
/observe
```

The model reviews session evidence and previews proposed changes with **Apply**, **Later**, or **Decline** choices. With nothing to review in a fresh session, the command reports that and starts no model turn.

You can add feedback or a focus:

```text
/observe Focus on the upstream skills I corrected in this session.
```

A note starts a review without other signals, but the pass can finish without proposals if evidence does not support a change. Observation runs only on request, never automatically at session exit.

To see what the extension knows about the current branch without starting a review, enter:

```text
/observe-report
```

It lists signal counts, loaded skills, remedy outcomes of applied fixes, stale amendments, the next `/observe` pass's estimated size, and the Later count. It calls no model and writes nothing.

### Optional remote skills

- [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), from Matt Pocock's skills, adds retrospective guidance for project-environment findings.
- [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md), from Lauren Tan's pstack, can be offered as `/skill:correct` after at least two evidenced occurrences of a mistake class. Only you may invoke it; observer approval neither launches its repairs nor authorizes commits.

Install these skills separately. Ordinary observation works without them. See [optional references](docs/observation.md#optional-references) for their behavior and [setup](docs/setup.md#optional-remote-skills) for source links.

## Defaults and limits

- **Interactive review:** `/observe` requires a main session with UI. Amendment delivery also runs in subagents and headless sessions, but requires the extension to stay loaded.
- **Different targets:** upstream and plugin skill files stay untouched. Approved local or managed skill changes can edit those skills directly, and approved project fixes use normal editing tools.
- **Instruction delivery, not guaranteed compliance:** amendments add guidance to the model's context. Pattern rules are checked against their supplied samples, not proven correct for every possible output.
- **Existing state:** loading can migrate legacy observer-owned files. New proposals follow the review workflow; this is not a filesystem sandbox. See [storage and migration](docs/amendments.md).

## Documentation

- [Setup](docs/setup.md) covers first use, persistent loading, optional skills, and state locations.
- [Observation workflow](docs/observation.md) explains signals, proposals, project scope, and the session digest.
- [Amendments and replay](docs/amendments.md) covers storage, delivery, upstream updates, reference files, and pattern checks.
- [Development and tool contracts](docs/development.md) covers proposal approval, the ledger, module responsibilities, and development checks.
- [Changelog](CHANGELOG.md) records package changes.

## License

The TypeScript implementation, tests, and project documentation are licensed under [MIT](LICENSE). The adapted [`observer.md`](observer.md) instructions remain under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See [third-party notices](THIRD_PARTY_NOTICES.md) for attribution and licence scope.

## Origins and inspiration

Adapted from [task-observer / One Skill to Rule Them All](https://github.com/rebelytics/one-skill-to-rule-them-all) by [Eoghan Henn](https://rebelytics.com) and contributors, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Its approach of finding skill improvements in real work and user corrections is the starting point. This adaptation uses OMP's session history, an explicit `/observe` command, and separate skill amendments.

[ASSERT](https://github.com/responsibleai/ASSERT), from Microsoft Responsible AI, inspired the feedback checks: proposals cite session evidence, pattern rules are replayed against both mistake and legitimate examples, and observation passes check whether earlier fixes failed again.
