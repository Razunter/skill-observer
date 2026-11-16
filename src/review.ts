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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import {
  compactionFingerprint, isOnReadAmendment, isPinKind, isPinned, type ObserverRule, parseFrontmatter, readObserverRule, readOnReadAmendments, readSkillRules,
  type RuleDirs, rulePath, sectionHeadings, skillAmendment, skillAmendmentName,
} from "./amendments.js";
import {
  canonicalHarnessTarget, canonicalMissingPath, canonicalPathIn, canonicalProjectTarget, type Evidence, HARNESS_ROOT_NAMES, type HarnessFile, harnessFingerprint, harnessRootDirs, hookFileKey, hookPath,
  ledgerForProject, type LedgerRecord, projectFingerprint, PROPOSAL_KINDS, HARNESS_ROOTS, type HarnessTarget, type ProposalKind, removalFingerprint,
  proposalFingerprint, readLedger, targetLabel, type TargetScope,
} from "./ledger.js";
import type { ExtensionAPI, ExtensionContext, SchemaBuilder, SessionEntry } from "./omp.js";
import { type CatalogLookup, type CatalogSkill, lookupCatalog, parseSkillsBlock } from "./catalog.js";
import { withdrawal } from "./on-read-amendment-transitions.js";
import { APPLY, approvalShape, approvedHarness, checkReconciliation, isReconcilable, observationPassStart, preparedInPass, type ProposalAnswerRef, type ProposalReconciliation, STALE_OPTIONS } from "./proposal-approval.js";
import {
  createProvenanceResolver, defaultSkillRoots, type InstalledSkillScan, ompAgentDir, type ProvenanceResolver, scanInstalledSkills, skillHash, type SkillProvenance, type SkillRoots, type SourceCoverage,
} from "./provenance.js";
import { checkCompanionCommand, checkHookCommand } from "./project-publication.js";
import { fixRule } from "./publication.js";
import { checkPointers, checkReferenceFiles, hasUnlistedReferenceEntries, type ReferenceFile, readReferenceFiles, referenceFolder } from "./references.js";
import { type PatternDraft, type Sample, sampleSchemas } from "./replay.js";
import type { ObserverFiles } from "./resolve.js";
import { type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";

export const REVIEW_TOOL_NAME = "observer_review";
const PRIORITIES = ["stale", "note", "evidence", "compaction"] as const;
type Priority = (typeof PRIORITIES)[number];
const OPERATIONS = ["direct-edit", "on-read-append", "rule", "stale-update", "stale-delete", "withdrawal", "compaction", "harness"] as const;

interface ReviewEvidence extends Evidence { source?: string }

/** The exact change a candidate proposes, as the pass drafts it. */
type ChangeDraft =
  /** A local or managed skill edit, a new skill or a project repair, published later by the target's normal owner. */
  | { operation: "direct-edit"; preview: string }
  | { operation: "on-read-append"; section: string }
  | ({ operation: "rule"; body: string } & PatternDraft)
  | { operation: "stale-update"; rule: string; body: string; references?: ReferenceFile[] }
  | { operation: "stale-delete"; rule: string }
  | { operation: "withdrawal"; body?: string; references?: ReferenceFile[] }
  | { operation: "compaction"; includes: string[]; body: string; references: ReferenceFile[] }
  /** An observer hook or companion change, at the stage the user approves now: the described remedy, before any code is drafted. */
  | ({ operation: "harness"; stage: "intent" } & HarnessIntent)
  /** The drafted code, after the user's Apply of the same identity's intent in this pass, which `intent` cites. */
  | { operation: "harness"; stage: "code"; intent: ProposalAnswerRef; files: HarnessFile[]; check: HarnessCheck }
  /** Deleting the hook file the target names, asked once: the pass deletes it after Apply. */
  | { operation: "harness"; stage: "removal" };

/** The described remedy of an observer hook or companion change: the intent-stage preview, field by field. */
interface HarnessIntent { event: string; predicate: string; action: string; mistake: string; legitimate: string; scope: string; lowerRungs: string }
const INTENT_LINES: ReadonlyArray<[keyof HarnessIntent, string]> = [
  ["event", "Event"], ["predicate", "Predicate"], ["action", "Action"], ["mistake", "Mistake sample"], ["legitimate", "Legitimate sample"],
  ["scope", "Scope"], ["lowerRungs", "Why each lower rung fails"],
];

/** The check the drafting ran on the code, and its observed output. */
export interface HarnessCheck { command: string; output: string }

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
type ReviewCandidate = CandidateDraft & TargetScope;

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
  /** Apply of an intent authorises drafting only: nothing is written or recorded as applied from it. */
  | { operation: "harness"; stage: "intent" }
  /** Approve the exact code: `root` is the target root's directory; the pass writes the files with normal tools and the resolver only records them. */
  | { operation: "harness"; stage: "code"; root: string; files: HarnessFile[]; check: HarnessCheck }
  /** Delete the hook `file` in its hooks directory `root`: the pass deletes it with its own tools and the resolver records the removal once it is gone. */
  | { operation: "harness"; stage: "removal"; root: string; file: string }
  /** `record`: the amendment already holds the section verbatim, so publication writes nothing and only the ledger changes. */
  | { operation: "on-read-append"; effect: "create" | "append" | "record"; rule: RuleIdentity; target: FileSnapshot; section: string }
  /** Samples stay in the form the scope sees, as `observer_check` and `observer_resolve` take them. */
  | { operation: "rule"; rule: RuleIdentity; target: FileSnapshot; body: string; matches: Sample[]; spares: Sample[] }
  | { operation: "stale-update"; rule: RuleIdentity; target: FileSnapshot; body: string; references?: ReferenceChange }
  | { operation: "stale-delete"; rule: RuleIdentity; target: FileSnapshot; references?: ReferenceChange }
  | { operation: "withdrawal"; withdrawn: { fingerprint: string; gist: string }; effect: "record" }
  | { operation: "withdrawal"; withdrawn: { fingerprint: string; gist: string }; effect: "delete"; rule: RuleIdentity; target: FileSnapshot; references?: ReferenceChange }
  | { operation: "withdrawal"; withdrawn: { fingerprint: string; gist: string }; effect: "rewrite"; rule: RuleIdentity; target: FileSnapshot; body: string; references?: ReferenceChange }
  /** `rule` is absent when this pass's additions create the amendment the compaction rewrites. */
  | { operation: "compaction"; rule?: RuleIdentity; target: FileSnapshot; includes: string[]; body: string; references: ReferenceChange };
type ProtectedChange = Exclude<PreparedChange, { operation: "direct-edit" | "harness" }>;
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
  action: "inspect" | "catalog" | "prepare" | "select";
  skill?: string;
  references?: string[];
  terms?: string[];
  at?: string;
  limit?: number;
  cursor?: string;
  candidates?: ReviewCandidate[];
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
interface ReviewDetails {
  eligible: PreparedEntry[];
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

interface PrepareContext extends ReceiptContext {
  cwd: string;
  /** The agent directory, which holds the global hooks directory and the companion extension. */
  agentDir: string;
  /** The whole ledger: a withdrawal cites a fix wherever it was recorded. */
  ledger: readonly LedgerRecord[];
  /** Filled by Prepare: the `## ` headings of each on-read append's target amendment at the bytes it read, by candidate ID, kept out of the proposal so its content hash ignores them. */
  amendmentSections: Map<string, string[]>;
}

/** The model uses installed host judge helpers between Prepare and Select; this tool never calls a provider. */
export function registerReviewTool(pi: ExtensionAPI, files: ObserverFiles, catalogGap: () => string | undefined): void {
  const z = pi.zod;
  const referenceFiles = z.array(z.object({ name: z.string(), body: z.string() }));
  const change = z.union([
    z.object({ operation: z.enum(["direct-edit"]), preview: z.string().describe("The exact diff, new skill or project repair.") }),
    z.object({ operation: z.enum(["on-read-append"]), section: z.string().describe("The section appended to the skill's on-read amendment: a `## ` heading line and its text.") }),
    z.object({ operation: z.enum(["rule"]), name: z.string(), body: z.string(), pattern: z.string(), ...sampleSchemas(z) })
      .describe("A pattern amendment (upstream/plugin) or barrier rule (local/managed), as checked by observer_check."),
    z.object({ operation: z.enum(["stale-update"]), rule: z.string(), body: z.string(), references: referenceFiles.optional() }),
    z.object({ operation: z.enum(["stale-delete"]), rule: z.string() }),
    z.object({ operation: z.enum(["withdrawal"]), body: z.string().optional(), references: referenceFiles.optional() })
      .describe("Takes back the applied fix named by the candidate `fingerprint`; for a fix inside the on-read amendment, `body` is its whole new body, empty to delete it."),
    z.object({ operation: z.enum(["compaction"]), includes: z.array(z.string()), body: z.string(), references: referenceFiles })
      .describe("`includes`: the on-read appends of this Prepare it covers, by gist or fingerprint; `references`: the complete set."),
    z.object({
      operation: z.enum(["harness"]), stage: z.enum(["intent"]),
      event: z.string().describe("The host event the hook handles, such as `tool_call` for one tool."),
      predicate: z.string().describe("What in the event marks the mistake."), action: z.string().describe("What the hook does then: block the call or add context; only the companion may change a call or its result."),
      mistake: z.string().describe("The session's mistake as a sample event."), legitimate: z.string().describe("Its nearest legitimate counterpart, which the hook leaves untouched."),
      scope: z.string().describe("Why this project's hooks, the global hooks for a mistake that generalises, or the companion."),
      lowerRungs: z.string().describe("Why a configuration repair, skill text, barrier rule, pattern amendment, project check or, for the companion, a hook does not fit."),
    }).describe("An observer hook or companion-extension change at its intent stage: the described remedy, previewed and asked before any code is drafted. Apply authorises drafting only."),
    z.object({
      operation: z.enum(["harness"]), stage: z.enum(["code"]),
      intent: z.object(approvalShape(z)).describe("The user's Apply of this identity's intent in this pass, as observer_resolve would cite an approval."),
      files: z.array(z.object({ path: z.string().describe("Relative to the target root: for a hook, its one file; for the companion, every file the change writes, including `package.json` declaring `omp.extensions` when the companion is new."), text: z.string().describe("The file's exact text, as written.") })),
      check: z.object({ command: z.string().describe("For the companion, `bun test`, run in the companion directory against its test file."), output: z.string().describe("The check's observed output, unedited.") }),
    }).describe("The drafted code of an approved intent, with the check it passed: shown and asked in a Select and Ask of its own; Apply approves writing exactly these files."),
    z.object({ operation: z.enum(["harness"]), stage: z.enum(["removal"]) })
      .describe("Deletes the hook file the target names, in either hooks directory, hand-written ones included: asked once, showing the file as it stands, with Apply and Decline. After Apply the pass deletes the file itself; observer_resolve records the removal once it is gone."),
  ]);
  const draft = {
    gist: z.string(), priority: z.enum(PRIORITIES), remedy: z.string(), change,
    evidence: z.array(z.object({ quote: z.string(), count: z.number(), source: z.string().optional(), occurrenceIds: z.array(z.string()).optional() })).optional(),
    fingerprint: z.string().optional(),
    reconciles: z.object({
      approval: z.object(approvalShape(z)).describe("The user's approval of the original proposal, exactly as observer_resolve would cite it."),
      changedTarget: z.string().optional().describe("Only when the target amendment or rule file changed since the approved Prepare read it, and then required: how it changed."),
      reason: z.string().describe("Why this revision of the approved section or rule: what the user's note asked for, the target's change, or both."),
      preserved: z.string().describe("Why the revision keeps the approved intent and the target's unrelated content."),
    }).optional().describe("On-read append or rule only: revises an approved proposal, in the same pass, by the note the user attached to its Apply (read from the Ask; a section, or a rule's body, pattern and samples, not its name), for a target that changed after its Prepare, or both. The main agent's reconciliation, not the user's approval: a change that would drop or rewrite the target's new content, or delete a target, needs a new proposal and Ask."),
    diagnosis: z.object({
      inspection: z.string().describe("The ID of this pass's observer_review inspect call of the candidate's skill, whose receipt the citations name; for a new skill, of its new-skill search."),
      explanation: z.string().describe("Why the inspected guidance does not already address the finding (missing, unclear or ignored), with the check that could have shown otherwise and its result; for a new skill, why each search match does not fit."),
      delta: z.string().describe("One sentence: what a future agent will do differently."),
      citations: z.array(z.object({
        source: z.string().describe("A source `path` the inspection receipt lists."),
        lines: z.object({ from: z.number(), to: z.number() }).optional().describe("1-based inclusive lines of that source as inspected."),
        section: z.string().optional().describe("A `## ` heading of that source as inspected."),
      })).optional().describe("Required for a repair, omitted for a new skill: the inspected guidance the explanation rests on, each by `lines`, `section` or both."),
    }).optional().describe("The candidate diagnosis: required for a new skill, a direct edit of a local or managed skill, an on-read append and a rule; omitted for a project or harness remedy, stale answers, withdrawals and compactions."),
  };
  pi.registerTool<ReviewParams, ReviewDetails>({
    name: REVIEW_TOOL_NAME, label: "Observer Review", approval: "read", loadMode: "essential", defaultInactive: true,
    description: "Inspect a skill's current guidance before drafting a repair to it: its `SKILL.md`, every observer rule amending it with its status (a stale pin is still in force), and the reference files requested from its observer reference folder, each with line numbers, `sha256` and `## ` sections, plus the folder's inventory by fingerprint; the successful result is the receipt a candidate `diagnosis` cites by its call ID. With `terms`, inspect searches for a new skill instead: it fails when a skill named `skill` is installed or was created this session, or when the skills directory, managed skills, plugin registry or an enabled plugin's skills exist but can't be read; otherwise it reports each source's coverage and the skills whose name or description holds a term. A fitting match is no new skill: inspect it and repair it. Catalog searches this branch's skill catalog observations for the skill named exactly `skill`, or for skills whose description shown then contains every one of `terms`: per observation, its entry, references and whether the observed skills block listed the skill with the description shown then, did not list it, or left it unknown, then each later change OMP's persisted skill notices and compactions made to it, ordered by observation then skill name, and known capture gaps. With `at`, only the latest observation at or before that entry and the gaps between. Results come `limit` at a time; `next` continues while the catalog evidence is unchanged. It refuses an empty query, never reads installed skills, and no match means unknown, not absent. An observation is what the system prompt listed at `before_agent_start`, not proof the model received it. Prepare canonical eligible observation proposals before optional host judge_batch: canonicalize each exact change into the operation observer_resolve would carry out, read its current target and reference files, render its preview, merge identities/evidence, remove prior declines, and return per proposal its reference, fingerprint, scope, gist and preview (for an on-read append also `amendmentSections`, the `## ` headings its target amendment already holds), plus minimized judgeStates only for classes needing comparison with an explicitly configured available judge model. Prepare refuses a direct edit of a local or managed skill, an on-read append or a rule without a `diagnosis` naming a successful inspect receipt of its skill from this pass on this branch, its explanation, its behavior delta and citations of places that receipt inspected; Prepare, and Select again before producing its form, refuse it once that skill's inspected sources, rules or reference folder inventory changed: inspect again and prepare again. A new skill needs a `diagnosis` naming its new-skill search from this pass on this branch, why the matches do not fit and its behavior delta; Prepare and Select refuse it once a skill of that name exists or the searched inventory or any searched skill file changed. A candidate with `reconciles` revises an approved on-read append or rule by the user's approval note on its Apply, for its changed target, or both: Prepare checks the cited approval still holds in this pass and the revision makes the same operation on the same target under the same identity. Under a note that asks for a check or only acknowledges, the revision may equal the approved change, with `reason` stating what was checked. Select takes only those references, verifies them against this branch's successful Prepare results, rechecks model availability before accepting advisory rankings, or uses stable evidence ordering with a fallback reason. Selection preserves stale/note/evidence/compaction priority and five slots; overflow remains deferred for observer_resolve. Select returns the references it selected and deferred, and `askHtml`, the complete Ask form for the proposals it selected: call `ask` with `html` set to it exactly as returned, since an answer approves only under that form. This tool neither writes, asks, approves nor publishes and never calls a model.",
    parameters: z.object({
      action: z.enum(["inspect", "catalog", "prepare", "select"]),
      skill: z.string().optional().describe("Inspect only: the installed skill whose current guidance to read; with `terms`, the name of the proposed new skill. Catalog: the exact skill name to look up, instead of `terms`."),
      references: z.array(z.string()).optional()
        .describe("Inspect only: file names in the skill's observer reference folder to read too; the others are only listed by fingerprint and are not inspected."),
      terms: z.array(z.string()).optional()
        .describe("Inspect, for a proposed new skill: the words of its workflow to look for, case-insensitively, in every current skill's name and description. Catalog, instead of `skill`: words that must all appear, case-insensitively and literally, in an observed skill's rendered description; names are not searched."),
      at: z.string().optional().describe("Catalog only: the exact ID of an entry on the active branch; the lookup returns the latest observation at or before it, with the skill notices, compactions and resets up to it and the known gaps in between."),
      limit: z.number().optional().describe("Catalog only: the page size, a whole number of at least 1; 20 when omitted."),
      cursor: z.string().optional().describe("Catalog only: the `next` cursor of the previous page, with the same `skill`, `terms` and `at`; refused once the branch's catalog evidence changed."),
      candidates: z.array(z.union([
        z.object({ ...draft, kind: z.enum(PROPOSAL_KINDS), skill: z.string() }),
        z.object({ ...draft, kind: z.enum(["project"]), target: z.object({
          scope: z.enum(["project"]), root: z.string(), path: z.string(), mechanism: z.string(),
        }) }),
        z.object({ ...draft, kind: z.enum(["harness"]), target: z.object({
          scope: z.enum(["harness"]), root: z.enum(HARNESS_ROOTS),
          path: z.string().optional().describe("An existing hook file, relative to its hooks directory; omit for a new hook, which is named by its fingerprint, and for the companion."),
          mechanism: z.string(),
        }) }),
      ])).optional().describe("Prepare only: exact candidate changes. Stale Keep is no candidate. Project identity uses target mechanism; global guidance uses its general gist."),
      proposals: z.array(proposalRefSchema(z)).optional()
        .describe("Select only: the `reference` of each eligible proposal, exactly as Prepare returned it."),
      rankings: z.array(z.object({ id: z.string(), score: z.number(), confidence: z.number(), consistent: z.unknown().describe("Boolean: true only after inspecting agreement with cited evidence.") })).optional().describe("Select only: each compared candidateId exactly once, score 0..3 and confidence 0..1 from host judge, with consistent as a boolean after inspecting evidence agreement. Do not rank singleton classes."),
      rankingFailure: z.string().optional().describe("Select only: exact unavailable/failed host ranking reason. Do not retry the batch."),
    }),
    async execute(toolCallId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (params?.action === "inspect" || params?.action === "catalog") return readOnlyActionResult(params, files, ctx, catalogGap());
      const details = emptyDetails();
      const amendmentSections = new Map<string, string[]>();
      try {
        const ledger = readLedger(files.ledgerFile());
        const guidance = receiptContext(ctx, files);
        if (params?.action === "prepare") {
          if (!Array.isArray(params.candidates) || params.proposals !== undefined) throw new Error("Prepare needs a candidate array and no references");
          const context: PrepareContext = { ...guidance, cwd: ctx.cwd, agentDir: ompAgentDir(), ledger, amendmentSections };
          details.eligible = prepareProposals(params.candidates, context).map((proposal) => ({
            reference: { reviewToolCallId: toolCallId, candidateId: proposal.candidateId, contentHash: contentHash(proposal) },
            proposal,
          }));
        } else if (params?.action === "select") {
          if (params.candidates !== undefined) throw new Error("Select takes `proposals`, the references a successful Prepare returned, not candidate drafts");
          const declined = declinedFingerprints(ledgerForProject(ledger, ctx.cwd));
          details.eligible = preparedEntries(params.proposals, guidance.evidence, guidance.branch)
            .filter((entry) => !declined.has(entry.proposal.fingerprint));
          if (details.eligible.length > 1 && details.eligible.some(({ proposal }) => "change" in proposal && proposal.change.operation === "harness" && proposal.change.stage === "code")) {
            throw new Error("the code of a hook or companion change is asked in its own Select and Ask, apart from every other question");
          }
        } else {
          throw new Error("review needs inspect/catalog/prepare/select");
        }
        const classCounts: Record<Priority, number> = { stale: 0, note: 0, evidence: 0, compaction: 0 };
        for (const { proposal } of details.eligible) classCounts[proposal.priority]++;
        const cutoff = 5;
        const compared = details.eligible.filter(({ proposal }) => {
          const index = PRIORITIES.indexOf(proposal.priority);
          const preceding = PRIORITIES.slice(0, index).reduce((sum, priority) => sum + classCounts[priority], 0);
          const slots = Math.max(0, cutoff - preceding);
          return slots > 0 && classCounts[proposal.priority] > slots;
        });
        const modelUnavailable = compared.length > 0 ? await rankingModelUnavailable(pi, ctx) : undefined;
        details.needsRanking = compared.length > 0 && !modelUnavailable;
        if (params.action === "prepare") {
          for (const { proposal } of details.needsRanking ? compared : []) {
            details.judgeStates[proposal.candidateId] = {
              target: proposal.kind === "project" ? `project:${proposal.target.path}` : proposal.kind === "harness" ? `harness:${targetLabel(proposal)}` : `skill:${proposal.skill}`,
              mechanism: proposal.target?.mechanism ?? proposal.gist,
              remedy: proposal.remedy, evidence: proposal.evidence,
              repeatCount: distinctOccurrences(proposal.evidence) || proposal.evidence.reduce((max, item) => Math.max(max, item.count), 0),
            };
          }
        } else {
          const selection = selectCandidates(details.eligible, compared, params.rankings, modelUnavailable ?? params.rankingFailure);
          const selected = selection.ordered.slice(0, 5);
          for (const { reference, proposal } of selected) {
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
          details.selected = selected;
          details.deferred = selection.ordered.slice(5);
          if (selection.fallback) details.fallback = selection.fallback;
        }
      } catch (error) {
        signal?.throwIfAborted();
        details.eligible = [];
        details.failures.push(error instanceof Error ? error.message : String(error));
      }
      const output = params?.action === "prepare"
        ? {
            eligible: details.eligible.map((entry) => preparedSummary(entry, amendmentSections)),
            needsRanking: details.needsRanking, judgeStates: details.judgeStates, failures: details.failures,
          }
        : {
            selected: details.selected.map(({ reference }) => reference), deferred: details.deferred.map(({ reference }) => reference),
            ...(details.selected.length > 0 && { askHtml: renderAskHtml(details.selected.map(({ proposal }) => proposal)) }),
            ...(details.fallback && { fallback: details.fallback }), failures: details.failures,
          };
      return { content: [{ type: "text", text: JSON.stringify(output) }], details, isError: details.failures.length > 0 };
    },
  });
}

const emptyDetails = (): ReviewDetails => ({ eligible: [], needsRanking: false, judgeStates: {}, selected: [], deferred: [], failures: [] });

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

function readOnlyActionResult(params: ReviewParams, files: ObserverFiles, ctx: ExtensionContext, catalogGap: string | undefined) {
  const details = emptyDetails();
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details, isError: false });
  try {
    if (params.action === "catalog") {
      if (params.candidates !== undefined || params.proposals !== undefined || params.references !== undefined) {
        throw new Error("A catalog lookup takes `skill` or `terms`, with optional `at`, `limit` and `cursor`");
      }
      const { lookup, text } = lookupCatalog(params, ctx.sessionManager.getBranch(), catalogGap);
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
    throw new Error(`\`${amendmentFile}\` is no on-read amendment skill-observer can read: its frontmatter is missing, malformed or another author's`);
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
 * is preselected, so the user chooses each answer. A preview sits in a `<p>`
 * with `<br>` line breaks because the host cuts each `<pre>` line at the dialog
 * width; the whitespace a `<p>` collapses is shown as marks instead.
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
    : proposal.change.operation === "withdrawal" || isRemoval(proposal.change) ? [APPLY, "Decline"] : [APPLY, "Later", "Decline"];
  // Approval of these takes no note, so a noted answer becomes a new Prepare and Ask.
  const notedAsksAgain = isStale ? "An Update or Delete with a note is asked again."
    : ["withdrawal", "compaction", "harness"].includes(proposal.change.operation) ? "An Apply with a note is asked again." : undefined;
  const evidence = proposal.evidence.map(({ quote, count, source }) => `<li>${escapeHtml(`"${quote}" (×${count}${source ? `, ${source}` : ""})`)}</li>`);
  const name = escapeHtml(proposal.candidateId).replace(/"/g, "&quot;");
  return [
    "<fieldset>",
    `<legend>${escapeHtml(`${targetLabel(proposal)}: ${proposal.gist}`)}</legend>`,
    `<p>${escapeHtml(proposal.remedy)}</p>`,
    ...(proposal.diagnosis ? renderDiagnosis(proposal.diagnosis) : []),
    ...(evidence.length > 0 ? ["<ul>", ...evidence, "</ul>"] : []),
    ...previews,
    ...(notedAsksAgain ? [`<p>${notedAsksAgain}</p>`] : []),
    // The host reports the text block right before a group as the answer's question.
    `<p><b>${isStale ? "Keep, update or delete this stale amendment?" : "Apply this change?"}</b></p>`,
    // The host reports text typed into the group's Other row as an option's label when it equals that option's value, so no value is a bare label.
    ...labels.map((label) => `<label><input type="radio" name="${name}" value="${name}=${label}" required>${label}</label>`),
    "</fieldset>",
  ].join("\n");
}

function renderDiagnosis({ inspection, explanation, delta, citations, search }: CandidateDiagnosis): string[] {
  const place = ({ source, lines, section }: Citation) => `${source}${lines ? ` lines ${lines.from}–${lines.to}` : ""}${section ? ` § ${section}` : ""}`;
  const grounds = search
    ? `Searched current skills, inspection ${inspection}, for: ${search.terms.join(", ")}; matches: ${search.matches.join(", ") || "none"}`
    : `Cited guidance, inspection ${inspection}: ${citations.map(place).join("; ")}`;
  return [
    `<p>${escapeHtml(`Diagnosis: ${explanation}`)}</p>`,
    `<p>${escapeHtml(`Behavior change: ${delta}`)}</p>`,
    `<p>${escapeHtml(grounds)}</p>`,
  ];
}

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

const declinedFingerprints = (ledger: readonly LedgerRecord[]) =>
  new Set(ledger.filter((record) => record.outcome === "declined").map((record) => record.fingerprint));

function prepareProposals(candidates: readonly ReviewCandidate[], context: PrepareContext): PreparedProposal[] {
  const scoped = ledgerForProject(context.ledger, context.cwd);
  const declined = declinedFingerprints(scoped);
  const grouped = new Map<string, PreparedProposal>();
  const checked = candidates.map((draft) => checkedCandidate(draft, context));
  // A compaction's `includes` resolve to this Prepare's on-read appends, so it is prepared after them.
  const ordered = checked.toSorted((a, b) => Number(a.change.operation === "compaction") - Number(b.change.operation === "compaction"));
  for (const candidate of ordered) {
    const prepared = preparedProposal(candidate, scoped, declined, [...grouped.values()], context);
    if (!prepared) continue;
    const proposal = isSkillTextRepair(candidate) || isNewSkill(candidate)
      ? { ...prepared, diagnosis: candidateDiagnosis(candidate, context) } : prepared;
    const previous = grouped.get(proposal.candidateId);
    grouped.set(proposal.candidateId, previous ? joined(previous, proposal) : proposal);
  }
  return [...grouped.values()];
}

const SKILL_TEXT_OPERATIONS: ReadonlyArray<string> = ["direct-edit", "on-read-append", "rule"];

function isSkillTextRepair<T extends { kind: string; change?: { operation: string } }>(subject: T): subject is T & { skill: string } {
  return subject.kind !== "project" && subject.kind !== "harness" && subject.kind !== "new" && subject.change !== undefined && SKILL_TEXT_OPERATIONS.includes(subject.change.operation);
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
    throw new Error(isNew
      ? `the new skill \`${skill}\` needs its candidate diagnosis ${missing.join("; ")}: search for it with observer_review \`action: "inspect"\`, \`skill\` and \`terms\`, and cite that receipt`
      : `the repair of \`${skill}\` needs its candidate diagnosis ${missing.join("; ")}: inspect the skill with observer_review \`action: "inspect"\` and cite that receipt`);
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
  if (result.isError !== false || !(details?.inspection || details?.search)) throw new Error(`${label}: that inspection failed; inspect the skill again`);
  if (passStart === undefined) throw new Error(`${label}: no observation pass is current on this branch, so no inspection grounds a repair`);
  if (call.position < passStart) throw new Error(`${label} is from an earlier observation pass; inspect the skill again in this pass`);
  return details;
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
  if ("alternatives" in previous && "alternatives" in next) {
    const alternatives = [...previous.alternatives];
    for (const alternative of next.alternatives) {
      const same = alternatives.find(({ change }) => change.operation === alternative.change.operation);
      if (!same) alternatives.push(alternative);
      else if (JSON.stringify(same) !== JSON.stringify(alternative)) throw new Error(`stale \`${same.change.rule.name}\` has two different ${same.change.operation} drafts`);
    }
    alternatives.sort((a, b) => OPERATIONS.indexOf(a.change.operation) - OPERATIONS.indexOf(b.change.operation));
    return { ...previous, evidence, alternatives };
  }
  const preferred = PRIORITIES.indexOf(next.priority) < PRIORITIES.indexOf(previous.priority) ? next : previous;
  return { ...preferred, evidence };
}

function checkedCandidate(candidate: ReviewCandidate, context: PrepareContext): ReviewCandidate & { evidence: ReviewEvidence[] } {
  if (!candidate || typeof candidate.gist !== "string" || !candidate.gist.trim() || !PRIORITIES.includes(candidate.priority) ||
      typeof candidate.remedy !== "string" || !candidate.remedy.trim() || !candidate.change || !OPERATIONS.includes(candidate.change.operation)) {
    throw new Error("each review candidate needs gist, priority, remedy and an exact change");
  }
  if (candidate.evidence !== undefined && (!Array.isArray(candidate.evidence) || candidate.evidence.some((item) => !item ||
      typeof item.quote !== "string" || !item.quote.trim() || !Number.isInteger(item.count) || item.count < 1 ||
      (item.source !== undefined && typeof item.source !== "string") ||
      (item.occurrenceIds !== undefined && (!Array.isArray(item.occurrenceIds) || item.occurrenceIds.some((id) => typeof id !== "string" || !id.trim())))))) throw new Error("candidate evidence needs exact quotes, occurrence IDs and positive integer counts");
  const evidence = mergeEvidence(candidate.evidence ?? []);
  if (candidate.kind === "project") {
    if (candidate.skill !== undefined) throw new Error("project review candidates carry no skill name");
    return { ...candidate, target: canonicalProjectTarget(context.cwd, candidate.target), evidence };
  }
  if (candidate.kind === "harness") {
    if (candidate.skill !== undefined) throw new Error("harness review candidates carry no skill name");
    return { ...candidate, target: canonicalHarnessTarget(context.cwd, context.agentDir, candidate.target), evidence };
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
  candidate: ReviewCandidate & { evidence: ReviewEvidence[] }, scoped: readonly LedgerRecord[], declined: ReadonlySet<string>,
  prepared: readonly PreparedProposal[], context: PrepareContext,
): PreparedProposal | undefined {
  const { change: draft } = candidate;
  const isStale = draft.operation === "stale-update" || draft.operation === "stale-delete";
  if ((candidate.priority === "stale") !== isStale) throw new Error("stale priority is exactly a stale Update/Delete change");
  if ((candidate.priority === "compaction") !== (draft.operation === "compaction")) throw new Error("compaction priority is exactly a compaction change");
  if (candidate.reconciles !== undefined && draft.operation !== "on-read-append" && draft.operation !== "rule") {
    throw new Error("only an on-read append or a rule can be reconciled: its revision keeps the target's current content; a change that would delete a changed target, or rewrite one without keeping its content, needs a new prepared proposal and Ask");
  }
  const scope: TargetScope = candidate.kind === "project" ? { kind: "project", target: candidate.target }
    : candidate.kind === "harness" ? { kind: "harness", target: candidate.target }
    : { kind: candidate.kind, skill: candidate.skill };
  const base = { priority: candidate.priority, ...scope, gist: candidate.gist, remedy: candidate.remedy, evidence: candidate.evidence };
  if (candidate.kind === "harness") {
    if (draft.operation !== "harness") throw new Error("an observer hook or companion change is a harness change, asked first as its intent");
    if (draft.stage === "removal") {
      const removal = hookRemoval(candidate.target, context);
      checkCurrentFingerprint(candidate, removal.fingerprint);
      if (declined.has(removal.fingerprint)) return undefined;
      const { priority, gist, remedy, evidence } = candidate;
      return { candidateId: `removal:${removal.fingerprint}`, fingerprint: removal.fingerprint, priority, kind: "harness", target: removal.target, gist, remedy, evidence, ...removalStage(removal) };
    }
    const isCode = draft.stage === "code";
    if (!isCode && draft.stage !== "intent") throw new Error("a harness change is prepared at its `intent` stage, then at its `code` stage, or as a `removal`");
    const missing = isCode ? undefined : INTENT_LINES.find(([field]) => typeof draft[field] !== "string" || !draft[field].trim());
    if (missing) throw new Error(`a harness intent needs its ${missing[1].toLowerCase()}`);
    const fingerprint = proposalIdentity(candidate, scoped);
    if (declined.has(fingerprint)) return undefined;
    if (isCode) return { candidateId: `code:${fingerprint}`, fingerprint, ...base, ...codeStage(candidate.target, fingerprint, draft, context) };
    return { candidateId: `proposal:${fingerprint}`, fingerprint, ...base, change: { operation: "harness", stage: "intent" }, preview: intentPreview(candidate.target, fingerprint, draft, context) };
  }
  if (draft.operation === "harness") throw new Error("a harness change needs a harness target: the project or global hooks directory, or the companion extension");
  if (draft.operation === "direct-edit") {
    if (isPinKind(candidate.kind)) throw new Error("an upstream or plugin skill takes amendment rules, not a direct edit");
    if (typeof draft.preview !== "string" || !draft.preview.trim()) throw new Error("a direct edit needs its exact preview");
    const fingerprint = proposalIdentity(candidate, scoped);
    if (declined.has(fingerprint)) return undefined;
    return { candidateId: `proposal:${fingerprint}`, fingerprint, ...base, change: { operation: "direct-edit" }, preview: draft.preview };
  }
  if (candidate.kind === "project") throw new Error("a project proposal is a direct edit");
  const { skill, kind } = candidate;
  const { dirs, referencesDir } = context;
  /** `prepare` validates and reads the change's target only once the identity is known not to be declined. */
  const proposal = (identityClass: string, fingerprint: string, prepare: () => ProtectedChange): PreparedProposal | undefined => {
    if (declined.has(fingerprint)) return undefined;
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
      const fingerprint = proposalIdentity(candidate, scoped);
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
      if (typeof draft.pattern !== "string" || !draft.pattern.trim()) throw new Error("a rule change needs its `pattern`; an on-read fix is an on-read append");
      const fingerprint = proposalIdentity(candidate, scoped);
      return reconciled(proposal("proposal", fingerprint, () => {
        const { operation: _, ...rule } = draft;
        const fix = fixRule({ skill, kind, gist: candidate.gist, rule }, fingerprint, dirs, context.provenance);
        return {
          operation: "rule", ...ruleTarget(fix.rule), body: fix.rule.body.trim(),
          matches: rule.matches ?? [], spares: rule.spares ?? [],
        };
      }));
    }
    case "stale-update":
    case "stale-delete": {
      const rule = readObserverRule(dirs, draft.rule);
      if (rule.amends !== skill) throw new Error("stale rule does not amend the candidate skill");
      checkCurrentFingerprint(candidate, rule.fingerprint);
      return proposal("stale", rule.fingerprint, () => {
        if (!isPinned(rule)) throw new Error(`\`${rule.name}\` is a barrier rule for a local or managed skill, so it never goes stale`);
        if (draft.operation === "stale-delete") {
          return { operation: "stale-delete", ...ruleTarget(rule), ...optional("references", releasedReferences(dirs, referencesDir, rule)) };
        }
        const body = typeof draft.body === "string" ? draft.body.trim() : "";
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
      const fingerprint = proposalIdentity(candidate, scoped);
      return proposal("withdrawal", fingerprint, () => {
        const hasDraft = draft.body !== undefined || draft.references !== undefined;
        const taken = withdrawal({ skill, fingerprint },
          hasDraft ? { body: draft.body ?? "", ...optional("references", draft.references) } : undefined,
          new Map(context.ledger.map((record) => [record.fingerprint, record])), dirs, referencesDir);
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
      checkCurrentFingerprint(candidate, fingerprint);
      return proposal("compaction", fingerprint, () => {
        const installed = context.provenance.byName(skill);
        if (!isPinKind(installed.kind) || installed.kind !== kind) throw new Error(`\`${skill}\` is not an upstream or plugin skill, so it has no on-read amendment to compact`);
        const body = typeof draft.body === "string" ? draft.body.trim() : "";
        if (!body) throw new Error("a compaction needs the compacted `body`");
        if (!Array.isArray(draft.includes) || draft.includes.some((addition) => typeof addition !== "string" || !addition.trim())) {
          throw new Error("a compaction's `includes` lists the on-read appends of this Prepare it covers, by gist or fingerprint");
        }
        if (!Array.isArray(draft.references)) throw new Error("a compaction needs its complete set of `references`, empty for none");
        checkReferenceFiles(draft.references);
        checkPointers(referencesDir, skill, body, draft.references);
        return {
          operation: "compaction", ...optional("rule", current && ruleIdentity(current)),
          target: snapshot(current?.path ?? rulePath(dirs.amendmentsDir, skillAmendmentName(skill))),
          includes: [...new Set(draft.includes.map((addition) => includedAddition(skill, addition, prepared)))],
          body, references: referenceChange(referencesDir, skill, draft.references),
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
  const matches = prepared.filter((proposal) => proposal.skill === skill && "change" in proposal && proposal.change.operation === "on-read-append" &&
    (proposal.fingerprint === addition || proposalFingerprint(skill, proposal.gist) === named));
  const [match] = matches;
  if (!match || matches.length > 1) {
    throw new Error(`the compaction of \`${skill}\` includes ${JSON.stringify(addition)}, which names ${match ? "more than one" : "no"} on-read append of this Prepare`);
  }
  return match.fingerprint;
}

/** A proposal's ledger identity: the scoped gist, or a re-offered Later entry's or withdrawn fix's recorded fingerprint. */
function proposalIdentity(candidate: ReviewCandidate, ledger: readonly LedgerRecord[]): string {
  let fingerprint = candidate.kind === "project" ? projectFingerprint(candidate.target)
    : candidate.kind === "harness" ? harnessFingerprint(candidate.target)
    : proposalFingerprint(candidate.skill, candidate.gist);
  if (candidate.kind !== "project" && candidate.kind !== "harness" && candidate.fingerprint !== undefined) {
    const existing = ledger.find((record) => record.fingerprint === candidate.fingerprint);
    if (existing) {
      if (existing.target !== undefined || existing.skill !== candidate.skill) throw new Error("candidate fingerprint belongs to another target");
      fingerprint = existing.fingerprint;
    }
  }
  checkCurrentFingerprint(candidate, fingerprint);
  return fingerprint;
}

/** The intent-stage preview: where the hook or companion change goes, its description, and what Apply authorises. */
function intentPreview(target: HarnessTarget, fingerprint: string, intent: HarnessIntent, { cwd, agentDir }: PrepareContext): string {
  const dirs = harnessRootDirs(cwd, agentDir);
  const where = target.root === "companion" ? `The companion extension \`${dirs.companion}\``
    : `The ${HARNESS_ROOT_NAMES[target.root]} \`${join(dirs[target.root], hookPath(target, fingerprint))}\``;
  return [
    `${where}:`, "", ...INTENT_LINES.map(([field, label]) => `${label}: ${intent[field].trim()}`), "",
    "Apply authorises drafting only: the drafted code and its check result are shown and asked again before any file is written.",
  ].join("\n");
}

/**
 * A hook's or companion change's code stage, accepted only while the user's
 * Apply of the intent with the same identity holds in this pass: each file's
 * exact text, the check the draft passed and its observed output, all shown
 * in the preview.
 */
function codeStage(target: HarnessTarget, fingerprint: string, draft: Extract<ChangeDraft, { stage: "code" }>, { cwd, agentDir, branch }: PrepareContext):
  { change: Extract<PreparedChange, { stage: "code" }>; preview: string } {
  const { proposal: intent } = approvedHarness(draft.intent, ["intent"], branch);
  if (intent.fingerprint !== fingerprint) throw new Error(`the cited intent Apply approved another hook or companion change, \`${intent.fingerprint}\`, not \`${fingerprint}\``);
  const root = harnessRootDirs(cwd, agentDir)[target.root];
  const isCompanion = target.root === "companion";
  const files = isCompanion ? companionFiles(root, draft.files) : [hookFile(hookPath(target, fingerprint), draft.files)];
  const { command, output } = draft.check ?? {};
  if (typeof command !== "string" || !command.trim() || typeof output !== "string") throw new Error("the code needs the check command it passed and that check's observed output");
  if (isCompanion) checkCompanionCommand(command);
  else checkHookCommand(command, root, files[0]!.path);
  const preview = [
    ...files.flatMap(({ path, text }) => [`${existsSync(join(root, path)) ? "Replace" : "Create"} \`${join(root, path)}\` with:`, "", text, ""]),
    `Check command: ${command}`, "Check result:", output, "",
    `Apply writes this code and reruns the check in the foreground in \`${root}\`. A written ${isCompanion ? "companion file" : "hook"} acts only after omp restarts.`,
  ].join("\n");
  // The Ask form collapses whitespace, so a carriage return would be written without ever being shown.
  if (preview.includes("\r")) throw new Error("the code or its check output holds a carriage return, which the Ask preview would not show; send it with `\\n` line ends only");
  return { change: { operation: "harness", stage: "code", root, files, check: { command, output } }, preview };
}

function hookFile(file: string, drafted: readonly HarnessFile[] | undefined): HarnessFile {
  const [only, ...rest] = Array.isArray(drafted) ? drafted : [];
  if (!only || rest.length > 0 || only.path !== file || typeof only.text !== "string" || !only.text.trim()) throw new Error(`a hook's code is its one file \`${file}\` with its exact text`);
  return { path: only.path, text: only.text };
}

/**
 * A companion change's files, each at a plain path inside the companion
 * directory. Its manifest, written now or already there, declares the entries
 * host discovery loads, and the change adds or keeps a test file outside
 * `node_modules` for `bun test` to run.
 */
function companionFiles(root: string, drafted: readonly HarnessFile[] | undefined): HarnessFile[] {
  if (!Array.isArray(drafted) || drafted.length === 0) throw new Error("a companion change's code is every file it writes, each with its path in the companion directory and its exact text");
  const files = drafted.map(({ path, text }) => {
    if (typeof text !== "string") throw new Error(`companion file \`${path}\` needs its exact text`);
    return { path: canonicalPathIn(root, path, `companion file \`${path}\``), text };
  });
  if (new Set(files.map(({ path }) => path)).size < files.length) throw new Error("a companion change names each file once");
  const manifestFile = join(root, "package.json");
  const manifest = files.find(({ path }) => path === "package.json")?.text ?? (existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : undefined);
  if (manifest === undefined) throw new Error("a new companion extension needs its `package.json`, declaring its entry files under `omp.extensions`");
  if (!declaresEntries(manifest)) throw new Error("the companion's `package.json` must declare its entry files under `omp.extensions`: host discovery loads nothing else in the directory");
  const isTestFile = (path: string) => !path.split(sep).includes("node_modules") && TEST_FILE.test(path);
  if (!files.some(({ path }) => isTestFile(path)) && !(existsSync(root) && keepsTestFile(root))) {
    throw new Error("a companion change adds or keeps a test file, such as `index.test.ts`, outside `node_modules` for `bun test` to run");
  }
  return files;
}

const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

/** Whether `dir` holds a test file outside `node_modules`, at any depth. */
function keepsTestFile(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    if (TEST_FILE.test(entry.name) || (entry.isDirectory() && keepsTestFile(join(dir, entry.name)))) return true;
  }
  return false;
}

function declaresEntries(manifest: string): boolean {
  try {
    const entries = JSON.parse(manifest)?.omp?.extensions;
    return Array.isArray(entries) && entries.length > 0 && entries.every((entry) => typeof entry === "string");
  } catch {
    return false;
  }
}

/**
 * A hook removal's target, naming its file, and its identity: the file alone
 * (see {@link removalFingerprint}), not the hook's own identity, so a recorded
 * hook's applied record is found by its file when the removal is recorded.
 */
function hookRemoval(target: HarnessTarget, { cwd, agentDir }: PrepareContext): HookRemoval {
  if (target.root === "companion") throw new Error("only a hook file is removed this way, not the companion extension");
  const hook = harnessFingerprint(target);
  const path = hookPath(target, hook);
  // Saved canonical, so the resolver can tell the hooks directory was swapped for a symlink elsewhere.
  const root = canonicalMissingPath(harnessRootDirs(cwd, agentDir)[target.root]);
  return { target: { ...target, path }, fingerprint: removalFingerprint(hookFileKey(target, hook)!), root, file: join(root, path) };
}
interface HookRemoval { target: HarnessTarget; fingerprint: string; root: string; file: string }

/** The removal's preview is the file as it stands; deleting writes nothing, so a carriage return the form hides changes nothing approved. */
function removalStage({ target, root, file }: HookRemoval): { change: Extract<PreparedChange, { stage: "removal" }>; preview: string } {
  if (!existsSync(file)) throw new Error(`there is no hook file \`${file}\` to remove`);
  const preview = [
    `Delete the ${HARNESS_ROOT_NAMES[target.root]} \`${file}\`, which holds:`, "", readFileSync(file, "utf8"), "",
    "Apply lets the agent delete this file; the removal is recorded once it is gone. A removed hook stops acting only after omp restarts.",
  ].join("\n");
  return { change: { operation: "harness", stage: "removal", root, file }, preview };
}

const isRemoval = (change: PreparedChange) => change.operation === "harness" && change.stage === "removal";

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
  switch (change.operation) {
    case "on-read-append":
      if (change.effect === "record") return `The on-read amendment \`${change.target.path}\` of ${of} already holds this section, so only the proposal ledger changes:\n\n${change.section}`;
      return change.effect === "create"
        ? `Create the on-read amendment \`${change.target.path}\` of ${of} with this section:\n\n${change.section}`
        : `Append this section to the on-read amendment \`${change.target.path}\` of ${of}:\n\n${change.section}`;
    case "rule": {
      const samples = (items: readonly Sample[]) => items.map((item) => `- ${JSON.stringify(item)}`).join("\n");
      return [
        `${change.target.sha256 === null ? "Write" : "Rewrite"} the ${isPinKind(kind) ? "pattern amendment" : "barrier rule"} \`${change.rule.name}\` at \`${change.target.path}\` for ${of}.`,
        `Scope: ${change.rule.scope}`, `Pattern: ${change.rule.condition}`, `Matches:\n${samples(change.matches)}`, `Spares:\n${samples(change.spares)}`,
        "", change.body,
      ].join("\n");
    }
    case "stale-update":
      return `Update the stale amendment \`${change.rule.name}\` at \`${change.target.path}\` of ${of}, pinned to the skill as installed now. New body:\n\n${change.body}${renderReferences(change.references)}`;
    case "stale-delete":
      return `Delete the stale amendment \`${change.rule.name}\` at \`${change.target.path}\` of ${of}; the fixes it holds go out of force.${renderReferences(change.references)}`;
    case "withdrawal": {
      const fix = `Withdraw fix \`${change.withdrawn.fingerprint}\` (${change.withdrawn.gist}) of ${of}`;
      if (change.effect === "record") return `${fix}; its rule file is already gone, so only the proposal ledger changes.`;
      if (change.effect === "delete") return `${fix}: delete \`${change.target.path}\`.${renderReferences(change.references)}`;
      return `${fix}: rewrite \`${change.target.path}\` without it. New body:\n\n${change.body}${renderReferences(change.references)}`;
    }
    case "compaction": {
      const includes = change.includes.length > 0 ? change.includes.map((fingerprint) => `\`${fingerprint}\``).join(", ") : "none";
      return `Compact the on-read amendment \`${change.target.path}\` of ${of}, covering this pass's on-read fixes ${includes}. New body:\n\n${change.body}${renderReferences(change.references)}`;
    }
  }
}

function renderReferences(change: ReferenceChange | undefined): string {
  if (!change) return "";
  const written = change.write.map(({ name, body }) => `\n\nReference file \`${join(change.folder, name)}\`:\n\n${body}`).join("");
  const removed = change.remove.length > 0 ? `\n\nDeletes reference files ${change.remove.map((name) => `\`${join(change.folder, name)}\``).join(", ")}.` : "";
  return `${written}${removed}`;
}

function contentHash(proposal: PreparedProposal): string {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

/**
 * Resolves Select's references to the proposals this branch's successful
 * Prepare results of the current observation pass hold, unchanged, so no form
 * is shown whose answers could approve nothing. Throws on a reference without
 * exactly one matching saved proposal and content hash.
 */
function preparedEntries(references: unknown, evidence: SessionToolEvidence, branch: readonly SessionEntry[]): PreparedEntry[] {
  if (!Array.isArray(references)) throw new Error("Select needs `proposals`: the references a successful Prepare returned");
  const seen = new Set<string>();
  return references.map((reference: Partial<PreparedProposalRef> | undefined) => {
    if (!isProposalRef(reference)) throw new Error("each proposal reference needs reviewToolCallId, candidateId and contentHash");
    if (seen.has(reference.candidateId)) throw new Error(`proposal \`${reference.candidateId}\` is referenced twice`);
    seen.add(reference.candidateId);
    return preparedInPass(reference, evidence, branch);
  });
}

export function isProposalRef(ref: Partial<PreparedProposalRef> | undefined): ref is PreparedProposalRef {
  return typeof ref?.reviewToolCallId === "string" && typeof ref.candidateId === "string" && typeof ref.contentHash === "string";
}

export function preparedEntry(evidence: SessionToolEvidence, reference: PreparedProposalRef): PreparedEntry {
  const label = `proposal \`${reference.candidateId}\` of review \`${reference.reviewToolCallId}\``;
  let receipt;
  try {
    receipt = evidence.completedCall(reference.reviewToolCallId);
  } catch {
    throw new Error(`${label}: this branch holds no completed review call with that ID`);
  }
  const { call, result } = receipt;
  if (call.name !== REVIEW_TOOL_NAME || call.args.action !== "prepare") throw new Error(`${label}: that call is not an observer_review Prepare`);
  if (result.isError !== false) throw new Error(`${label}: that Prepare did not succeed`);
  const details: unknown = result.details;
  const saved = details && typeof details === "object" && "eligible" in details && Array.isArray(details.eligible) ? details.eligible : [];
  // This tool wrote these entries; the content hash below is what checks they are unchanged.
  const matches = (saved as PreparedEntry[]).filter((entry) => entry?.reference?.candidateId === reference.candidateId);
  const [entry] = matches;
  if (!entry?.proposal || matches.length > 1) throw new Error(`${label}: that Prepare holds no single proposal with that ID`);
  const hash = contentHash(entry.proposal);
  if (entry.proposal.candidateId !== reference.candidateId || entry.reference.reviewToolCallId !== reference.reviewToolCallId || entry.reference.contentHash !== hash) {
    throw new Error(`${label}: the saved proposal no longer matches its content hash`);
  }
  if (reference.contentHash !== hash) throw new Error(`${label}: content hash does not match the prepared proposal`);
  return entry;
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
