/**
 * Eligibility, canonical prepared proposals and bounded advisory selection for
 * the existing observation pass. Prepare turns each exact candidate change into
 * the operation `observer_resolve` would carry out, with the target state it
 * read and a preview rendered from that operation; its successful result is the
 * branch artifact. A candidate that reconciles an approved on-read append or
 * rule with its changed target is prepared the same way, carrying that reconciliation.
 * Select accepts only references to those results.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  compactionFingerprint, isOnReadAmendment, isPinKind, isPinned, type ObserverRule, readObserverRule, readOnReadAmendments,
  type RuleDirs, rulePath, skillAmendment, skillAmendmentName,
} from "./amendments.js";
import {
  canonicalProjectTarget, type Evidence, ledgerForProject, type LedgerRecord,
  projectFingerprint, PROPOSAL_KINDS, type ProjectTarget, type ProposalKind,
  proposalFingerprint, readLedger,
} from "./ledger.js";
import type { ExtensionAPI, ExtensionContext, SchemaBuilder, SessionEntry } from "./omp.js";
import { withdrawal } from "./on-read-amendment-transitions.js";
import { approvalShape, checkReconciliation, isReconcilable, type ProposalReconciliation } from "./proposal-approval.js";
import { createProvenanceResolver, defaultSkillRoots, type ProvenanceResolver } from "./provenance.js";
import { fixRule } from "./publication.js";
import { checkPointers, checkReferenceFiles, hasUnlistedReferenceEntries, type ReferenceFile, readReferenceFiles, referenceFolder } from "./references.js";
import { type PatternDraft, type Sample, sampleSchemas } from "./replay.js";
import type { ObserverFiles } from "./resolve.js";
import { type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";

export const REVIEW_TOOL_NAME = "observer_review";
const PRIORITIES = ["stale", "note", "evidence", "compaction"] as const;
type Priority = (typeof PRIORITIES)[number];
const OPERATIONS = ["direct-edit", "on-read-append", "rule", "stale-update", "stale-delete", "withdrawal", "compaction"] as const;

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
  | { operation: "compaction"; includes: string[]; body: string; references: ReferenceFile[] };

interface CandidateDraft {
  gist: string;
  priority: Priority;
  remedy: string;
  change: ChangeDraft;
  evidence?: ReviewEvidence[];
  fingerprint?: string;
  /** The approved on-read append or rule this candidate revises for its changed target, and the main agent's account of the revision. */
  reconciles?: Partial<ProposalReconciliation>;
}
type SkillScope = { kind: ProposalKind; skill: string; target?: never };
type ProjectScope = { kind: "project"; target: ProjectTarget; skill?: never };
type ReviewCandidate = CandidateDraft & (SkillScope | ProjectScope);

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
type ProtectedChange = Exclude<PreparedChange, { operation: "direct-edit" }>;
type StaleChange = Extract<PreparedChange, { operation: "stale-update" | "stale-delete" }>;
/** A stale question's answer that changes the rule, and the preview its option shows. */
interface StaleAlternative { change: StaleChange; preview: string }

/** Immutable reviewed data: what a question shows and what publication may later consider. */
export type PreparedProposal = {
  candidateId: string;
  fingerprint: string;
  priority: Priority;
  gist: string;
  remedy: string;
  evidence: ReviewEvidence[];
  /** A revision's link to the approved proposal it reconciles: the main agent's judgment, not the user's approval of this revision. */
  reconciles?: ProposalReconciliation;
} & (
  | { change: Exclude<PreparedChange, StaleChange>; preview: string }
  /** A stale amendment's one Keep/Update/Delete question: each prepared answer, Update before Delete. */
  | { alternatives: StaleAlternative[] }
) & (SkillScope | ProjectScope);

export type PreparedProposalRef = Readonly<{ reviewToolCallId: string; candidateId: string; contentHash: string }>;
interface PreparedEntry { reference: PreparedProposalRef; proposal: PreparedProposal }

interface Ranking { id: string; score: number; confidence: number; consistent: boolean }
interface ReviewParams {
  action: "prepare" | "select";
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
}

interface PrepareContext {
  cwd: string;
  dirs: RuleDirs;
  referencesDir: string;
  /** The whole ledger: a withdrawal cites a fix wherever it was recorded. */
  ledger: readonly LedgerRecord[];
  provenance: ProvenanceResolver;
  /** The session branch, where a reconciliation's approval is saved. */
  branch: readonly SessionEntry[];
}

/** The model uses installed host judge helpers between Prepare and Select; this tool never calls a provider. */
export function registerReviewTool(pi: ExtensionAPI, files: ObserverFiles): void {
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
  ]);
  const draft = {
    gist: z.string(), priority: z.enum(PRIORITIES), remedy: z.string(), change,
    evidence: z.array(z.object({ quote: z.string(), count: z.number(), source: z.string().optional(), occurrenceIds: z.array(z.string()).optional() })).optional(),
    fingerprint: z.string().optional(),
    reconciles: z.object({
      approval: z.object(approvalShape(z)).describe("The user's approval of the original proposal, exactly as observer_resolve would cite it."),
      changedTarget: z.string().describe("How the target amendment or rule file changed since the approved Prepare read it."),
      reason: z.string().describe("Why this revision of the approved section or rule."),
      preserved: z.string().describe("Why the revision keeps the approved intent and the target's unrelated content."),
    }).optional().describe("On-read append or rule only: revises an approved proposal whose target changed after its Prepare, in the same pass. The main agent's reconciliation, not the user's approval: a change that would drop or rewrite the target's new content, or delete a target, needs a new proposal and Ask."),
  };
  pi.registerTool<ReviewParams, ReviewDetails>({
    name: REVIEW_TOOL_NAME, label: "Observer Review", approval: "read", loadMode: "essential", defaultInactive: true,
    description: "Prepare canonical eligible observation proposals before optional host judge_batch: canonicalize each exact change into the operation observer_resolve would carry out, read its current target and reference files, render its preview, merge identities/evidence, remove prior declines, and return a reference per proposal plus minimized judgeStates only for classes needing comparison with an explicitly configured available judge model. A candidate with `reconciles` revises an approved on-read append or rule for its changed target: Prepare checks the cited approval still holds in this pass and the revision makes the same operation on the same target under the same identity. Select takes only those references, verifies them against this branch's successful Prepare results, rechecks model availability before accepting advisory rankings, or uses stable evidence ordering with a fallback reason. Selection preserves stale/note/evidence/compaction priority and five slots; overflow remains deferred for observer_resolve. This tool neither asks, approves nor publishes and never calls a model.",
    parameters: z.object({
      action: z.enum(["prepare", "select"]),
      candidates: z.array(z.union([
        z.object({ ...draft, kind: z.enum(PROPOSAL_KINDS), skill: z.string() }),
        z.object({ ...draft, kind: z.enum(["project"]), target: z.object({
          scope: z.enum(["project"]), root: z.string(), path: z.string(), mechanism: z.string(),
        }) }),
      ])).optional().describe("Prepare only: exact candidate changes. Stale Keep is no candidate. Project identity uses target mechanism; global guidance uses its general gist."),
      proposals: z.array(proposalRefSchema(z)).optional()
        .describe("Select only: the `reference` of each eligible proposal, exactly as Prepare returned it."),
      rankings: z.array(z.object({ id: z.string(), score: z.number(), confidence: z.number(), consistent: z.unknown().describe("Boolean: true only after inspecting agreement with cited evidence.") })).optional().describe("Select only: each compared candidateId exactly once, score 0..3 and confidence 0..1 from host judge, with consistent as a boolean after inspecting evidence agreement. Do not rank singleton classes."),
      rankingFailure: z.string().optional().describe("Select only: exact unavailable/failed host ranking reason. Do not retry the batch."),
    }),
    async execute(toolCallId, params, signal, _update, ctx) {
      const details: ReviewDetails = { eligible: [], needsRanking: false, judgeStates: {}, selected: [], deferred: [], failures: [] };
      try {
        signal?.throwIfAborted();
        const ledger = readLedger(files.ledgerFile());
        if (params?.action === "prepare") {
          if (!Array.isArray(params.candidates) || params.proposals !== undefined) throw new Error("Prepare needs a candidate array and no references");
          const context: PrepareContext = {
            cwd: ctx.cwd, dirs: { rulesDir: files.rulesDir(), amendmentsDir: files.amendmentsDir() }, referencesDir: files.referencesDir(),
            ledger, provenance: createProvenanceResolver(defaultSkillRoots(ctx.cwd)), branch: ctx.sessionManager.getBranch(),
          };
          details.eligible = prepareProposals(params.candidates, context).map((proposal) => ({
            reference: { reviewToolCallId: toolCallId, candidateId: proposal.candidateId, contentHash: contentHash(proposal) },
            proposal,
          }));
        } else if (params?.action === "select") {
          if (params.candidates !== undefined) throw new Error("Select takes `proposals`, the references a successful Prepare returned, not candidate drafts");
          const declined = declinedFingerprints(ledgerForProject(ledger, ctx.cwd));
          details.eligible = preparedEntries(params.proposals, ctx.sessionManager.getBranch())
            .filter((entry) => !declined.has(entry.proposal.fingerprint));
        } else {
          throw new Error("review needs prepare/select");
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
              target: proposal.kind === "project" ? `project:${proposal.target.path}` : `skill:${proposal.skill}`,
              mechanism: proposal.kind === "project" ? proposal.target.mechanism : proposal.gist,
              remedy: proposal.remedy, evidence: proposal.evidence,
              repeatCount: distinctOccurrences(proposal.evidence) || proposal.evidence.reduce((max, item) => Math.max(max, item.count), 0),
            };
          }
        } else {
          const selection = selectCandidates(details.eligible, compared, params.rankings, modelUnavailable ?? params.rankingFailure);
          details.selected = selection.ordered.slice(0, 5);
          details.deferred = selection.ordered.slice(5);
          if (selection.fallback) details.fallback = selection.fallback;
        }
      } catch (error) {
        signal?.throwIfAborted();
        details.eligible = [];
        details.failures.push(error instanceof Error ? error.message : String(error));
      }
      const output = params?.action === "prepare"
        ? { eligible: details.eligible, needsRanking: details.needsRanking, judgeStates: details.judgeStates, failures: details.failures }
        : { selected: details.selected, deferred: details.deferred, ...(details.fallback && { fallback: details.fallback }), failures: details.failures };
      return { content: [{ type: "text", text: JSON.stringify(output) }], details, isError: details.failures.length > 0 };
    },
  });
}

/** The parameter schema of a {@link PreparedProposalRef}, wherever a tool takes one. */
export function proposalRefSchema(z: SchemaBuilder) {
  return z.object({ reviewToolCallId: z.string(), candidateId: z.string(), contentHash: z.string() });
}

async function rankingModelUnavailable(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
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
  const checked = candidates.map((draft) => checkedCandidate(draft, context.cwd));
  // A compaction's `includes` resolve to this Prepare's on-read appends, so it is prepared after them.
  const ordered = checked.toSorted((a, b) => Number(a.change.operation === "compaction") - Number(b.change.operation === "compaction"));
  for (const candidate of ordered) {
    const proposal = preparedProposal(candidate, scoped, declined, [...grouped.values()], context);
    if (!proposal) continue;
    const previous = grouped.get(proposal.candidateId);
    grouped.set(proposal.candidateId, previous ? joined(previous, proposal) : proposal);
  }
  return [...grouped.values()];
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

function checkedCandidate(candidate: ReviewCandidate, cwd: string): ReviewCandidate & { evidence: ReviewEvidence[] } {
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
    return { ...candidate, target: canonicalProjectTarget(cwd, candidate.target), evidence };
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
  const scope: SkillScope | ProjectScope = candidate.kind === "project"
    ? { kind: "project", target: candidate.target }
    : { kind: candidate.kind, skill: candidate.skill };
  const base = { priority: candidate.priority, ...scope, gist: candidate.gist, remedy: candidate.remedy, evidence: candidate.evidence };
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
    // Native Ask shows a preview with CRLF as LF and a bare CR as a space, so the bytes shown would not be the bytes written.
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
        // Publication appends nothing when the amendment already holds the section verbatim.
        const effect = bytes === null ? "create" : bytes.toString("utf8").includes(section) ? "record" : "append";
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
  let fingerprint = candidate.kind === "project" ? projectFingerprint(candidate.target) : proposalFingerprint(candidate.skill, candidate.gist);
  if (candidate.kind !== "project" && candidate.fingerprint !== undefined) {
    const existing = ledger.find((record) => record.fingerprint === candidate.fingerprint);
    if (existing) {
      if (existing.kind === "project" || existing.skill !== candidate.skill) throw new Error("candidate fingerprint belongs to another target");
      fingerprint = existing.fingerprint;
    }
  }
  checkCurrentFingerprint(candidate, fingerprint);
  return fingerprint;
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
  return { path, sha256: bytes && createHash("sha256").update(bytes).digest("hex") };
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
 * Prepare results hold, unchanged. Throws on a reference without exactly one
 * matching saved proposal and content hash.
 */
function preparedEntries(references: unknown, branch: readonly SessionEntry[]): PreparedEntry[] {
  if (!Array.isArray(references)) throw new Error("Select needs `proposals`: the references a successful Prepare returned");
  const evidence = sessionToolEvidence(branch);
  const seen = new Set<string>();
  return references.map((reference: Partial<PreparedProposalRef> | undefined) => {
    if (!isProposalRef(reference)) throw new Error("each proposal reference needs reviewToolCallId, candidateId and contentHash");
    if (seen.has(reference.candidateId)) throw new Error(`proposal \`${reference.candidateId}\` is referenced twice`);
    seen.add(reference.candidateId);
    return preparedEntry(evidence, reference);
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
