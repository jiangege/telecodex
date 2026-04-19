import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexThreadCatalog, CodexThreadSummary } from "../codex/sessionCatalog.js";
import type { Logger } from "../runtime/logger.js";
import { AdminStore } from "../store/adminStore.js";
import { AppStateStore } from "../store/appStateStore.js";
import { FileStateStorage } from "../store/fileState.js";
import { SessionStore } from "../store/sessionStore.js";
import { WorkspaceStore } from "../store/workspaceStore.js";

type TestStoreFacade = SessionStore & {
  getAppState: (key: string) => string | null;
  setAppState: (key: string, value: string) => void;
  deleteAppState: (key: string) => void;
  getAuthorizedUserId: () => number | null;
  getBindingCodeState: AdminStore["getBindingCodeState"];
  issueBindingCode: AdminStore["issueBindingCode"];
  recordBindingCodeFailure: AdminStore["recordBindingCodeFailure"];
  clearBindingCode: AdminStore["clearBindingCode"];
  claimAuthorizedUserId: AdminStore["claimAuthorizedUserId"];
  rebindAuthorizedUserId: AdminStore["rebindAuthorizedUserId"];
  clearAuthorizedUserId: AdminStore["clearAuthorizedUserId"];
};

export function createTestSessionStore(): {
  store: TestStoreFacade;
  sessions: SessionStore;
  admin: AdminStore;
  appState: AppStateStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-test-"));
  const storage = new FileStateStorage(path.join(dir, "state"));
  const sessions = new SessionStore(storage);
  const admin = new AdminStore(storage);
  const appState = new AppStateStore(storage);
  const store = createLegacyTestStoreAlias(sessions, admin, appState);
  return {
    store,
    sessions,
    admin,
    appState,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

export function createTestStores(): {
  store: TestStoreFacade;
  sessions: SessionStore;
  admin: AdminStore;
  appState: AppStateStore;
  workspaces: WorkspaceStore;
  projects: WorkspaceStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-test-"));
  const storage = new FileStateStorage(path.join(dir, "state"));
  const sessions = new SessionStore(storage);
  const admin = new AdminStore(storage);
  const appState = new AppStateStore(storage);
  const workspaces = new WorkspaceStore(storage);
  const store = createLegacyTestStoreAlias(sessions, admin, appState);
  return {
    store,
    sessions,
    admin,
    appState,
    workspaces,
    projects: workspaces,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

function createLegacyTestStoreAlias(
  sessions: SessionStore,
  admin: AdminStore,
  appState: AppStateStore,
): TestStoreFacade {
  const store = sessions as TestStoreFacade;
  store.getAppState = appState.get.bind(appState);
  store.setAppState = appState.set.bind(appState);
  store.deleteAppState = appState.delete.bind(appState);
  store.getAuthorizedUserId = admin.getAuthorizedUserId.bind(admin);
  store.getBindingCodeState = admin.getBindingCodeState.bind(admin);
  store.issueBindingCode = admin.issueBindingCode.bind(admin);
  store.recordBindingCodeFailure = admin.recordBindingCodeFailure.bind(admin);
  store.clearBindingCode = admin.clearBindingCode.bind(admin);
  store.claimAuthorizedUserId = admin.claimAuthorizedUserId.bind(admin);
  store.rebindAuthorizedUserId = admin.rebindAuthorizedUserId.bind(admin);
  store.clearAuthorizedUserId = admin.clearAuthorizedUserId.bind(admin);
  return store;
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
  const sentPhotos: Array<{
    chatId: number;
    photo: unknown;
    messageThreadId: number | null;
    options: Record<string, unknown> | null;
  }> = [];
  const sentDocuments: Array<{
    chatId: number;
    document: unknown;
    messageThreadId: number | null;
    options: Record<string, unknown> | null;
  }> = [];
  const edited: Array<{ chatId: number; messageId: number; text: string; options?: Record<string, unknown> }> = [];
  const answeredCallbacks: Array<{ callbackQueryId: string; text?: string; showAlert?: boolean }> = [];
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
    async editMessageText(chatId: number, messageId: number, text: string, options?: Record<string, unknown>) {
      edited.push({ chatId, messageId, text, ...(options ? { options } : {}) });
      return true;
    },
    async sendPhoto(chatId: number, photo: unknown, options?: Record<string, unknown> & { message_thread_id?: number | null }) {
      sentPhotos.push({
        chatId,
        photo,
        messageThreadId: options?.message_thread_id ?? null,
        options: options ?? null,
      });
      return { message_id: nextMessageId++ };
    },
    async sendDocument(chatId: number, document: unknown, options?: Record<string, unknown> & { message_thread_id?: number | null }) {
      sentDocuments.push({
        chatId,
        document,
        messageThreadId: options?.message_thread_id ?? null,
        options: options ?? null,
      });
      return { message_id: nextMessageId++ };
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
    async answerCallbackQuery(callbackQueryId: string, options?: { text?: string; show_alert?: boolean }) {
      answeredCallbacks.push({
        callbackQueryId,
        ...(options?.text == null ? {} : { text: options.text }),
        ...(options?.show_alert == null ? {} : { showAlert: options.show_alert }),
      });
      return true;
    },
  };
  const bot = { api };

  return {
    bot: bot as never,
    api,
    sent,
    sentPhotos,
    sentDocuments,
    edited,
    chatActions,
    forumEdits,
    deletedTopics,
    answeredCallbacks,
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
  const edited: Array<{ chatId: number; messageId: number; text: string; options?: Record<string, unknown> }> = [];
  const sentPhotos: Array<{
    chatId: number;
    photo: unknown;
    messageThreadId: number | null;
    options: Record<string, unknown> | null;
  }> = [];
  const sentDocuments: Array<{
    chatId: number;
    document: unknown;
    messageThreadId: number | null;
    options: Record<string, unknown> | null;
  }> = [];
  const chatActions: Array<{ chatId: number; action: string; messageThreadId: number | null }> = [];
  const createdTopics: Array<{ chatId: number; name: string; messageThreadId: number }> = [];
  const botCommands: Array<{
    commands: Array<{ command: string; description: string }>;
    scope: unknown;
  }> = [];
  const answeredCallbacks: Array<{ callbackQueryId: string; text?: string; showAlert?: boolean }> = [];
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
    async editMessageText(chatId: number, messageId: number, text: string, options?: Record<string, unknown>) {
      edited.push({ chatId, messageId, text, ...(options ? { options } : {}) });
      return true;
    },
    async sendPhoto(chatId: number, photo: unknown, options?: Record<string, unknown> & { message_thread_id?: number | null }) {
      sentPhotos.push({
        chatId,
        photo,
        messageThreadId: options?.message_thread_id ?? null,
        options: options ?? null,
      });
      return { message_id: nextMessageId++ };
    },
    async sendDocument(chatId: number, document: unknown, options?: Record<string, unknown> & { message_thread_id?: number | null }) {
      sentDocuments.push({
        chatId,
        document,
        messageThreadId: options?.message_thread_id ?? null,
        options: options ?? null,
      });
      return { message_id: nextMessageId++ };
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
    async answerCallbackQuery(callbackQueryId: string, options?: { text?: string; show_alert?: boolean }) {
      answeredCallbacks.push({
        callbackQueryId,
        ...(options?.text == null ? {} : { text: options.text }),
        ...(options?.show_alert == null ? {} : { showAlert: options.show_alert }),
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
    sentPhotos,
    sentDocuments,
    edited,
    chatActions,
    createdTopics,
    botCommands,
    answeredCallbacks,
  };
}
