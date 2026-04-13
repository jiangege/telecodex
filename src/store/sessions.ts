import type { DatabaseSync } from "node:sqlite";
import type { SessionMode } from "../config.js";

export interface TelegramSession {
  sessionKey: string;
  chatId: string;
  messageThreadId: string | null;
  codexThreadId: string | null;
  cwd: string;
  model: string;
  mode: SessionMode;
  activeTurnId: string | null;
  outputMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  session_key: string;
  chat_id: string;
  message_thread_id: string | null;
  codex_thread_id: string | null;
  cwd: string;
  model: string;
  mode: string;
  active_turn_id: string | null;
  output_message_id: number | null;
  created_at: string;
  updated_at: string;
}

export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  getAuthorizedUserId(): number | null {
    const row = this.db
      .prepare("SELECT value FROM app_state WHERE key = 'authorized_user_id'")
      .get() as { value: string } | undefined;
    if (!row) return null;
    const userId = Number(row.value);
    return Number.isSafeInteger(userId) ? userId : null;
  }

  claimAuthorizedUserId(userId: number): number {
    const existing = this.getAuthorizedUserId();
    if (existing != null) return existing;

    this.db
      .prepare(
        `INSERT OR IGNORE INTO app_state (key, value, updated_at)
         VALUES ('authorized_user_id', ?, ?)`,
      )
      .run(String(userId), new Date().toISOString());

    const current = this.getAuthorizedUserId();
    if (current == null) throw new Error("Failed to persist authorized Telegram user id");
    return current;
  }

  clearAuthorizedUserId(): void {
    this.db.prepare("DELETE FROM app_state WHERE key = 'authorized_user_id'").run();
  }

  getOrCreate(input: {
    sessionKey: string;
    chatId: string;
    messageThreadId: string | null;
    defaultCwd: string;
    defaultModel: string;
  }): TelegramSession {
    const existing = this.get(input.sessionKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_key, chat_id, message_thread_id, cwd, model, mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'read', ?, ?)`,
      )
      .run(
        input.sessionKey,
        input.chatId,
        input.messageThreadId,
        input.defaultCwd,
        input.defaultModel,
        now,
        now,
      );

    const created = this.get(input.sessionKey);
    if (!created) throw new Error("Session insert failed");
    return created;
  }

  get(sessionKey: string): TelegramSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_key = ?")
      .get(sessionKey) as SessionRow | undefined;
    return row ? mapRow(row) : null;
  }

  getByThreadId(threadId: string): TelegramSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE codex_thread_id = ? LIMIT 1")
      .get(threadId) as SessionRow | undefined;
    return row ? mapRow(row) : null;
  }

  setThread(sessionKey: string, threadId: string | null): void {
    this.patch(sessionKey, { codex_thread_id: threadId, active_turn_id: null, output_message_id: null });
  }

  setActiveTurn(sessionKey: string, turnId: string | null): void {
    this.patch(sessionKey, { active_turn_id: turnId });
  }

  setOutputMessage(sessionKey: string, messageId: number | null): void {
    this.patch(sessionKey, { output_message_id: messageId });
  }

  setCwd(sessionKey: string, cwd: string): void {
    this.patch(sessionKey, { cwd });
  }

  setModel(sessionKey: string, model: string): void {
    this.patch(sessionKey, { model });
  }

  setMode(sessionKey: string, mode: SessionMode): void {
    this.patch(sessionKey, { mode });
  }

  private patch(sessionKey: string, fields: Record<string, string | number | null>): void {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const setSql = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    values.push(new Date().toISOString(), sessionKey);
    this.db.prepare(`UPDATE sessions SET ${setSql}, updated_at = ? WHERE session_key = ?`).run(...values);
  }
}

export function makeSessionKey(chatId: number | string, messageThreadId?: number | string | null): string {
  return messageThreadId == null ? String(chatId) : `${chatId}:${messageThreadId}`;
}

function mapRow(row: SessionRow): TelegramSession {
  return {
    sessionKey: row.session_key,
    chatId: row.chat_id,
    messageThreadId: row.message_thread_id,
    codexThreadId: row.codex_thread_id,
    cwd: row.cwd,
    model: row.model,
    mode: row.mode === "write" ? "write" : "read",
    activeTurnId: row.active_turn_id,
    outputMessageId: row.output_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
