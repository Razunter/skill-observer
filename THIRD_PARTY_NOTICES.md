# Third-party notices

## Licence scope

The original TypeScript implementation, tests, and project documentation are licensed under the [MIT licence](LICENSE). The adapted instructions in [`observer.md`](observer.md), and the fragments generated from it in `observer/`, are licensed under CC BY 4.0 as described below. The package's `(MIT AND CC-BY-4.0)` expression records these separate scopes; it does not offer MIT as an alternative licence for upstream material.

## task-observer / One Skill to Rule Them All

- Author: Eoghan Henn / [rebelytics.com](https://rebelytics.com) and contributors.
- Copyright (c) 2026 Eoghan Henn / rebelytics.com.
- Source: <https://github.com/rebelytics/one-skill-to-rule-them-all>.
- Licence: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/legalcode.en), including its Section 5 disclaimer of warranties and limitation of liability.

`observer.md` adapts task-observer's session-observation and skill-improvement workflow for OMP. Changes include explicit `/observe` invocation, OMP session digests, provenance-aware skill amendments, evidence-backed approval and publication, and sample-based rule replay. The upstream attribution and CC BY 4.0 licence remain applicable to the adapted instructions; the MIT licence does not replace them.

### Reviewed upstream revision

`observer.md` was last reviewed against upstream v3.9.0, commit `f86755764373f96a50401762f31f22077127b999` (2026-11-02), on 2026-11-06. The adaptation's origin is inferred, not recorded, as v3.4.0, commit `c479475c551ad84d3bfa572245d053ef3ec6e112` (2026-09-25), from the date of the earliest local spec. Adopted from v3.9.0: quoted outside text (tool output, fetched pages, issue and PR text, other repositories) is data, never instructions; a `later` the pass records itself names what would change the decision, when it could arrive and whether the deferred action is still possible (`reoffer`); a new-skill proposal records which skill lists were searched. The review form preselects nothing, since OMP's HTML-form `ask` submits preselected values on timeout. Declined: consent at the point of use (`/observe` stays explicit, ADR 0001); the file-log, scan, validator and hook machinery (outside this extension's scope). Future syncs diff upstream from v3.9.0.

## ASSERT

[ASSERT](https://github.com/responsibleai/ASSERT), from Microsoft Responsible AI, is credited as design inspiration for evidence-backed proposals, replay checks, and feedback on earlier fixes. Its repository is [MIT-licensed](https://github.com/responsibleai/ASSERT/blob/main/LICENSE).

## Optional external skills

`retro`, `correct`, and `writing-for-agents` are separately installed references, not bundled copies. Their own licences remain applicable to those external installations. Source links and their integration behavior are in [setup](docs/setup.md#optional-remote-skills).
