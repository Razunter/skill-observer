import { Database } from "bun:sqlite";
import { recordObservation } from "../../src/observations.js";

const [action, file, cwd, timestamp, ...remarks] = process.argv.slice(2);
if (!file) throw new Error("The fixture needs an observer store path");

if (action === "record" && cwd && timestamp) {
  console.log("ready");
  for await (const _ of process.stdin) {}
  for (const text of remarks) recordObservation(file, cwd, text, new Date(timestamp));
} else if (action === "read-lock" || action === "exclusive-lock") {
  const db = new Database(file, action === "read-lock" ? { readonly: true } : { create: false });
  try {
    db.run(action === "read-lock" ? "BEGIN" : "BEGIN EXCLUSIVE");
    db.query("SELECT count(*) FROM observations").get();
    console.log("ready");
    for await (const _ of process.stdin) {}
    db.run("ROLLBACK");
  } finally {
    db.close();
  }
} else {
  throw new Error(`Invalid fixture action: ${action}`);
}
