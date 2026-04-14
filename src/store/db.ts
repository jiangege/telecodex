import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LATEST_DB_SCHEMA_VERSION = 11;

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
          active_turn_id TEXT,
          output_message_id INTEGER,
          sandbox_mode TEXT NOT NULL DEFAULT 'read-only',
          approval_policy TEXT NOT NULL DEFAULT 'on-request',
          telegram_topic_name TEXT,
          reasoning_effort TEXT,
          runtime_status TEXT NOT NULL DEFAULT 'idle',
          runtime_status_detail TEXT,
          runtime_status_updated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS sessions_codex_thread_id_idx
          ON sessions (codex_thread_id);

        CREATE TABLE IF NOT EXISTS queued_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS queued_inputs_session_key_idx
          ON queued_inputs (session_key, id);
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
        "reasoning_effort",
        "ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT",
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
           OR runtime_status NOT IN ('idle', 'preparing', 'running', 'failed')
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
    version: 10,
    apply(db) {
      db.exec(`
        DROP INDEX IF EXISTS turn_deliveries_thread_id_idx;
        DROP INDEX IF EXISTS turn_deliveries_session_key_idx;
        DROP INDEX IF EXISTS turn_deliveries_status_idx;
        DROP INDEX IF EXISTS pending_interactions_session_key_idx;
        DROP TABLE IF EXISTS turn_deliveries;
        DROP TABLE IF EXISTS pending_interactions;
      `);
    },
  },
  {
    version: 11,
    apply(db) {
      db.exec(`
        CREATE TABLE sessions_v11 (
          session_key TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          message_thread_id TEXT,
          codex_thread_id TEXT,
          cwd TEXT NOT NULL,
          model TEXT NOT NULL,
          active_turn_id TEXT,
          output_message_id INTEGER,
          sandbox_mode TEXT NOT NULL DEFAULT 'read-only',
          approval_policy TEXT NOT NULL DEFAULT 'on-request',
          telegram_topic_name TEXT,
          reasoning_effort TEXT,
          runtime_status TEXT NOT NULL DEFAULT 'idle',
          runtime_status_detail TEXT,
          runtime_status_updated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO sessions_v11 (
          session_key,
          chat_id,
          message_thread_id,
          codex_thread_id,
          cwd,
          model,
          active_turn_id,
          output_message_id,
          sandbox_mode,
          approval_policy,
          telegram_topic_name,
          reasoning_effort,
          runtime_status,
          runtime_status_detail,
          runtime_status_updated_at,
          created_at,
          updated_at
        )
        SELECT
          session_key,
          chat_id,
          message_thread_id,
          codex_thread_id,
          cwd,
          model,
          active_turn_id,
          output_message_id,
          sandbox_mode,
          approval_policy,
          telegram_topic_name,
          reasoning_effort,
          runtime_status,
          runtime_status_detail,
          runtime_status_updated_at,
          created_at,
          updated_at
        FROM sessions;

        DROP TABLE sessions;
        ALTER TABLE sessions_v11 RENAME TO sessions;

        CREATE INDEX IF NOT EXISTS sessions_codex_thread_id_idx
          ON sessions (codex_thread_id);
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
