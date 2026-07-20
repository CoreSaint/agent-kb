import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DDL } from "./schema.ts";

export function kbPath(): string {
  const explicit = process.env.AGENT_KB_PATH?.trim();
  if (explicit) return explicit.replace(/^~(?=\/|$)/, homedir());
  return join(homedir(), ".local", "share", "agent-kb", "kb.sqlite");
}

export function openDb(path = kbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Allow concurrent CLI + Pi extension writers to wait instead of failing immediately.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(DDL);
  return db;
}
