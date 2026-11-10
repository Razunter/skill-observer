/**
 * The slice of OMP's extension API and session-file shapes this extension
 * uses, typed structurally so the package needs no dependency on the OMP
 * runtime. Names and shapes follow OMP's `ExtensionAPI` / `ExtensionContext`
 * (see `omp://extensions.md`) and real session files.
 */

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: ToolArguments;
}

/**
 * Tool-call arguments. The digest reads `html` for `ask` (`questions` on a
 * call saved before OMP 18.18), `path` for `read`, `tasks` for `task`, and any
 * short string argument for the outline.
 */
export type ToolArguments = {
  html?: string;
  questions?: AskQuestion[];
  path?: string;
  tasks?: Array<{ name?: string; agent?: string }>;
} & Record<string, unknown>;

export interface AgentMessage {
  role: string;
  content?: string | ContentBlock[];
  steering?: boolean;
  attribution?: "user" | "agent";
  /** Set on harness-written messages, such as reminders. */
  synthetic?: boolean;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: ToolResultDetails;
}

/**
 * One line of the session JSONL, as returned by `sessionManager.getBranch()`.
 * Only the fields the digest reads are typed; each is optional because its
 * presence depends on `type`.
 */
export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  /** When OMP saved the entry, as an ISO 8601 string. */
  timestamp?: string;
  /** `message` entries. */
  message?: AgentMessage;
  /** `custom_message` entries. */
  customType?: string;
  /** `custom_message` text; on `async-result` messages it carries each `<task-result>` status. */
  content?: string;
  /**
   * `rules` on `ttsr-injection` messages and on the amendment reminders this
   * extension adds; `name` and `path` on `skill-prompt` messages.
   */
  details?: { rules?: string[]; name?: string; path?: string };
  /** `ttsr_injection` entries. */
  injectedRules?: string[];
  /** `compaction` entries: the first entry the compaction kept in context. */
  firstKeptEntryId?: string;
  /** `custom` entries, which never reach the model: an extension's own records, read according to `customType`. */
  data?: unknown;
}

/**
 * A question of an `ask` call saved before OMP 18.18, which took `questions`
 * instead of one HTML form. Saved arguments are read as untrusted, so every
 * field stays optional.
 */
export interface AskQuestion {
  id?: string;
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string; preview?: string }>;
  multi?: boolean;
  recommended?: number;
}

/** One answer in an `ask` result saved before OMP 18.18. */
interface LegacyAskAnswer {
  /** Set on batched results only; a single answer spread into the details has none. */
  id?: string;
  question?: string;
  /** The asked option labels, in order. */
  options?: string[];
  multi?: boolean;
  selectedOptions?: string[];
  customInput?: string;
}

/**
 * One named field of an answered `ask` form, as the host's `FormAnswer`:
 * `answer` is the chosen option's label on one line, several joined with `, `,
 * `Other: <text>` for the free text the host adds to radio and checkbox
 * groups, the text of a text field, or empty when nothing was chosen.
 */
export interface AskFormAnswer {
  name?: string;
  question?: string;
  answer?: string;
}

/**
 * `ask` result details: `answers` for every named field of the form, in form
 * order, and `timedOut` when the deadline submitted the form's current values
 * instead of the user. A result saved before OMP 18.18 holds batched answers
 * under `results` or a single answer spread bare into the details; only the
 * digest still reads those. A cancelled ask is saved as an error result with
 * `{}` details, not as an answer.
 */
export type AskDetails = { answers?: AskFormAnswer[]; timedOut?: boolean; results?: LegacyAskAnswer[] } & LegacyAskAnswer;

/** `manage_skill` result details: the action taken and the skill it named. */
interface ManageSkillDetails {
  action?: string;
  name?: string;
}

/** A subagent job: its id and status (`pending`, `running`, `completed`, `failed`, …). */
interface JobStatus {
  id?: string;
  status?: string;
}

/**
 * Subagent job details: a `task` result lists its spawned jobs under
 * `progress`; a `wait` result reports background jobs under `jobs`.
 */
interface JobDetails {
  progress?: JobStatus[];
  jobs?: JobStatus[];
}

interface BashResultDetails {
  exitCode?: number;
  timedOut?: boolean;
  wallTimeMs?: number;
  terminalId?: string;
  /** Presence denotes an unfinished job/service rather than a foreground receipt. */
  async?: unknown;
  service?: unknown;
}

/** Tool-result details, read according to `toolName`. */
export type ToolResultDetails = AskDetails & ManageSkillDetails & JobDetails & BashResultDetails;

export interface ExtensionContext {
  /** False in print, headless RPC and subagent sessions. */
  hasUI: boolean;
  /** Missing on hosts older than the agent-kind API; treat as the main agent. */
  agent?: { kind: "main" | "sub" };
  cwd: string;
  /** Optional on older hosts; review needs authenticated models of every judge-compatible kind. */
  modelRegistry?: { getAvailable(kind: "all"): Array<{ provider: string; id: string; kind?: string }> };
  sessionManager: { getBranch(): SessionEntry[]; getSessionId(): string };
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export type ExtensionEvent =
  | "session_start"
  | "session_switch"
  | "session_branch"
  | "session_tree"
  | "agent_end"
  | "message_end";

/**
 * Fired before a prompt, or a dequeued steering or follow-up batch with user
 * work, reaches the model. `prompt` is the submitted text; a batch joins its
 * user messages with blank lines. It may run again for the same submission.
 */
export interface BeforeAgentStartEvent {
  prompt: string;
}

/** A message returned here is appended after the submitted batch, on the same turn. */
export interface BeforeAgentStartResult {
  message?: CustomMessage;
}

/** Native pre-execution hook, before normal writes can change a reviewed target. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: ToolArguments;
}

export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

/** Native result hook fields; content can include text and images. */
export interface ToolResultEvent {
  input?: ToolArguments;
  toolName: string;
  toolCallId: string;
  content: ContentBlock[];
  details: unknown;
  isError: boolean;
}

export interface ToolResultEventResult {
  content?: ContentBlock[];
  details?: unknown;
  isError?: boolean;
  /** Text OMP adds to the context after the tool results; only a call the model made itself has somewhere to put it. */
  additionalContext?: string;
}

/** Command handlers get a richer context in OMP; this extension needs only the base. */
export type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

/** A `pi.sendMessage` payload; it persists as a `custom_message` entry. */
export interface CustomMessage {
  customType: string;
  content: string;
  /** Whether the TUI shows the message; the model receives it either way. */
  display: boolean;
  attribution?: "user" | "agent";
  details?: { rules?: string[] };
}

export interface SendMessageOptions {
  /** Starts a turn when the session is idle. */
  triggerTurn?: boolean;
  /** `followUp` waits for a running turn to finish instead of interrupting it. */
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** The slice of OMP's Zod-compatible schema builder (`pi.zod`) that tool parameters use. */
export interface Schema {
  optional(): Schema;
  describe(description: string): Schema;
}

export interface SchemaBuilder {
  object(shape: Record<string, Schema>): Schema;
  array(element: Schema): Schema;
  string(): Schema;
  number(): Schema;
  enum(values: readonly [string, ...string[]]): Schema;
  union(members: readonly [Schema, Schema, ...Schema[]]): Schema;
  /** An object with string keys and values of one schema. */
  record(value: Schema): Schema;
  unknown(): Schema;
}

export interface ToolResult<TDetails> {
  content: Array<{ type: "text"; text: string }>;
  details?: TDetails;
  isError?: boolean;
}

/** A `pi.registerTool` definition. OMP validates `params` against `parameters` before `execute`. */
export interface ToolDefinition<TParams, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  /** Approval tier; OMP defaults to `exec`. */
  approval?: "read" | "write" | "exec";
  /** `essential` lists the tool top-level; OMP's default for extension tools, `discoverable`, mounts it as an `xd://` device. */
  loadMode?: "essential" | "discoverable";
  /** Registered but left out of the active set until the extension calls `setActiveTools`. */
  defaultInactive?: boolean;
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<ToolResult<TDetails>>;
}

export interface ExtensionAPI {
  /** Injected host exports; read explicit assignments without enabling any settings. */
  pi?: {
    settings: { getModelRole(role: string): string | undefined };
    resolveScopedModels?(
      parsed: { models: string[] },
      registry: {
        getAvailable(): Array<{ provider: string; id: string; kind?: string }>;
        getDiscoverableProviders(): string[];
        refresh(): Promise<void>;
      },
      settings: NonNullable<ExtensionAPI["pi"]>["settings"],
    ): Promise<Array<{ model: { provider: string; id: string; kind?: string } }>>;
  };
  on(event: ExtensionEvent, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartResult | undefined,
  ): void;
  on(
    event: "tool_result",
    handler: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | undefined,
  ): void;
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>,
  ): void;
  registerCommand(name: string, options: { description?: string; handler: CommandHandler }): void;
  registerTool<TParams, TDetails>(tool: ToolDefinition<TParams, TDetails>): void;
  /** Names of the tools the model can call now, top-level and `xd://` devices alike. */
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): Promise<void>;
  sendMessage(message: CustomMessage, options?: SendMessageOptions): void;
  /** Persists a `custom` entry on the session's current branch; the model never sees it. */
  appendEntry(customType: string, data?: unknown): void;
  zod: SchemaBuilder;
}
