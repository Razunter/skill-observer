import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger.js";
import { readPendingObservations, recordObservation } from "../src/observations.js";
import { observerStorePath, readObserverStore, writeObserverStore } from "../src/observer-store.js";

const script = fileURLToPath(new URL("../scripts/migrate-observer-store.ts", import.meta.url));
let root: string;
let agent: string;
let store: string;
let ledger: string;
let observations: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "observer-migration-")));
  agent = join(root, "chosen-agent");
  store = observerStorePath(agent);
  ledger = join(dirname(store), "ledger.jsonl");
  observations = join(dirname(store), "observations.jsonl");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function cli(args: string[] = ["--agent-dir", agent], { envAgent = join(root, "environment-agent"), preload }: { envAgent?: string | null; preload?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  delete env.PI_CODING_AGENT_DIR;
  if (envAgent !== null) env.PI_CODING_AGENT_DIR = envAgent;
  return spawnSync(process.execPath, ["--no-env-file", ...(preload ? ["--preload", preload] : []), script, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 10_000,
  });
}

const timestamp = "2024-06-10T11:12:13.000Z";
const decision = (fingerprint: string, extra?: object) => ({
  fingerprint, kind: "upstream", skill: "sample", gist: "private proposal evidence", outcome: "later", timestamp, sessionId: "old-session", ...extra,
});
const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n");

function observation(text: string, recordedAt: string, count = 1) {
  return { key: createHash("sha256").update(`${root}\n${text.toLowerCase().replace(/[^a-z]/g, "")}`).digest("hex").slice(0, 12),
    revision: randomUUID(), project: root, text, count, recordedAt };
}

describe("observer store migration", () => {
  it("previews without writing, then preserves the latest decisions, pending observations and exact shown markers", () => {
    const earlier = decision("a0000000000");
    const merged = decision("a0000000000", { outcome: "merged", rule: "/archive/sample.md", merges: ["older-fix"], evidence: [{ quote: "private quote", count: 2 }], otherField: "kept" });
    const later = decision("b00000000000", { reoffer: "a new observation" });
    const project = decision("c00000000000", { kind: "project", skill: undefined,
      target: { scope: "project", root: "/retired/project", path: "guide.md", mechanism: "remember checks" },
      publication: { writeToolCallId: "old-write", checkToolCallIds: ["old-check"], afterHash: "a".repeat(64) }, outcome: "applied" });
    const harness = decision("d00000000000", { kind: "harness", skill: undefined,
      target: { scope: "harness", root: "project-hooks", project: "/retired/project", path: "sample.ts", mechanism: "guard the check" },
      publication: { writeToolCallIds: ["old-write"], checkToolCallIds: ["old-check"], files: [{ path: "sample.ts", afterHash: "a".repeat(64) }] },
      outcome: "withdrawn" });
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const replaced = observation("Private stale acknowledgement", new Date(Date.now() - 1_000).toISOString());
    const pending = observation(replaced.text, recent, 5);
    const secondPending = observation("Private second pending", recent);
    const shown = observation("Private shown remark", old);
    const expired = observation("Private expired pending", old);
    const expiredMarker = observation("Private expired marker", old);
    const ledgerInput = Buffer.from(jsonl(earlier, later, merged, project, harness));
    const observationsInput = Buffer.from(jsonl(replaced, pending, { ...replaced, shownAt: recent }, secondPending, shown,
      { ...shown, shownAt: recent }, expired, expiredMarker, { ...expiredMarker, shownAt: old }) + '\n\n{"text":"torn\\u12');
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(ledger, ledgerInput);
    writeFileSync(observations, observationsInput);

    const preview = cli();
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(agent);
    expect(preview.stdout).toContain(`${ledgerInput.length} bytes`);
    expect(preview.stdout).toContain(`${observationsInput.length} bytes`);
    expect(preview.stdout).toMatch(/4 proposal decisions.*2 pending observations.*1 recurrence marker/s);
    expect(preview.stdout + preview.stderr).toMatch(/observations\.jsonl.*11.*incomplete/i);
    expect(preview.stdout + preview.stderr).not.toMatch(/private/i);
    expect(readdirSync(dirname(store)).sort()).toEqual(["ledger.jsonl", "observations.jsonl"]);

    const apply = cli(["--agent-dir", agent, "--apply"]);
    expect(apply.status, apply.stderr).toBe(0);
    expect(apply.stdout + apply.stderr).not.toMatch(/private/i);
    expect(readFileSync(ledger)).toEqual(ledgerInput);
    expect(readFileSync(observations)).toEqual(observationsInput);
    expect(readLedger(store)).toEqual([later, merged, JSON.parse(JSON.stringify(project)), JSON.parse(JSON.stringify(harness))]);
    const read = () => readObserverStore(store, (db) => readPendingObservations(db, root, new Date()));
    expect(read()).toEqual([
      { ...pending, recordedAt: Date.parse(recent), priorShownAt: null },
      { ...secondPending, recordedAt: Date.parse(recent), priorShownAt: null },
    ]);
    recordObservation(store, root, shown.text, new Date());
    recordObservation(store, root, expiredMarker.text, new Date());
    expect(read()?.slice(2)).toMatchObject([
      { key: shown.key, count: 1, priorShownAt: Date.parse(recent) },
      { key: expiredMarker.key, count: 1, priorShownAt: null },
    ]);

    const beforeRerun = readFileSync(store);
    writeFileSync(ledger, "no longer valid JSONL");
    rmSync(observations);
    mkdirSync(observations);
    for (const extra of [[], ["--apply"]]) {
      const rerun = cli(["--agent-dir", agent, ...extra]);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(rerun.stdout).toMatch(/already migrated/i);
    }
    expect(readFileSync(store)).toEqual(beforeRerun);
    expect(readFileSync(ledger, "utf8")).toBe("no longer valid JSONL");
  });

  it.each(["environment", "default"] as const)("resolves the %s agent directory and handles empty or absent sources", (location) => {
    const envAgent = location === "environment" ? agent : null;
    const destination = observerStorePath(envAgent ?? join(root, ".omp", "agent"));
    if (envAgent) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(join(dirname(destination), "observations.jsonl"), "\n \r\n");
    }
    const preview = cli([], { envAgent });
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(destination);
    expect(preview.stdout).toMatch(/0 proposal decisions.*0 pending observations.*0 recurrence markers/s);
    expect(existsSync(destination)).toBe(false);
    if (!envAgent) expect(existsSync(join(root, ".omp"))).toBe(false);
    const apply = cli(["--apply"], { envAgent });
    expect(apply.status, apply.stderr).toBe(0);
    expect(readLedger(destination)).toEqual([]);
    if (envAgent) expect(readFileSync(join(dirname(destination), "observations.jsonl"), "utf8")).toBe("\n \r\n");
  });

  it.each([
    ["malformed interior", '{"gist":\n' + jsonl(decision("a00000000000"))],
    ["malformed final", '{"gist":[false,]}'],
    ["ambiguous final", '[{"gist":'],
    ["terminated fragment", '{"gist":\n'],
    ["invalid encoding", Buffer.from([0x7b, 0x22, 0xf0, 0x9f])],
    ["UTF-8 BOM", "\ufeff" + jsonl(decision("a00000000000"))],
    ["invalid decision hidden by later answer", jsonl(decision("a00000000000", { outcome: "unsupported" }), decision("a00000000000"))],
    ["invalid known field", jsonl(decision("a00000000000", { evidence: [{ quote: "private evidence", count: {} }] }))],
    ["unsupported row", "[]"],
  ])("refuses %s without publishing", (_label, input) => {
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(ledger, input);
    for (const args of [["--agent-dir", agent], ["--agent-dir", agent, "--apply"]]) {
      const result = cli(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ledger.jsonl");
      expect(result.stderr).not.toContain("private evidence");
    }
    expect(existsSync(store)).toBe(false);
    expect(readFileSync(ledger)).toEqual(Buffer.from(input));
  });

  it("refuses an unreadable source instead of treating it as absent", () => {
    mkdirSync(observations, { recursive: true });
    const result = cli(["--agent-dir", agent, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("observations.jsonl");
    expect(existsSync(store)).toBe(false);
  });

  it("refuses an observation with an unsupported acknowledgement date", () => {
    mkdirSync(dirname(store), { recursive: true });
    const shown = observation("Private remark", new Date().toISOString());
    writeFileSync(observations, jsonl(shown, { ...shown, shownAt: "never" }));
    const result = cli(["--agent-dir", agent, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/observations\.jsonl:2:.*unsupported/i);
    expect(result.stderr).not.toContain(shown.text);
    expect(existsSync(store)).toBe(false);
  });

  it.each(["runtime", "empty", "foreign", "schema only", "import marker only", "missing table", "damaged SQLite page"])("never replaces a %s destination", (kind) => {
    mkdirSync(dirname(store), { recursive: true });
    if (kind === "runtime") writeObserverStore(store, new Date(), () => {});
    else if (kind === "empty") writeFileSync(store, "");
    else if (kind === "schema only" || kind === "missing table" || kind === "damaged SQLite page") {
      expect(cli(["--agent-dir", agent, "--apply"]).status).toBe(0);
      const db = new Database(store);
      if (kind === "schema only" || kind === "missing table") {
        db.run(kind === "schema only" ? "DELETE FROM observer_store" : "DROP TABLE proposals");
        db.close();
      } else {
        const { page_size: pageSize } = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!;
        const { rootpage } = db.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_schema WHERE name = 'proposals'").get()!;
        db.close();
        const damaged = readFileSync(store);
        damaged[(rootpage - 1) * pageSize] = 0xff;
        writeFileSync(store, damaged);
      }
    } else {
      const db = new Database(store);
      db.run("CREATE TABLE observer_store (id INTEGER, origin TEXT)");
      if (kind !== "foreign") db.run("PRAGMA application_id = 0x534f4253; PRAGMA user_version = 1");
      db.run("INSERT INTO observer_store VALUES (1, 'import')");
      db.close();
    }
    const before = readFileSync(store);
    const result = cli(["--agent-dir", agent, "--apply"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/existing destination/i);
    expect(readFileSync(store)).toEqual(before);
  });

  it("can retry after the process is killed just before publication", () => {
    mkdirSync(dirname(store), { recursive: true });
    const original = jsonl(decision("a00000000000"));
    writeFileSync(ledger, original);
    const preload = join(root, "interrupt.ts");
    writeFileSync(preload, `import * as fs from "node:fs";
import { mock } from "bun:test";
mock.module("node:fs", () => ({ ...fs, linkSync: () => process.kill(process.pid, "SIGKILL") }));`);
    const args = ["--agent-dir", agent, "--apply"];
    const interrupted = cli(args, { preload });
    expect(interrupted.signal, interrupted.stderr).toBe("SIGKILL");
    expect(existsSync(store)).toBe(false);
    expect(readFileSync(ledger, "utf8")).toBe(original);

    const retry = cli(args);
    expect(retry.status, retry.stderr).toBe(0);
    expect(readLedger(store)).toEqual([decision("a00000000000")]);
    expect(readFileSync(ledger, "utf8")).toBe(original);
  });

  it("leaves a competing destination untouched if it appears at publication", () => {
    const preload = join(root, "compete.ts");
    writeFileSync(preload, `import * as fs from "node:fs";
import { mock } from "bun:test";
const link = fs.linkSync;
mock.module("node:fs", () => ({ ...fs, linkSync: (source, destination) => {
  fs.writeFileSync(destination, "competing file", { flag: "wx" });
  link(source, destination);
} }));`);
    const result = cli(["--agent-dir", agent, "--apply"], { preload });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/existing destination/i);
    expect(readFileSync(store, "utf8")).toBe("competing file");
  });

  it("does not accept an overwrite option", () => {
    const result = cli(["--agent-dir", agent, "--apply", "--force"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--force/);
    expect(existsSync(agent)).toBe(false);
  });
});
