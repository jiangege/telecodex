import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexThreadCatalog, CodexThreadSummary } from "../codex/sessionCatalog.js";
import type { Logger } from "../runtime/logger.js";
import { FileStateStorage } from "../store/fileState.js";
import { ProjectStore } from "../store/projects.js";
import { SessionStore } from "../store/sessions.js";

export function createTestSessionStore(): {
  store: SessionStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-test-"));
  const storage = new FileStateStorage(path.join(dir, "state"));
  return {
    store: new SessionStore(storage),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

export function createTestStores(): {
  store: SessionStore;
  projects: ProjectStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-test-"));
  const storage = new FileStateStorage(path.join(dir, "state"));
  return {
    store: new SessionStore(storage),
    projects: new ProjectStore(storage),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
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

export function createFakeThreadCatalog(initialThreads: CodexThreadSummary[] = []): CodexThreadCatalog & {
  setThreads: (threads: CodexThreadSummary[]) => void;
} {
  let threads = [...initialThreads];

  return {
    setThreads(nextThreads: CodexThreadSummary[]) {
      threads = [...nextThreads];
    },
    async listProjectThreads(input) {
      const projectRoot = path.resolve(input.projectRoot);
      const limit = Math.max(1, input.limit ?? threads.length ?? 1);
      return threads
        .filter((thread) => thread.cwd === projectRoot || thread.cwd.startsWith(`${projectRoot}${path.sep}`))
        .slice(0, limit);
    },
    async findProjectThreadById(input) {
      const projectRoot = path.resolve(input.projectRoot);
      return (
        threads.find(
          (thread) =>
            thread.id === input.threadId &&
            (thread.cwd === projectRoot || thread.cwd.startsWith(`${projectRoot}${path.sep}`)),
        ) ?? null
      );
    },
  };
}

export function createFakeBot() {
  let nextMessageId = 1;
  const sent: Array<{
    chatId: number;
    text: string;
    messageThreadId: number | null;
    options: Record<string, unknown> | null;
  }> = [];
  const edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  const chatActions: Array<{ chatId: number; action: string; messageThreadId: number | null }> = [];
  const forumEdits: Array<{ chatId: number; messageThreadId: number; name: string }> = [];
  const deletedTopics: Array<{ chatId: number; messageThreadId: number }> = [];

  const api = {
    async sendMessage(chatId: number, text: string, options?: Record<string, unknown> & { message_thread_id?: number | null }) {
      sent.push({
        chatId,
        text,
        messageThreadId: options?.message_thread_id ?? null,
        options: options ?? null,
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
    async getFile(fileId: string) {
      return {
        file_id: fileId,
        file_path: `photos/${fileId}.jpg`,
      };
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
  const sent: Array<{
    chatId: number;
    text: string;
    messageThreadId: number | null;
    options: Record<string, unknown> | null;
  }> = [];
  const edited: Array<{ chatId: number; messageId: number; text: string }> = [];
  const chatActions: Array<{ chatId: number; action: string; messageThreadId: number | null }> = [];
  const createdTopics: Array<{ chatId: number; name: string; messageThreadId: number }> = [];
  const botCommands: Array<{
    commands: Array<{ command: string; description: string }>;
    scope: unknown;
  }> = [];
  const commands = new Map<string, (ctx: any) => Promise<unknown>>();
  const events = new Map<string, (ctx: any) => Promise<unknown>>();

  const api = {
    async sendMessage(chatId: number, text: string, options?: Record<string, unknown> & { message_thread_id?: number | null }) {
      sent.push({
        chatId,
        text,
        messageThreadId: options?.message_thread_id ?? null,
        options: options ?? null,
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
    async getFile(fileId: string) {
      return {
        file_id: fileId,
        file_path: `photos/${fileId}.jpg`,
      };
    },
    async createForumTopic(chatId: number, name: string) {
      const messageThreadId = nextMessageId++;
      createdTopics.push({ chatId, name, messageThreadId });
      return { name, message_thread_id: messageThreadId };
    },
    async setMyCommands(commands: Array<{ command: string; description: string }>, options?: { scope?: unknown }) {
      botCommands.push({
        commands: [...commands],
        scope: options?.scope ?? null,
      });
      return true;
    },
  };

  const bot = {
    api,
    use(_middleware: unknown) {
      return this;
    },
    catch(_handler: unknown) {
      return this;
    },
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
    botCommands,
  };
}
