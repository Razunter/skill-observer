/**
 * Session digest builder: a function from saved session entries to the skill
 * signals an observation pass works from. Its only I/O is the injected
 * provenance resolver. The status hint and `/observe` both read it, so they
 * always agree on what counts as a signal.
 */

import type {
  AgentMessage,
  AskDetails,
  AskQuestion,
  SessionEntry,
  ToolArguments,
} from "./omp.js";
import type { ProvenanceResolver, SkillProvenance } from "./provenance.js";
import { AMENDMENT_REMINDER_TYPE, amendmentDelivery, remindedAmendments } from "./reminder.js";
import { sessionToolEvidence } from "./session-tool-evidence.js";

interface SignalBase {
  /** The user or a rule corrected the agent. Corrections and workflow outlines turn on the status hint. */
  correction: boolean;
  /** How many identical signals this one stands for. */
  count: number;
  /** The latest of the identical occurrences. */
  entryId?: string;
  occurrenceIds?: string[];
  /** On corrections: the ~200 characters of assistant text just before the latest occurrence. */
  before?: string;
}

interface AskSignalBase extends SignalBase {
  questionId?: string;
  question: string;
}

export type SkillSignal =
  | (SignalBase & { kind: "steering"; text: string })
  | (SignalBase & { kind: "rule-violation"; rules: string[] })
  | (AskSignalBase & { kind: "ask-custom-input"; customInput: string })
  | (AskSignalBase & { kind: "ask-off-recommendation"; recommended: string; selected: string[] })
  | (SignalBase & {
      kind: "tool-error";
      tool: string;
      /** Short summary of the call's arguments. */
      args: string;
      /** The error text, cut to about 300 characters. */
      error: string;
      /** Skills loaded earlier in the same turn. */
      skills: string[];
    })
  | (SignalBase & {
      kind: "workflow";
      /** One line per tool call of a turn with no skill loaded: name, argument summary, status. */
      calls: string[];
    });

/** A signal before identical ones are counted as one. */
type Uncounted<T> = T extends unknown ? Omit<T, "count"> : never;
type RawSignal = Uncounted<SkillSignal>;

/** How a skill entered the session: the model read it, or the user ran `/skill:<name>`. */
export type SkillLoadRoute = "read" | "slash-command";

/** A skill loaded in the session, listed once however many times it was loaded. */
export type LoadedSkill = SkillProvenance & {
  via: SkillLoadRoute[];
  /** On-read amendments delivered for the skill in this session, by rule name; absent when none were. */
  amendmentsDelivered?: string[];
};

export interface DigestEnvironment {
  provenance: ProvenanceResolver;
}

/** A finished tool result outside an observation pass, which remedy outcomes compare with a fix's evidence. */
export interface ToolExercise {
  entryId: string;
  tool: string;
  /** The call's one string argument; empty when it had any other shape. */
  args: string;
  failed: boolean;
  error?: string;
  deliveredRules: string[];
  /** When the result was saved; absent on an entry saved without a timestamp. */
  at?: string;
}

export interface SessionDigest {
  /** Oldest first; a counted signal sits where it last occurred. */
  signals: SkillSignal[];
  skills: LoadedSkill[];
  toolExercises?: ToolExercise[];
  /** Reads requested, including failed and unresolved requests; never proof of loading. */
  attemptedSkills?: SkillProvenance[];
  /** Managed skills created with `manage_skill` in this session, by name. */
  createdSkills: string[];
}

const RECOMMENDED_SUFFIX = /\s*\(Recommended\)$/;

/**
 * The label the model recommended: the `recommended` index, or else an option
 * the model labelled "(Recommended)" by hand.
 */
function recommendedLabel(question: AskQuestion): string | undefined {
  const labels = (question.options ?? []).map((option) => option.label ?? "");
  if (typeof question.recommended === "number") return labels[question.recommended];
  return labels.find((label) => RECOMMENDED_SUFFIX.test(label));
}

function askSignals(
  entryId: string | undefined,
  call: ToolArguments,
  details: AskDetails,
  resultText: string,
): RawSignal[] {
  if (Array.isArray(details.answers)) return formAskSignals(entryId, call.html ?? "", details, resultText);
  const questions = call.questions ?? [];
  const answers = details.results ?? (details.selectedOptions || details.customInput ? [details] : []);
  const signals: RawSignal[] = [];
  for (const answer of answers) {
    const asked =
      questions.find((q) => answer.id !== undefined && q.id === answer.id) ??
      questions.find((q) => answer.question !== undefined && q.question === answer.question) ??
      (questions.length === 1 ? questions[0] : undefined);
    const base = {
      correction: true,
      entryId,
      questionId: answer.id ?? asked?.id,
      question: answer.question ?? asked?.question ?? "",
    };

    const customInput = clip(answer.customInput ?? "", CORRECTION_TEXT_CHARS);
    if (customInput) {
      signals.push({ ...base, kind: "ask-custom-input", customInput });
      continue;
    }

    const recommended = asked && recommendedLabel(asked);
    const selected = answer.selectedOptions ?? [];
    if (recommended === undefined || selected.length === 0) continue;
    const tookRecommendation =
      selected.length === 1 &&
      selected[0]!.replace(RECOMMENDED_SUFFIX, "") === recommended.replace(RECOMMENDED_SUFFIX, "");
    if (!tookRecommendation) {
      signals.push({ ...base, kind: "ask-off-recommendation", recommended, selected });
    }
  }
  return signals;
}

const CUSTOM_INPUT_PREFIX = "Other: ";

/** Signals of an answered HTML form, the shape `ask` has had since OMP 18.18. */
function formAskSignals(
  entryId: string | undefined,
  html: string,
  details: AskDetails,
  resultText: string,
): RawSignal[] {
  // The deadline submitted the form's defaults; the user answered nothing.
  if (details.timedOut) return [];
  const signals: RawSignal[] = [];
  for (const answer of details.answers ?? []) {
    const base = { correction: true, entryId, questionId: answer.name, question: answer.question ?? "" };

    if (answer.answer?.startsWith(CUSTOM_INPUT_PREFIX)) {
      const customInput = clip(answer.answer.slice(CUSTOM_INPUT_PREFIX.length), CORRECTION_TEXT_CHARS);
      if (customInput) signals.push({ ...base, kind: "ask-custom-input", customInput });
      continue;
    }

    if (answer.name === undefined) continue;
    const preselected = preselectedValues(html, answer.name);
    const selected = submittedValues(resultText, answer.name);
    if (preselected.length === 0 || selected.length === 0) continue;
    const tookPreselection =
      selected.length === preselected.length && selected.every((value) => preselected.includes(value));
    if (!tookPreselection) {
      signals.push({ ...base, kind: "ask-off-recommendation", recommended: preselected.join(", "), selected });
    }
  }
  return signals;
}

const INPUT_TAG = /<input\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
const CHARACTER_REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The values of the radios and checkboxes named `name` that the form shows already chosen. */
function preselectedValues(html: string, name: string): string[] {
  // shortcut: a <select>'s `selected` option is not scanned, scan it when the digest must see select defaults.
  const values: string[] = [];
  for (const [, tagBody = ""] of html.matchAll(INPUT_TAG)) {
    const attributes = new Map<string, string>();
    for (const [, key = "", double, single, bare] of tagBody.matchAll(ATTRIBUTE)) {
      const raw = double ?? single ?? bare ?? "";
      const decoded = raw.replace(CHARACTER_REFERENCE, (reference, decimal?: string, hex?: string, entity?: string) => {
        if (entity) return ENTITIES[entity]!;
        const codePoint = decimal ? Number(decimal) : Number.parseInt(hex!, 16);
        // A reference past the last code point stays as written: String.fromCodePoint throws on it.
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : reference;
      });
      attributes.set(key.toLowerCase(), decoded);
    }
    const type = attributes.get("type")?.toLowerCase();
    const isChoice = type === "radio" || type === "checkbox";
    const value = attributes.get("value");
    if (isChoice && attributes.has("checked") && attributes.get("name") === name && value) values.push(value);
  }
  return values;
}

/** What the form submitted for `name`, from the JSON object the result text carries after its first line. */
function submittedValues(resultText: string, name: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(resultText.slice(resultText.indexOf("\n") + 1));
  } catch {
    // A result text without the JSON cannot show what was submitted, so it supports no signal.
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const value = (data as Record<string, unknown>)[name];
  return (Array.isArray(value) ? value : [value])
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map(String)
    .filter(Boolean);
}

function textOf(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

const SKILL_URL = /^skill:\/\/([^/:\s]+)/;
/** A physical `SKILL.md` path, with an optional `read` selector such as `:10-20` or `:raw`. */
const SKILL_FILE = /^(.*\/SKILL\.md)(?::[^/]*)?$/;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/** The skill a `read` call loads: any `skill://` URL, or a local `SKILL.md` path. */
function skillReadBy(path: string, provenance: ProvenanceResolver): SkillProvenance | undefined {
  const url = SKILL_URL.exec(path);
  if (url) return provenance.byName(url[1]!);
  const file = SKILL_FILE.exec(path);
  if (file && !URL_SCHEME.test(path)) return provenance.byPath(file[1]!);
  return undefined;
}

/** The skill a `/skill:<name>` prompt started: its recorded path, else its name. */
function skillStartedBy(
  details: SessionEntry["details"],
  provenance: ProvenanceResolver,
): SkillProvenance | undefined {
  const byPath = details?.path ? provenance.byPath(details.path) : undefined;
  if (byPath && byPath.kind !== "unknown") return byPath;
  return details?.name ? provenance.byName(details.name) : byPath;
}

/** A turn with no skill loaded needs this many tool calls to count as a workflow. */
const MIN_WORKFLOW_CALLS = 3;
const ARGS_SUMMARY_CHARS = 80;
const ERROR_CHARS = 300;
/** Corrections stay nearly whole; the cut only stops a pasted log from filling the digest. */
const CORRECTION_TEXT_CHARS = 2000;
const BEFORE_CORRECTION_CHARS = 200;
/** Calls past this many in one turn are counted, not listed. */
const MAX_OUTLINE_CALLS = 50;

/** Argument keys that name what a call acts on, most telling first. */
const SUMMARY_KEYS = ["path", "command", "pattern", "query", "url", "name", "action", "op"];

/** Whitespace runs folded to single spaces, then cut to `max` characters. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** The last `max` characters of `text`, starting at a word, with whitespace folded. */
function tail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(-max);
  const midWord = flat[flat.length - max - 1] !== " ";
  return `…${midWord ? cut.slice(cut.indexOf(" ") + 1) : cut}`;
}

/** A short summary of what a tool call acted on; a subagent run names its tasks. */
function summarizeArgs(args: ToolArguments | undefined): string {
  if (!args) return "";
  if (Array.isArray(args.tasks)) {
    const tasks = args.tasks.map((task) =>
      [task.name, task.agent && `(${task.agent})`].filter(Boolean).join(" "),
    );
    return clip(`${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${tasks.join(", ")}`, ARGS_SUMMARY_CHARS);
  }
  const key = SUMMARY_KEYS.find((candidate) => typeof args[candidate] === "string");
  const summary = key ? (args[key] as string) : typeof args.i === "string" ? args.i : "";
  // A path's end names the file; its start is usually a long shared prefix.
  if (key === "path" && summary.length > ARGS_SUMMARY_CHARS) {
    return `…${summary.slice(-ARGS_SUMMARY_CHARS)}`;
  }
  return clip(summary, ARGS_SUMMARY_CHARS);
}

interface ToolCallRecord {
  id?: string;
  name: string;
  args: string;
  status: "ok" | "error" | "no result";
  /** A `task` call's subagent jobs and their latest status, by job id. */
  jobs?: Map<string, string>;
  exerciseArgs?: string;
  skill?: SkillProvenance;
}

/** One user prompt and everything the agent did until the next one. */
interface Turn {
  /** Skills loaded so far in this turn, by name. */
  skills: string[];
  calls: ToolCallRecord[];
  /** An observation pass: its calls are no manual workflow and its tool errors no skill signal. */
  observing: boolean;
}

/** Subagent statuses: `completed` when all agree, else a count per status. */
function jobStatus(jobs: ReadonlyMap<string, string>): string {
  const counts = new Map<string, number>();
  for (const status of jobs.values()) counts.set(status, (counts.get(status) ?? 0) + 1);
  if (counts.size === 1) return [...counts.keys()][0]!;
  return [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
}

function outlineLine(call: ToolCallRecord): string {
  const status = call.jobs?.size ? jobStatus(call.jobs) : call.status;
  return [call.name, call.args && JSON.stringify(call.args), status].filter(Boolean).join(" ");
}

/** A background job's status as its `async-result` delivery states it. */
const DELIVERED_TASK = /<task-result id="([^"]+)"[^>]*\bstatus="([^"]+)"/g;

function outline(calls: readonly ToolCallRecord[]): string[] {
  const lines = calls.slice(0, MAX_OUTLINE_CALLS).map(outlineLine);
  const hidden = calls.length - lines.length;
  return hidden > 0 ? [...lines, `… and ${hidden} more calls`] : lines;
}

/** What makes two signals identical: everything but where and after what they occurred. */
function identity(signal: RawSignal): string {
  return JSON.stringify(signal, (key, value) =>
    key === "entryId" || key === "before" || key === "occurrenceIds" ? undefined : value,
  );
}

/** A prompt the user typed; steering and harness-written user messages are not. */
function isUserPrompt(message: AgentMessage): boolean {
  return (
    message.role === "user" && !message.steering && !message.synthetic && message.attribution !== "agent"
  );
}

/** The `customType` of the message `/observe` sends to start an observation pass. */
export const OBSERVATION_MESSAGE_TYPE = "skill-observer";

export function buildDigest(
  entries: readonly SessionEntry[],
  env: DigestEnvironment,
): SessionDigest {
  entries = sessionToolEvidence(entries).digestEntries();
  const attemptedSkills = new Map<string, SkillProvenance>();
  const toolExercises: ToolExercise[] = [];
  const skills = new Map<string, LoadedSkill>();
  const createdSkills = new Set<string>();
  // Keyed by identity; a repeat moves its signal to the end, where it last occurred.
  const signals = new Map<string, SkillSignal>();
  /** `within` names the occurrence this one is part of, so evidence citing both counts one occurrence. */
  const add = (signal: RawSignal, within?: string) => {
    const key = identity(signal);
    const previous = signals.get(key);
    const own = signal.entryId ? `${signal.entryId}:${signal.kind}:${"questionId" in signal ? signal.questionId ?? "" : ""}` : undefined;
    const occurrenceId = own && within ? `${within}/${own}` : own;
    const occurrenceIds = [...new Set([...(previous?.occurrenceIds ?? []), ...(occurrenceId ? [occurrenceId] : [])])];
    const count = occurrenceIds.length || (previous?.count ?? 0) + 1;
    signals.delete(key);
    signals.set(key, { ...signal, count, ...(occurrenceIds.length ? { occurrenceIds } : {}) } as SkillSignal);
  };
  let turn: Turn = { skills: [], calls: [], observing: false };

  const loadSkill = (skill: SkillProvenance | undefined, route: SkillLoadRoute): LoadedSkill | undefined => {
    if (!skill) return undefined;
    if (!turn.skills.includes(skill.name)) turn.skills.push(skill.name);
    const key = skill.kind === "unknown" ? `unknown:${skill.name}` : skill.path;
    const loaded = skills.get(key) ?? { ...skill, via: [] };
    skills.set(key, loaded);
    if (!loaded.via.includes(route)) loaded.via.push(route);
    return loaded;
  };
  /** Records an on-read amendment as delivered on its skill's entry, which the delivery also loads. */
  const deliverAmendment = (rule: string, skill: string, route: SkillLoadRoute) => {
    const loaded = loadSkill(env.provenance.byName(skill), route);
    if (loaded && !loaded.amendmentsDelivered?.includes(rule)) {
      loaded.amendmentsDelivered = [...(loaded.amendmentsDelivered ?? []), rule];
    }
  };
  const startTurn = (observing = false) => {
    if (!turn.observing && turn.skills.length === 0 && turn.calls.length >= MIN_WORKFLOW_CALLS) {
      add({ kind: "workflow", correction: false, entryId: turn.calls[0]?.id, calls: outline(turn.calls) });
    }
    turn = { skills: [], calls: [], observing };
  };

  // Assistant text the user saw last, kept to show what a correction answers.
  let lastProse = "";
  const correct = (signal: RawSignal) => {
    const before = tail(lastProse, BEFORE_CORRECTION_CHARS);
    add(before ? { ...signal, before } : signal);
  };

  // A rule interrupt leaves a `ttsr-injection` message followed by a
  // `ttsr_injection` entry parented to it; rules injected into tool results
  // leave only the entry. Count each rule-violation signal once, from the entry.
  const recordedInterrupts = new Set<string | null | undefined>();
  for (const entry of entries) {
    if (entry.type === "ttsr_injection") recordedInterrupts.add(entry.parentId);
  }

  const askCalls = new Map<string, ToolArguments>();
  const calls = new Map<string, ToolCallRecord>();
  // Subagent job id → the `task` call that spawned it.
  const jobs = new Map<string, ToolCallRecord>();
  const settleJob = (id: string | undefined, status: string | undefined) => {
    if (id && status) jobs.get(id)?.jobs?.set(id, status);
  };
  for (const entry of entries) {
    if (entry.type === "custom_message" && entry.customType === "skill-prompt") {
      startTurn();
      loadSkill(skillStartedBy(entry.details, env.provenance), "slash-command");
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === OBSERVATION_MESSAGE_TYPE) {
      startTurn(true);
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === AMENDMENT_REMINDER_TYPE) {
      // The reminder names its skills and rules itself, so a rule deleted since still shows as delivered.
      for (const { rule, skill } of remindedAmendments(entry.content ?? "")) deliverAmendment(rule, skill, "slash-command");
      continue;
    }
    const delivery = amendmentDelivery(entry);
    if (delivery) {
      for (const rule of delivery.rules) deliverAmendment(rule, delivery.skill, "read");
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "async-result") {
      for (const [, id, status] of (entry.content ?? "").matchAll(DELIVERED_TASK)) {
        settleJob(id, status);
      }
      continue;
    }

    const injectedRules =
      entry.type === "ttsr_injection"
        ? (entry.injectedRules ?? [])
        : entry.type === "custom_message" &&
            entry.customType === "ttsr-injection" &&
            !recordedInterrupts.has(entry.id)
          ? (entry.details?.rules ?? [])
          : undefined;
    if (injectedRules) {
      // On-read amendments never reach TTSR, so every rule OMP injects caught a mistake.
      if (injectedRules.length > 0) {
        correct({
          kind: "rule-violation",
          correction: true,
          entryId: entry.id,
          rules: injectedRules,
        });
      }
      continue;
    }

    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (isUserPrompt(message)) {
      startTurn();
    } else if (message.role === "user" && message.steering && message.attribution !== "agent") {
      correct({
        kind: "steering",
        correction: true,
        entryId: entry.id,
        text: clip(textOf(message.content), CORRECTION_TEXT_CHARS),
      });
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      const prose = textOf(message.content);
      if (prose.trim()) lastProse = prose;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const call: ToolCallRecord = {
          id: block.id ?? entry.id,
          name: block.name ?? "unknown",
          args: summarizeArgs(block.arguments),
          status: "no result",
        };
        // Hosts fill unset options with null or false; only a call with one set string argument is comparable.
        const argumentKeys = Object.entries(block.arguments ?? {})
          .filter(([key, value]) => key !== "i" && value !== null && value !== undefined && value !== false).map(([key]) => key);
        if (argumentKeys.length === 1 && typeof block.arguments?.[argumentKeys[0]!] === "string" &&
            (block.arguments[argumentKeys[0]!] as string).length <= ARGS_SUMMARY_CHARS) {
          call.exerciseArgs = call.args;
        }
        turn.calls.push(call);
        if (block.id) calls.set(block.id, call);
        if (block.name === "ask" && block.id) {
          askCalls.set(block.id, block.arguments ?? {});
        } else if (block.name === "read" && typeof block.arguments?.path === "string") {
          call.skill = skillReadBy(block.arguments.path, env.provenance);
          if (call.skill) attemptedSkills.set(call.skill.kind === "unknown" ? call.skill.name : call.skill.path, call.skill);
        }
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId ?? "");
      if (call) call.status = message.isError ? "error" : "ok";
      if (call?.skill && !message.isError) loadSkill(call.skill, "read");
      // A background job or service has not finished, so its result proves nothing yet.
      const unfinished = message.details?.async !== undefined || message.details?.service !== undefined;
      if (call && !turn.observing && entry.id && !unfinished) {
        toolExercises.push({ entryId: entry.id, tool: call.name, args: call.exerciseArgs ?? "", failed: Boolean(message.isError),
          ...(message.isError ? { error: clip(textOf(message.content), ERROR_CHARS) } : {}),
          deliveredRules: [...skills.values()].flatMap((skill) => skill.amendmentsDelivered ?? []),
          ...(entry.timestamp !== undefined && { at: entry.timestamp }) });
      }
      // A cancelled ask is an error result with empty details; it is no signal.
      const cancelledAsk =
        message.toolName === "ask" && Object.keys(message.details ?? {}).length === 0;
      if (message.isError) {
        if (cancelledAsk || turn.observing) continue;
        add({
          kind: "tool-error",
          correction: false,
          entryId: entry.id,
          tool: message.toolName ?? call?.name ?? "unknown",
          args: call?.args ?? "",
          error: clip(textOf(message.content), ERROR_CHARS),
          skills: [...turn.skills],
        }, turn.calls[0]?.id && `${turn.calls[0].id}:workflow:`);
      } else if (message.toolName === "ask" && message.details) {
        const askCall = askCalls.get(message.toolCallId ?? "") ?? {};
        const firstText = typeof message.content === "string"
          ? message.content
          : message.content?.find((block) => block.type === "text")?.text ?? "";
        for (const signal of askSignals(entry.id, askCall, message.details, firstText)) {
          if (!turn.observing || signal.kind === "ask-custom-input") correct(signal);
        }
      } else if (
        message.toolName === "manage_skill" &&
        message.details?.action === "create" &&
        message.details.name
      ) {
        createdSkills.add(message.details.name);
      } else if (call && message.toolName === "task" && message.details?.progress?.length) {
        call.jobs = new Map();
        for (const job of message.details.progress) {
          if (!job.id) continue;
          call.jobs.set(job.id, job.status ?? "pending");
          jobs.set(job.id, call);
        }
      } else {
        for (const job of message.details?.jobs ?? []) settleJob(job.id, job.status);
      }
    }
  }
  startTurn();
  return {
    signals: [...signals.values()],
    skills: [...skills.values()],
    attemptedSkills: [...attemptedSkills.values()],
    toolExercises,
    createdSkills: [...createdSkills],
  };
}

/** True when the digest gives an observation pass nothing to work from. */
export function isEmptyDigest(digest: SessionDigest): boolean {
  return digest.signals.length === 0 && digest.skills.length === 0;
}

/** How often each rule broke as a rule violation in the digest, by rule name. */
export function ruleViolationCounts(digest: SessionDigest): Map<string, number> {
  const counts = new Map<string, number>();
  for (const signal of digest.signals) {
    if (signal.kind !== "rule-violation") continue;
    for (const rule of signal.rules) counts.set(rule, (counts.get(rule) ?? 0) + signal.count);
  }
  return counts;
}

const ROUTE_TEXT: Record<SkillLoadRoute, string> = {
  read: "read by the model",
  "slash-command": "started by the user with /skill:",
};

function renderSkill(skill: LoadedSkill): string {
  const routes = skill.via.map((route) => ROUTE_TEXT[route]).join(" and ");
  const amendments = skill.amendmentsDelivered
    ? `; amendments delivered: ${skill.amendmentsDelivered.map((rule) => `\`${rule}\``).join(", ")}`
    : "";
  if (skill.kind === "unknown") return `- \`${skill.name}\`: provenance unknown; ${routes}${amendments}.`;
  return `- \`${skill.name}\`: ${skill.kind}; ${routes}${amendments}. File: \`${skill.path}\``;
}

function signalBody(signal: SkillSignal): string {
  switch (signal.kind) {
    case "steering":
      return `Steering message the user typed mid-turn: ${JSON.stringify(signal.text)}`;
    case "rule-violation":
      return `Rule violation: ${signal.rules.map((rule) => `\`${rule}\``).join(", ")} fired.`;
    case "ask-custom-input":
      return `Ask answered with custom input. Question: ${JSON.stringify(signal.question)} Answer: ${JSON.stringify(signal.customInput)}`;
    case "ask-off-recommendation":
      return `Ask answered against the recommendation. Question: ${JSON.stringify(signal.question)} Recommended: ${JSON.stringify(signal.recommended)} Chosen: ${JSON.stringify(signal.selected.join(", "))}`;
    case "tool-error": {
      const skills =
        signal.skills.length > 0
          ? `Skills loaded this turn: ${signal.skills.map((skill) => `\`${skill}\``).join(", ")}.`
          : "No skill loaded this turn.";
      return `${toolErrorText(signal.tool, signal.args, signal.error)} ${skills}`;
    }
    case "workflow":
      return [
        "Tool outline of a turn with no skill loaded:",
        ...signal.calls.map((call) => `   - ${call}`),
      ].join("\n");
  }
}

function renderSignal(signal: SkillSignal): string {
  const count = signal.count > 1 ? `(×${signal.count}) ` : "";
  const before = signal.before
    ? `\n   Assistant text just before it: ${JSON.stringify(signal.before)}`
    : "";
  const occurrences = signal.occurrenceIds?.length ? ` [occurrences: ${signal.occurrenceIds.join(", ")}]` : "";
  return `${count}${signalBody(signal)}${occurrences}${before}`;
}

/**
 * How the digest quotes a failed call, and so how a proposal's evidence quotes
 * it: without `error`, the prefix that names the call alone.
 */
export function toolErrorText(tool: string, args: string, error?: string): string {
  const call = [`\`${tool}\``, args && JSON.stringify(args)].filter(Boolean).join(" ");
  return `Tool error in ${call}:${error === undefined ? "" : ` ${JSON.stringify(error)}`}`;
}

/** The rendered digest stays within this many tokens. */
export const DIGEST_TOKEN_CAP = 12_000;
/** Tokens are estimated from characters; exact tokenisation is not needed. */
const CHARS_PER_TOKEN = 4;
/** Room kept for the dropped-signals line and list numbering slack. */
const DROP_NOTE_CHARS = 120;

/**
 * The digest as the markdown an observation pass reads, oldest signal first.
 * When it would exceed `tokenCap`, the oldest signals are dropped and the
 * text says how many. Each kept signal gets an id, `S1` for the oldest kept
 * one, which the pass's proposals cite; ids hold only within one pass.
 */
export function renderDigest(digest: SessionDigest, tokenCap = DIGEST_TOKEN_CAP): string {
  const { head, bodies } = digestParts(digest);
  if (bodies.length === 0) return `${head}\nNone.`;

  const first = droppedCount(head, bodies, tokenCap);
  const kept = bodies.slice(first).map((body, index) => `- S${index + 1}: ${body}`);
  const dropped =
    first > 0
      ? [
          `${first} older signal${first === 1 ? " was" : "s were"} dropped to keep the digest under its cap.`,
          "",
        ]
      : [];
  return [head, ...dropped, ...kept].join("\n");
}

/** How many of the oldest signals {@link renderDigest} leaves out to stay within `tokenCap`. */
export function droppedSignalCount(digest: SessionDigest, tokenCap = DIGEST_TOKEN_CAP): number {
  const { head, bodies } = digestParts(digest);
  return droppedCount(head, bodies, tokenCap);
}

function digestParts(digest: SessionDigest): { head: string; bodies: string[] } {
  const skills = digest.skills.length > 0 ? digest.skills.map(renderSkill) : ["None."];
  const created =
    digest.createdSkills.length > 0
      ? digest.createdSkills.map((name) => `- \`${name}\``)
      : ["None."];
  const head = [
    "### Skills loaded",
    "",
    ...skills,
    "",
    "### Managed skills created this session",
    "",
    ...created,
    "",
    "### Signals",
    "",
  ].join("\n");
  return { head, bodies: digest.signals.map(renderSignal) };
}

/** The newest bodies that fit after `head` are kept; the count of the older rest. */
function droppedCount(head: string, bodies: readonly string[], tokenCap: number): number {
  const linePrefixChars = `- S${bodies.length}: `.length + 1;
  let room = tokenCap * CHARS_PER_TOKEN - head.length - DROP_NOTE_CHARS;
  let first = bodies.length;
  while (first > 0 && bodies[first - 1]!.length + linePrefixChars <= room) {
    first -= 1;
    room -= bodies[first]!.length + linePrefixChars;
  }
  return first;
}
