import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs, TextDecoder } from "node:util";
import { ANSWER_OUTCOMES, PROPOSAL_KINDS, STALE_OUTCOMES, putLedgerRecords, type LedgerRecord } from "../src/ledger.js";
import { hasCompletedObserverImport, observationCutoff, observerStorePath, publishObserverStore } from "../src/observer-store.js";
import { ompAgentDir } from "../src/provenance.js";
import { isTornObject } from "./json-object-prefix.js";

type LegacyObservation = {
  key: string;
  project: string;
  revision: string;
  text: string;
  count: number;
  recordedAt: number;
  shownAt?: number;
};

const outcomes = new Set<string>([...ANSWER_OUTCOMES, ...Object.values(STALE_OUTCOMES), "merged"]);
const skillKinds = new Set<string>(PROPOSAL_KINDS);

function main(now: Date): void {
  const { values } = parseArgs({ options: { "agent-dir": { type: "string" }, apply: { type: "boolean" } } });
  const selected = values["agent-dir"] ?? ompAgentDir();
  if (!selected) throw new Error("The agent directory must not be empty.");
  const agentDir = resolve(selected);
  const destination = observerStorePath(agentDir);
  console.log(`Agent directory: ${agentDir}\nDestination: ${destination}`);
  if (hasCompletedObserverImport(destination)) {
    console.log("Already migrated; nothing changed.");
    return;
  }

  const ledger = readSource(dirname(destination), "ledger.jsonl", (value) => isLedgerRecord(value) ? value : undefined);
  const observations = readSource(dirname(destination), "observations.jsonl", parseObservation);
  const decisions = new Map<string, LedgerRecord>();
  for (const record of ledger) {
    decisions.delete(record.fingerprint);
    decisions.set(record.fingerprint, record);
  }
  const { pending, markers } = reduceObservations(observations, observationCutoff(now));
  console.log(`Retain: ${decisions.size} proposal decisions, ${pending.length} pending observations, ${markers.length} recurrence markers.`);
  if (!values.apply) {
    console.log("Preview only. Stop legacy OMP sessions sharing this agent directory before running with --apply.");
    return;
  }

  const published = publishObserverStore(destination, "import", (db) => {
    putLedgerRecords(db, [...decisions.values()]);
    const put = db.query("INSERT INTO observations (project, key, state_at, revision, text, count) VALUES (?, ?, ?, ?, ?, ?)");
    for (const { project, key, recordedAt, revision, text, count } of pending) put.run(project, key, recordedAt, revision, text, count);
    for (const { project, key, shownAt } of markers) put.run(project, key, shownAt, null, null, null);
  });
  if (published) console.log("Migration complete. The original JSONL files were not changed.");
  else if (hasCompletedObserverImport(destination)) console.log("Already migrated by another invocation; nothing changed.");
  else throw new Error("Destination changed during publication. Retry to inspect the current state.");
}

function readSource<T>(dir: string, name: string, parse: (value: unknown) => T | undefined): T[] {
  const file = join(dir, name);
  let bytes: Buffer;
  try {
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (!entry) {
      console.log(`${name}: 0 bytes (absent).`);
      return [];
    }
    if (!(entry.isSymbolicLink() ? statSync(file) : entry).isFile()) throw new Error("not a regular file");
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error(`${name}: cannot read input (${error instanceof Error ? error.message : String(error)}).`);
  }
  console.log(`${name}: ${bytes.length} bytes.`);

  let text: string;
  try {
    // Preserve a BOM as data, so only the legacy writer's UTF-8 JSONL is accepted.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${name}: invalid UTF-8 input.`);
  }
  const lines = text.split("\n");
  const rows: T[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^[ \t\r]*$/.test(line)) continue;
    let value: unknown;
    try {
      value = JSON.parse(line, (_key, item: unknown) => {
        if (typeof item === "number" && !Number.isFinite(item)) throw new RangeError();
        return item;
      });
    } catch (error) {
      if (error instanceof SyntaxError && index === lines.length - 1 && isTornObject(line)) {
        console.log(`${name}:${index + 1}: ignored incomplete final record.`);
        continue;
      }
      throw new Error(`${name}:${index + 1}: malformed JSON record.`);
    }
    const row = parse(value);
    if (row === undefined) throw new Error(`${name}:${index + 1}: unsupported legacy record.`);
    rows.push(row);
  }
  return rows;
}

function reduceObservations(rows: readonly LegacyObservation[], cutoff: number) {
  const recordings = new Map<string, LegacyObservation>();
  const shown = new Map<string, LegacyObservation & { shownAt: number }>();
  for (const row of rows) {
    if (row.shownAt !== undefined) {
      shown.set(row.revision, { ...row, shownAt: row.shownAt });
      continue;
    }
    // The append order picks the winning recording and breaks ties in its recording time.
    const identity = JSON.stringify([row.project, row.key]);
    recordings.delete(identity);
    recordings.set(identity, row);
  }
  const pending: LegacyObservation[] = [];
  const markers: { project: string; key: string; shownAt: number }[] = [];
  for (const row of recordings.values()) {
    const acknowledgement = shown.get(row.revision);
    if (acknowledgement?.project === row.project && acknowledgement.key === row.key) {
      if (acknowledgement.shownAt > cutoff) markers.push({ project: row.project, key: row.key, shownAt: acknowledgement.shownAt });
    } else if (row.recordedAt > cutoff) {
      pending.push(row);
    }
  }
  return { pending, markers };
}

function parseObservation(value: unknown): LegacyObservation | undefined {
  if (!object(value)) return undefined;
  const { project, key, revision, text, count, recordedAt, shownAt } = value;
  if (!nonempty(project) || !isAbsolute(project) || !nonempty(key) || !/^[a-f0-9]{12}$/.test(key) || !nonempty(revision) ||
      !nonempty(text) || text !== text.trim() || !/[\p{L}\p{N}]/u.test(text) || [...text].length > 500 || !positiveInteger(count) ||
      !isoDate(recordedAt) || (shownAt !== undefined && !isoDate(shownAt))) return undefined;
  return { project, key, revision, text, count, recordedAt: Date.parse(recordedAt),
    ...(shownAt !== undefined && { shownAt: Date.parse(shownAt) }) };
}

function isLedgerRecord(value: unknown): value is LedgerRecord {
  if (!object(value)) return false;
  const { type, fingerprint, kind, skill, gist, outcome, timestamp, sessionId, evidence, reoffer, rule, compaction, experimentResult, target, publication } = value;
  if (type !== undefined || !nonempty(fingerprint) || !/^[0-9a-f]{11,12}$/.test(fingerprint) || !nonempty(gist) ||
      !nonempty(outcome) || !outcomes.has(outcome) || !isoDate(timestamp) || !nonempty(sessionId) ||
      (reoffer !== undefined && !nonempty(reoffer)) ||
      (evidence !== undefined && (!Array.isArray(evidence) || !evidence.every((item: unknown) =>
        object(item) && typeof item.quote === "string" && positiveInteger(item.count) &&
        (item.occurrenceIds === undefined || strings(item.occurrenceIds))))) ||
      (experimentResult !== undefined && (!object(experimentResult) || !nonempty(experimentResult.requestId) ||
        !nonempty(experimentResult.reference) || !nonempty(experimentResult.hash)))) return false;

  if (typeof kind === "string" && skillKinds.has(kind)) {
    return nonempty(skill) && target === undefined && publication === undefined && (rule === undefined || nonempty(rule)) &&
      (compaction === undefined || compaction === true);
  }
  if (skill !== undefined || rule !== undefined || compaction !== undefined || !object(target) || !nonempty(target.mechanism)) return false;
  if (kind === "project") {
    return target.scope === "project" && nonempty(target.root) && isAbsolute(target.root) && relativeFile(target.path) &&
      (publication === undefined || (object(publication) && nonempty(publication.writeToolCallId) &&
        strings(publication.checkToolCallIds) && nonempty(publication.afterHash)));
  }
  if (kind !== "harness" || target.scope !== "harness") return false;
  if (target.root === "project-hooks") {
    if (!nonempty(target.project) || !isAbsolute(target.project)) return false;
  } else if ((target.root !== "global-hooks" && target.root !== "companion") || target.project !== undefined) {
    return false;
  }
  if (target.path !== undefined && (target.root === "companion" || !relativeFile(target.path))) return false;
  return publication === undefined || (object(publication) && strings(publication.writeToolCallIds) &&
    strings(publication.checkToolCallIds) && Array.isArray(publication.files) && publication.files.every((file: unknown) =>
      object(file) && relativeFile(file.path) && nonempty(file.afterHash)));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.isWellFormed() && !value.includes("\0");
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every(nonempty);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function relativeFile(value: unknown): boolean {
  return nonempty(value) && !isAbsolute(value) && !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

try {
  main(new Date());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
