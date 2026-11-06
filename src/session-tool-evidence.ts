/**
 * Session tool evidence: the branch's tool requests and outcomes, indexed by
 * call ID with their origin and branch position. Native records are the saved
 * transcript; hook records are this extension's copies of every call its tool
 * hooks see, which include calls the transcript does not show as its own, such
 * as nested `eval` calls and device dispatches. Records are kept as found,
 * contradictions included. The digest view, the strict completed-call lookup
 * and native placement each apply their own policy to them, and none is built
 * on another.
 */

import { isDeepStrictEqual } from "node:util";
import type {
  AgentMessage, ExtensionAPI, SessionEntry, ToolArguments, ToolCallEvent, ToolResultDetails, ToolResultEvent,
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
}

export interface CompletedToolCall {
  readonly call: ToolCallEvidence;
  readonly result: ToolResultEvidence;
}

export interface SessionToolEvidence {
  /**
   * The branch as the session digest reads it: hook records become ordinary
   * messages in branch order, each call ID keeps its first request and first
   * outcome whatever their origin, a device dispatch shows only its inner tool,
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
    isNativeCall: (id, name) => byId.get(id)?.calls.some((call) => call.origin === "native" && call.name === name) ?? false,
  };
}

/**
 * Saves the hook copy of a starting call. Its native call is not on the branch
 * yet, so every call is copied; the views tell native ones apart later.
 */
export function recordHookCall(pi: ExtensionAPI, event: ToolCallEvent): void {
  pi.appendEntry(HOOK_CALL_TYPE, { toolCallId: event.toolCallId, toolName: event.toolName, input: structuredClone(event.input) });
}

/** Saves the hook copy of a call's outcome when its start was copied; an outcome alone has no request to pair with. */
export function recordHookResult(pi: ExtensionAPI, event: ToolResultEvent, branch: readonly SessionEntry[]): void {
  // The copied start is usually recent, so search backward and decode only hook call records.
  const isCopied = branch.findLast((entry, position) => entry.customType === HOOK_CALL_TYPE &&
    callsIn(entry, position).some((call) => call.id === event.toolCallId && call.name === event.toolName)) !== undefined;
  if (isCopied) pi.appendEntry(HOOK_RESULT_TYPE, {
    toolCallId: event.toolCallId, toolName: event.toolName, input: structuredClone(event.input),
    content: event.content, details: event.details, isError: event.isError,
  });
}

function projectDigestEntries(
  branch: readonly SessionEntry[],
  byPosition: readonly EntryRecords[],
  byId: ReadonlyMap<string, IdRecords>,
): SessionEntry[] {
  // A device dispatch runs its inner tool under the outer call's ID and that hook fires last, so the last hook name per ID is the leaf.
  const isDispatchLayer = (id: string, name: string) => {
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
      requested.add(id);
      return [{ type: "toolCall", id, name: digestName(use.recipient_name), arguments: use.parameters }];
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
    return [{ type: "message", id: `tool-result:${result.id}`, ...(timestamp !== undefined && { timestamp }), message: {
      role: "toolResult", toolCallId: result.id, toolName: name, isError: result.isError, content: result.content, details: result.details,
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
  return [{ origin: "hook", position, id: data.toolCallId, name: data.toolName, args: data.input as ToolArguments }];
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
    input: "input" in data ? data.input : undefined };
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
  return { call, result };
}
