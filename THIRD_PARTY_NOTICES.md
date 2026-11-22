# Third-party notices

## Licence scope

The original TypeScript implementation, tests, and project documentation are licensed under the [MIT licence](LICENSE). The adapted instructions in [`observer.md`](observer.md), and the fragments generated from it in `observer/`, are licensed under CC BY 4.0 as described below. The package's `(MIT AND CC-BY-4.0)` expression records these separate scopes; it does not offer MIT as an alternative licence for upstream material.

## task-observer / One Skill to Rule Them All

- Author: Eoghan Henn / [rebelytics.com](https://rebelytics.com) and contributors.
- Copyright (c) 2026 Eoghan Henn / rebelytics.com.
- Source: <https://github.com/rebelytics/one-skill-to-rule-them-all>.
- Licence: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/legalcode.en), including its Section 5 disclaimer of warranties and limitation of liability.

`observer.md` adapts task-observer's session-observation and skill-improvement workflow for OMP. Changes include explicit `/observe` invocation, discovery from completed session work, and instructions delivered by stage. The adaptation uses OMP session digests and accounts for skill provenance when handling amendments. It ties approval to exact changes supported by evidence and replays rules against samples. The upstream attribution and CC BY 4.0 licence remain applicable to the adapted instructions; the MIT licence does not replace them.

### Reviewed upstream revision

`observer.md` was reviewed against [upstream v3.12.0](https://github.com/rebelytics/one-skill-to-rule-them-all/tree/88c5f3e3e2d3ffb4ccffd949ad69186a5e948228), commit `88c5f3e3e2d3ffb4ccffd949ad69186a5e948228`, on 2026-11-22. Future syncs diff from that revision. The adaptation's origin is inferred as v3.4.0, commit `c479475c551ad84d3bfa572245d053ef3ec6e112` (2026-09-25), from the date of the earliest local spec.

- **Adopted with OMP's existing workflow:** Treat quoted commands as evidence, not permission to execute. Keep rules needed before a reference read in the delivered amendment. Redact private values before recording new evidence, keeping real examples and marking altered quotes.
- **Not adopted:** A second command approval path, per-item log closure, invented examples for publication, persistent feedback channels, longitudinal metrics, installation despite an unmet check, or upstream activation, file logs, scans, scripts, validators, hooks, and eval fixtures. OMP keeps its explicit observation pass, current-state store, User notes, recorded observations, and existing extension feedback route. It does not publish externally.
- **Earlier review:** The v3.9.0 review at `f86755764373f96a50401762f31f22077127b999` adopted treating quoted outside text as data, a re-offer condition for Later outcomes the pass records itself, and coverage of the skill lists searched for a new skill. The OMP form preselects nothing because the host can submit defaults on timeout.

## ASSERT

[ASSERT](https://github.com/responsibleai/ASSERT), from Microsoft Responsible AI, is credited as design inspiration for evidence-backed proposals, replay checks, and feedback on earlier fixes. Its repository is [MIT-licensed](https://github.com/responsibleai/ASSERT/blob/main/LICENSE).

## Optional external skills

`retro`, `correct`, and `writing-for-agents` are separately installed references, not bundled copies. Their own licences remain applicable to those external installations. Source links and their integration behavior are in [setup](docs/setup.md#optional-remote-skills).
