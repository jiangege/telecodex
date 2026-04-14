import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../runtime/logger.js";
import { openDatabase } from "../store/db.js";
import { SessionStore } from "../store/sessions.js";

export function createTestSessionStore(): {
  store: SessionStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-test-"));
  const dbPath = path.join(dir, "state.sqlite");
  const db = openDatabase(dbPath);
  return {
    store: new SessionStore(db),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function createNoopLogger(): Logger {
  return {
    filePath: "",
    child: () => createNoopLogger(),
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    flush: () => undefined,
  };
}

export function createFakeBot() {
  let nextMessageId = 1;
  const sent: Array<{ chatId: number; text: string; messageThreadId: number | null }> = [];
  const edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  const forumEdits: Array<{ chatId: number; messageThreadId: number; name: string }> = [];
  const pinned: Array<{ chatId: number; messageId: number }> = [];
  const deletedTopics: Array<{ chatId: number; messageThreadId: number }> = [];

  const api = {
    async sendMessage(chatId: number, text: string, options?: { message_thread_id?: number | null }) {
      sent.push({
        chatId,
        text,
        messageThreadId: options?.message_thread_id ?? null,
      });
      return { message_id: nextMessageId++ };
    },
    async editMessageText(chatId: number, messageId: number, text: string) {
      edited.push({ chatId, messageId, text });
      return true;
    },
    async editForumTopic(chatId: number, messageThreadId: number, input: { name: string }) {
      forumEdits.push({ chatId, messageThreadId, name: input.name });
      return true;
    },
    async pinChatMessage(chatId: number, messageId: number) {
      pinned.push({ chatId, messageId });
      return true;
    },
    async deleteForumTopic(chatId: number, messageThreadId: number) {
      deletedTopics.push({ chatId, messageThreadId });
      return true;
    },
  };
  const bot = { api };

  return {
    bot: bot as never,
    api,
    sent,
    edited,
    forumEdits,
    pinned,
    deletedTopics,
  };
}
