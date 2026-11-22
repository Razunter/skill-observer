/**
 * Eligibility, canonical prepared proposals and bounded advisory selection for
 * the existing observation pass. Prepare turns each exact candidate change into
 * the operation `observer_resolve` would carry out, with the target state it
 * read and a preview rendered from that operation; its successful result is the
 * branch artifact. A candidate that reconciles an approved on-read append or
 * rule with the user's approval note, its changed target, or both is prepared the same
 * way, carrying that reconciliation.
 * Select accepts only references to those results, and renders the one Ask
 * form that shows the proposals it selected.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  compactionFingerprint, isOnReadAmendment, isPinKind, isPinned, type ObserverRule, parseFrontmatter, readObserverRule, readOnReadAmendments, readSkillRules,
  type RuleDirs, rulePath, sectionHeadings, skillAmendment, skillAmendmentName,
} from "./amendments.js";
import {
  canonicalHarnessTarget, canonicalInstalledCopyTarget, canonicalMissingPath, canonicalProfileTarget, canonicalProjectTarget, type Evidence, type HarnessFile, harnessFingerprint, hookFileKey, hookPath,
  ledgerDecisionInProject, type LedgerRecord, projectFingerprint, PROPOSAL_KINDS, HARNESS_ROOTS, type HarnessTarget, type ProposalKind, removalFingerprint,
  normaliseText, type ProjectTarget, profileFingerprint, proposalFingerprint, readLedgerDecision, requireCheckedExecutableTarget, targetLabel, type TargetScope,
} from "./ledger.js";
import type { ExtensionAPI, ExtensionContext, Schema, SchemaBuilder, SessionEntry } from "./omp.js";
import { type CatalogLookup, type CatalogSkill, lookupCatalog, parseSkillsBlock } from "./catalog.js";
import { withdrawal } from "./on-read-amendment-transitions.js";
import { APPLY, approvalShape, checkReconciliation, checkTarget, isReconcilable, observationPassStart, preparedInPass, type ProposalReconciliation, STALE_OPTIONS } from "./proposal-approval.js";
import { DRAFT_RECORD_GATES, type Gate, instructionText } from "./payload.js";
import {
  createProvenanceResolver, defaultSkillRoots, type InstalledSkillScan, ompAgentDir, type ProvenanceResolver, scanInstalledSkills, skillHash, type SkillProvenance, type SkillRoots, type SourceCoverage,
} from "./provenance.js";
import { checkProjectState, prepareProjectEdit, type ProjectEdit } from "./project-publication.js";
import { checkExecutableState, prepareExecutableEdit, type ExecutableEdit } from "./executable-publication.js";
import { projectRootScope, projectScopeNote } from "./project-scope.js";
import { checkProfileState, prepareProfileEdit, type ProfileCheck, type ProfileEdit } from "./profile-publication.js";
import { fixRule } from "./publication.js";
import { checkPointers, checkReferenceFiles, hasUnlistedReferenceEntries, type ReferenceFile, readReferenceFiles, referenceFolder } from "./references.js";
import { type PatternDraft, type Sample, sampleSchemas } from "./replay.js";
import type { ObserverFiles } from "./resolve.js";
import { type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";
import { readObserverStore } from "./observer-store.js";
import { type EvidenceKey, lookupRuleEvidence } from "./rule-evidence.js";
import { lookupBranchSource } from "./branch-source.js";

export const REVIEW_TOOL_NAME = "observer_review";
const PRIORITIES = ["stale", "note", "evidence", "compaction"] as const;
const ASK_LIMIT = 5;
const OVERFLOW_REASON = "Deferred because five other proposals filled the main Ask. Reconsider in the next observation pass if the fix is still applicable.";
type Priority = (typeof PRIORITIES)[number];
const OPERATIONS = ["direct-edit", "project-edit", "project-edits", "profile-edit", "on-read-append", "rule", "stale-update", "stale-delete", "withdrawal", "compaction", "harness"] as const;

interface ReviewEvidence extends Evidence { source?: string }

/** The exact change a candidate proposes, as the pass drafts it. */
type ChangeDraft =
  /** A local or managed skill edit or a new skill, published by the target's normal owner. */
  | { operation: "direct-edit"; preview: string }
  | { operation: "project-edit"; text?: string; check: string }
  | { operation: "project-edits"; edits: Array<{ target: ProjectTarget; text?: string; check: string }> }
  | { operation: "profile-edit"; text: string; check: ProfileCheck }
  | { operation: "on-read-append"; section: string }
  | ({ operation: "rule"; body: string } & PatternDraft)
  | { operation: "stale-update"; rule: string; body: string; references?: ReferenceFile[] }
  | { operation: "stale-delete"; rule: string }
  | { operation: "withdrawal"; body?: string; references?: ReferenceFile[] }
  | { operation: "compaction"; includes: string[]; body: string; references: ReferenceFile[] }
  | { operation: "harness"; stage: "checked"; files: HarnessFile[]; checkToolCallId: string; lowerRungs: string };

interface Citation { source: string; lines?: { from: number; to: number }; section?: string }

interface CandidateDiagnosis { inspection: string; explanation: string; delta: string; citations: Citation[]; search?: { terms: string[]; matches: string[] } }

export interface GuidanceSource {
  role: "skill" | "rule" | "reference";
  path: string;
  status: "active" | "stale";
  sha256: string;
  lines: number;
  sections: string[];
}

export interface GuidanceInspection {
  skill: string;
  kind: Exclude<SkillProvenance["kind"], "unknown">;
  sources: GuidanceSource[];
  /** The reference folder's files by path: membership only, since an unrequested body is never inspected. */
  referenceInventory: Array<{ path: string }>;
}

interface SearchedSkill { name: string; description: string; source: string; path?: string }

export interface GuidanceSearch {
  skill: string;
  terms: string[];
  coverage: Array<SourceCoverage & { supplemental?: true }>;
  matches: Array<SearchedSkill & { matched: string[] }>;
  fingerprint: string;
}

interface CandidateDraft {
  gist: string;
  priority: Priority;
  remedy: string;
  change: ChangeDraft;
  evidence?: ReviewEvidence[];
  fingerprint?: string;
  /** The approved on-read append or rule this candidate revises for its changed target, and the main agent's account of the revision. */
  reconciles?: Partial<ProposalReconciliation>;
  diagnosis?: Partial<CandidateDiagnosis>;
}
type ReviewCandidate = CandidateDraft & (Exclude<TargetScope, { kind: "project" }> |
  { kind: "project"; target?: ProjectTarget; skill?: never });

/** A file's bytes as Prepare read them; `sha256` is null for a missing file. */
interface FileSnapshot { path: string; sha256: string | null }
/** A rule's frontmatter identity, as on disk or as it would be written. */
type RuleIdentity = Omit<ObserverRule, "body">;
/** The skill's reference folder as Prepare read it, the files written in its place, and those the change deletes. */
interface ReferenceChange { folder: string; before: FileSnapshot[]; write: ReferenceFile[]; remove: string[] }

/**
 * The canonical operation: for a protected rule/reference mutation, exactly
 * what `observer_resolve` would write or delete, bodies trimmed as written.
 * A direct edit is not observer-owned and keeps the pass's own exact preview.
 */
export type PreparedChange =
  | { operation: "direct-edit" }
  | ProjectEdit
  | ProjectEdits
  | ProfileEdit
  | ExecutableEdit
  /** `record`: the amendment already holds the section verbatim, so publication writes nothing and only the ledger changes. */
  | { operation: "on-read-append"; effect: "create" | "append" | "record"; rule: RuleIdentity; target: FileSnapshot; section: string }
  /** Samples stay in the form the scope sees, as `observer_check` and `observer_resolve` take them. `replaces`: the same skill's fix whose rule this one overwrites. */
  | { operation: "rule"; rule: RuleIdentity; target: FileSnapshot; body: string; matches: Sample[]; spares: Sample[]; replaces?: { fingerprint: string; gist: string } }
  | { operation: "stale-update"; rule: RuleIdentity; target: FileSnapshot; body: string; references?: ReferenceChange }
  | { operation: "stale-delete"; rule: RuleIdentity; target: FileSnapshot; references?: ReferenceChange }
  | { operation: "withdrawal"; withdrawn: { fingerprint: string; gist: string }; effect: "record" }
  | { operation: "withdrawal"; withdrawn: { fingerprint: string; gist: string }; effect: "delete"; rule: RuleIdentity; target: FileSnapshot; references?: ReferenceChange }
  | { operation: "withdrawal"; withdrawn: { fingerprint: string; gist: string }; effect: "rewrite"; rule: RuleIdentity; target: FileSnapshot; body: string; references?: ReferenceChange }
  /** `rule` is absent when this pass's additions create the amendment the compaction rewrites. */
  | { operation: "compaction"; rule?: RuleIdentity; target: FileSnapshot; includes: string[]; body: string; references: ReferenceChange };
export interface ProjectEdits {
  operation: "project-edits";
  edits: Array<{ target: ProjectTarget; change: ProjectEdit }>;
}

type ProtectedChange = Exclude<PreparedChange, { operation: "direct-edit" | "project-edit" | "project-edits" | "profile-edit" | "harness" }>;
type StaleChange = Extract<PreparedChange, { operation: "stale-update" | "stale-delete" }>;
/** A stale amendment's answer that changes the rule, and the preview the Ask form shows under its heading. */
interface StaleAlternative { change: StaleChange; preview: string }

/** Immutable reviewed data: what the Ask form shows and what publication may later consider. */
export type PreparedProposal = {
  candidateId: string;
  fingerprint: string;
  priority: Priority;
  gist: string;
  remedy: string;
  evidence: ReviewEvidence[];
  /** A revision's link to the approved proposal it reconciles: the main agent's judgment, not the user's approval of this revision. */
  reconciles?: ProposalReconciliation;
  diagnosis?: CandidateDiagnosis;
} & (
  | { change: Exclude<PreparedChange, StaleChange>; preview: string }
  /** A stale amendment's one Keep/Update/Delete choice: each prepared answer, Update before Delete. */
  | { alternatives: StaleAlternative[] }
) & TargetScope;

export type PreparedProposalRef = Readonly<{ reviewToolCallId: string; candidateId: string; contentHash: string }>;
export interface PreparedEntry { reference: PreparedProposalRef; proposal: PreparedProposal }

interface Ranking { id: string; score: number; confidence: number; consistent: boolean }
interface ReviewParams {
  action: "draft" | "inspect" | "catalog" | "evidence" | "source" | "prepare" | "select" | "record";
  key?: EvidenceKey;
  skill?: string;
  references?: string[];
  terms?: string[];
  at?: string;
  limit?: number;
  cursor?: string;
  candidates?: unknown[];
  proposals?: PreparedProposalRef[];
  rankings?: Ranking[];
  rankingFailure?: string;
}
interface JudgeState {
  target: string;
  mechanism: string;
  remedy: string;
  evidence: ReviewEvidence[];
  repeatCount: number;
}
interface RejectedDraft {
  index: number;
  gist?: string;
  reason: string;
}

class CommonReviewError extends Error {}

interface ReviewDetails {
  eligible: PreparedEntry[];
  rejected: RejectedDraft[];
  needsRanking: boolean;
  judgeStates: Record<string, JudgeState>;
  selected: PreparedEntry[];
  deferred: PreparedEntry[];
  fallback?: string;
  failures: string[];
  inspection?: GuidanceInspection;
  search?: GuidanceSearch;
  catalog?: CatalogLookup;
}

interface GuidanceContext {
  dirs: RuleDirs;
  referencesDir: string;
  provenance: ProvenanceResolver;
  roots: SkillRoots;
  branch: readonly SessionEntry[];
  systemPrompt?: string[];
}

interface SearchInventory { installed: InstalledSkillScan; created: string[] }

/** What Prepare and Select check receipts against, each built once per call. */
interface ReceiptContext extends GuidanceContext {
  evidence: SessionToolEvidence;
  passStart: number | undefined;
  /** Scanned on first use. */
  inventory: () => SearchInventory;
  /** Each inspection's currency by ID: its refusal, or `undefined` while current. */
  currency: Map<string, string | undefined>;
}

interface ReviewDecisions {
  get: (fingerprint: string) => LedgerRecord | undefined;
  scoped: (fingerprint: string, projectRoot?: string) => LedgerRecord | undefined;
}

interface PrepareContext extends ReceiptContext {
  cwd: string;
  projectRoot: (root: string) => string;
  /** The agent directory, which holds the global hooks directory and the companion extension. */
  agentDir: string;
  ownerTools: ReadonlySet<string>;
  decisions: ReviewDecisions;
  /** Filled by Prepare: the `## ` headings of each on-read append's target amendment at the bytes it read, by candidate ID, kept out of the proposal so its content hash ignores them. */
  amendmentSections: Map<string, string[]>;
}

/** The model uses installed host judge helpers between Prepare and Select; this tool never calls a provider. */
export function registerReviewTool(
  pi: ExtensionAPI,
  files: ObserverFiles,
  catalogGap: (branch: readonly SessionEntry[]) => string | undefined,
  activateStageTool?: (action: "draft" | "record") => Promise<void>,
): void {
  const z = pi.zod;
  const referenceFiles = z.array(z.object({ name: z.string(), body: z.string() }));
  const projectTarget = z.object({ scope: z.enum(["project"]), root: z.string(), path: z.string(), mechanism: z.string() });
  const projectEdit = {
    text: z.string().optional().describe("Complete result; omit to remove an existing file."),
    check: z.string().describe("Exact foreground check after writing, in the target root."),
  };
  const profileChecks = {
    content: z.object({ kind: z.enum(["content"]), contains: z.string().describe("Decisive passage present after the edit."), excludes: z.string().optional(),
      installedCopy: z.object({ skill: z.string(), why: z.string().describe("Why controls, amendment and owned source do not fit.") }).optional() }),
    pattern: z.object({ kind: z.enum(["pattern"]), replayToolCallId: z.string().describe("Passing observer_check on the exact ruleText.") }),
    "skill-control": z.object({ kind: z.enum(["skill-control"]), skill: z.string(), mode: z.enum(["manual-only", "disable"]) }),
  };
  const profileEdit = { operation: z.enum(["profile-edit"]), text: z.string().describe("Complete replacement text.") };
  const changes = {
    "direct-edit": z.object({ operation: z.enum(["direct-edit"]), preview: z.string().describe("Exact skill edit or new skill.") }),
    "project-edit": z.object({ operation: z.enum(["project-edit"]), ...projectEdit }),
    "project-edits": z.object({ operation: z.enum(["project-edits"]), edits: z.array(z.object({ target: projectTarget, ...projectEdit })) })
      .describe("One fix across named destinations in one or more reviewed checkouts; omit outer `target`."),
    "profile-edit": z.object({ ...profileEdit, check: z.union([profileChecks.content, profileChecks.pattern, profileChecks["skill-control"]]) }),
    "on-read-append": z.object({ operation: z.enum(["on-read-append"]), section: z.string().describe("Append one `## ` heading and its text.") }),
    rule: z.object({ operation: z.enum(["rule"]), name: z.string(), body: z.string(), pattern: z.string(), ...sampleSchemas(z) })
      .describe("A pattern amendment (upstream/plugin) or barrier rule (local/managed), as checked by observer_check."),
    "stale-update": z.object({ operation: z.enum(["stale-update"]), rule: z.string(), body: z.string(), references: referenceFiles.optional() }),
    "stale-delete": z.object({ operation: z.enum(["stale-delete"]), rule: z.string() }),
    withdrawal: z.object({ operation: z.enum(["withdrawal"]), body: z.string().optional(), references: referenceFiles.optional() })
      .describe("Withdraw the applied fix named by `fingerprint`; for an on-read fix, give the full remaining `body` (empty deletes)."),
    compaction: z.object({ operation: z.enum(["compaction"]), includes: z.array(z.string()), body: z.string(), references: referenceFiles })
      .describe("`includes`: covered on-read appends from this Prepare, by gist or fingerprint. `references`: complete set."),
    harness: z.object({
      operation: z.enum(["harness"]), stage: z.enum(["checked"]),
      files: z.array(z.object({ path: z.string(), text: z.string().optional() }))
        .describe("All exact files, relative to executable root; omit `text` only for removal."),
      checkToolCallId: z.string().describe("Same-pass successful foreground Bash check of these exact changes in scratch."),
      lowerRungs: z.string().describe("Why a simpler remedy cannot fix this mechanism."),
    }).describe("Checked executable code. One exact native Apply authorizes publication, not activation."),
  } satisfies Record<(typeof OPERATIONS)[number], Schema>;
  const formatting = " Inline `code`; at most two **bold** phrases.";
  const draft = {
    gist: z.string().describe("One sentence starting with what changes. Inline `code` renders."),
    priority: z.enum(PRIORITIES),
    remedy: z.string().describe(`How this fixes the finding and how to verify it.${formatting}`),
    change: z.union([changes["direct-edit"], changes["project-edit"], changes["project-edits"], changes["profile-edit"],
      changes["on-read-append"], changes.rule, changes["stale-update"], changes["stale-delete"], changes.withdrawal, changes.compaction, changes.harness]),
    evidence: z.array(z.object({
      quote: z.string().describe("Short excerpt. Replace private values with placeholders such as [redacted email]. Start altered quotes with [redacted excerpt] followed by a space."),
      count: z.number(), source: z.string().optional(), occurrenceIds: z.array(z.string()).optional(),
    })).optional(),
    fingerprint: z.string().optional(),
    reconciles: z.object({
      approval: z.object(approvalShape(z)).describe("Exact original approval as cited to observer_resolve."),
      changedTarget: z.string().optional().describe("Required only after target drift: what changed since approved Prepare."),
      reason: z.string().describe("What the Apply note requests, why target drift needs revision, or both."),
      preserved: z.string().describe("How the revision preserves approved intent and unrelated content."),
    }).optional().describe("Same-pass on-read append or rule only: revise the section or rule body, pattern and samples, never the rule name. Use the Apply note from Ask, post-Prepare target drift, or both. This is the agent's revision, not user approval. Dropping or rewriting new target content, or deleting a target, needs a new proposal and Ask."),
    diagnosis: z.object({
      inspection: z.string().describe("Same-pass observer_review call ID: Inspect this skill or search for this new skill."),
      explanation: z.string().describe(`Why guidance is missing, unclear or ignored. Give the check that could disprove this and its result. For a new skill, why each search match does not fit.${formatting}`),
      delta: z.string().describe(`One sentence on changed future agent behavior.${formatting}`),
      citations: z.array(z.object({
        source: z.string().describe("Exact `path` from the inspection receipt."),
        lines: z.object({ from: z.number(), to: z.number() }).optional().describe("1-based inclusive lines in the inspected source."),
        section: z.string().optional().describe("Inspected `## ` heading."),
      })).optional().describe("Required for repairs, omitted for new skills. Ground the explanation with `lines`, `section` or both per source."),
    }).optional().describe("Required for new skills, local/managed direct edits, on-read appends and rules. Omit for project/harness remedies, stale answers, withdrawals and compactions."),
  };
  const skill = { kind: z.enum(PROPOSAL_KINDS), skill: z.string() };
  const scopes = {
    project: { kind: z.enum(["project"]), target: projectTarget.optional() },
    profile: { kind: z.enum(["profile"]), target: z.object({
      scope: z.enum(["profile"]), root: z.string().describe("Active OMP agent directory."),
      path: z.string().describe("Profile-relative path; exact inspected absolute SKILL.md only for an explicitly chosen installed copy."),
      mechanism: z.string(),
    }) },
    harness: { kind: z.enum(["harness"]), target: z.object({
      scope: z.enum(["harness"]), root: z.enum(HARNESS_ROOTS),
      path: z.string().optional().describe("An existing hook file, relative to its hooks directory; omit for a new hook, which is named by its fingerprint, and for the companion."),
      source: z.string().optional().describe("For an owned extension: its canonical absolute source directory."),
      checkout: z.string().optional().describe("Canonical checkout owning the extension source, if outside the current project."),
      mechanism: z.string(),
    }) },
  };
  const candidateKind = z.enum([...PROPOSAL_KINDS, "project", "profile", "harness"]);
  const candidate = z.object({
    ...draft,
    kind: candidateKind,
    skill: z.string().optional().describe("Required for skill proposals only."),
    target: z.union([projectTarget, scopes.profile.target, scopes.harness.target]).optional()
      .describe("Required for project, profile and harness proposals. Omit for `project-edits` and skill proposals."),
  });
  const parseCandidate = (raw: unknown): ReviewCandidate | string => {
    const kind = inputField(raw, "kind");
    const rawChange = inputField(raw, "change");
    const operation = inputField(rawChange, "operation");
    if (kind === "harness" && operation === "harness" && inputField(rawChange, "stage") === "intent") {
      return "Report item. Next action: specify the exact executable file changes and cite the observed scratch check; legacy approvals are not valid.";
    }

    // Validate by kind, operation and profile check type so errors do not list fields from other draft variants.
    const scope: Record<string, Schema> = schemaVariant(scopes, kind) ?? (PROPOSAL_KINDS.some((value) => value === kind) ? skill
      : { kind: candidateKind });
    const change = operation === "profile-edit"
      ? z.object({ ...profileEdit, check: schemaVariant(profileChecks, inputField(inputField(rawChange, "check"), "kind"))
        ?? z.object({ kind: z.enum(["content", "pattern", "skill-control"]) }) })
      : schemaVariant(changes, operation) ?? z.object({ operation: z.enum(OPERATIONS) });
    const exact = z.object({ ...draft, ...scope, change }).safeParse(raw);
    if (exact.success) return exact.data as ReviewCandidate;
    const paths = exact.error.issues.map(({ path }) => path.map(String).join(".")).filter(Boolean);
    if (paths.length === 0) return "malformed candidate: supply a proposal object with a complete change";
    const fields = [...new Set(paths)].map((path) => `\`${path}\``).join(", ");
    if (kind === "profile" && paths.some((path) => path === "change.check" || path.startsWith("change.check."))) {
      return `Report item. Next action: prepare the exact profile replacement and a check for that destination. Correct ${fields}.`;
    }
    return `malformed candidate: check ${fields}`;
  };
  pi.registerTool<ReviewParams, ReviewDetails>({
    name: REVIEW_TOOL_NAME, label: "Observer Review", approval: "read", loadMode: "essential", defaultInactive: true,
    description: "Observation pass: read procedure, skill guidance, catalog, primary branch source or rule evidence; prepare eligible proposals, explain rejections and select the Ask form. No writes or model calls.",
    parameters: z.object({
      action: z.enum(["draft", "inspect", "catalog", "evidence", "source", "prepare", "select", "record"]),
      key: z.object({ skill: z.string().optional(), rule: z.string().optional(), fingerprint: z.string().optional() }).optional()
        .describe("Evidence: one exact skill name, rule name or proposal fingerprint."),
      skill: z.string().optional().describe("Inspect only: the installed skill whose current guidance to read; with `terms`, the name of the proposed new skill. Catalog: the exact skill name to look up, instead of `terms`."),
      references: z.array(z.string()).optional()
        .describe("Inspect only: file names in the skill's observer reference folder to read too; the others are only listed by fingerprint and are not inspected."),
      terms: z.array(z.string()).optional()
        .describe("Inspect, for a proposed new skill: the words of its workflow to look for, case-insensitively, in every current skill's name and description. Catalog, instead of `skill`: words that must all appear, case-insensitively and literally, in an observed skill's rendered description; names are not searched."),
      at: z.string().optional().describe("Source: one exact pre-pass entry ID or tool-error or steering occurrence ID, without `cursor`. Catalog: the exact active branch entry ID at or before which to find the latest catalog observation."),
      limit: z.number().optional().describe("Catalog only: the page size, a whole number of at least 1; 20 when omitted."),
      cursor: z.string().optional().describe("Source: start before this exact pre-pass entry ID, without `at`. Catalog or Evidence: the previous page's `next` for the same lookup."),
      // Leave malformed siblings for Prepare to reject by index without hiding the draft shapes from the model.
      candidates: z.array(z.union([candidate, z.unknown()])).optional()
        .describe("Prepare only: exact candidate changes. Project and profile identity includes target and mechanism."),
      proposals: z.array(proposalRefSchema(z)).optional()
        .describe("Select only: the `reference` of each eligible proposal, exactly as Prepare returned it."),
      rankings: z.array(z.object({ id: z.string(), score: z.number(), confidence: z.number(), consistent: z.unknown().describe("Boolean: true only after inspecting agreement with cited evidence.") })).optional().describe("Select only: each compared candidateId exactly once, score 0..3 and confidence 0..1 from host judge, with consistent as a boolean after inspecting evidence agreement. Do not rank singleton classes."),
      rankingFailure: z.string().optional().describe("Select only: exact unavailable/failed host ranking reason. Do not retry the batch."),
    }),
    async execute(toolCallId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (params?.action === "source") {
        const branch = ctx.sessionManager.getBranch();
        const passStart = ctx.hasUI && ctx.agent?.kind === "main" ? observationPassStart(branch) : undefined;
        const source = passStart === undefined
          ? { entries: [], gaps: ["Only the main agent in a current observation pass can retrieve branch source."] }
          : lookupBranchSource(branch, passStart, params);
        return { content: [{ type: "text", text: JSON.stringify(source) }], details: emptyDetails(), isError: passStart === undefined };
      }
      if (params?.action === "inspect" || params?.action === "catalog" || params?.action === "evidence") {
        return readOnlyActionResult(params, files, ctx, catalogGap);
      }
      const details = emptyDetails();
      const amendmentSections = new Map<string, string[]>();
      let next: string | undefined;
      try {
        const guidance = receiptContext(ctx, files);
        if (params?.action === "draft" || params?.action === "record") {
          if (!ctx.hasUI || ctx.agent?.kind === "sub" || guidance.passStart === undefined) {
            throw new Error("only the main agent in a current observation pass can request that procedure");
          }
          const stage = params.action === "record" && hasReviewedPublication(guidance.evidence, guidance.passStart) ? "publish" : params.action;
          const text = instructionText(stage, DRAFT_RECORD_GATES);
          if (activateStageTool) await activateStageTool(params.action);
          return { content: [{ type: "text", text }], details, isError: false };
        }
        if (!ctx.hasUI || ctx.agent?.kind === "sub" || guidance.passStart === undefined) {
          throw new Error("no observation pass is current for this main agent");
        }
        const passDetails = guidance.branch[guidance.passStart]?.details;
        const scope = projectScopeNote(undefined, guidance.branch.slice(guidance.passStart + 1)) ??
          (passDetails?.observationLeads?.cwd === ctx.cwd ? passDetails.projectScope : undefined);
        const projectRoot = projectRootScope(ctx.cwd, scope);
        if (params?.action === "prepare") {
          const { candidates } = params;
          if (!Array.isArray(candidates) || params.proposals !== undefined) throw new Error("Prepare needs a candidate array and no references");
          if ("diagnosis" in params && params.diagnosis !== undefined) {
            throw new Error("Prepare ignores a `diagnosis` beside `candidates`: move `diagnosis` into each candidate it grounds, beside its `change`");
          }
          const ownerTools = new Set(pi.getAllTools().filter(({ sourceInfo }) => sourceInfo?.source === "builtin").map(({ name }) => name));
          const prepared = withReviewDecisions(files.storeFile(), ctx.cwd, (decisions) =>
            prepareProposals(candidates, parseCandidate, { ...guidance, cwd: ctx.cwd, projectRoot, agentDir: ompAgentDir(),
              ownerTools, decisions, amendmentSections }));
          details.rejected = prepared.rejected;
          details.eligible = prepared.eligible.map((proposal) => ({
            reference: { reviewToolCallId: toolCallId, candidateId: proposal.candidateId, contentHash: contentHash(proposal) },
            proposal,
          }));
        } else if (params?.action === "select") {
          if (params.candidates !== undefined) throw new Error("Select takes `proposals`, the references a successful Prepare returned, not candidate drafts");
          details.eligible = withReviewDecisions(files.storeFile(), ctx.cwd, ({ scoped }) =>
            preparedEntries(params.proposals, guidance.evidence, guidance.branch)
              .filter(({ proposal }) => {
                if (proposal.kind === "harness") {
                  return scoped(proposal.fingerprint, harnessProjectRoot(proposal.target))?.outcome !== "declined";
                }
                if (proposal.kind !== "project" || !("change" in proposal)) return scoped(proposal.fingerprint)?.outcome !== "declined";
                if (proposal.change.operation !== "project-edits") {
                  projectRoot(proposal.target.root);
                  return scoped(proposal.fingerprint, proposal.target.root)?.outcome !== "declined";
                }
                for (const { target } of proposal.change.edits) projectRoot(target.root);
                const declined = proposal.change.edits.find(({ target }) => scoped(projectFingerprint(target), target.root)?.outcome === "declined");
                if (declined) throw new Error(`the project destination \`${declined.change.file}\` was declined; review revised scope rather than omitting it`);
                return true;
              }));
        } else {
          throw new Error("review needs draft/inspect/catalog/evidence/source/prepare/select/record");
        }
        const classCounts: Record<Priority, number> = { stale: 0, note: 0, evidence: 0, compaction: 0 };
        for (const { proposal } of details.eligible) classCounts[proposal.priority]++;
        const compared = details.eligible.filter(({ proposal }) => {
          const index = PRIORITIES.indexOf(proposal.priority);
          const preceding = PRIORITIES.slice(0, index).reduce((sum, priority) => sum + classCounts[priority], 0);
          const slots = Math.max(0, ASK_LIMIT - preceding);
          return slots > 0 && classCounts[proposal.priority] > slots;
        });
        const modelUnavailable = compared.length > 0 ? await rankingModelUnavailable(pi, ctx) : undefined;
        details.needsRanking = compared.length > 0 && !modelUnavailable;
        if (params.action === "prepare") {
          if (details.eligible.some(({ proposal }) => !proposal.reconciles)) {
            next = instructionText("select", details.needsRanking ? new Set<Gate>(["ranking"]) : undefined);
          }
          for (const { proposal } of details.needsRanking ? compared : []) {
            details.judgeStates[proposal.candidateId] = {
              target: proposal.kind === "profile" ? `profile:${proposal.target.path}` : proposal.kind === "project" ? `project:${proposal.target.path}` : proposal.kind === "harness" ? `harness:${targetLabel(proposal)}` : `skill:${proposal.skill}`,
              mechanism: proposal.target?.mechanism ?? proposal.gist,
              remedy: proposal.remedy, evidence: proposal.evidence,
              repeatCount: distinctOccurrences(proposal.evidence) || proposal.evidence.reduce((max, item) => Math.max(max, item.count), 0),
            };
          }
        } else {
          const selection = selectCandidates(details.eligible, compared, params.rankings, modelUnavailable ?? params.rankingFailure);
          const selected = selection.ordered.slice(0, ASK_LIMIT);
          for (const { reference, proposal } of selected) {
            const staleReason = staleChoiceRefusal(proposal, guidance.provenance);
            if (staleReason) throw new Error(`proposal \`${reference.candidateId}\`: ${staleReason}`);
            if ("alternatives" in proposal) {
              for (const { change } of proposal.alternatives) checkTarget(change, "Prepare");
            } else if (proposal.change.operation === "compaction" || proposal.change.operation === "withdrawal") {
              checkTarget(proposal.change, "Prepare");
            }
            if ("change" in proposal && proposal.change.operation === "compaction") {
              const selectedAppends = selected.filter(({ proposal: other }) =>
                other.skill === proposal.skill && "change" in other && other.change.operation === "on-read-append");
              const { includes } = proposal.change;
              if (selectedAppends.length !== includes.length || selectedAppends.some(({ reference: addition, proposal: other }) =>
                addition.reviewToolCallId !== reference.reviewToolCallId || !includes.includes(other.fingerprint))) {
                throw new Error(`proposal \`${reference.candidateId}\`: select the compaction with exactly the on-read appends it covers from the same Prepare`);
              }
            }
            const { diagnosis } = proposal;
            if (!diagnosis) {
              if (isSkillTextRepair(proposal) || isNewSkill(proposal)) {
                const how = proposal.kind === "new" ? `search for \`${proposal.skill}\` with observer_review \`action: "inspect"\` and its \`terms\``
                  : `inspect \`${proposal.skill}\` with observer_review \`action: "inspect"\``;
                throw new Error(`proposal \`${reference.candidateId}\` was prepared without a candidate diagnosis: ${how}, cite that receipt, then prepare it again`);
              }
              continue;
            }
            try {
              if (proposal.kind === "new") checkSearchCurrent(diagnosis.inspection, searchReceipt(diagnosis.inspection, guidance), guidance);
              else checkCurrent(diagnosis.inspection, inspectionReceipt(diagnosis.inspection, guidance), guidance);
            } catch (error) {
              throw new Error(`proposal \`${reference.candidateId}\`: ${error instanceof Error ? error.message : String(error)}, then prepare it again`);
            }
          }
          for (const { proposal } of selected) {
            if (proposal.kind === "harness") {
              if (!("change" in proposal) || proposal.change.operation !== "harness" || proposal.change.stage !== "checked") {
                throw new Error("legacy executable approvals cannot publish; prepare the checked exact change again");
              }
              if (proposal.target.root === "extension" && proposal.target.checkout !== undefined) projectRoot(proposal.target.checkout);
              checkExecutableState(proposal.change, proposal.change.files.map(({ path }) => path));
              continue;
            }
            if (proposal.kind === "profile") {
              if (!("change" in proposal) || proposal.change.operation !== "profile-edit") throw new Error("a profile edit needs fresh Prepare before Ask");
              checkProfileState(proposal.target, proposal.change, true);
              continue;
            }
            if (proposal.kind !== "project") continue;
            if ("change" in proposal && proposal.change.operation === "project-edits") {
              for (const { change } of proposal.change.edits) checkProjectState(change, true);
            } else if ("change" in proposal && proposal.change.operation === "project-edit") {
              checkProjectState(proposal.change, true);
            } else {
              throw new Error("a legacy project preview needs fresh Prepare before Ask");
            }
          }
          if (selected.length > 0) next = instructionText("ask", DRAFT_RECORD_GATES);
          details.selected = selected;
          details.deferred = selection.ordered.slice(ASK_LIMIT);
          if (selection.fallback) details.fallback = selection.fallback;
        }
      } catch (error) {
        signal?.throwIfAborted();
        details.eligible = [];
        details.rejected = [];
        details.selected = [];
        details.deferred = [];
        details.needsRanking = false;
        details.judgeStates = {};
        next = undefined;
        details.failures.push(errorMessage(error));
      }
      const output = params?.action === "prepare"
        ? {
            eligible: details.eligible.map((entry) => preparedSummary(entry, amendmentSections)),
            ...(details.rejected.length > 0 && { rejected: details.rejected }),
            needsRanking: details.needsRanking, judgeStates: details.judgeStates, failures: details.failures,
          }
        : {
            selected: details.selected.map(({ reference }) => reference), deferred: details.deferred.map(({ reference }) => reference),
            ...(details.deferred.length > 0 && { deferredReason: OVERFLOW_REASON }),
            ...(details.selected.length > 0 && { askHtml: renderAskHtml(details.selected.map(({ proposal }) => proposal)) }),
            ...(details.fallback && { fallback: details.fallback }), failures: details.failures,
          };
      return { content: [{ type: "text", text: JSON.stringify(next ? { ...output, guidance: next } : output) }], details, isError: details.failures.length > 0 };
    },
  });
}

const emptyDetails = (): ReviewDetails => ({ eligible: [], rejected: [], needsRanking: false, judgeStates: {}, selected: [], deferred: [], failures: [] });

/** Match the native form to a successful Select, not to a stale or unrelated Ask. */
export function reviewSelectionForForm(evidence: SessionToolEvidence, passStart: number, html: unknown, before = Infinity) {
  if (typeof html !== "string") return;
  for (const { call, result } of evidence.completedCalls(REVIEW_TOOL_NAME).reverse()) {
    if (call.position <= passStart || result.position >= before || call.args.action !== "select" || result.isError !== false) continue;
    const selected = (result.details as Partial<ReviewDetails> | undefined)?.selected;
    if (Array.isArray(selected) && selected.length > 0 && renderAskHtml(selected.map(({ proposal }) => proposal)) === html) return selected;
  }
}

/** Receipt lookup for guidance, not authorization: publication still validates its own cited receipts. */
export function hasReviewedPublication(evidence: SessionToolEvidence, passStart: number, ownerToolsOnly = false): boolean {
  return evidence.completedCalls("ask").some(({ call, result }) => {
    if (call.position <= passStart || call.origin !== "native" || result.origin !== "native"
      || result.isError !== false || result.details?.timedOut === true || !Array.isArray(result.details?.answers)) return false;
    const selected = reviewSelectionForForm(evidence, passStart, call.args.html, call.position);
    return selected?.some(({ proposal }) => {
      const answer = result.details?.answers?.find((choice) => choice?.name === proposal.candidateId)?.answer;
      if (ownerToolsOnly) {
        return answer === APPLY && "change" in proposal && ["direct-edit", "project-edit", "project-edits", "profile-edit", "harness"].includes(proposal.change.operation);
      }
      return answer === APPLY || answer === STALE_OPTIONS["stale-update"] || answer === STALE_OPTIONS["stale-delete"];
    });
  });
}

/** A proposal left outside the five questions has no user answer to record. */
export function overflowDeferral(ref: PreparedProposalRef, evidence: SessionToolEvidence): string | undefined {
  for (const { call, result } of evidence.completedCalls(REVIEW_TOOL_NAME).reverse()) {
    if (call.args.action !== "select" || result.isError !== false) continue;
    const details = result.details as Partial<ReviewDetails> | undefined;
    if (Array.isArray(details?.selected) && details.selected.some((entry) => isDeepStrictEqual(entry?.reference, ref))) return undefined;
    if (Array.isArray(details?.deferred) && details.deferred.some((entry) => isDeepStrictEqual(entry?.reference, ref))) return OVERFLOW_REASON;
  }
}

type PreparedProjectEntry = PreparedEntry & { proposal: (Extract<TargetScope, { kind: "project" }> & { change: ProjectEdit | ProjectEdits | { operation: "direct-edit" } } |
  Extract<TargetScope, { kind: "profile" }> & { change: ProfileEdit } |
  Extract<TargetScope, { kind: "harness" }> & { change: ExecutableEdit }) };

export function preparedProjectEntries(evidence: SessionToolEvidence, passStart: number): PreparedProjectEntry[] {
  const entries = new Map<string, PreparedProjectEntry>();
  for (const { call, result } of evidence.completedCalls(REVIEW_TOOL_NAME)) {
    if (call.position <= passStart || call.args.action !== "prepare" || result.isError !== false) continue;
    const eligible = (result.details as Partial<ReviewDetails> | undefined)?.eligible;
    if (!Array.isArray(eligible)) continue;
    for (const entry of eligible) {
      const proposal = entry?.proposal;
      if (proposal && "change" in proposal && (
        (proposal.kind === "project" && ["project-edit", "project-edits", "direct-edit"].includes(proposal.change.operation)) ||
        (proposal.kind === "profile" && proposal.change.operation === "profile-edit") ||
        (proposal.kind === "harness" && proposal.change.operation === "harness" && proposal.change.stage === "checked")
      )) {
        entries.delete(proposal.candidateId);
        entries.set(proposal.candidateId, entry as PreparedProjectEntry);
      }
    }
  }
  return [...entries.values()].reverse();
}

function guidanceContext(ctx: ExtensionContext, files: ObserverFiles): GuidanceContext {
  const roots = defaultSkillRoots(ctx.cwd);
  return {
    dirs: { rulesDir: files.rulesDir(), amendmentsDir: files.amendmentsDir() }, referencesDir: files.referencesDir(),
    provenance: createProvenanceResolver(roots), roots, branch: ctx.sessionManager.getBranch(), systemPrompt: ctx.getSystemPrompt?.(),
  };
}

function receiptContext(ctx: ExtensionContext, files: ObserverFiles): ReceiptContext {
  const guidance = guidanceContext(ctx, files);
  const evidence = sessionToolEvidence(guidance.branch);
  let inventory: SearchInventory | undefined;
  return {
    ...guidance, evidence, passStart: observationPassStart(guidance.branch), currency: new Map(),
    inventory: () => (inventory ??= searchInventory(guidance.roots, evidence)),
  };
}

const searchInventory = (roots: SkillRoots, evidence: SessionToolEvidence): SearchInventory => ({ installed: scanInstalledSkills(roots), created: createdSkills(evidence) });

function readOnlyActionResult(params: ReviewParams, files: ObserverFiles, ctx: ExtensionContext, catalogGap: (branch: readonly SessionEntry[]) => string | undefined) {
  const details = emptyDetails();
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details, isError: false });
  try {
    if (params.action === "evidence") return ok(JSON.stringify(lookupRuleEvidence(params.key, params.cursor, files.storeFile(), ctx)));
    if (params.action === "catalog") {
      if (params.candidates !== undefined || params.proposals !== undefined || params.references !== undefined) {
        throw new Error("A catalog lookup takes `skill` or `terms`, with optional `at`, `limit` and `cursor`");
      }
      const branch = ctx.sessionManager.getBranch();
      const { lookup, text } = lookupCatalog(params, branch, ctx.sessionManager.getEntries(), catalogGap(branch));
      details.catalog = lookup;
      return ok(text);
    }
    if (params.candidates !== undefined || params.proposals !== undefined) throw new Error("Inspect takes a `skill` and optional `references`, not candidates or proposal references");
    if (params.terms !== undefined) {
      if (params.references !== undefined) throw new Error("A new-skill search takes `skill` and `terms`; a new skill has no reference files yet");
      const { roots, branch, systemPrompt } = guidanceContext(ctx, files);
      const { search, text } = searchGuidance(params.skill, params.terms, () => searchInventory(roots, sessionToolEvidence(branch)), systemPrompt);
      details.search = search;
      return ok(text);
    }
    const { inspection, text } = inspectGuidance(params.skill, params.references, guidanceContext(ctx, files));
    details.inspection = inspection;
    return ok(text);
  } catch (error) {
    details.failures.push(error instanceof Error ? error.message : String(error));
    return { content: [{ type: "text" as const, text: JSON.stringify({ failures: details.failures }) }], details, isError: true };
  }
}

function inspectGuidance(skill: unknown, requested: unknown, context: GuidanceContext): { inspection: GuidanceInspection; text: string } {
  const { inspection, folder, texts } = guidanceReceipt(skill, requested, context);
  const { sources, referenceInventory } = inspection;
  const unread = referenceInventory.filter(({ path }) => !sources.some((source) => source.path === path)).map(({ path }) => `\`${basename(path)}\``);
  const text = [
    `Current guidance of \`${inspection.skill}\` (${inspection.kind}). Cite this call's ID as the diagnosis \`inspection\`, and each source by its path with \`lines\` or a \`section\`.`,
    `Reference folder \`${folder}\`: ${referenceInventory.length} file(s)${unread.length > 0 ? `; not inspected: ${unread.join(", ")}` : ""}.`,
    ...sources.map((source, i) => `\n### ${source.role} \`${source.path}\` (${source.status}, ${source.lines} lines)\n${sourceLines(texts[i]!).map((line, n) => `${n + 1}| ${line}`).join("\n")}`),
  ].join("\n");
  return { inspection, text };
}

function guidanceReceipt(skill: unknown, requested: unknown, { dirs, referencesDir, provenance }: Pick<GuidanceContext, "dirs" | "referencesDir" | "provenance">):
  { inspection: GuidanceInspection; folder: string; texts: string[] } {
  if (typeof skill !== "string" || !skill.trim()) throw new Error("Inspect needs the `skill` whose guidance to read");
  if (requested !== undefined && (!Array.isArray(requested) || requested.some((name) => typeof name !== "string"))) {
    throw new Error("`references` lists file names in the skill's observer reference folder");
  }
  const names: string[] = requested ?? [];
  checkReferenceFiles(names.map((name) => ({ name, body: "" })));
  const installed = provenance.byName(skill);
  if (installed.kind === "unknown") throw new Error(`no installed skill is named \`${skill}\``);
  const read: Array<{ source: GuidanceSource; text: string }> = [];
  const skillBytes = readGuidance(installed.path);
  if (!parseFrontmatter(skillBytes.toString("utf8"))) throw new Error(`\`${installed.path}\` has no frontmatter block, so its guidance can't be read as a skill`);
  read.push(guidanceSource("skill", installed.path, "active", skillBytes));

  const rules = readSkillRules(dirs, skill);
  const amendmentFile = join(dirs.amendmentsDir, `${skillAmendmentName(skill)}.md`);
  if (existsSync(amendmentFile) && !rules.some((rule) => rule.path === amendmentFile)) {
    throw new Error(`\`${amendmentFile}\` is not an on-read amendment skill-observer can read: its frontmatter is missing, malformed or another author's`);
  }
  const pin = rules.some(isPinned) ? skillHash(installed) : undefined;
  for (const rule of rules) read.push(guidanceSource("rule", rule.path, isPinned(rule) && rule.skillHash !== pin ? "stale" : "active", readGuidance(rule.path)));

  const folder = referenceFolder(referencesDir, skill);
  const inventory = existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(folder, entry.name)).sort()
    : [];
  for (const name of names) {
    const path = inventory.find((file) => basename(file) === name);
    if (!path) throw new Error(`the requested reference file \`${name}\` is not in \`${folder}\``);
    read.push(guidanceSource("reference", path, "active", readGuidance(path)));
  }
  const inspection = { skill, kind: installed.kind, sources: read.map(({ source }) => source), referenceInventory: inventory.map((path) => ({ path })) };
  return { inspection, folder, texts: read.map(({ text }) => text) };
}

function readGuidance(path: string): Buffer<ArrayBuffer> {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`\`${path}\` could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function guidanceSource(role: GuidanceSource["role"], path: string, status: GuidanceSource["status"], bytes: Buffer<ArrayBuffer>): { source: GuidanceSource; text: string } {
  const text = bytes.toString("utf8");
  return { source: { role, path, status, sha256: sha256Hex(bytes), lines: sourceLines(text).length, sections: sectionHeadings(text) }, text };
}

function sourceLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function searchGuidance(skill: unknown, terms: unknown, inventory: () => SearchInventory, systemPrompt: string[] | undefined): { search: GuidanceSearch; text: string } {
  if (typeof skill !== "string" || !skill.trim()) throw new Error("A new-skill search needs the proposed skill's name in `skill`");
  if (!Array.isArray(terms) || terms.length === 0 || terms.some((term) => typeof term !== "string" || !term.trim())) {
    throw new Error("A new-skill search needs `terms`: the words of its workflow to look for in current skill names and descriptions");
  }
  const name = skill.trim();
  const words = terms.map((term: string) => term.trim());
  const { installed, created } = inventory();
  const prompt = promptCatalog(systemPrompt);
  const coverage: GuidanceSearch["coverage"] = [
    ...installed.coverage, { source: "skills created this session", path: "session branch", status: created.length > 0 ? "present" : "absent" },
    { ...prompt.coverage, supplemental: true },
  ];
  const unavailable = installed.coverage.filter(({ status }) => status === "unavailable");
  if (unavailable.length > 0) {
    throw new Error(`the search for \`${name}\` could not read ${unavailable.map(({ source, path, reason }) => `${source} \`${path}\` (${reason})`).join("; ")}, so it can't show that no skill there already covers the workflow; report the unreadable source instead of proposing the skill`);
  }
  const searched: SearchedSkill[] = [
    ...installed.skills.map(({ provenance, bytes }) => ({
      name: provenance.name, description: parseFrontmatter(bytes.toString("utf8"))?.frontmatter.description ?? "",
      source: provenance.kind === "plugin" ? `plugin ${provenance.plugin}` : provenance.kind, path: provenance.path,
    })),
    ...created.map((createdName) => ({ name: createdName, description: "", source: "created this session" })),
    ...prompt.skills.map((listed) => ({ ...listed, source: "prompt catalog" })),
  ];
  const identity = ({ source, path }: SearchedSkill) => (path ? `${source} \`${path}\`` : source);
  const existing = searched.filter((entry) => entry.name === name);
  if (existing.length > 0) {
    throw new Error(`a skill named \`${name}\` already exists (${existing.map(identity).join("; ")}): inspect it and propose a repair to it, not a new skill`);
  }
  const matches = searched.flatMap((entry) => {
    const haystack = `${entry.name}\n${entry.description}`.toLowerCase();
    const matched = words.filter((word) => haystack.includes(word.toLowerCase()));
    return matched.length > 0 ? [{ ...entry, matched }] : [];
  });
  // Optional sources that are absent still count: one appearing later changes the searched inventory.
  const fingerprint = createHash("sha256").update(JSON.stringify([
    installed.coverage.map(({ source, path, status }) => [source, path, status]),
    installed.skills.map(({ provenance, bytes }) => [provenance.path, sha256Hex(bytes)]),
    created.toSorted(),
  ])).digest("hex");
  const text = [
    `No current skill is named \`${name}\`. Cite this call's ID as the new skill's diagnosis \`inspection\` and say why each match does not fit; before dismissing a match that might fit, inspect it with \`skill\` and no \`terms\`, and propose a repair to it when it fits.`,
    `Searched names and descriptions for: ${words.map((word) => `\`${word}\``).join(", ")}.`,
    "Coverage:",
    ...coverage.map(({ source, path, status, reason, supplemental }) => `- ${source} \`${path}\`: ${status}${reason ? ` (${reason})` : ""}${supplemental ? "; supplemental, never blocks" : ""}`),
    matches.length > 0 ? `Matches (${matches.length}):` : "No skill matched.",
    ...matches.map((match) => `- \`${match.name}\` (${identity(match)}) on ${match.matched.map((word) => `\`${word}\``).join(", ")}: ${match.description}`),
  ].join("\n");
  return { search: { skill: name, terms: words, coverage, matches, fingerprint }, text };
}

function createdSkills(evidence: SessionToolEvidence): string[] {
  return evidence.completedCalls("manage_skill").flatMap(({ result }) => {
    const details = result.details as { action?: unknown; name?: unknown } | undefined;
    return !result.isError && details?.action === "create" && typeof details.name === "string" ? [details.name] : [];
  });
}

function promptCatalog(systemPrompt: string[] | undefined): { coverage: SourceCoverage; skills: CatalogSkill[] } {
  const base = { source: "prompt catalog", path: "system prompt" };
  if (!systemPrompt) return { coverage: { ...base, status: "unavailable", reason: "the host exposes no system prompt" }, skills: [] };
  const block = parseSkillsBlock(systemPrompt);
  if (block.status === "no-block") return { coverage: { ...base, status: "absent" }, skills: [] };
  if (block.status === "unsupported") return { coverage: { ...base, status: "unavailable", reason: "its skills block is in neither the standard nor the bundled custom-prompt form" }, skills: [] };
  return { coverage: { ...base, status: "present" }, skills: block.skills };
}

/** What the model needs of a prepared proposal to rank, ask and answer it; its change and evidence stay in the saved details. */
function preparedSummary({ reference, proposal }: PreparedEntry, amendmentSections: ReadonlyMap<string, string[]>) {
  const sections = "change" in proposal && proposal.change.operation === "on-read-append" ? amendmentSections.get(proposal.candidateId) : undefined;
  return {
    reference, fingerprint: proposal.fingerprint, kind: proposal.kind,
    ...(proposal.target ? { target: proposal.target } : { skill: proposal.skill }),
    gist: proposal.gist,
    ...("alternatives" in proposal ? { previews: proposal.alternatives.map(({ preview }) => preview) } : { preview: proposal.preview }),
    ...optional("amendmentSections", sections),
  };
}

/**
 * The one form an observation pass asks with: a fieldset per proposal, in
 * order, whose radio group is named by the proposal's candidate ID. No option
 * is preselected, so the user chooses each answer. The legend, gist and
 * question come first so a proposal can be decided from them; the host takes
 * the text block right before a radio group as its question, so the question
 * heading sits directly above the options. Details follow as labelled
 * paragraphs, then the preview. A preview sits in a `<p>` with `<br>` line
 * breaks because the host cuts each `<pre>` line at the dialog width; the
 * whitespace a `<p>` collapses is shown as marks instead. Model prose renders
 * its inline markup; previews and evidence quotes show their text verbatim.
 */
export function renderAskHtml(proposals: readonly PreparedProposal[]): string {
  return ["<form>", ...proposals.map(renderFieldset), "</form>"].join("\n");
}

function renderFieldset(proposal: PreparedProposal): string {
  const previewParagraph = (preview: string) => `<p>${preview.split("\n").map((line) => escapeHtml(markHiddenWhitespace(line))).join("<br>")}</p>`;
  const isStale = "alternatives" in proposal;
  const staleLabels = isStale ? proposal.alternatives.map(({ change }) => STALE_OPTIONS[change.operation]) : [];
  const previews = isStale
    ? proposal.alternatives.flatMap(({ preview }, i) => [`<p><b>${staleLabels[i]}</b></p>`, previewParagraph(preview)])
    : [previewParagraph(proposal.preview)];
  const labels = isStale ? ["Keep", ...staleLabels]
    : proposal.change.operation === "withdrawal" || isHookRemoval(proposal) ? [APPLY, "Decline"] : [APPLY, "Later", "Decline"];
  const notedAsksAgain = isStale ? "An Update or Delete with a note is asked again."
    : proposal.change.operation === "harness" ? "A note that changes the code requires a newly checked change and another Apply."
    : ["withdrawal", "compaction"].includes(proposal.change.operation) ? "If you add a note to Apply, you'll be asked again to review the proposal." : undefined;
  const evidence = proposal.evidence.map(({ quote, count, source }) => `<li>“${escapeHtml(quote)}” <b>×${count}</b>${source ? ` · ${escapeHtml(source)}` : ""}</li>`);
  const name = escapeHtml(proposal.candidateId).replace(/"/g, "&quot;");
  const { diagnosis } = proposal;
  return [
    "<fieldset>",
    `<legend>${inline(`${actionLabel(proposal)} · ${!isStale && proposal.change.operation === "project-edits" ? "reviewed files (project)" : targetLabel(proposal)}`)}</legend>`,
    `<p><b>${inline(proposal.gist)}</b></p>`,
    `<h4>${isStale ? "Keep, update or delete this stale amendment?" : "Apply this change?"}</h4>`,
    // The host reports text typed into the group's Other row as an option's label when it equals that option's value, so no value is a bare label.
    ...labels.map((label) => `<label><input type="radio" name="${name}" value="${name}=${label}" required>${label}</label>`),
    ...(notedAsksAgain ? [`<p><i>${notedAsksAgain}</i></p>`] : []),
    ...(diagnosis ? [`<p><b>Problem:</b> ${inline(diagnosis.explanation)}</p>`, `<p><b>Effect:</b> ${inline(diagnosis.delta)}</p>`] : []),
    `<p><b>Remedy:</b> ${inline(proposal.remedy)}</p>`,
    ...(evidence.length > 0 ? ["<p><b>Evidence:</b></p>", "<ul>", ...evidence, "</ul>"] : []),
    ...(diagnosis ? [renderGrounds(diagnosis)] : []),
    "<h4>Change</h4>",
    ...previews,
    "</fieldset>",
  ].join("\n");
}

/** The legend's action: what Apply does to which kind of target. */
function actionLabel(proposal: PreparedProposal): string {
  if ("alternatives" in proposal) return "Stale amendment";
  const { change } = proposal;
  switch (change.operation) {
    case "on-read-append":
      return change.effect === "record" ? "Record on-read fix" : "Add on-read fix";
    case "rule":
      return `${change.target.sha256 === null ? "Add" : "Rewrite"} ${isPinKind(proposal.kind) ? "pattern amendment" : "barrier rule"}`;
    case "direct-edit":
      return proposal.kind === "new" ? "Create skill" : "Edit";
    case "project-edit":
      return change.afterHash === null ? "Remove file" : change.beforeHash === null ? "Create file" : "Edit file";
    case "project-edits":
      return "Apply the same fix";
    case "profile-edit":
      return change.installedCopy ? "Edit installed copy" : change.beforeHash === null ? "Create profile file" : "Edit profile file";
    case "harness":
      return isHookRemoval(proposal) ? "Remove hook" : "Publish checked code";
    case "withdrawal":
      return "Withdraw fix";
    case "compaction":
      return "Compact on-read amendment";
  }
}

/** The guidance a diagnosis rests on: each cited source once, by its last two path segments, with every place cited in it. */
function renderGrounds({ citations, search }: CandidateDiagnosis): string {
  if (search) return `<p><b>Searched:</b> ${escapeHtml(search.terms.join(", "))} · matches: ${escapeHtml(search.matches.join(", ") || "none")}</p>`;
  const places = new Map<string, string[]>();
  for (const { source, lines, section } of citations) {
    const span = lines && (lines.from === lines.to ? `L${lines.from}` : `L${lines.from}–${lines.to}`);
    const place = [span, section !== undefined && `§ ${escapeHtml(section)}`].filter(Boolean).join(" ");
    const cited = places.get(source) ?? [];
    if (cited.length === 0) places.set(source, cited);
    cited.push(place);
  }
  const sources = [...places].map(([source, cited]) => `<code>${escapeHtml(source.split(sep).slice(-2).join("/"))}</code> ${cited.join(", ")}`);
  return `<p><b>Grounds:</b> ${sources.join("; ")}</p>`;
}

/**
 * Model prose with its inline markup rendered: `code` spans, `**bold**` and
 * `*italic*`. Emphasis must open and close on a letter, digit or code span, so
 * globs such as `personas/*.md`, `*.test.*` or `**\/*.ts` stay literal. Code
 * spans stand in as `\0n\0` while emphasis is matched, so bold may wrap one.
 */
function inline(text: string): string {
  const codes: string[] = [];
  // A literal NUL would collide with the placeholders; it is a control character no form prose needs, so it is dropped.
  return escapeHtml(text.replaceAll("\0", ""))
    .replace(CODE_SPAN, (span) => `\0${codes.push(`<code>${span.slice(1, -1)}</code>`) - 1}\0`)
    .replace(BOLD, "<b>$1</b>")
    .replace(ITALIC, "$1<i>$2</i>")
    .replace(/\0(\d+)\0/g, (_, index: string) => codes[Number(index)]!);
}

const CODE_SPAN = /`[^`\n]+`/g;
const BOLD = /\*\*(?=[\p{L}\p{N}\0])(.+?)(?<=[\p{L}\p{N}\0])\*\*/gu;
const ITALIC = /(^|[\s([{"'“‘])\*(?=[\p{L}\p{N}\0])([^*]*?[\p{L}\p{N}\0])\*(?=$|[\s.,;:!?)\]}"'”’])/gu;

/** Marks the whitespace of a preview line that the host's form would hide: `·` per space of an indent, a trailing run or a run of two or more, `→` per tab. */
const markHiddenWhitespace = (line: string) => line.replace(/^ +| +$| {2,}/g, (run) => "·".repeat(run.length)).replace(/\t/g, "→");

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The parameter schema of a {@link PreparedProposalRef}, wherever a tool takes one. */
export function proposalRefSchema(z: SchemaBuilder) {
  return z.object({ reviewToolCallId: z.string(), candidateId: z.string(), contentHash: z.string() });
}

/** Why advisory ranking can't run on this host, or `undefined` when an explicit, available judge role assignment permits it. */
export async function rankingModelUnavailable(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const host = pi.pi;
    if (!host?.settings?.getModelRole || !host.resolveScopedModels || !ctx.modelRegistry?.getAvailable) return "host explicit judge configuration or model resolution is unavailable";
    if (!host.settings.getModelRole("judge")?.trim()) return "no explicit judge model is configured";
    const available = ctx.modelRegistry.getAvailable("all").filter(model => ["chat", "tiny", "judge"].includes(model.kind ?? "chat"));
    // The generic model facade excludes native judges; resolve against the authenticated judge pool without discovery.
    const resolved = await host.resolveScopedModels({ models: ["@judge"] }, {
      getAvailable: () => available,
      getDiscoverableProviders: () => [],
      refresh: async () => { throw new Error("observer ranking cannot refresh model discovery"); },
    }, host.settings);
    if (resolved.length === 0) return "the explicitly configured judge model is unavailable";
    return undefined;
  } catch {
    return "host explicit judge configuration or model resolution could not be read";
  }
}

function withReviewDecisions<T>(file: string, cwd: string, check: (decisions: ReviewDecisions) => T): T {
  return readObserverStore(file, (db) => {
    const root = realpathSync(cwd);
    const decisions = new Map<string, LedgerRecord | undefined>();
    const get = (fingerprint: string) => {
      if (!decisions.has(fingerprint)) {
        try {
          const record = readLedgerDecision(db, fingerprint);
          if (record !== undefined && (record?.fingerprint !== fingerprint || typeof record.outcome !== "string"
            || (record.kind === "project" || record.kind === "profile" || record.kind === "harness" ? !record.target : !record.skill))) {
            throw new Error("invalid stored decision");
          }
          decisions.set(fingerprint, record);
        } catch (error) {
          throw new CommonReviewError(`could not read the proposal ledger decision for \`${fingerprint}\`: ${errorMessage(error)}`);
        }
      }
      return decisions.get(fingerprint);
    };
    return check({
      get,
      scoped(fingerprint, projectRoot = root) {
        const record = get(fingerprint);
        return record && ledgerDecisionInProject(record, projectRoot) ? record : undefined;
      },
    });
  }) ?? check({ get: () => undefined, scoped: () => undefined });
}

function prepareProposals(candidates: readonly unknown[], parseCandidate: (raw: unknown) => ReviewCandidate | string, context: PrepareContext): {
  eligible: PreparedProposal[]; rejected: RejectedDraft[];
} {
  const eligible = new Map<string, PreparedProposal>();
  type DraftGroup = { drafts: number[]; reason?: string };
  const rejected = new Map<number, string>();
  const drafts = candidates.map((raw, index) => {
    const draft = parseCandidate(raw);
    if (typeof draft !== "string") return draft;
    rejected.set(index, draft);
    return undefined;
  });
  const collect = (compaction: boolean) => {
    const groups = new Map<string, DraftGroup>();
    for (const [index, draft] of drafts.entries()) {
      if (!draft || (draft.change.operation === "compaction") !== compaction) continue;
      let group: DraftGroup | undefined;
      try {
        const candidate = checkedCandidate(draft, context);
        const prepared = preparedProposal(candidate, eligible, context, (id) => {
          group = groups.get(id) ?? { drafts: [] };
          group.drafts.push(index);
          groups.set(id, group);
        });
        if (!prepared) continue;
        const proposal = isSkillTextRepair(candidate) || isNewSkill(candidate)
          ? { ...prepared, diagnosis: candidateDiagnosis(candidate, context) } : prepared;
        const previous = eligible.get(proposal.candidateId);
        eligible.set(proposal.candidateId, previous ? joined(previous, proposal) : proposal);
      } catch (error) {
        if (error instanceof CommonReviewError) throw error;
        const reason = draft.kind === "profile" ? `Report item. Next action: ${errorMessage(error)}` : errorMessage(error);
        rejected.set(index, reason);
        if (group) group.reason ??= reason;
      }
    }
    for (const [id, { drafts, reason: groupReason }] of groups) {
      const proposal = eligible.get(id);
      const reason = groupReason ?? (proposal && staleChoiceRefusal(proposal, context.provenance));
      if (!reason) continue;
      eligible.delete(id);
      for (const index of drafts) {
        if (!rejected.has(index)) rejected.set(index, drafts.length === 1 ? reason : `another draft for this proposal was rejected: ${reason}`);
      }
    }
  };
  // A compaction can include only appends accepted by this Prepare call.
  collect(false);
  collect(true);
  return {
    eligible: [...eligible.values()],
    rejected: [...rejected].sort(([a], [b]) => a - b).map(([index, reason]) => {
      const gist = inputField(candidates[index], "gist");
      return { index, ...(typeof gist === "string" && { gist }), reason };
    }),
  };
}

function inputField(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" && Object.hasOwn(input, key)
    ? (input as Record<string, unknown>)[key] : undefined;
}

function schemaVariant<T extends object>(variants: T, key: unknown): T[keyof T] | undefined {
  return typeof key === "string" && Object.hasOwn(variants, key) ? variants[key as keyof T] : undefined;
}

function staleChoiceRefusal(proposal: PreparedProposal, provenance: ProvenanceResolver): string | undefined {
  if (!("alternatives" in proposal)) return;
  if (proposal.skill === undefined) return "a stale choice needs an amendment's skill";
  const operations = proposal.alternatives.map(({ change }) => change.operation);
  const canUpdate = isPinKind(provenance.byName(proposal.skill).kind);
  if (!operations.includes("stale-delete") || operations.includes("stale-update") !== canUpdate) {
    return "a complete stale choice needs both Update and Delete for an installed upstream or plugin skill; an orphaned amendment takes Delete only";
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const SKILL_TEXT_OPERATIONS: ReadonlyArray<string> = ["direct-edit", "on-read-append", "rule"];

function isSkillTextRepair<T extends { kind: string; change?: { operation: string } }>(subject: T): subject is T & { skill: string } {
  return subject.kind !== "project" && subject.kind !== "profile" && subject.kind !== "harness" && subject.kind !== "new" && subject.change !== undefined && SKILL_TEXT_OPERATIONS.includes(subject.change.operation);
}

function isNewSkill<T extends { kind: string; change?: { operation: string } }>(subject: T): subject is T & { skill: string } {
  return subject.kind === "new" && subject.change?.operation === "direct-edit";
}

function candidateDiagnosis({ skill, kind, diagnosis: draft }: ReviewCandidate & { skill: string }, context: PrepareContext): CandidateDiagnosis {
  const isNew = kind === "new";
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const [inspection, explanation, delta] = [text(draft?.inspection), text(draft?.explanation), text(draft?.delta)];
  const citations = Array.isArray(draft?.citations) && draft.citations.length > 0 ? draft.citations : undefined;
  const missing = [
    !inspection && (isNew ? "`inspection`, the ID of the observer_review new-skill search whose receipt it cites" : "`inspection`, the ID of the observer_review inspect call of the skill whose receipt it cites"),
    !explanation && (isNew ? "`explanation`, why each skill the search matched does not fit" : "`explanation`, why current guidance does not already address the finding, with the check that could have shown otherwise and its result"),
    !delta && "`delta`, one sentence on what a future agent will do differently",
    !isNew && !citations && "`citations` of the inspected guidance",
  ].filter((part) => typeof part === "string");
  if (missing.length > 0 || !inspection || !explanation || !delta) {
    const where = draft === undefined ? " (`diagnosis` is a field of the candidate, beside `change`)" : "";
    throw new Error(isNew
      ? `the new skill \`${skill}\` needs its candidate diagnosis${where} ${missing.join("; ")}: search for it with observer_review \`action: "inspect"\`, \`skill\` and \`terms\`, and cite that receipt`
      : `the repair of \`${skill}\` needs its candidate diagnosis${where} ${missing.join("; ")}: inspect the skill with observer_review \`action: "inspect"\` and cite that receipt`);
  }
  if (isNew) {
    const search = searchReceipt(inspection, context);
    if (search.skill !== skill) throw new Error(`inspection \`${inspection}\` searched for \`${search.skill}\`, not \`${skill}\`: search for \`${skill}\` and cite that receipt`);
    checkSearchCurrent(inspection, search, context);
    return { inspection, explanation, delta, citations: [], search: { terms: search.terms, matches: [...new Set(search.matches.map(({ name }) => name))] } };
  }
  const receipt = inspectionReceipt(inspection, context);
  if (receipt.skill !== skill) throw new Error(`inspection \`${inspection}\` read \`${receipt.skill}\`, not \`${skill}\`: inspect \`${skill}\` and cite that receipt`);
  if (receipt.kind !== kind) {
    const owner = isPinKind(receipt.kind) ? ", whose fixes are amendment rules, never a direct edit" : "";
    throw new Error(`inspection \`${inspection}\` read \`${skill}\` as a ${receipt.kind} skill, not ${kind}: propose it as the ${receipt.kind} skill it is${owner}`);
  }
  checkCurrent(inspection, receipt, context);
  return { inspection, explanation, delta, citations: citations!.map((citation) => checkedCitation(citation, receipt, inspection)) };
}

function inspectionReceipt(id: string, context: Pick<ReceiptContext, "evidence" | "passStart">): GuidanceInspection {
  const { inspection } = inspectDetails(id, context);
  if (!inspection) throw new Error(`inspection \`${id}\` is a new-skill search, not a reading of a skill's guidance; inspect the skill without \`terms\` and cite that receipt`);
  return inspection;
}

function searchReceipt(id: string, context: Pick<ReceiptContext, "evidence" | "passStart">): GuidanceSearch {
  const { search } = inspectDetails(id, context);
  if (!search) throw new Error(`inspection \`${id}\` read an existing skill's guidance, not a new-skill search; search with \`skill\` and \`terms\` and cite that receipt`);
  return search;
}

function inspectDetails(id: string, { evidence, passStart }: Pick<ReceiptContext, "evidence" | "passStart">): Pick<ReviewDetails, "inspection" | "search"> {
  const label = `inspection \`${id}\``;
  let completed;
  try {
    completed = evidence.completedCall(id);
  } catch {
    throw new Error(`${label}: this branch holds no completed observer_review call with that ID; inspect the skill and cite that call`);
  }
  const { call, result } = completed;
  if (call.name !== REVIEW_TOOL_NAME || call.args.action !== "inspect") throw new Error(`${label}: that call is not an observer_review inspect`);
  const details = result.details as Pick<ReviewDetails, "inspection" | "search"> | undefined;
  if (result.isError !== false) throw new Error(`${label}: that inspection failed; inspect the skill again`);
  const { inspection, search } = details ?? {};
  if (inspection ? search || typeof inspection.skill !== "string" || !Array.isArray(inspection.sources) || !Array.isArray(inspection.referenceInventory)
    : !search || typeof search.skill !== "string" || typeof search.fingerprint !== "string" || !Array.isArray(search.terms) || !Array.isArray(search.matches)) {
    throw new CommonReviewError(`${label}: the saved inspection receipt is corrupt`);
  }
  if (passStart === undefined) throw new Error(`${label}: no observation pass is current on this branch, so no inspection grounds a repair`);
  if (call.position < passStart) throw new Error(`${label} is from an earlier observation pass; inspect the skill again in this pass`);
  return { inspection, search };
}

function checkCurrent(id: string, receipt: GuidanceInspection, context: ReceiptContext): void {
  failIfStale(id, context, () => {
    const requested = receipt.sources.filter(({ role }) => role === "reference").map(({ path }) => basename(path));
    let changes: string[];
    try {
      changes = guidanceChanges(receipt, guidanceReceipt(receipt.skill, requested, context).inspection);
    } catch (error) {
      changes = [error instanceof Error ? error.message : String(error)];
    }
    return changes.length > 0
      ? `inspection \`${id}\` of \`${receipt.skill}\` is no longer current: ${changes.join("; ")}; inspect \`${receipt.skill}\` again and cite the new receipt`
      : undefined;
  });
}

function checkSearchCurrent(id: string, receipt: GuidanceSearch, context: ReceiptContext): void {
  failIfStale(id, context, () => {
    let change: string | undefined;
    try {
      if (searchGuidance(receipt.skill, receipt.terms, context.inventory, context.systemPrompt).search.fingerprint !== receipt.fingerprint) {
        change = "the searched skill inventory or a searched skill file changed";
      }
    } catch (error) {
      change = error instanceof Error ? error.message : String(error);
    }
    return change ? `inspection \`${id}\`, the search for new skill \`${receipt.skill}\`, is no longer current: ${change}; search again with its \`terms\` and cite the new receipt` : undefined;
  });
}

/** Checks inspection `id` once per call; each later candidate citing it gets the same refusal. */
function failIfStale(id: string, { currency }: Pick<ReceiptContext, "currency">, staleness: () => string | undefined): void {
  if (!currency.has(id)) currency.set(id, staleness());
  const refusal = currency.get(id);
  if (refusal !== undefined) throw new Error(refusal);
}

function guidanceChanges(inspected: GuidanceInspection, current: GuidanceInspection): string[] {
  const diff = (noun: string, was: ReadonlyArray<{ path: string; sha256?: string }>, now: ReadonlyArray<{ path: string; sha256?: string }>) => [
    ...now.filter(({ path }) => !was.some((old) => old.path === path)).map(({ path }) => `${noun} \`${path}\` was added`),
    ...was.flatMap(({ path, sha256 }) => {
      const found = now.find((next) => next.path === path);
      return !found ? [`${noun} \`${path}\` was removed`] : found.sha256 !== sha256 ? [`${noun} \`${path}\` changed`] : [];
    }),
  ];
  const statuses = current.sources.flatMap(({ path, sha256, status }) =>
    inspected.sources.some((old) => old.path === path && old.sha256 === sha256 && old.status !== status) ? [`source \`${path}\` is now ${status}`] : []);
  const owner = current.kind === inspected.kind ? [] : [`\`${current.skill}\` is now ${current.kind === "upstream" ? "an" : "a"} ${current.kind} skill, not ${inspected.kind}`];
  return [...owner, ...diff("source", inspected.sources, current.sources), ...statuses, ...diff("reference folder file", inspected.referenceInventory, current.referenceInventory)];
}

function checkedCitation(citation: Partial<Citation> | undefined, receipt: GuidanceInspection, inspection: string): Citation {
  const source = receipt.sources.find(({ path }) => path === citation?.source);
  if (!citation || !source) throw new Error(`a citation names \`${citation?.source}\`, which inspection \`${inspection}\` did not read; cite a source path its receipt lists`);
  const { lines, section } = citation;
  const label = `the citation of \`${source.path}\``;
  if (lines === undefined && section === undefined) throw new Error(`${label} needs \`lines\` or a \`section\``);
  if (lines !== undefined && !(Number.isInteger(lines?.from) && Number.isInteger(lines?.to) && lines.from >= 1 && lines.from <= lines.to && lines.to <= source.lines)) {
    throw new Error(`${label} gives lines ${lines?.from}–${lines?.to}, but inspection \`${inspection}\` read lines 1–${source.lines}`);
  }
  if (section !== undefined && !source.sections.includes(section)) throw new Error(`${label} names section ${JSON.stringify(section)}, which inspection \`${inspection}\` did not read there`);
  return { source: source.path, ...optional("lines", lines && { from: lines.from, to: lines.to }), ...optional("section", section) };
}

/** One proposal from two candidates with the same identity: their evidence merged, and for a stale question each answer drafted. */
function joined(previous: PreparedProposal, next: PreparedProposal): PreparedProposal {
  const evidence = mergeEvidence([...previous.evidence, ...next.evidence]);
  if (previous.kind !== next.kind) throw new Error(`proposal \`${previous.candidateId}\` has conflicting kinds`);
  if ("alternatives" in previous && "alternatives" in next) {
    const alternatives = [...previous.alternatives];
    for (const alternative of next.alternatives) {
      const first = alternatives[0]!;
      if (first.change.rule.name !== alternative.change.rule.name || !isDeepStrictEqual(first.change.target, alternative.change.target)) {
        throw new Error(`proposal \`${previous.candidateId}\` has conflicting stale amendment targets`);
      }
      const same = alternatives.find(({ change }) => change.operation === alternative.change.operation);
      if (!same) alternatives.push(alternative);
      else if (!isDeepStrictEqual(same, alternative)) throw new Error(`stale \`${same.change.rule.name}\` has two different ${same.change.operation} drafts`);
    }
    alternatives.sort((a, b) => OPERATIONS.indexOf(a.change.operation) - OPERATIONS.indexOf(b.change.operation));
    return { ...previous, evidence, alternatives };
  }
  if (!("change" in previous) || !("change" in next) || previous.preview !== next.preview
    || !isDeepStrictEqual(previous.change, next.change) || !isDeepStrictEqual(previous.reconciles, next.reconciles)) {
    throw new Error(`proposal \`${previous.candidateId}\` has conflicting changes for the same identity`);
  }
  const preferred = PRIORITIES.indexOf(next.priority) < PRIORITIES.indexOf(previous.priority) ? next : previous;
  return { ...preferred, evidence };
}

function checkedCandidate(candidate: ReviewCandidate, context: PrepareContext): ReviewCandidate & { evidence: ReviewEvidence[] } {
  if (!candidate || typeof candidate.gist !== "string" || !candidate.gist.trim() || !PRIORITIES.includes(candidate.priority) ||
      typeof candidate.remedy !== "string" || !candidate.remedy.trim() || !candidate.change || !OPERATIONS.includes(candidate.change.operation)) {
    throw new Error("each review candidate needs gist, priority, remedy and an exact change");
  }
  // The form already shows the gist bold; more than two bold phrases in the details stop standing out.
  for (const [field, text] of [["remedy", candidate.remedy], ["diagnosis.explanation", candidate.diagnosis?.explanation], ["diagnosis.delta", candidate.diagnosis?.delta]]) {
    const bolds = typeof text === "string" ? text.replace(CODE_SPAN, "\0").match(BOLD)?.length ?? 0 : 0;
    if (bolds > 2) throw new Error(`\`${field}\` bolds ${bolds} phrases; bold at most two`);
  }
  if (candidate.evidence !== undefined && (!Array.isArray(candidate.evidence) || candidate.evidence.some((item) => !item ||
      typeof item.quote !== "string" || !item.quote.trim() || !Number.isInteger(item.count) || item.count < 1 ||
      (item.source !== undefined && typeof item.source !== "string") ||
      (item.occurrenceIds !== undefined && (!Array.isArray(item.occurrenceIds) || item.occurrenceIds.some((id) => typeof id !== "string" || !id.trim())))))) throw new Error("candidate evidence needs exact quotes, occurrence IDs and positive integer counts");
  const evidence = mergeEvidence(candidate.evidence ?? []);
  if (candidate.kind === "project") {
    if (candidate.skill !== undefined) throw new Error("project review candidates carry no skill name");
    if (candidate.change.operation === "project-edits") {
      if (candidate.target !== undefined) throw new Error("put all project destinations in the grouped edit, not an outer target");
      return { ...candidate, evidence };
    }
    if (!candidate.target) throw new Error("a project edit needs a project target");
    return { ...candidate, target: canonicalProjectTarget(context.projectRoot(candidate.target.root), candidate.target), evidence };
  }
  if (candidate.kind === "profile") {
    if (candidate.skill !== undefined || evidence.length === 0) throw new Error("cite the session evidence for the profile remedy; name the file via target, not skill");
    const { change } = candidate;
    const installedCopy = change.operation === "profile-edit" && change.check.kind === "content" && change.check.installedCopy !== undefined;
    return { ...candidate, target: installedCopy ? candidate.target : canonicalProfileTarget(candidate.target), evidence };
  }
  if (candidate.kind === "harness") {
    if (candidate.skill !== undefined) throw new Error("harness review candidates carry no skill name");
    return { ...candidate, target: canonicalHarnessTarget(context.cwd, context.agentDir, candidate.target, context.projectRoot), evidence };
  }
  if (!PROPOSAL_KINDS.includes(candidate.kind) || typeof candidate.skill !== "string" || !candidate.skill.trim() || candidate.target !== undefined) {
    throw new Error("global review candidate needs a valid skill kind and name, not a project target");
  }
  return { ...candidate, evidence };
}

/**
 * Canonicalizes one candidate, reading the rule and reference files its change
 * touches; `undefined` for a scoped decline, whose target need not still be
 * writable. Throws with the reason it can't.
 */
function preparedProposal(
  candidate: ReviewCandidate & { evidence: ReviewEvidence[] },
  prepared: ReadonlyMap<string, PreparedProposal>, context: PrepareContext, identify: (id: string) => void,
): PreparedProposal | undefined {
  const { change: draft } = candidate;
  const { decisions } = context;
  const isDeclined = (fingerprint: string, root?: string) => decisions.scoped(fingerprint, root)?.outcome === "declined";
  const isStale = draft.operation === "stale-update" || draft.operation === "stale-delete";
  if ((candidate.priority === "stale") !== isStale) throw new Error("stale priority is exactly a stale Update/Delete change");
  if ((candidate.priority === "compaction") !== (draft.operation === "compaction")) throw new Error("compaction priority is exactly a compaction change");
  if (candidate.reconciles !== undefined && draft.operation !== "on-read-append" && draft.operation !== "rule") {
    throw new Error("only an on-read append or a rule can be reconciled: its revision keeps the target's current content; a change that would delete a changed target, or rewrite one without keeping its content, needs a new prepared proposal and Ask");
  }
  const metadata = { priority: candidate.priority, gist: candidate.gist, remedy: candidate.remedy, evidence: candidate.evidence };
  if (draft.operation === "project-edits") {
    if (candidate.kind !== "project") throw new Error("grouped project edits need project targets");
    if (!Array.isArray(draft.edits) || draft.edits.length < 2 || draft.edits.some(edit =>
      !edit?.target || (edit.text !== undefined && typeof edit.text !== "string"))) {
      throw new Error("grouped project edits need at least two exact project destinations");
    }
    const targets = draft.edits.map(({ target }) => canonicalProjectTarget(context.projectRoot(target.root), target));
    for (const target of targets) requireProjectOwnership(target, context.agentDir);
    if (new Set(targets.map(({ root, path }) => join(root, path))).size !== targets.length ||
        new Set(targets.map(({ mechanism }) => normaliseText(mechanism))).size !== 1) {
      throw new Error("a project proposal needs one mechanism and distinct destination files");
    }
    const fingerprints = targets.map(projectFingerprint);
    const fingerprint = createHash("sha256").update(JSON.stringify(["project-edits", [...fingerprints].sort()])).digest("hex").slice(0, 12);
    const candidateId = `proposal:${fingerprint}`;
    identify(candidateId);
    checkCurrentFingerprint(candidate, fingerprint);
    const previews: string[] = [];
    const edits = targets.map((target, i) => {
      if (decisions.scoped(fingerprints[i]!, target.root)?.outcome === "declined") {
        throw new Error(`\`${join(target.root, target.path)}\` was declined; review revised scope rather than omitting it`);
      }
      const { text, check } = draft.edits[i]!;
      const prepared = prepareOwnedProjectEdit(target, text, check, context.ownerTools);
      previews.push(prepared.preview);
      return { target, change: prepared.change };
    });
    return { ...metadata, kind: "project", target: targets[0]!, candidateId, fingerprint,
      change: { operation: "project-edits", edits }, preview: previews.join("\n\n") };
  }
  if (draft.operation === "project-edit") {
    if (candidate.kind !== "project" || !candidate.target) throw new Error("a project edit needs a project target");
    const target = candidate.target;
    requireProjectOwnership(target, context.agentDir);
    const fingerprint = projectFingerprint(target);
    checkCurrentFingerprint(candidate, fingerprint);
    identify(`proposal:${fingerprint}`);
    if (draft.text !== undefined && typeof draft.text !== "string") throw new Error("project replacement text must be a string");
    if (decisions.scoped(fingerprint, target.root)?.outcome === "declined") return undefined;
    return { candidateId: `proposal:${fingerprint}`, fingerprint, ...metadata, kind: "project", target,
      ...prepareOwnedProjectEdit(target, draft.text, draft.check, context.ownerTools) };
  }
  if (candidate.kind === "project") throw new Error("a project change needs its exact replacement or removal and check; prepare a project edit");
  const scope: TargetScope = candidate.kind === "profile" ? { kind: "profile", target: candidate.target }
    : candidate.kind === "harness" ? { kind: "harness", target: candidate.target }
    : { kind: candidate.kind, skill: candidate.skill };
  const base = { ...metadata, ...scope };
  if (candidate.kind === "harness") {
    if (draft.operation !== "harness" || draft.stage !== "checked") throw new Error("an executable change needs its exact files and an observed scratch check; legacy approvals are not valid");
    const target = candidate.target;
    const hook = target.root === "project-hooks" || target.root === "global-hooks";
    const codeIdentity = harnessFingerprint(target);
    const path = hook ? hookPath(target, codeIdentity) : undefined;
    const removal = path !== undefined && draft.files?.length === 1 && draft.files[0]?.path === path && draft.files[0].text === undefined;
    const fingerprint = removal ? removalFingerprint(hookFileKey(target, codeIdentity)!) : codeIdentity;
    const candidateId = `${removal ? "removal" : "proposal"}:${fingerprint}`;
    identify(candidateId);
    checkCurrentFingerprint(candidate, fingerprint);
    if (isDeclined(fingerprint, harnessProjectRoot(target))) return undefined;
    if (!Array.isArray(draft.files) || !context.ownerTools.has("bash") ||
        draft.files.some((file) => !context.ownerTools.has(file?.text === undefined ? "edit" : "write"))) {
      throw new Error("the ordinary owner tools or foreground Bash check are unavailable; report this finding to its owner");
    }
    const prepared = prepareExecutableEdit(target, path, draft, context);
    const reviewedTarget = removal && (target.root === "project-hooks" || target.root === "global-hooks") ? { ...target, path } : target;
    return { candidateId, fingerprint, ...metadata, kind: "harness", target: reviewedTarget, ...prepared };
  }
  if (draft.operation === "harness") throw new Error("a checked executable change needs a harness target");
  if (candidate.kind === "profile") {
    if (draft.operation !== "profile-edit") throw new Error("prepare a profile edit with its exact replacement and target-bound check");
    const installedCopy = draft.check.kind === "content" ? draft.check.installedCopy : undefined;
    let diagnosis: CandidateDiagnosis | undefined;
    let inspection: Parameters<typeof prepareProfileEdit>[5];
    let target = candidate.target;
    if (installedCopy !== undefined) {
      const { skill } = installedCopy;
      const pass = context.passStart === undefined ? undefined : context.branch[context.passStart];
      if (!pass?.details?.observationLeads?.leads.some(({ kind, text }) => kind === "note" && text === `allow-installed-copy ${skill}`)) {
        throw new Error(`prefer skill controls, an amendment or owned source. Only the user can opt into an installed copy with /observe allow-installed-copy ${skill}`);
      }
      const installed = context.provenance.byName(skill);
      if (installed.kind !== "upstream" && installed.kind !== "plugin") throw new Error("inspect the named installed upstream or plugin skill");
      diagnosis = candidateDiagnosis({ ...candidate, kind: installed.kind, skill, target: undefined }, context);
      const source = inspectionReceipt(diagnosis.inspection, context).sources.find(({ role }) => role === "skill");
      if (!source) throw new Error("the inspection did not record the exact installed skill source");
      target = canonicalInstalledCopyTarget(target, source.path);
      inspection = { installed, source };
    }
    const fingerprint = proposalIdentity({ ...candidate, target }, decisions);
    identify(`proposal:${fingerprint}`);
    if (isDeclined(fingerprint)) return undefined;
    if (!context.ownerTools.has("write")) throw new Error("the built-in write tool is unavailable; ask the operator to apply the documented change through its owner");
    const prepared = prepareProfileEdit(target, draft.text, draft.check, context.evidence, context.passStart, inspection);
    return { candidateId: `proposal:${fingerprint}`, fingerprint, ...metadata, kind: "profile", ...prepared, ...(diagnosis && { diagnosis }) };
  }
  if (draft.operation === "profile-edit") throw new Error("a profile edit needs a profile target");
  if (draft.operation === "direct-edit") {
    if (isPinKind(candidate.kind)) throw new Error("an upstream or plugin skill takes amendment rules, not a direct edit");
    const fingerprint = proposalIdentity(candidate, decisions);
    identify(`proposal:${fingerprint}`);
    if (isDeclined(fingerprint)) return undefined;
    if (typeof draft.preview !== "string" || !draft.preview.trim()) throw new Error("a direct edit needs its exact preview");
    return { candidateId: `proposal:${fingerprint}`, fingerprint, ...base, change: { operation: "direct-edit" }, preview: draft.preview };
  }
  const { skill, kind } = candidate;
  const { dirs, referencesDir } = context;
  /** `prepare` validates and reads the change's target only once the identity is known not to be declined. */
  const proposal = (identityClass: string, fingerprint: string, prepare: () => ProtectedChange): PreparedProposal | undefined => {
    identify(`${identityClass}:${fingerprint}`);
    if (isDeclined(fingerprint)) return undefined;
    const change = prepare();
    const preview = renderPreview(skill, kind, change);
    // The Ask form collapses whitespace, so a CRLF or a bare CR would be written without ever being shown.
    if (preview.includes("\r")) throw new Error("the change holds a carriage return, which the Ask preview would not show; send its text with `\\n` line ends only");
    const reviewed = change.operation === "stale-update" || change.operation === "stale-delete" ? { alternatives: [{ change, preview }] } : { change, preview };
    return { candidateId: `${identityClass}:${fingerprint}`, fingerprint, ...base, ...reviewed };
  };
  /** A revision of an approved on-read append or rule carries the reconciliation it claims, once checked. */
  const reconciled = (prepared: PreparedProposal | undefined): PreparedProposal | undefined => {
    if (!prepared || candidate.reconciles === undefined || !("change" in prepared) || !isReconcilable(prepared.change)) return prepared;
    return { ...prepared, reconciles: checkReconciliation(candidate.reconciles, { ...prepared, change: prepared.change }, context.branch) };
  };
  switch (draft.operation) {
    case "on-read-append": {
      const fingerprint = proposalIdentity(candidate, decisions);
      return reconciled(proposal("proposal", fingerprint, () => {
        const { rule: created } = fixRule({ skill, kind, gist: candidate.gist, rule: { body: draft.section } }, fingerprint, dirs, context.provenance);
        const rule = skillAmendment(dirs.amendmentsDir, skill) ?? created;
        const section = created.body.trim();
        const bytes = existsSync(rule.path) ? readFileSync(rule.path) : null;
        const text = bytes?.toString("utf8");
        context.amendmentSections.set(`proposal:${fingerprint}`, sectionHeadings(parseFrontmatter(text ?? "")?.body ?? ""));
        // Publication appends nothing when the amendment already holds the section verbatim.
        const effect = text === undefined ? "create" : text.includes(section) ? "record" : "append";
        return { operation: "on-read-append", effect, rule: ruleIdentity(rule), target: snapshot(rule.path, bytes), section };
      }));
    }
    case "rule": {
      const fingerprint = proposalIdentity(candidate, decisions);
      return reconciled(proposal("proposal", fingerprint, () => {
        if (typeof draft.pattern !== "string" || !draft.pattern.trim()) throw new Error("a rule change needs its `pattern`; an on-read fix is an on-read append");
        const { operation: _, ...rule } = draft;
        const fix = fixRule({ skill, kind, gist: candidate.gist, rule }, fingerprint, dirs, context.provenance);
        return {
          operation: "rule", ...ruleTarget(fix.rule), body: fix.rule.body.trim(),
          matches: rule.matches ?? [], spares: rule.spares ?? [], ...optional("replaces", fix.replaces),
        };
      }));
    }
    case "stale-update":
    case "stale-delete": {
      const rule = readObserverRule(dirs, draft.rule);
      return proposal("stale", rule.fingerprint, () => {
        if (rule.amends !== skill) throw new Error("stale rule does not amend the candidate skill");
        checkCurrentFingerprint(candidate, rule.fingerprint);
        if (!isPinned(rule)) throw new Error(`\`${rule.name}\` is a barrier rule for a local or managed skill, so it never goes stale`);
        if (draft.operation === "stale-delete") {
          return { operation: "stale-delete", ...ruleTarget(rule), ...optional("references", releasedReferences(dirs, referencesDir, rule)) };
        }
        const body = typeof draft.body === "string" ? draft.body.trim() : "";
        const installed = context.provenance.byName(skill);
        if (!isPinKind(installed.kind) || installed.kind !== kind) throw new Error(`\`${skill}\` is no longer installed as a ${kind} skill, so this amendment cannot be updated`);
        if (!body) throw new Error("a stale Update needs the new `body`");
        if (draft.references !== undefined) {
          if (!isOnReadAmendment(rule)) throw new Error("`references` come only with a new body for the skill's on-read amendment");
          checkReferenceFiles(draft.references);
          checkPointers(referencesDir, skill, body, draft.references);
        }
        return {
          operation: "stale-update", ...ruleTarget(rule), body,
          ...optional("references", draft.references && referenceChange(referencesDir, skill, draft.references)),
        };
      });
    }
    case "withdrawal": {
      if (candidate.fingerprint === undefined) throw new Error("a withdrawal names the applied fix it takes back by `fingerprint`");
      const fingerprint = proposalIdentity(candidate, decisions);
      return proposal("withdrawal", fingerprint, () => {
        const hasDraft = draft.body !== undefined || draft.references !== undefined;
        const taken = withdrawal({ skill, fingerprint },
          hasDraft ? { body: draft.body ?? "", ...optional("references", draft.references) } : undefined,
          decisions, dirs, referencesDir);
        const withdrawn = { fingerprint: taken.record.fingerprint, gist: taken.record.gist };
        if (!taken.rule) return { operation: "withdrawal", withdrawn, effect: "record" };
        const body = taken.body?.trim();
        if (!body) {
          return { operation: "withdrawal", withdrawn, effect: "delete", ...ruleTarget(taken.rule), ...optional("references", releasedReferences(dirs, referencesDir, taken.rule)) };
        }
        return {
          operation: "withdrawal", withdrawn, effect: "rewrite", ...ruleTarget(taken.rule), body,
          ...optional("references", taken.references && referenceChange(referencesDir, skill, taken.references)),
        };
      });
    }
    case "compaction": {
      const current = skillAmendment(dirs.amendmentsDir, skill);
      const fingerprint = compactionFingerprint(skill, current?.body ?? "");
      return proposal("compaction", fingerprint, () => {
        checkCurrentFingerprint(candidate, fingerprint);
        const installed = context.provenance.byName(skill);
        if (!isPinKind(installed.kind) || installed.kind !== kind) throw new Error(`\`${skill}\` is not an upstream or plugin skill, so it has no on-read amendment to compact`);
        const body = typeof draft.body === "string" ? draft.body.trim() : "";
        if (!body) throw new Error("a compaction needs the compacted `body`");
        if (!Array.isArray(draft.includes) || draft.includes.some((addition) => typeof addition !== "string" || !addition.trim())) {
          throw new Error("a compaction's `includes` lists the on-read appends of this Prepare it covers, by gist or fingerprint");
        }
        const appends = [...prepared.values()].filter((entry) => entry.skill === skill && "change" in entry && entry.change.operation === "on-read-append");
        const includes = [...new Set(draft.includes.map((addition) => includedAddition(skill, addition, appends)))];
        const omitted = appends.filter(({ fingerprint }) => !includes.includes(fingerprint));
        if (omitted.length > 0) throw new Error(`the compaction leaves out eligible on-read fixes: ${omitted.map(({ gist }) => JSON.stringify(gist)).join(", ")}`);
        if (!Array.isArray(draft.references)) throw new Error("a compaction needs its complete set of `references`, empty for none");
        checkReferenceFiles(draft.references);
        checkPointers(referencesDir, skill, body, draft.references);
        const references = referenceChange(referencesDir, skill, draft.references);
        if (!current && includes.length === 0) throw new Error(`\`${skill}\` has no on-read amendment or prepared additions to compact`);
        return {
          operation: "compaction", ...optional("rule", current && ruleIdentity(current)),
          target: snapshot(current?.path ?? rulePath(dirs.amendmentsDir, skillAmendmentName(skill))),
          includes,
          body, references,
        };
      });
    }
  }
}

/**
 * The ledger identity of the one on-read append of this Prepare for `skill`
 * that `addition` names, by its fingerprint or its gist: a re-offered Later fix
 * keeps its recorded fingerprint under a reworded gist.
 */
function includedAddition(skill: string, addition: string, prepared: readonly PreparedProposal[]): string {
  const named = proposalFingerprint(skill, addition);
  const matches = prepared.filter((proposal) => proposal.fingerprint === addition || proposalFingerprint(skill, proposal.gist) === named);
  const [match] = matches;
  if (!match || matches.length > 1) {
    throw new Error(`the compaction of \`${skill}\` includes ${JSON.stringify(addition)}, which names ${match ? "more than one" : "no"} on-read append of this Prepare`);
  }
  return match.fingerprint;
}

function harnessProjectRoot(target: HarnessTarget): string | undefined {
  return target.root === "extension" ? target.checkout : target.root === "project-hooks" ? target.project : undefined;
}

function prepareOwnedProjectEdit(target: ProjectTarget, text: string | undefined, check: string, ownerTools: ReadonlySet<string>) {
  const owner = text === undefined ? "edit" : "write";
  const missing = [owner, "bash"].filter((tool) => !ownerTools.has(tool));
  if (missing.length > 0) {
    throw new Error(`Report item. Next action: arrange for the owner to apply and verify \`${join(target.root, target.path)}\`; missing registered built-in tool(s): ${missing.join(", ")}`);
  }
  return prepareProjectEdit(target, text, check);
}

function requireProjectOwnership(target: ProjectTarget, agentDir: string): void {
  const within = relative(canonicalMissingPath(agentDir), join(target.root, target.path));
  if (within && !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)) {
    throw new Error("this is an active profile file; prepare it in profile scope with its target-bound check");
  }
  requireCheckedExecutableTarget(target);
}

/** A proposal's ledger identity: the scoped gist, or a re-offered Later entry's or withdrawn fix's recorded fingerprint. */
function proposalIdentity(candidate: Exclude<ReviewCandidate, { kind: "project" }>, decisions: ReviewDecisions): string {
  let fingerprint = candidate.kind === "profile" ? profileFingerprint(candidate.target)
    : candidate.kind === "harness" ? harnessFingerprint(candidate.target) : proposalFingerprint(candidate.skill, candidate.gist);
  if (candidate.kind !== "profile" && candidate.kind !== "harness" && candidate.fingerprint !== undefined) {
    const existing = decisions.scoped(candidate.fingerprint);
    if (existing) {
      if (existing.target !== undefined || existing.skill !== candidate.skill) throw new Error("candidate fingerprint belongs to another target");
      fingerprint = existing.fingerprint;
    }
  }
  checkCurrentFingerprint(candidate, fingerprint);
  return fingerprint;
}

function isHookRemoval(proposal: PreparedProposal): boolean {
  return proposal.kind === "harness" && (proposal.target.root === "project-hooks" || proposal.target.root === "global-hooks") &&
    "change" in proposal && proposal.change.operation === "harness" && proposal.change.stage === "checked" &&
    proposal.change.files[0]?.afterHash === null;
}

function checkCurrentFingerprint(candidate: ReviewCandidate, fingerprint: string): void {
  if (candidate.fingerprint !== undefined && candidate.fingerprint !== fingerprint) throw new Error("candidate fingerprint does not match its current scoped identity");
}

const optional = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/** The rule a change targets, and the bytes Prepare read at its path. */
function ruleTarget(rule: ObserverRule): { rule: RuleIdentity; target: FileSnapshot } {
  return { rule: ruleIdentity(rule), target: snapshot(rule.path) };
}

function ruleIdentity(rule: ObserverRule): RuleIdentity {
  const { body: _, ...identity } = rule;
  return identity;
}

export function snapshot(path: string, bytes = existsSync(path) ? readFileSync(path) : null): FileSnapshot {
  return { path, sha256: bytes && sha256Hex(bytes) };
}

/** The skill's reference folder replaced by exactly `files`, trimmed as written; a folder holding more than plain files can't be previewed, so it's refused. */
function referenceChange(referencesDir: string, skill: string, files: readonly ReferenceFile[]): ReferenceChange {
  if (hasUnlistedReferenceEntries(referencesDir, skill)) {
    throw new Error(`the reference folder of \`${skill}\` holds more than reference files, which replacing it would delete unseen; move them out first`);
  }
  const before = readReferenceFiles(referencesDir, skill).map((path) => snapshot(path));
  const write = files.map(({ name, body }) => ({ name, body: body.trim() }));
  const remove = before.map(({ path }) => basename(path)).filter((name) => !write.some((file) => file.name === name));
  return { folder: referenceFolder(referencesDir, skill), before, write, remove };
}

/**
 * Deleting a skill's last on-read amendment deletes its reference files with
 * it: the change holds the folder as Prepare read it, empty included, so a
 * file added since stops the deletion.
 */
function releasedReferences(dirs: RuleDirs, referencesDir: string, rule: ObserverRule): ReferenceChange | undefined {
  const isLast = isOnReadAmendment(rule) &&
    !readOnReadAmendments(dirs.amendmentsDir).some((other) => other.amends === rule.amends && other.path !== rule.path);
  return isLast ? referenceChange(referencesDir, rule.amends, []) : undefined;
}

/** The deterministic human-readable preview of a protected change; every written byte of instruction content appears verbatim. */
function renderPreview(skill: string, kind: ProposalKind, change: ProtectedChange): string {
  const of = `\`${skill}\` (${kind})`;
  const path = "target" in change ? tildePath(change.target.path) : undefined;
  switch (change.operation) {
    case "on-read-append":
      if (change.effect === "record") return `The on-read amendment \`${path}\` of ${of} already holds this section, so only the proposal ledger changes:\n\n${change.section}`;
      return change.effect === "create"
        ? `Create the on-read amendment \`${path}\` of ${of} with this section:\n\n${change.section}`
        : `Append this section to the on-read amendment \`${path}\` of ${of}:\n\n${change.section}`;
    case "rule": {
      // Samples feed only the replay check and are never written, so a long one is cut rather than shown whole.
      const samples = (items: readonly Sample[]) => items.map((item) => {
        const line = `- ${JSON.stringify(item)}`;
        return line.length > SAMPLE_LINE_LIMIT ? `${line.slice(0, SAMPLE_LINE_LIMIT - 1)}…` : line;
      }).join("\n");
      return [
        `${change.target.sha256 === null ? "Write" : "Rewrite"} the ${isPinKind(kind) ? "pattern amendment" : "barrier rule"} \`${change.rule.name}\` at \`${path}\` for ${of}${change.replaces ? `, replacing fix \`${change.replaces.fingerprint}\` (${change.replaces.gist}), which goes out of force` : ""}.`,
        `Scope: ${change.rule.scope}`, `Pattern: ${change.rule.condition}`, `Matches:\n${samples(change.matches)}`, `Spares:\n${samples(change.spares)}`,
        "", change.body,
      ].join("\n");
    }
    case "stale-update":
      return `Update the stale amendment \`${change.rule.name}\` at \`${path}\` of ${of}, pinned to the skill as installed now. New body:\n\n${change.body}${renderReferences(change.references)}`;
    case "stale-delete":
      return `Delete the stale amendment \`${change.rule.name}\` at \`${path}\` of ${of}; the fixes it holds go out of force.${renderReferences(change.references)}`;
    case "withdrawal": {
      const fix = `Withdraw fix \`${change.withdrawn.fingerprint}\` (${change.withdrawn.gist}) of ${of}`;
      if (change.effect === "record") return `${fix}; its rule file is already gone, so only the proposal ledger changes.`;
      if (change.effect === "delete") return `${fix}: delete \`${path}\`.${renderReferences(change.references)}`;
      return `${fix}: rewrite \`${path}\` without it. New body:\n\n${change.body}${renderReferences(change.references)}`;
    }
    case "compaction": {
      const includes = change.includes.length > 0 ? change.includes.map((fingerprint) => `\`${fingerprint}\``).join(", ") : "none";
      return `Compact the on-read amendment \`${path}\` of ${of}, covering this pass's on-read fixes ${includes}. New body:\n\n${change.body}${renderReferences(change.references)}`;
    }
  }
}

function renderReferences(change: ReferenceChange | undefined): string {
  if (!change) return "";
  const written = change.write.map(({ name, body }) => `\n\nReference file \`${tildePath(join(change.folder, name))}\`:\n\n${body}`).join("");
  const removed = change.remove.length > 0 ? `\n\nDeletes reference files ${change.remove.map((name) => `\`${tildePath(join(change.folder, name))}\``).join(", ")}.` : "";
  return `${written}${removed}`;
}

const SAMPLE_LINE_LIMIT = 200;

/** A path a preview names, with the home directory shown as `~` so the dialog line stays short. */
function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

function contentHash(proposal: PreparedProposal): string {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

export type PreparedReceiptIndex = Map<string, ReadonlyMap<string, PreparedEntry>>;

/**
 * Resolves Select's references to the proposals this branch's successful
 * Prepare results of the current observation pass hold, unchanged, so no form
 * is shown whose answers could approve nothing. Throws on a reference without
 * exactly one matching saved proposal and content hash.
 */
function preparedEntries(references: unknown, evidence: SessionToolEvidence, branch: readonly SessionEntry[]): PreparedEntry[] {
  if (!Array.isArray(references)) throw new Error("Select needs `proposals`: the references a successful Prepare returned");
  const seen = new Set<string>();
  const receipts: PreparedReceiptIndex = new Map();
  return references.map((reference: Partial<PreparedProposalRef> | undefined) => {
    if (!isProposalRef(reference)) throw new Error("each proposal reference needs reviewToolCallId, candidateId and contentHash");
    if (seen.has(reference.candidateId)) throw new Error(`proposal \`${reference.candidateId}\` is referenced twice`);
    seen.add(reference.candidateId);
    return preparedInPass(reference, evidence, branch, receipts);
  });
}

export function isProposalRef(ref: Partial<PreparedProposalRef> | undefined): ref is PreparedProposalRef {
  return typeof ref?.reviewToolCallId === "string" && typeof ref.candidateId === "string" && typeof ref.contentHash === "string";
}

export function preparedEntry(evidence: SessionToolEvidence, reference: PreparedProposalRef, receipts?: PreparedReceiptIndex): PreparedEntry {
  const label = `proposal \`${reference.candidateId}\` of review \`${reference.reviewToolCallId}\``;
  const { reviewToolCallId, candidateId } = reference;
  let entries = receipts?.get(reviewToolCallId);
  if (!entries) {
    entries = validatedPrepareEntries(evidence, reviewToolCallId, label);
    receipts?.set(reviewToolCallId, entries);
  }
  const entry = entries.get(candidateId);
  if (!entry) throw new Error(`${label}: that Prepare holds no single proposal with that ID`);
  const hash = entry.reference.contentHash;
  if (reference.contentHash !== hash) throw new Error(`${label}: content hash does not match the prepared proposal`);
  return entry;
}

function validatedPrepareEntries(evidence: SessionToolEvidence, reviewToolCallId: string, label: string): ReadonlyMap<string, PreparedEntry> {
  let receipt;
  try {
    receipt = evidence.completedCall(reviewToolCallId);
  } catch {
    throw new Error(`${label}: this branch holds no completed review call with that ID`);
  }
  const { call, result } = receipt;
  if (call.name !== REVIEW_TOOL_NAME || call.args.action !== "prepare") throw new Error(`${label}: that call is not an observer_review Prepare`);
  if (result.isError !== false) throw new Error(`${label}: that Prepare did not succeed`);
  const details: unknown = result.details;
  if (!details || typeof details !== "object" || !("eligible" in details) || !Array.isArray(details.eligible)) {
    throw new CommonReviewError(`review \`${reviewToolCallId}\`: the saved Prepare receipt has no eligible list`);
  }
  const entries = new Map<string, PreparedEntry>();
  for (const saved of details.eligible as PreparedEntry[]) {
    const ref = saved?.reference;
    if (!isProposalRef(ref) || !saved.proposal || saved.proposal.candidateId !== ref.candidateId
      || ref.reviewToolCallId !== reviewToolCallId || ref.contentHash !== contentHash(saved.proposal) || entries.has(ref.candidateId)) {
      throw new CommonReviewError(`review \`${reviewToolCallId}\`: a saved proposal no longer matches its content hash or has a duplicate identity`);
    }
    entries.set(ref.candidateId, saved);
  }
  return entries;
}

function mergeEvidence(evidence: readonly ReviewEvidence[]): ReviewEvidence[] {
  const merged = new Map<string, ReviewEvidence>();
  for (const item of evidence) {
    const key = JSON.stringify([item.source ?? "", item.quote]);
    const previous = merged.get(key);
    const occurrenceIds = [...new Set([...(previous?.occurrenceIds ?? []), ...(item.occurrenceIds ?? [])])];
    merged.set(key, { ...item, ...(occurrenceIds.length > 0 && { occurrenceIds }), count: occurrenceIds.length || Math.max(previous?.count ?? 0, item.count) });
  }
  return [...merged.values()];
}

function selectCandidates(eligible: readonly PreparedEntry[], compared: readonly PreparedEntry[], rankings?: readonly Ranking[], rankingFailure?: string): { ordered: PreparedEntry[]; fallback?: string } {
  const scores = new Map<string, number>();
  let fallback: string | undefined;
  if (compared.length > 0) {
    const ids = new Set(compared.map(({ proposal }) => proposal.candidateId));
    if (rankingFailure) fallback = `Advisory ranking unavailable: ${rankingFailure}; using stable evidence/repeat ordering.`;
    else if (!Array.isArray(rankings) || rankings.length !== compared.length) fallback = "Advisory ranking missing or partial; using stable evidence/repeat ordering.";
    else {
      for (const ranking of rankings) {
        if (!ranking || !ids.has(ranking.id) || scores.has(ranking.id) || !Number.isFinite(ranking.score) || ranking.score < 0 || ranking.score > 3 ||
            !Number.isFinite(ranking.confidence) || ranking.confidence < 0.7 || ranking.confidence > 1 || ranking.consistent !== true) {
          fallback = "Advisory ranking invalid, low-confidence or evidence-inconsistent; using stable evidence/repeat ordering.";
          break;
        }
        scores.set(ranking.id, ranking.score);
      }
    }
  }
  const evidence = ({ proposal }: PreparedEntry) =>
    distinctOccurrences(proposal.evidence) + proposal.evidence.filter((item) => !item.occurrenceIds?.length).reduce((sum, item) => sum + item.count, 0);
  const repeat = ({ proposal }: PreparedEntry) => proposal.evidence.reduce((max, item) => Math.max(max, item.count), 0);
  const position = new Map(eligible.map((entry, index) => [entry, index]));
  const ordered = [...eligible].sort((a, b) => {
    const priority = PRIORITIES.indexOf(a.proposal.priority) - PRIORITIES.indexOf(b.proposal.priority);
    if (priority) return priority;
    if (!fallback && compared.length > 0) {
      const score = (scores.get(b.proposal.candidateId) ?? 0) - (scores.get(a.proposal.candidateId) ?? 0);
      if (score) return score;
    }
    return evidence(b) - evidence(a) || repeat(b) - repeat(a) || position.get(a)! - position.get(b)!;
  });
  return { ordered, ...(fallback && { fallback }) };
}

/** An ID `<parent>/<own>` is part of its parent occurrence, so a cited parent adds nothing beyond its cited parts. */
function distinctOccurrences(evidence: readonly ReviewEvidence[]): number {
  const ids = [...new Set(evidence.flatMap((item) => item.occurrenceIds ?? []))];
  return ids.filter((id) => !ids.some((other) => other.startsWith(`${id}/`))).length;
}
