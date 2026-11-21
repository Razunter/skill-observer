import { closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

const APPLICATION_ID = 0x534f4253;
const SCHEMA_VERSION = 1;
const OBSERVATION_WINDOW_MS = 30 * 86_400_000;

const SCHEMA = [
  `CREATE TABLE observer_store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    origin TEXT NOT NULL CHECK (origin IN ('runtime', 'import'))
  ) STRICT`,
  `CREATE TABLE observations (
    recorded_order INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    state_at INTEGER NOT NULL,
    revision TEXT,
    text TEXT,
    count INTEGER,
    prior_shown_at INTEGER,
    UNIQUE (project, key),
    CHECK ((revision IS NULL AND text IS NULL AND count IS NULL AND prior_shown_at IS NULL)
      OR (revision IS NOT NULL AND text IS NOT NULL AND count IS NOT NULL AND count > 0))
  ) STRICT`,
  "CREATE INDEX observations_pending ON observations (project, state_at) WHERE revision IS NOT NULL",
  "CREATE INDEX observations_expiry ON observations (state_at)",
  `CREATE TABLE proposals (
    answer_order INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    rule_name TEXT,
    hook_file_key TEXT,
    record TEXT NOT NULL
  ) STRICT`,
  "CREATE INDEX proposals_rule ON proposals (rule_name)",
  "CREATE INDEX proposals_hook ON proposals (hook_file_key)",
];

export const observationCutoff = (now: Date): number => now.getTime() - OBSERVATION_WINDOW_MS;

export function observerStorePath(agentDir: string): string {
  return join(agentDir, "skill-observer", "observer.sqlite");
}

/** Work over one read-only snapshot, then close it before returning. */
export function readObserverStore<T>(file: string, read: (db: Database) => T): T | undefined {
  if (!lstatSync(file, { throwIfNoEntry: false })) {
    requireMigration(file);
    return undefined;
  }
  return withConnection(file, true, (db) => db.transaction(() => {
    checkStore(file, db);
    return read(db);
  }).deferred());
}

export class ObserverCommitUnknownError extends Error {
  constructor(cause: unknown) {
    super(`Observer store commit outcome is unknown: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** Prune and write under the same reserved writer lock. Callbacks are synchronous. */
export function writeObserverStore<T>(file: string, now: Date, write: (db: Database) => T): T {
  if (!lstatSync(file, { throwIfNoEntry: false })) {
    requireMigration(file);
    // A concurrent first writer can win publication. Both writers use the winner.
    publishObserverStore(file, "runtime");
  }
  return withConnection(file, false, (db) => {
    db.run("BEGIN IMMEDIATE");
    let committing = false;
    try {
      checkStore(file, db);
      db.query("DELETE FROM observations WHERE state_at <= ?").run(observationCutoff(now));
      const result = write(db);
      committing = true;
      db.run("COMMIT");
      return result;
    } catch (error) {
      if (db.inTransaction) {
        try {
          db.run("ROLLBACK");
          committing = false;
        } catch (rollbackError) {
          const failure = new AggregateError([error, rollbackError], String(error));
          if (committing) throw new ObserverCommitUnknownError(failure);
          throw failure;
        }
      }
      if (committing) throw new ObserverCommitUnknownError(error);
      throw error;
    }
  });
}

/** A migration rerun trusts only a complete, intact import, without consulting recovery copies. */
export function hasCompletedObserverImport(file: string): boolean {
  if (!lstatSync(file, { throwIfNoEntry: false })) return false;
  try {
    return withConnection(file, true, (db) => db.transaction(() => {
      checkStoreIdentity(file, db);
      const schema = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL").all();
      // SQLite stores statement text, so ignore formatting changes to our own DDL.
      const normalise = (sql: string) => sql.replace(/\s+/g, " ");
      const expected = new Set(SCHEMA.map(normalise));
      if (schema.length !== expected.size || schema.some(({ sql }) => !expected.delete(normalise(sql)))) throw new Error("unrecognized store schema");
      const marker = db.query<{ origin: string }, []>("SELECT origin FROM observer_store WHERE id = 1").get();
      if (marker?.origin !== "import") throw new Error("no import completion marker");
      const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check(1)").get();
      if (integrity?.integrity_check !== "ok" ||
          db.query("SELECT 1 FROM proposals WHERE CASE WHEN json_valid(record) THEN json_extract(record, '$.fingerprint') IS NOT fingerprint ELSE 1 END LIMIT 1").get()) {
        throw new Error("integrity check failed");
      }
      return true;
    }).deferred());
  } catch (error) {
    throw new Error(`Refusing existing destination ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Initialize off-path and publish without replacing a destination. False means another file won. */
export function publishObserverStore(file: string, origin: "runtime" | "import", initialize?: (db: Database) => void): boolean {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(parent, ".observer-store-"));
  const staged = join(dir, "observer.sqlite");
  try {
    writeFileSync(staged, "", { mode: 0o600, flag: "wx" });
    const db = new Database(staged, { create: false });
    try {
      // A rollback journal lets read-only connections open without updating WAL sidecars.
      db.run("PRAGMA journal_mode = DELETE; PRAGMA auto_vacuum = FULL; PRAGMA secure_delete = ON");
      db.transaction(() => {
        db.run(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; ${SCHEMA.join(";\n")}`);
        initialize?.(db);
        db.query("INSERT INTO observer_store (id, origin) VALUES (1, ?)").run(origin);
      })();
    } finally {
      db.close(true);
    }
    try {
      linkSync(staged, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withConnection<T>(file: string, readonly: boolean, use: (db: Database) => T): T {
  if (!lstatSync(file).isFile()) throw new Error(`Observer store is not a regular file: ${file}`);
  // Reject WAL-mode files before SQLite can open or initialize their shared-memory sidecar.
  const fd = openSync(file, "r");
  try {
    const mode = Buffer.alloc(2);
    if (readSync(fd, mode, 0, 2, 18) !== 2 || mode[0] !== 1 || mode[1] !== 1) {
      throw new Error(`Observer store has an invalid or unsupported SQLite header: ${file}`);
    }
  } finally {
    closeSync(fd);
  }
  const db = new Database(file, readonly ? { readonly: true } : { create: false });
  try {
    db.run("PRAGMA busy_timeout = 500");
    if (!readonly) db.run("PRAGMA secure_delete = ON");
    return use(db);
  } finally {
    db.close();
  }
}

function checkStoreIdentity(file: string, db: Database): void {
  const id = db.query<{ application_id: number }, []>("PRAGMA application_id").get();
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  if (id?.application_id !== APPLICATION_ID || version?.user_version !== SCHEMA_VERSION) {
    throw new Error(`Observer store has an unrecognized identity or schema version: ${file}`);
  }
}

function checkStore(file: string, db: Database): void {
  checkStoreIdentity(file, db);
  const origin = db.query<{ origin: string }, []>("SELECT origin FROM observer_store WHERE id = 1").get()?.origin;
  if (origin === "import") return;
  if (origin !== "runtime") throw new Error(`Observer store is not initialized: ${file}`);
  requireMigration(file);
}

function requireMigration(file: string): void {
  const dir = dirname(file);
  if (["ledger.jsonl", "observations.jsonl"].some((name) => lstatSync(join(dir, name), { throwIfNoEntry: false }))) {
    throw new Error(`Legacy observer state in ${dir} requires the migration script (scripts/migrate-observer-store.ts) before using the observer store.`);
  }
}
