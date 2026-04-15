import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LATEST_DB_SCHEMA_VERSION, openDatabase } from "../store/db.js";

test("openDatabase migrates a legacy database to the latest schema version", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-db-test-"));
  const dbPath = path.join(dir, "state.sqlite");

  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        chat_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_thread_id TEXT,
        codex_thread_id TEXT,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'read',
        active_turn_id TEXT,
        output_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE turn_deliveries (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_thread_id TEXT,
        output_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE pending_interactions (
        interaction_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_json TEXT NOT NULL,
        message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const db = openDatabase(dbPath);
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(versionRow.user_version, LATEST_DB_SCHEMA_VERSION);

    const sessionColumns = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    assert.equal(sessionColumns.has("sandbox_mode"), true);
    assert.equal(sessionColumns.has("approval_policy"), true);
    assert.equal(sessionColumns.has("telegram_topic_name"), true);
    assert.equal(sessionColumns.has("runtime_status"), true);
    assert.equal(sessionColumns.has("runtime_status_updated_at"), true);
    assert.equal(sessionColumns.has("web_search_mode"), true);
    assert.equal(sessionColumns.has("network_access_enabled"), true);
    assert.equal(sessionColumns.has("skip_git_repo_check"), true);
    assert.equal(sessionColumns.has("additional_directories"), true);
    assert.equal(sessionColumns.has("output_schema"), true);
    assert.equal(sessionColumns.has("mode"), false);
    assert.equal(sessionColumns.has("thread_bootstrap_state"), false);
    assert.equal(sessionColumns.has("pinned_status_text_hash"), false);
    assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_deliveries'").get() as unknown) == null, true);
    assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_interactions'").get() as unknown) == null, true);

    const queueColumns = new Set(
      (db.prepare("PRAGMA table_info(queued_inputs)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    assert.equal(queueColumns.has("input_json"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
