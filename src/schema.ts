export const SCHEMA_VERSION = 1;

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'medium',
  evidence TEXT NOT NULL DEFAULT '[]',
  supersedes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  source TEXT NOT NULL DEFAULT 'user'
);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  body,
  project,
  tags
);
CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE INDEX IF NOT EXISTS idx_records_project ON records(project);
CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at);
CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(id, title, summary, body, project, tags)
  VALUES (new.id, new.title, new.summary, new.body, COALESCE(new.project, ''), new.tags);
END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  DELETE FROM records_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
  DELETE FROM records_fts WHERE id = old.id;
  INSERT INTO records_fts(id, title, summary, body, project, tags)
  VALUES (new.id, new.title, new.summary, new.body, COALESCE(new.project, ''), new.tags);
END;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
`;
