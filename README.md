# skill-observer

An [OMP](https://github.com/can1357/oh-my-pi) extension for adjusting upstream skills without editing their installed files.

Your adjustments live in separate **amendments**, so skill updates do not overwrite them. The extension delivers these alongside the skill when you invoke it with `/skill:<name>` or the agent reads its `SKILL.md`.

Run `/observe` to review session corrections and proposed fixes. When an upstream skill changes, the next `/observe` also reviews whether its amendments still apply. It can also propose improvements to local skills and project checks.

**Status:** vibe-coded experiment.

## Requirements and first run

Requires [OMP](https://github.com/can1357/oh-my-pi) with a configured model. Clone this repository with `git clone`, then run from the checkout root:

```sh
omp --version
omp -e "$PWD"
```

The extension is not published on npm. No runtime npm packages or build step are needed. See [setup](docs/setup.md) for persistent loading, OMP's `/extensions` controls, and state locations.

## Use it

After working with a skill and correcting the agent, enter:

```text
/observe
```

The model reviews the session evidence and offers proposed changes with previews and **Apply**, **Later**, or **Decline** choices. In a fresh session with nothing to review, the command reports that and starts no model turn.

You can add feedback or a focus:

```text
/observe Focus on the upstream skills I corrected in this session.
```

A note starts a review even without other signals, but the pass can finish without proposals if the evidence does not support a change. Observation runs only when you request it, not automatically at session exit.

### Optional remote skills

- [`retro`](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), from Matt Pocock's skills, adds retrospective guidance for project-environment findings.
- [`correct`](https://github.com/cursor/plugins/blob/main/harness/pstack/claude-code/skills/correct/SKILL.md), from Lauren Tan's pstack, can be offered as `/skill:correct` for a mistake class evidenced at least twice. Only you may invoke it; observer approval does not launch its repairs or authorize commits.

These skills are installed separately. Ordinary observation remains usable without them. See [optional references](docs/observation.md#optional-references) for their behavior and [setup](docs/setup.md#optional-remote-skills) for source links.

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
