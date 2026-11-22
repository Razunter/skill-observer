# Checked hooks and extension changes

Use this route only when a configuration repair, guidance edit, rule or ordinary project check cannot fix the observed problem.

## Choose the owner

Use `kind: "harness"` and `target: { scope: "harness", root, mechanism }`. Keep the `mechanism` stable across drafts of the same remedy.

- `project-hooks`: a hook specific to this checkout. `global-hooks`: a hook that applies across projects in this profile. Name an existing hook by its root-relative `path`, including for removal; omit `path` for a new `skill-observer-<fingerprint>.ts` hook. Use the same mechanism to retain the generated identity when revising it. For a new name, Prepare reports the expected path if the draft names a different one.
- `extension`: an owned OMP extension source directory. Set `source` to its absolute canonical path; add `checkout` for a different checkout explicitly brought into scope by the user. An installed plugin or unrelated repository is not an owned source.
- `companion`: the profile's companion extension. A new companion must declare its entries in `package.json` under `omp.extensions`.

## Check the draft

Create a private scratch directory with `mktemp -d "${TMPDIR:-/tmp}/omp-observe-check.XXXXXXXX"`. Use its canonical absolute path as the foreground Bash `cwd`. Use ordinary permissions. Do not write in the destination before Apply or shell-wrap the check.

For a hook, put its one exact proposed file at its target-relative path in scratch. Replay the session's mistake and its nearest legitimate counterpart. The samples file is a JSON array of `{ name, role, event, toolName, input, toolCallId?, content?, isError?, expect }`. Use `role` of `mistake` or `legitimate`, `event` of `tool_call` or `tool_result`, and `expect` of `blocked`, `context` or `untouched`. To exercise a stateful sequence, order the events and give related calls and results the same `toolCallId`.

Run `bun --no-env-file '<bundled check-hook.ts path>' '<root-relative hook path>' '<absolute scratch sample path>'`. The bundled checker loads the hook and fails if it rewrites a tool call or result. For hook removal, leave the hook absent in scratch, use `--absent` before the hook path and expect both sampled events to be untouched.

For an extension, copy the owned source into scratch, excluding `.git` and `node_modules`, then apply the exact draft there. Run a supported foreground test such as `bun --no-env-file test`, `node --test` or `vitest run` against the mistake and its legitimate counterpart. Configured scripts and TypeScript-only checks have additional requirements in [the check guide](docs/observation.md#checked-omp-hooks-and-extension-source). Prepare checks that the entire tree used in the check matches the proposed result, including unchanged source, configuration, and test inputs. If the check cannot run with ordinary permissions or the preview cannot match the checked inputs, report the finding, owner and next action.

## Ask once, publish and record

Prepare `{ operation: "harness", stage: "checked", files: [{ path, text }], checkToolCallId, lowerRungs }`. Omit `text` only to remove a file. Cite the observed scratch Bash call ID and explain why a simpler remedy does not fit. Keep scratch unchanged and readable through Resolve. Select with the other eligible proposals and call the exact native Ask. Review shows each destination's before and after state, scratch command and result, blast radius and activation effect.

Only the exact Apply authorizes publication. A `Verify only` note can preserve the reviewed change. For a note changing the work, or when the target or checked inputs change, refresh the check, Prepare and ask again.

Use `write` for each exact reviewed absolute path and complete result, or a single `edit` with its current read tag and only `REM` for a removal. After the writes, run the exact approved foreground Bash check in the reviewed root. Send one `kind: "harness"` outcome to Resolve. Cite `approval` for a native Apply, Later or Decline. For a verified Apply add `publication: { writeToolCallIds, checkToolCallIds, files: [{ path, afterHash }] }`; `afterHash` is the result's SHA-256 or `null` for removal. For eligible overflow use the `proposal` reference and `reoffer` instead of an approval. A missing approval, failed write or failed check does not become a ledger decision.

Report what was actually written and verified; do not repeat the writes if recording fails. The change takes effect on the next OMP load of the code, not on Apply. Publication does not activate code, restart OMP or deploy anything.
