import { OBSERVER_BOOKKEEPING_TOOLS } from "./digest.js";
import type { SessionEntry, ToolArguments } from "./omp.js";
import { isFromUser } from "./proposal-approval.js";
import { digestName, findBranchToolResult } from "./session-tool-evidence.js";

interface SourceEntry {
  id: string;
  role: "user" | "assistant" | "toolResult";
  text: string;
  clipped?: true;
}

interface BranchSource {
  entries: SourceEntry[];
  next?: string;
  gaps: string[];
}

const PAGE_SIZE = 6;
const MAX_TEXT = 2_000;
const MAX_CALL_ARGS = 1_000;
const gap = (reason: string): BranchSource => ({ entries: [], gaps: [reason] });

export function lookupBranchSource(branch: readonly SessionEntry[], passStart: number, { at, cursor }: { at?: string; cursor?: string }): BranchSource {
  if (at !== undefined && cursor !== undefined) return gap("Use either an exact `at` entry ID or a `cursor`, not both.");

  const positions = new Map<string, number>();
  branch.forEach(({ id }, position) => {
    if (id) positions.set(id, positions.has(id) ? -1 : position);
  });
  const beforePass = (id: string): number | undefined => {
    const position = positions.get(id);
    return position !== undefined && position >= 0 && position < passStart ? position : undefined;
  };

  if (at !== undefined) {
    const exact = positions.has(at);
    const errorId = exact ? undefined : /(?:^|:workflow:\/)(tool-result:.+):tool-error:$/.exec(at)?.[1];
    const steering = !exact && !at.startsWith("tool-result:") && at.endsWith(":steering:");
    const id = errorId ?? (steering ? at.slice(0, -":steering:".length) : at);
    const candidate = errorId !== undefined || (!positions.has(id) && id.startsWith("tool-result:"))
      ? toolResultEntry(branch, passStart, id, errorId !== undefined)
      : branch[beforePass(id) ?? -1];
    const entry = candidate?.id && (!steering || candidate.message?.steering === true)
      ? projectSource(candidate, candidate.id) : undefined;
    return entry ? { entries: [entry], gaps: [] } : gap("No unique entry with primary text at that ID on the pre-pass active branch.");
  }

  const page: BranchSource = { entries: [], gaps: [] };
  let end = passStart;
  if (cursor !== undefined) {
    const position = beforePass(cursor);
    if (position === undefined) return gap("The cursor does not name a unique entry on the pre-pass active branch.");
    end = position;
  } else {
    const compactedAt = branch.findLastIndex(({ type }, i) => i < passStart && type === "compaction");
    if (compactedAt >= 0) {
      const kept = branch[compactedAt]!.firstKeptEntryId;
      const firstKept = kept ? beforePass(kept) : undefined;
      if (firstKept !== undefined && firstKept < compactedAt) end = firstKept;
      else page.gaps.push("The latest compaction has no usable first-kept entry ID. This page starts before the pass instead.");
    }
  }

  for (let i = end - 1; i >= 0; i--) {
    const candidate = branch[i]!;
    const id = candidate.id;
    if (!id || positions.get(id) !== i) continue;
    const entry = projectSource(candidate, id);
    if (!entry) continue;
    if (page.entries.length === PAGE_SIZE) {
      page.next = page.entries.at(-1)!.id;
      break;
    }
    page.entries.push(entry);
  }
  if (page.entries.length === 0) page.gaps.push("No primary text is available before this position on the pre-pass active branch.");
  return page;
}

function toolResultEntry(branch: readonly SessionEntry[], end: number, id: string, requireError: boolean): SessionEntry | undefined {
  const result = findBranchToolResult(branch, end, id.slice("tool-result:".length));
  if (!result || (requireError && result.isError !== true)) return;
  return { type: "message", id, message: {
    role: "toolResult", toolName: result.name, toolCallId: result.id, content: result.content,
  } };
}

function projectSource({ type, message }: SessionEntry, id: string): SourceEntry | undefined {
  if (type !== "message" || !message || message.synthetic) return;
  const { role, content, toolName, toolCallId } = message;
  if (role !== "assistant" && role !== "toolResult" && !(role === "user" && isFromUser(message))) return;
  if (role === "toolResult" && Object.hasOwn(OBSERVER_BOOKKEEPING_TOOLS, digestName(toolName))) return;
  let text = "";
  let clipped = false;
  const append = (block: string) => {
    const remaining = MAX_TEXT - text.length;
    if (block.length > remaining) clipped = true;
    text += block.slice(0, remaining);
  };
  if (role === "assistant" && Array.isArray(content)) {
    let observerCall = false;
    for (const block of content) {
      if (block.type !== "toolCall" || !block.name) continue;
      const name = digestName(block.name);
      if (Object.hasOwn(OBSERVER_BOOKKEEPING_TOOLS, name)) {
        observerCall = true;
        continue;
      }
      const args = sourceArguments(block.arguments);
      clipped ||= args.clipped;
      if (text) append("\n");
      append("Tool call ");
      append(name);
      append(": ");
      append(args.text);
      if (clipped && text.length === MAX_TEXT) break;
    }
    if (observerCall && !text) return;
  }
  const marker = role === "toolResult" && toolCallId ? JSON.stringify({ observerToolCallId: toolCallId }) : undefined;
  if (typeof content === "string") append(content);
  else if (content) {
    let previousText = false;
    for (const block of content) {
      if (block.type !== "text") continue;
      if (marker !== undefined && block.text === marker) break;
      if (previousText || text && block.text) append("\n");
      append(block.text ?? "");
      previousText = true;
      if (clipped && text.length === MAX_TEXT) break;
    }
  }
  if (!text.trim()) return;
  return { id, role, text, ...(clipped && { clipped: true }) };
}

function sourceArguments(args: ToolArguments = {}): { text: string; clipped: boolean } {
  let text = "";
  let clipped = false;
  // shortcut: nested arguments are omitted; expand them only when a finding needs their contents.
  for (const key in args) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    const remaining = MAX_CALL_ARGS - text.length - 2;
    if (remaining <= 0 || key.length > remaining) return { text: `{${text.slice(0, MAX_CALL_ARGS - 3)}…}`, clipped: true };
    const prefix = `${text ? "," : ""}${JSON.stringify(key)}:`;
    const encoded = typeof value === "string" ? JSON.stringify(value.slice(0, remaining))
      : value === null || typeof value === "boolean" || typeof value === "number" ? JSON.stringify(value) : undefined;
    if (encoded === undefined || typeof value === "string" && value.length > remaining) clipped = true;
    const field = prefix + (encoded ?? "…");
    if (field.length > remaining) return { text: `{${text}${field.slice(0, remaining - 1)}…}`, clipped: true };
    text += field;
  }
  return { text: `{${text}}`, clipped };
}
