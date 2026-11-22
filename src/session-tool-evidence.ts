/**
 * Session tool evidence: the branch's tool requests and outcomes, indexed by
 * call ID with their origin and branch position. Native records are the saved
 * transcript; hook records are this extension's copies of every call its tool
 * hooks see, which include calls the transcript does not show as its own, such
 * as nested `eval` calls and shell command dispatches. Records are kept as found,
 * contradictions included. The digest view, the strict completed-call lookup
 * and native placement each apply their own policy to them, and none is built
 * on another.
 */

import { isDeepStrictEqual } from "node:util";
import type {
  AgentMessage, ExtensionAPI, SessionEntry, ToolArguments, ToolCallEvent, ToolResultDetails, ToolResultEvent, ToolSupplier,
} from "./omp.js";

const HOOK_CALL_TYPE = "skill-observer-tool-call";
const HOOK_RESULT_TYPE = "skill-observer-tool-result";

export type ToolEvidenceOrigin = "native" | "hook";

export interface ToolCallEvidence {
  readonly origin: ToolEvidenceOrigin;
  /** Index of the branch entry holding the request. */
  readonly position: number;
  readonly id: string;
  readonly name: string | undefined;
  readonly args: ToolArguments;
  readonly authorization?: string;
}

export interface ToolResultEvidence {
  readonly origin: ToolEvidenceOrigin;
  /** Index of the branch entry holding the outcome. */
  readonly position: number;
  readonly id: string;
  readonly name: string | undefined;
  readonly isError: boolean | undefined;
  readonly content: AgentMessage["content"];
  readonly details: ToolResultDetails | undefined;
  /** Hook results only: the input the tool executed with, which can differ from the recorded request. */
  readonly input?: unknown;
  /** Hook results only: who supplied the tool, when the host's lookup found it. */
  readonly supplier?: ToolSupplier;
}

export interface CompletedToolCall {
  readonly call: ToolCallEvidence;
  readonly result: ToolResultEvidence;
  readonly observed?: { call: ToolCallEvidence; result: ToolResultEvidence };
}

export interface SessionToolEvidence {
  /**
   * The branch as the session digest reads it: hook records become ordinary
   * messages in branch order, each call ID keeps its first request and first
   * outcome whatever their origin, pure tool dispatches show their inner tools,
   * and `eval` and parallel wrappers give way to the structured calls they
   * carry. Lossy on purpose, so never receipt evidence; executable source stays
   * opaque.
   */
  digestEntries(): readonly SessionEntry[];
  /**
   * The one consistent request/result pair recorded for `id`, preferring a
   * complete native pair. Throws on missing, duplicate, contradictory or
   * out-of-order records instead of choosing among them. A failed outcome is
   * still completed; its status is the caller's policy.
   */
  completedCall(id: string): CompletedToolCall;
  /** Every pair `completedCall` returns for a call named exactly `name`, in branch order of their outcomes; IDs it refuses are left out. */
  completedCalls(name: string): CompletedToolCall[];
  /**
   * Whether the transcript holds `id` as a call the model made itself under
   * exactly `name`. Hook records never count, so a call nested in `eval`, or
   * the inner tool a device dispatch runs under its outer call's ID, is not
   * native. The assistant message reaches the branch only after a call's
   * `tool_call` hooks, so ask at result time.
   */
  isNativeCall(id: string, name: string): boolean;
}

type ContentBlock = Exclude<AgentMessage["content"], string | undefined>[number];

interface EntryRecords {
  readonly calls: readonly ToolCallEvidence[];
  readonly result: ToolResultEvidence | undefined;
}

interface IdRecords {
  readonly calls: ToolCallEvidence[];
  readonly results: ToolResultEvidence[];
}

/** Indexes one branch for one consumer invocation; the index holds no state beyond it. */
export function sessionToolEvidence(branch: readonly SessionEntry[]): SessionToolEvidence {
  const byPosition = branch.map((entry, position): EntryRecords => ({ calls: callsIn(entry, position), result: resultIn(entry, position) }));
  const byId = new Map<string, IdRecords>();
  const recordsFor = (id: string) => {
    let records = byId.get(id);
    if (!records) byId.set(id, records = { calls: [], results: [] });
    return records;
  };
  for (const { calls, result } of byPosition) {
    for (const call of calls) recordsFor(call.id).calls.push(call);
    if (result) recordsFor(result.id).results.push(result);
  }
  return {
    digestEntries: () => projectDigestEntries(branch, byPosition, byId),
    completedCall: (id) => {
      const records = byId.get(id);
      return pairCompletedCall(id, records?.calls ?? [], records?.results ?? []);
    },
    completedCalls: (name) => [...byId].flatMap(([id, { calls, results }]) => {
      if (!calls.some((call) => call.name === name)) return [];
      try {
        const completed = pairCompletedCall(id, calls, results);
        return completed.call.name === name ? [completed] : [];
      } catch {
        return [];
      }
    }).sort((a, b) => a.result.position - b.result.position),
    isNativeCall: (id, name) => byId.get(id)?.calls.some((call) => call.origin === "native" && call.name === name) ?? false,
  };
}

/**
 * Saves the hook copy of a starting call. Its native call is not on the branch
 * yet, so every call is copied; the views tell native ones apart later.
 */
export function recordHookCall(pi: ExtensionAPI, event: ToolCallEvent, authorization?: string): void {
  pi.appendEntry(HOOK_CALL_TYPE, { toolCallId: event.toolCallId, toolName: event.toolName, input: structuredClone(event.input), ...(authorization && { authorization }) });
}

/** Saves the hook copy of a call's outcome when its start was copied; an outcome alone has no request to pair with. */
export function recordHookResult(pi: ExtensionAPI, event: ToolResultEvent, branch: readonly SessionEntry[]): void {
  // The copied start is usually recent, so search backward and decode only hook call records.
  const isCopied = branch.findLast((entry, position) => entry.customType === HOOK_CALL_TYPE &&
    callsIn(entry, position).some((call) => call.id === event.toolCallId && call.name === event.toolName)) !== undefined;
  if (!isCopied) return;
  const supplier = toolSupplier(pi, event.toolName);
  pi.appendEntry(HOOK_RESULT_TYPE, {
    toolCallId: event.toolCallId, toolName: event.toolName, input: structuredClone(event.input),
    content: event.content, details: event.details, isError: event.isError, ...(supplier && { supplier }),
  });
}

/** The host's supplier for `name`; none when the lookup fails, which the digest shows as a supplier not recorded. */
function toolSupplier(pi: ExtensionAPI, name: string): ToolSupplier | undefined {
  try {
    const tool = pi.getAllTools().find((candidate) => candidate.name === name);
    if (!tool) return undefined;
    const { source, path } = tool.sourceInfo;
    return { source, path, ...(tool.mcpServerName !== undefined && { mcpServerName: tool.mcpServerName }) };
  } catch {
    // The copy serves the digest and receipts without a supplier, so a host lookup failure must not cost it.
    return undefined;
  }
}

function projectDigestEntries(
  branch: readonly SessionEntry[],
  byPosition: readonly EntryRecords[],
  byId: ReadonlyMap<string, IdRecords>,
): SessionEntry[] {
  const shellWrappers = new Set<string>();
  for (const [id, records] of byId) {
    const outer = records.results.find((result) => digestName(result.name) === "bash");
    if (!outer) continue;
    const command = records.calls.find((call) => digestName(call.name) === "bash")?.args.command;
    if (isPureToolCommandRun(outer, command, byId)) shellWrappers.add(id);
  }
  // A device dispatch runs its inner tool under the outer call's ID and that hook fires last, so the last hook name per ID is the leaf.
  const isDispatchLayer = (id: string, name: string) => {
    if (name === "bash" && shellWrappers.has(id)) return true;
    const leaf = byId.get(id)?.calls.findLast((call) => call.origin === "hook")?.name;
    return leaf !== undefined && digestName(leaf) !== name;
  };
  const requested = new Set<string>();
  const settled = new Set<string>();
  const nestedCalls = (args: ToolArguments | undefined): ContentBlock[] => {
    const uses = args?.tool_uses;
    if (!Array.isArray(uses)) return [];
    return uses.flatMap((item: unknown): ContentBlock[] => {
      if (!item || typeof item !== "object") return [];
      const use = item as { id?: string; toolCallId?: string; recipient_name?: string; parameters?: ToolArguments };
      const id = use.toolCallId ?? use.id;
      if (typeof use.recipient_name !== "string" || !id || requested.has(id)) return [];
      const name = digestName(use.recipient_name);
      if (isDispatchLayer(id, name)) return [];
      requested.add(id);
      return [{ type: "toolCall", id, name, arguments: use.parameters }];
    });
  };
  const projectCall = (block: ContentBlock): ContentBlock[] => {
    const name = digestName(block.name);
    if (block.id && (requested.has(block.id) || isDispatchLayer(block.id, name))) return [];
    if (block.id) requested.add(block.id);
    const isWrapper = name === "eval" || name === "multi_tool_use.parallel";
    return [...(isWrapper ? [] : [{ ...block, name }]), ...nestedCalls(block.arguments)];
  };
  const projectResult = (result: ToolResultEvidence): SessionEntry[] => {
    const name = digestName(result.name);
    if (settled.has(result.id) || isDispatchLayer(result.id, name)) return [];
    settled.add(result.id);
    const { timestamp } = branch[result.position]!;
    const supplier = byId.get(result.id)?.results.find((copy) => copy.origin === "hook" && digestName(copy.name) === name)?.supplier;
    return [{ type: "message", id: `tool-result:${result.id}`, ...(timestamp !== undefined && { timestamp }), message: {
      role: "toolResult", toolCallId: result.id, toolName: name, isError: result.isError, content: result.content, details: result.details,
      ...(supplier && { supplier }),
    } }];
  };
  return branch.flatMap((entry, position): SessionEntry[] => {
    const { calls: [call], result } = byPosition[position]!;
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.flatMap((block) => block.type === "toolCall" ? projectCall(block) : [block]);
      return [{ ...entry, type: "message", message: { ...message, content } }];
    }
    if (result?.id) return projectResult(result);
    if (entry.type === "custom" && (entry.customType === HOOK_CALL_TYPE || entry.customType === HOOK_RESULT_TYPE)) {
      const content = call?.id ? projectCall({ type: "toolCall", id: call.id, name: call.name, arguments: call.args }) : [];
      return content.length > 0 ? [{ type: "message", id: entry.id, message: { role: "assistant", content } }] : [];
    }
    if (message?.role === "toolResult") return [{ ...entry, type: "message", message: { ...message, toolName: digestName(message.toolName) } }];
    return [entry];
  });
}

function isPureToolCommandRun(outer: ToolResultEvidence, command: unknown, byId: ReadonlyMap<string, IdRecords>): boolean {
  const { toolCommands, trace } = outer.details ?? {};
  if (!Array.isArray(toolCommands) || !toolCommands.length || trace?.v !== 1 ||
      trace.status !== toolCommands.at(-1)?.exitCode || (trace.status !== 0) !== outer.isError ||
      typeof command !== "string" || trace.script !== command || !Array.isArray(trace.units)) return false;
  // shortcut: keep bash for possible redirects or expansions until the trace can rule out their effects.
  if (/[<>`$*?\[~]|[@+!]\(/u.test(command)) return false;
  let runs = 0;
  for (const unit of trace.units) {
    if (!Array.isArray(unit?.nodes)) return false;
    for (const node of unit.nodes) {
      if (node?.k === "and_or" || node?.k === "pipeline" || node?.k === "word") continue;
      if (node?.k !== "simple" || node.res !== "device" || node.runs !== 1) return false;
      runs++;
    }
  }
  return runs === toolCommands.length && toolCommands.every((dispatch, index) => {
    if (dispatch?.mode !== "execute" || typeof dispatch.tool !== "string" || ![0, 1].includes(dispatch.exitCode)) return false;
    const inner = byId.get(`${outer.id}:cmd:${index}`);
    const call = inner?.calls.find((record) => record.origin === "hook" && record.name === dispatch.tool);
    if (!inner || !call) return false;
    return inner.results.some((result) => result.origin === "hook" && result.name === dispatch.tool &&
      result.position > call.position && result.position < outer.position && result.isError === (dispatch.exitCode !== 0));
  });
}

/** Hosts can prefix a tool name with its namespace, as in `functions.read`. */
function digestName(name: string | undefined): string {
  return (name ?? "unknown").replace(/^(?:functions|tool)\./, "");
}

function callsIn(entry: SessionEntry, position: number): ToolCallEvidence[] {
  if (Array.isArray(entry.message?.content) && entry.message.role === "assistant") {
    return entry.message.content.flatMap((block) => block.type === "toolCall" && typeof block.id === "string"
      ? [{ origin: "native" as const, position, id: block.id, name: block.name, args: block.arguments ?? {} }]
      : []);
  }
  const data = entry.data;
  if (entry.type !== "custom" || entry.customType !== HOOK_CALL_TYPE || !data || typeof data !== "object" ||
      !("toolCallId" in data) || typeof data.toolCallId !== "string" || !("toolName" in data) || typeof data.toolName !== "string" ||
      !("input" in data) || !data.input || typeof data.input !== "object" || Array.isArray(data.input)) return [];
  return [{ origin: "hook", position, id: data.toolCallId, name: data.toolName, args: data.input as ToolArguments,
    ...("authorization" in data && typeof data.authorization === "string" && { authorization: data.authorization }) }];
}

function resultIn(entry: SessionEntry, position: number): ToolResultEvidence | undefined {
  const message = entry.message;
  if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
    return { origin: "native", position, id: message.toolCallId, name: message.toolName,
      isError: message.isError, content: message.content, details: message.details };
  }
  const data = entry.data;
  if (entry.type !== "custom" || entry.customType !== HOOK_RESULT_TYPE || !data || typeof data !== "object" ||
      !("toolCallId" in data) || typeof data.toolCallId !== "string" || !("toolName" in data) || typeof data.toolName !== "string" ||
      !("isError" in data) || typeof data.isError !== "boolean") return undefined;
  return { origin: "hook", position, id: data.toolCallId, name: data.toolName, isError: data.isError,
    content: "content" in data ? data.content as AgentMessage["content"] : undefined,
    details: "details" in data ? data.details as ToolResultDetails : undefined,
    input: "input" in data ? data.input : undefined,
    ...("supplier" in data && isToolSupplier(data.supplier) && { supplier: data.supplier }) };
}

function isToolSupplier(value: unknown): value is ToolSupplier {
  return !!value && typeof value === "object" && "source" in value && typeof value.source === "string" &&
    "path" in value && typeof value.path === "string" &&
    (!("mcpServerName" in value) || typeof value.mcpServerName === "string");
}

function pairCompletedCall(id: string, calls: readonly ToolCallEvidence[], results: readonly ToolResultEvidence[]): CompletedToolCall {
  const nativeCalls = calls.filter((record) => record.origin === "native");
  const hookCalls = calls.filter((record) => record.origin === "hook");
  const nativeResults = results.filter((record) => record.origin === "native");
  const hookResults = results.filter((record) => record.origin === "hook");
  const [nativeCall] = nativeCalls;
  const [hookCall] = hookCalls;
  const [nativeResult] = nativeResults;
  const [hookResult] = hookResults;
  const hasNativePair = nativeCall !== undefined && nativeResult !== undefined;
  const call = hasNativePair ? nativeCall : hookCall;
  const result = hasNativePair ? nativeResult : hookResult;
  const isDuplicated = [nativeCalls, hookCalls, nativeResults, hookResults].some((records) => records.length > 1);
  const isChangedHook = hookResult !== undefined && (!hookCall || hookResult.position <= hookCall.position ||
    hookResult.name !== hookCall.name || !isDeepStrictEqual(hookResult.input, hookCall.args));
  const isContradictory = nativeCall !== undefined && hookCall !== undefined && nativeCall.name !== hookCall.name ||
    nativeResult !== undefined && hookResult !== undefined &&
      (nativeResult.name !== hookResult.name || (nativeResult.isError === true) !== (hookResult.isError === true));
  if (isDuplicated || isChangedHook || isContradictory || !call || !result ||
      result.position <= call.position || result.name !== call.name) {
    throw new Error(`no completed observed tool call for ${id}`);
  }
  return { call, result, ...(hookCall && hookResult && { observed: { call: hookCall, result: hookResult } }) };
}
