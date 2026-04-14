import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LATEST_DB_SCHEMA_VERSION = 7;

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  runMigrations(db);
  return db;
}

const MIGRATIONS: Array<{ version: number; apply: (db: DatabaseSync) => void }> = [
  {
    version: 1,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
          chat_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          cwd TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          session_key TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          message_thread_id TEXT,
          codex_thread_id TEXT,
          cwd TEXT NOT NULL,
          model TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'read',
          active_turn_id TEXT,
          output_message_id INTEGER,
          sandbox_mode TEXT NOT NULL DEFAULT 'read-only',
          approval_policy TEXT NOT NULL DEFAULT 'on-request',
          telegram_topic_name TEXT,
          thread_bootstrap_state TEXT,
          reasoning_effort TEXT,
          runtime_status TEXT NOT NULL DEFAULT 'idle',
          runtime_status_detail TEXT,
          runtime_status_updated_at TEXT,
          pinned_status_message_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS sessions_codex_thread_id_idx
          ON sessions (codex_thread_id);

        CREATE TABLE IF NOT EXISTS turn_deliveries (
          turn_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          message_thread_id TEXT,
          output_message_id INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          content_hash TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          last_attempt_at TEXT,
          next_attempt_at TEXT,
          delivered_at TEXT,
          alerted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS turn_deliveries_thread_id_idx
          ON turn_deliveries (thread_id);

        CREATE INDEX IF NOT EXISTS turn_deliveries_session_key_idx
          ON turn_deliveries (session_key);

        CREATE TABLE IF NOT EXISTS queued_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS queued_inputs_session_key_idx
          ON queued_inputs (session_key, id);

        CREATE TABLE IF NOT EXISTS pending_interactions (
          interaction_id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          request_json TEXT NOT NULL,
          message_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS pending_interactions_session_key_idx
          ON pending_interactions (session_key, created_at);
      `);
    },
  },
  {
    version: 2,
    apply(db) {
      const addedSandboxMode = ensureTableColumn(
        db,
        "sessions",
        "sandbox_mode",
        "ALTER TABLE sessions ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'read-only'",
      );
      const addedApprovalPolicy = ensureTableColumn(
        db,
        "sessions",
        "approval_policy",
        "ALTER TABLE sessions ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'on-request'",
      );
      ensureTableColumn(
        db,
        "sessions",
        "telegram_topic_name",
        "ALTER TABLE sessions ADD COLUMN telegram_topic_name TEXT",
      );
      ensureTableColumn(
        db,
        "sessions",
        "thread_bootstrap_state",
        "ALTER TABLE sessions ADD COLUMN thread_bootstrap_state TEXT",
      );
      ensureTableColumn(
        db,
        "sessions",
        "reasoning_effort",
        "ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT",
      );
      ensureTableColumn(
        db,
        "sessions",
        "pinned_status_message_id",
        "ALTER TABLE sessions ADD COLUMN pinned_status_message_id INTEGER",
      );
      if (addedSandboxMode) {
        db.exec(`
          UPDATE sessions
          SET sandbox_mode = CASE mode
            WHEN 'write' THEN 'workspace-write'
            ELSE 'read-only'
          END
        `);
      }
      if (addedApprovalPolicy) {
        db.exec(`
          UPDATE sessions
          SET approval_policy = 'on-request'
        `);
      }
    },
  },
  {
    version: 3,
    apply(db) {
      ensureTableColumn(
        db,
        "turn_deliveries",
        "status",
        "ALTER TABLE turn_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
      );
      ensureTableColumn(
        db,
        "turn_deliveries",
        "content_hash",
        "ALTER TABLE turn_deliveries ADD COLUMN content_hash TEXT",
      );
      ensureTableColumn(
        db,
        "turn_deliveries",
        "failure_count",
        "ALTER TABLE turn_deliveries ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0",
      );
      ensureTableColumn(
        db,
        "turn_deliveries",
        "last_error",
        "ALTER TABLE turn_deliveries ADD COLUMN last_error TEXT",
      );
      ensureTableColumn(
        db,
        "turn_deliveries",
        "last_attempt_at",
        "ALTER TABLE turn_deliveries ADD COLUMN last_attempt_at TEXT",
      );
      ensureTableColumn(
        db,
        "turn_deliveries",
        "delivered_at",
        "ALTER TABLE turn_deliveries ADD COLUMN delivered_at TEXT",
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS turn_deliveries_status_idx
          ON turn_deliveries (status)
      `);
    },
  },
  {
    version: 4,
    apply(db) {
      ensureTableColumn(
        db,
        "turn_deliveries",
        "next_attempt_at",
        "ALTER TABLE turn_deliveries ADD COLUMN next_attempt_at TEXT",
      );
      ensureTableColumn(
        db,
        "turn_deliveries",
        "alerted_at",
        "ALTER TABLE turn_deliveries ADD COLUMN alerted_at TEXT",
      );
    },
  },
  {
    version: 5,
    apply(db) {
      ensureTableColumn(
        db,
        "sessions",
        "runtime_status",
        "ALTER TABLE sessions ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'idle'",
      );
      ensureTableColumn(
        db,
        "sessions",
        "runtime_status_detail",
        "ALTER TABLE sessions ADD COLUMN runtime_status_detail TEXT",
      );
      const addedRuntimeStatusUpdatedAt = ensureTableColumn(
        db,
        "sessions",
        "runtime_status_updated_at",
        "ALTER TABLE sessions ADD COLUMN runtime_status_updated_at TEXT",
      );
      db.exec(`
        UPDATE sessions
        SET runtime_status = CASE
          WHEN active_turn_id IS NOT NULL THEN 'running'
          ELSE 'idle'
        END
        WHERE runtime_status IS NULL
           OR runtime_status NOT IN ('idle', 'running', 'waiting_approval', 'waiting_input', 'recovering', 'failed')
      `);
      if (addedRuntimeStatusUpdatedAt) {
        db.exec(`
          UPDATE sessions
          SET runtime_status_updated_at = updated_at
          WHERE runtime_status_updated_at IS NULL
        `);
      }
    },
  },
  {
    version: 6,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS queued_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS queued_inputs_session_key_idx
          ON queued_inputs (session_key, id)
      `);
    },
  },
  {
    version: 7,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_interactions (
          interaction_id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          request_json TEXT NOT NULL,
          message_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS pending_interactions_session_key_idx
          ON pending_interactions (session_key, created_at)
      `);
    },
  },
];

function runMigrations(db: DatabaseSync): void {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion >= LATEST_DB_SCHEMA_VERSION) {
    return;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec("BEGIN");
    try {
      migration.apply(db);
      setSchemaVersion(db, migration.version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function ensureTableColumn(db: DatabaseSync, tableName: string, columnName: string, sql: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return false;
  }
  db.exec(sql);
  return true;
}

function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}
