/**
 * The replay check: a drafted pattern must fire on a sample of its mistake and
 * stay silent on a legitimate counterpart, as OMP's own TTSR engine judges
 * them. Each sample runs through `omp ttsr test` against a temporary rule file
 * holding exactly the condition and scope that would be written. There is no
 * fallback: where `omp` can't run, nothing counts as checked.
 *
 * `observer_check` runs it for the pass before the user is asked;
 * `observer_resolve` runs it again before writing a rule.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPattern, frontmatterField } from "./amendments.js";
import type { ExtensionAPI, Schema, SchemaBuilder } from "./omp.js";

export const CHECK_TOOL_NAME = "observer_check";

/** A sample as TTSR sees it: prose or file content as a string, or a tool call's arguments as an object. */
export type Sample = string | Record<string, unknown>;

/** A drafted pattern with the samples it is checked against. */
export interface PatternDraft {
  name: string;
  pattern: string;
  /** `text` (the default) or `tool:<name>`. */
  scope?: string;
  /** Samples of the mistake: each must fire the pattern. */
  matches?: Sample[];
  /** Legitimate counterparts: none may fire it. */
  spares?: Sample[];
}

/** A pattern's scope: the agent's text, or one tool's calls. */
const PATTERN_SCOPE = /^(?:text|tool:[a-z0-9_-]+)$/;

/** The scope a drafted pattern watches; a blank scope means the agent's text. */
function patternScope(draft: PatternDraft): string {
  const scope = draft.scope?.trim() || "text";
  if (!PATTERN_SCOPE.test(scope)) {
    throw new Error(`scope \`${scope}\` must be \`text\` or \`tool:<name>\` with a lowercase tool name`);
  }
  if (scope === "tool:read") {
    throw new Error("scope `tool:read` is reserved for legacy on-read amendments that the extension migrates; pick another scope, or make the fix an on-read amendment");
  }
  return scope;
}

/** A draft ready to replay: the condition and scope as they would be written, and each sample as TTSR matches it. */
export interface ReplayCase {
  condition: string;
  scope: string;
  matches: string[];
  spares: string[];
}

type SampleKind = "matches" | "spares";

/**
 * The text TTSR matches for a sample: the prose for `text`; the file content
 * for `edit` and `write`; `JSON.stringify` of the arguments for any other tool,
 * as OMP serializes them, JSON escaping included.
 */
function snippet(sample: Sample, scope: string, kind: SampleKind, index: number): string {
  const tool = scope.startsWith("tool:") ? scope.slice("tool:".length) : undefined;
  if (tool === undefined || tool === "edit" || tool === "write") {
    if (typeof sample === "string") return sample;
    throw new Error(`\`${kind}[${index}]\`: a \`${scope}\` sample must be a string: ${tool ? "the resulting file content" : "the prose"}`);
  }
  if (typeof sample === "object" && sample !== null && !Array.isArray(sample)) return JSON.stringify(sample);
  throw new Error(`\`${kind}[${index}]\`: a \`${scope}\` sample must be the call's arguments as an object`);
}

function snippets(draft: PatternDraft, scope: string, kind: SampleKind): string[] {
  const samples = draft[kind] ?? [];
  if (samples.length === 0) {
    const what = kind === "matches" ? "a sample of the mistake" : "a legitimate counterpart";
    throw new Error(`a pattern needs at least one \`${kind}\` sample: ${what}`);
  }
  return samples.map((sample, index) => snippet(sample, scope, kind, index));
}

/** Validates a draft and builds its replay case; throws with the reason for an invalid draft. */
export function replayCase(draft: PatternDraft): ReplayCase {
  const scope = patternScope(draft);
  checkPattern(draft.pattern);
  return {
    condition: draft.pattern,
    scope,
    matches: snippets(draft, scope, "matches"),
    spares: snippets(draft, scope, "spares"),
  };
}

export interface Misfire {
  sample: SampleKind;
  index: number;
  /** The sample as matched, cut to a preview. */
  snippet: string;
}

export type Verdict =
  | { verdict: "passed" }
  | { verdict: "misfired"; misfires: Misfire[] }
  /** `omp` could not run the check. */
  | { verdict: "unchecked"; reason: string };

const PREVIEW_CHARS = 200;
/** One `omp ttsr test` run takes about 0.5 s; this only stops a hung process. */
const RUN_TIMEOUT_MS = 30_000;

/** Whether the rule at `rule` fires on `text`, per `omp ttsr test`. */
function fires(rule: string, scope: string, text: string, signal: AbortSignal | undefined): Promise<boolean> {
  const source = scope === "text" ? ["--source", "text"] : ["--source", "tool", "--tool", scope.slice("tool:".length)];
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const child = spawn("omp", ["ttsr", "test", "--rule", rule, "--json", ...source, "--file", "-"], {
    signal,
    timeout: RUN_TIMEOUT_MS,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  // A process that failed to start or exited early breaks the pipe; `error` and `close` report why.
  child.stdin.on("error", () => {});
  child.on("error", reject);
  child.on("close", (code, killedBy) => {
    if (code !== 0) {
      // `omp` reports some failures as JSON on stdout, others on stderr.
      const output = stderr.trim() || stdout.trim().slice(0, PREVIEW_CHARS);
      reject(new Error(output || (killedBy ? `killed by ${killedBy}` : `exit code ${code}`)));
      return;
    }
    try {
      resolve((JSON.parse(stdout) as { triggered: unknown[] }).triggered.length > 0);
    } catch {
      reject(new Error(`unreadable output: ${stdout.slice(0, PREVIEW_CHARS)}`));
    }
  });
  child.stdin.end(text);
  return promise;
}

/** Replays every sample of `check` in parallel and reports those the pattern misjudged. */
export async function replay(check: ReplayCase, signal?: AbortSignal): Promise<Verdict> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "skill-observer-replay-"));
    const rule = join(dir, "draft.md");
    const frontmatter = [frontmatterField("condition", check.condition), frontmatterField("scope", check.scope)];
    writeFileSync(rule, ["---", ...frontmatter, "---", "", "Replay check.", ""].join("\n"));
    const runs = [
      ...check.matches.map((text, index) => ({ sample: "matches" as const, index, text })),
      ...check.spares.map((text, index) => ({ sample: "spares" as const, index, text })),
    ];
    // Settle every run before the finally removes the rule file they read.
    const settled = await Promise.allSettled(runs.map((run) => fires(rule, check.scope, run.text, signal)));
    const fired = settled.map((result) => {
      if (result.status === "rejected") throw new Error(`\`omp ttsr test\` failed: ${(result.reason as Error).message}`);
      return result.value;
    });
    const misfires = runs
      .filter((run, i) => fired[i] !== (run.sample === "matches"))
      .map(({ sample, index, text }) => ({ sample, index, snippet: text.slice(0, PREVIEW_CHARS) }));
    return misfires.length === 0 ? { verdict: "passed" } : { verdict: "misfired", misfires };
  } catch (error) {
    return { verdict: "unchecked", reason: `the replay check could not run: ${(error as Error).message}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** A failed verdict as one line: which samples misfired, or why the check couldn't run. */
export function describeVerdict(verdict: Exclude<Verdict, { verdict: "passed" }>): string {
  if (verdict.verdict === "unchecked") return verdict.reason;
  const misfires = verdict.misfires.map(
    ({ sample, index, snippet }) => `\`${sample}[${index}]\` ${sample === "matches" ? "did not fire" : "fired"} on \`${snippet}\``,
  );
  return `the replay check failed: ${misfires.join("; ")}`;
}

/** Parameter schemas for a pattern's scope and samples, shared by both tools. */
export function sampleSchemas(z: SchemaBuilder): Record<"scope" | "matches" | "spares", Schema> {
  const sample = z.union([z.string(), z.record(z.unknown())]);
  return {
    scope: z
      .string()
      .optional()
      .describe("Where the pattern watches: `text` for the agent's text (the default), or `tool:<name>` for one tool's calls, as in `tool:bash`."),
    matches: z
      .array(sample)
      .optional()
      .describe(
        "Samples of the mistake, each of which the pattern must fire on. Each takes the form the scope sees: a string of prose for `text`, the resulting file content for `tool:edit` and `tool:write` (one sample per touched file), or the call's arguments as an object for any other tool.",
      ),
    spares: z.array(sample).optional().describe("Legitimate counterparts, none of which the pattern may fire on, each in the form `matches` takes."),
  };
}

type DraftCheck = { name: string } & (Verdict | { verdict: "rejected"; reason: string });

interface CheckDetails {
  results: DraftCheck[];
}

export function registerCheckTool(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool<{ drafts: PatternDraft[] }, CheckDetails>({
    name: CHECK_TOOL_NAME,
    label: "Observer Check",
    description:
      "Replay drafted barrier-rule patterns through OMP's TTSR engine: each must fire on every `matches` sample and on no `spares` sample. Reports per draft whether it passed and which samples misfired. Writes nothing.",
    parameters: z.object({
      drafts: z
        .array(
          z.object({
            name: z.string().describe("The rule's drafted name."),
            pattern: z.string().describe("Regex matching the mistake where `scope` watches."),
            ...sampleSchemas(z),
          }),
        )
        .describe("One entry per drafted pattern."),
    }),
    approval: "read",
    // Joins the active tools with observer_resolve at the session's first `/observe`.
    loadMode: "essential",
    defaultInactive: true,
    async execute(_toolCallId, params, signal) {
      const results = await Promise.all(
        params.drafts.map(async (draft): Promise<DraftCheck> => {
          let check: ReplayCase;
          try {
            check = replayCase(draft);
          } catch (error) {
            return { name: draft.name, verdict: "rejected", reason: (error as Error).message };
          }
          return { name: draft.name, ...(await replay(check, signal)) };
        }),
      );
      const lines = results.map((result) =>
        result.verdict === "passed"
          ? `- \`${result.name}\`: passed.`
          : `- \`${result.name}\`: ${result.verdict}, ${result.verdict === "rejected" ? result.reason : describeVerdict(result)}.`,
      );
      const text = [`Replayed ${results.length} draft(s) through \`omp ttsr test\`:`, ...lines];
      if (results.some((result) => result.verdict === "unchecked")) {
        text.push(
          "",
          "The check can't run in this session, so offer no barrier rule in this pass: record each barrier candidate as `later` with this reason, and say why in the summary.",
        );
      }
      return {
        content: [{ type: "text", text: text.join("\n") }],
        details: { results },
        isError: results.some((result) => result.verdict === "rejected" || result.verdict === "unchecked"),
      };
    },
  });
}
