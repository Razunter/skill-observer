# Observer hooks and the companion extension

This is the procedure for the last two rungs of the remedy ladder. The payload names the project hooks directory, the global hooks directory, the companion extension directory and the hook check script. `observer_review` and `observer_resolve` refuse a call that skips one of the steps they check.

## When each rung fits

- An **observer hook** fixes a mechanical mistake that a barrier rule, pattern amendment or project check cannot catch. It is one self-contained file. It may register event handlers and commands and keep state.
- The **companion extension** is for a remedy a hook cannot carry: one that needs a registered tool, several modules or a dependency. It is the one extension a pass may edit.
- The intent says why each lower rung fails: configuration repair, skill text, barrier rule, pattern amendment, project check, and for the companion, a hook.
- A fix in any other extension's code stays a report item.

## Scope and target

A candidate of these rungs has `kind: "harness"`, no skill name, and `target: { scope: "harness", root, mechanism }`. Its `mechanism` names the mechanism in words with letters or digits.

- `root: "project-hooks"` fixes a mistake specific to this project. A project candidate whose path lies in the project's hooks directory is refused: propose that file here, as a project hook.
- `root: "global-hooks"` runs in every project. Use it only when the mistake passes the skill-scope test: it would hold in another project and another task.
- `root: "companion"` takes no `path`: its identity is the companion root and its mechanism.
- A hook's `path` names an existing hook file relative to its hooks directory, hand-written ones included. It is a plain root-relative file path that stays inside the root. Leave it out for a new hook, which is named `skill-observer-<fingerprint>.ts` after the proposal's fingerprint.

Keep the same target and mechanism from intent to code: together they are the identity both stages share.

## 1. The intent

Prepare the described remedy with `change: { operation: "harness", stage: "intent", event, predicate, action, mistake, legitimate, scope, lowerRungs }`. Each field is non-blank:

- `event`: the host event the hook handles, such as `tool_call` for one tool.
- `predicate`: what in the event marks the mistake.
- `action`: block, add context or change the call.
- `mistake`: the session's mistake as a sample event.
- `legitimate`: its nearest legitimate counterpart, which the hook leaves untouched.
- `scope`: why this project's hooks, the global hooks or the companion.
- `lowerRungs`: why each lower rung fails.

The intent goes through Prepare, Select and Ask in the main batch like any proposal. Its Apply authorises drafting only. Nothing is written on it, and it is never recorded as applied.

## 2. Drafting

After the intent's Apply, give one subagent the intent text, both samples, the target file's root-relative path or the companion directory, and the hook check script's path. The subagent works in a new temporary directory, never in the target. It writes the draft there at the target's root-relative path, writes the samples file there, runs the check, and returns each file's exact text, the check command and the check's unedited output. When the session has no subagent tool, draft the same way yourself.

A hook file default-exports a factory: `export default function (pi) { pi.on("tool_call", (event, ctx) => …) }`. A `tool_call` event carries `toolCallId`, `toolName` and `input`; a `tool_result` event adds `content` and `isError`. A handler blocks with `{ block: true, reason }` and adds context with `{ additionalContext }`.

The hook samples file is a JSON array. Each sample is `{ name, role, event, toolName, input, content?, isError?, expect }`:

- `role` is `"mistake"` or `"legitimate"`. The file holds at least one of each.
- `event` is `"tool_call"` or `"tool_result"`; `content` and `isError` belong to a `tool_result`.
- `expect` is `"blocked"`, `"context"` or `"untouched"`.
- A hook that keeps state gets the sequence its state needs, in order. Every sample runs against the same loaded hook.

Run the hook check from the temporary directory with `bun --no-env-file <hook check script> <hook path> <samples file>`: the script and samples file by absolute path, the hook by its root-relative path. The same command then reruns in the target root on the written hook, and Prepare refuses a hook check of any other form. It passes when it exits 0 and prints an `OK:` line. Run it with no arguments for its full usage.

For the companion, copy the companion directory into the temporary directory when it exists, make the change there and run `bun test` there. A companion change:

- lists every file it writes, each once, at a plain path relative to the companion directory;
- writes or keeps a `package.json` whose `omp.extensions` names its entry files, since the host loads nothing else in the directory;
- adds or keeps a test file named like `index.test.ts` (`.test`, `_test`, `.spec` or `_spec`) outside `node_modules`.

When drafting or its check fails, ask no code question: record the intent as `later` (see Recording).

## 3. The code

Prepare the drafted code under the intent's target and mechanism, with `change: { operation: "harness", stage: "code", intent, files, check }`:

- `intent`: the intent's Apply as you would cite an approval: `{ proposal: <its reference>, selectionToolCallId, askToolCallId }`. Prepare refuses the code when that Apply no longer holds, carries a note, or approved another identity.
- `files`: `[{ path, text }]` with each file's exact text. A hook's code is its one file, at the target's `path` or `skill-observer-<fingerprint>.ts`, with non-blank text.
- `check`: `{ command, output }`, the check the draft passed, exactly as run, and its unedited output. A hook's command is the hook check above; the companion's is `bun test`.

Send the text and output with `\n` line ends only; a carriage return is refused because the Ask form cannot show it. Then Select the code proposal alone and Ask with its `askHtml`, apart from every other question. Call `ask` directly, as for every question: an Ask made through `eval` or by a hook approves nothing. The form shows each file, the check command and its result, with Apply, Later and Decline.

## Approval notes

On this scope an Apply with a note approves nothing: the note is custom input. Revise the description or the code by the note. For code, rerun the check. Prepare it again, Select it and Ask again.

## 4. Publication

After the code's Apply, write each approved file with the normal `write` tool at its path in the target root, byte for byte. Then rerun the approved check command exactly, in the foreground with `bash`, `cwd` set to the target root, after the last write. Use no `async` and no service name. Then take each written file's SHA-256, for example with `sha256sum`.

## 5. Recording

Send one `observer_resolve` outcome per identity, with `kind: "harness"`, in the pass's one resolve call:

- `applied`, for published code: `approval` of the code's Apply (its reference, Select and Ask call IDs) and `publication: { writeToolCallIds, checkToolCallIds, files: [{ path, afterHash }] }`. Cite the actual `observerToolCallId` of each write and check. The resolver refuses the outcome unless each approved file has an observed write after the code's Apply, still holds its approved text, and its stated hash is the hash of that text, and unless each check ran the approved command and succeeded in the foreground in the target root after the writes. It writes no file. An intent's Apply never makes `applied`.
- `declined`, when the user declined either stage: `proposal`, the reference of the proposal declined.
- `later`, when the user answered Later at either stage, when drafting or its check failed, or when the code was never asked: `proposal`, the reference of the latest proposal of this identity, from the pass's latest Prepare that holds it. Give a `reoffer` for each `later` you record yourself. A code Later comes back as an intent question; the resolver notes that a draft existed.

An answer is `applied`, `later` or `declined`. `approval` goes with `applied` alone and `proposal` with the others. The resolver refuses a second answer for the same identity in one call, and a hook or companion proposal sent as a skill or project outcome. The ledger record holds no file text, description or draft.

## Removal

To remove a hook file, prepare `change: { operation: "harness", stage: "removal" }` with the target naming the file by `path`, in either hooks directory. The companion is not removed this way. The form shows the file as it stands, with Apply and Decline only, asked once. After Apply, delete the file yourself, then send `applied` with the removal's `approval` and no `publication`. The resolver records the removal only once the file is gone. A declined removal is `declined` through `proposal`.

## Activation and the summary

A written, changed or removed hook or companion file takes effect only after omp restarts. A new session in the same process keeps the old set. The summary says this for each such file.

The summary also says how to remove a faulty hook by hand: delete its file from the hooks directory, or the companion directory for the companion, and restart omp. A `tool_call` handler that throws or times out blocks the call, so a faulty hook can block the tools a pass would use to remove it.
