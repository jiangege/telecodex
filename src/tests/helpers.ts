import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../runtime/logger.js";
import { openDatabase } from "../store/db.js";
import { ProjectStore } from "../store/projects.js";
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

export function createTestStores(): {
  store: SessionStore;
  projects: ProjectStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-test-"));
  const dbPath = path.join(dir, "state.sqlite");
  const db = openDatabase(dbPath);
  return {
    store: new SessionStore(db),
    projects: new ProjectStore(db),
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
  const chatActions: Array<{ chatId: number; action: string; messageThreadId: number | null }> = [];
  const forumEdits: Array<{ chatId: number; messageThreadId: number; name: string }> = [];
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
    async sendChatAction(chatId: number, action: string, options?: { message_thread_id?: number | null }) {
      chatActions.push({
        chatId,
        action,
        messageThreadId: options?.message_thread_id ?? null,
      });
      return true;
    },
    async editForumTopic(chatId: number, messageThreadId: number, input: { name: string }) {
      forumEdits.push({ chatId, messageThreadId, name: input.name });
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
    chatActions,
    forumEdits,
    deletedTopics,
  };
}

export function createFakeHandlerBot() {
  let nextMessageId = 1;
  const sent: Array<{ chatId: number; text: string; messageThreadId: number | null }> = [];
  const edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  const chatActions: Array<{ chatId: number; action: string; messageThreadId: number | null }> = [];
  const createdTopics: Array<{ chatId: number; name: string; messageThreadId: number }> = [];
  const commands = new Map<string, (ctx: any) => Promise<unknown>>();
  const events = new Map<string, (ctx: any) => Promise<unknown>>();

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
    async sendChatAction(chatId: number, action: string, options?: { message_thread_id?: number | null }) {
      chatActions.push({
        chatId,
        action,
        messageThreadId: options?.message_thread_id ?? null,
      });
      return true;
    },
    async createForumTopic(chatId: number, name: string) {
      const messageThreadId = nextMessageId++;
      createdTopics.push({ chatId, name, messageThreadId });
      return { name, message_thread_id: messageThreadId };
    },
  };

  const bot = {
    api,
    command(command: string | string[], handler: (ctx: any) => Promise<unknown>) {
      for (const name of Array.isArray(command) ? command : [command]) {
        commands.set(name, handler);
      }
      return this;
    },
    on(event: string | string[], handler: (ctx: any) => Promise<unknown>) {
      for (const name of Array.isArray(event) ? event : [event]) {
        events.set(name, handler);
      }
      return this;
    },
  };

  return {
    bot: bot as never,
    api,
    commands,
    events,
    sent,
    edited,
    chatActions,
    createdTopics,
  };
}
