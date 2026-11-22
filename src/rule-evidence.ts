import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { buildDigest } from "./digest.js";
import { ledgerDecisionInProject, type LedgerRecord, readLedgerDecision, targetLabel } from "./ledger.js";
import { readObserverStore } from "./observer-store.js";
import type { ExtensionContext, SessionEntry } from "./omp.js";
import { remedyOutcomes } from "./outcomes.js";
import { observationPassStart } from "./proposal-approval.js";
import { createProvenanceResolver, defaultSkillRoots } from "./provenance.js";
import { type SessionToolEvidence, sessionToolEvidence } from "./session-tool-evidence.js";

export type EvidenceKey = { skill?: string; rule?: string; fingerprint?: string };

const PAGE_SIZE = 8;
const QUOTES_PER_PROPOSAL = 3;
const QUOTE_CHARS = 500;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const OCCURRENCE = /:(?:steering|rule-violation|ask-custom-input|ask-off-recommendation|tool-error|workflow):/;

export function lookupRuleEvidence(key: EvidenceKey | undefined, cursor: string | undefined, store: string, ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  if (!ctx.hasUI || ctx.agent?.kind === "sub" || observationPassStart(branch) === undefined) {
    throw new Error("only the main agent in a current observation pass can look up proposal evidence");
  }
  const selectors = [key?.skill, key?.rule, key?.fingerprint].filter((value) => value !== undefined);
  if (selectors.length !== 1 || typeof selectors[0] !== "string" || !selectors[0].trim()) {
    throw new Error("Evidence needs exactly one of `key.skill`, `key.rule` or `key.fingerprint`");
  }
  const value = selectors[0].trim();
  const root = realpathSync(ctx.cwd);
  const records = readObserverStore(store, (db) => {
    if (key?.fingerprint !== undefined) {
      const record = readLedgerDecision(db, value);
      return record && ledgerDecisionInProject(record, root) ? [record] : [];
    }
    const column = key?.skill !== undefined ? "json_extract(record, '$.skill')" : "rule_name";
    const name = key?.rule !== undefined ? basename(value, ".md") : value;
    return db.query<{ record: string }, [string]>(`SELECT record FROM proposals WHERE ${column} = ? ORDER BY answer_order DESC`).all(name)
      .map(({ record }) => JSON.parse(record) as LedgerRecord)
      .filter((record) => ledgerDecisionInProject(record, root));
  }) ?? [];
  const start = cursor === undefined ? 0 : records.findIndex((record) => record.fingerprint === cursor) + 1;
  if (cursor !== undefined && start === 0) throw new Error("Evidence cursor does not match this lookup");
  const page = records.slice(start, start + PAGE_SIZE);
  if (page.length === 0) return { matches: [], gaps: ["No recorded decisions match that key in this scope."] };

  const digest = buildDigest(branch, { provenance: createProvenanceResolver(defaultSkillRoots(ctx.cwd)) });
  const outcomes = new Map(remedyOutcomes(page, digest).map((outcome) => [outcome.fingerprint, outcome]));
  const sourceFor = sessionSources(ctx.sessionManager, root);
  return {
    matches: page.map((record) => ({
      fingerprint: record.fingerprint, kind: record.kind, target: targetLabel(record), gist: record.gist,
      scope: record.kind === "project" || (record.kind === "harness" && record.target.root === "project-hooks") ? "project" : "global",
      ...(record.rule && { rule: basename(record.rule, ".md") }), ...(record.compaction && { compaction: true }),
      outcome: record.outcome, remedyOutcome: outcomes.get(record.fingerprint)?.status,
      remedyEvidence: outcomes.get(record.fingerprint)?.evidence,
      ...recordEvidence(record, sourceFor),
    })),
    ...(records.length > start + PAGE_SIZE && { next: page.at(-1)!.fingerprint }),
  };
}

interface SessionSource {
  file?: string;
  primaryId: (id: string) => string | undefined;
  findQuote: (quote: string) => string | undefined;
}

function recordEvidence(record: LedgerRecord, sourceFor: (id: string) => SessionSource | undefined) {
  const quotes = record.evidence ?? [];
  if (quotes.length === 0) return { evidence: [], gaps: ["No quote was recorded for this decision."] };
  const source = sourceFor(record.sessionId);
  if (!source) return { evidence: [], gaps: ["Primary source unavailable in this project; recorded excerpts and source identifiers were not disclosed."] };
  const gaps = new Set<string>();
  const reference = { sessionId: record.sessionId, ...(source.file && { file: source.file }) };
  const evidence = quotes.slice(0, QUOTES_PER_PROPOSAL).flatMap(({ quote, count, occurrenceIds }) => {
    const ids = new Set<string>();
    for (const occurrence of occurrenceIds ?? []) {
      const id = occurrence.split("/").at(-1)?.split(OCCURRENCE, 1)[0];
      const primary = id && source.primaryId(id);
      if (primary) ids.add(primary);
      else gaps.add("Some cited occurrences are missing from the decision's saved session; verify them in primary evidence.");
    }
    if (!occurrenceIds?.length) {
      const primary = source.findQuote(quote);
      if (primary) ids.add(primary);
      else gaps.add("Some quotes have no recorded entry locator or literal match in the saved session.");
    }
    if (ids.size === 0) return [];
    if (quote.length > QUOTE_CHARS) gaps.add("A recorded quote was clipped; read its primary source for the full text.");
    if (ids.size > 3) gaps.add("More primary occurrences are recorded; only the first three references are shown.");
    return [{
      quote: quote.length > QUOTE_CHARS ? `${quote.slice(0, QUOTE_CHARS)}…` : quote, count,
      primary: [...ids].slice(0, 3).map((entryId) => ({ ...reference, entryId })),
    }];
  });
  if (quotes.length > QUOTES_PER_PROPOSAL) gaps.add("More quotes were recorded; consult the scoped source session for additional evidence.");
  return { evidence, session: reference, gaps: [...gaps] };
}

function sessionSources(manager: ExtensionContext["sessionManager"], root: string) {
  const cache = new Map<string, SessionSource | undefined>();
  let directory: { path: string; entries: Dirent[] } | undefined;
  const load = (id: string): SessionSource | undefined => {
    if (id === manager.getSessionId()) {
      const header = manager.getHeader?.();
      return header && realpathSync(header.cwd) === root ? sessionSource(manager.getEntries(), manager.getSessionFile?.()) : undefined;
    }
    if (!directory) {
      const sessionDir = manager.getSessionDir?.();
      if (!sessionDir) return;
      const path = realpathSync(sessionDir);
      directory = { path, entries: readdirSync(path, { withFileTypes: true }) };
    }
    const files = directory.entries.filter((entry) => entry.isFile() && entry.name.endsWith(`_${id}.jsonl`));
    if (files.length !== 1) return;
    const file = join(directory.path, files[0]!.name);
    const text = readSession(file);
    if (text === undefined) return;
    const firstNewline = text.indexOf("\n");
    if (firstNewline < 0) return;
    const header = JSON.parse(text.slice(0, firstNewline));
    if (header?.type !== "session" || header.id !== id || typeof header.cwd !== "string" || realpathSync(header.cwd) !== root) return;
    const entries = text.slice(firstNewline + 1).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as SessionEntry);
    return sessionSource(entries, file);
  };
  return (id: string) => {
    if (!cache.has(id)) {
      try {
        cache.set(id, load(id));
      } catch {
        cache.set(id, undefined);
      }
    }
    return cache.get(id);
  };
}

function readSession(file: string): string | undefined {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) return;
    const bytes = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const length = readSync(fd, bytes, read, bytes.length - read, read);
      if (!length) return;
      read += length;
    }
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sessionSource(entries: readonly SessionEntry[], file: string | undefined): SessionSource {
  const ids = new Set(entries.map((entry) => entry.id));
  let tools: SessionToolEvidence | undefined;
  return {
    file,
    findQuote(quote) {
      if (!quote.trim()) return;
      return entries.find(({ message }) => {
        if (message?.role !== "user" && message?.role !== "assistant") return false;
        const { content } = message;
        return typeof content === "string" ? content.includes(quote)
          : content?.some((block) => block.type === "text" && block.text?.includes(quote));
      })?.id;
    },
    primaryId(id) {
      if (ids.has(id)) return id;
      if (!id.startsWith("tool-result:")) return;
      try {
        tools ??= sessionToolEvidence(entries);
        return entries[tools.completedCall(id.slice("tool-result:".length)).result.position]?.id;
      } catch {
        // An orphaned or conflicting receipt is not a primary reference.
        return;
      }
    },
  };
}
