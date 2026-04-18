import { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { CodexThreadCatalog } from "../codex/sessionCatalog.js";
import type { CodexSdkRuntime } from "../codex/sdkRuntime.js";
import type { Logger } from "../runtime/logger.js";
import type { AdminStore } from "../store/adminStore.js";
import type { AppStateStore } from "../store/appStateStore.js";
import type { ProjectStore } from "../store/projectStore.js";
import type { SessionStore } from "../store/sessionStore.js";
import type { TelegramAttachmentIo } from "../telegram/attachments.js";
import { MessageBuffer, type MessageBufferOptions } from "../telegram/messageBuffer.js";
import { authMiddleware } from "./auth.js";
import { registerHandlers } from "./registerHandlers.js";
import { initializeBotRuntime } from "./startupReconciliation.js";

export function wireBot(input: {
  bot: Bot;
  config: AppConfig;
  sessions: SessionStore;
  projects: ProjectStore;
  admin: AdminStore;
  appState: AppStateStore;
  codex: CodexSdkRuntime;
  threadCatalog: CodexThreadCatalog;
  logger?: Logger;
  onAdminBound?: (userId: number) => void;
  attachmentIo?: Partial<TelegramAttachmentIo>;
  bufferOptions?: MessageBufferOptions;
  autoInitialize?: boolean;
}): {
  bot: Bot;
  buffers: MessageBuffer;
  initializeRuntime: () => Promise<void>;
  initializationPromise: Promise<void> | null;
} {
  const { bot, config, sessions, projects, admin, appState, codex, threadCatalog, logger, onAdminBound } = input;
  const buffers = new MessageBuffer(
    bot,
    config.updateIntervalMs,
    logger?.child("message-buffer"),
    input.bufferOptions,
  );

  bot.use(
    authMiddleware({
      admin,
      ...(logger ? { logger: logger.child("auth") } : {}),
      ...(onAdminBound ? { onAdminBound } : {}),
    }),
  );

  if (logger) {
    bot.catch((error) => {
      logger.error("grammy bot error", {
        updateId: error.ctx.update.update_id,
        chatId: error.ctx.chat?.id ?? null,
        chatType: error.ctx.chat?.type ?? null,
        messageThreadId: error.ctx.message?.message_thread_id ?? error.ctx.callbackQuery?.message?.message_thread_id ?? null,
        fromId: error.ctx.from?.id ?? null,
        error: error.error,
      });
    });
  }

  registerHandlers({
    bot,
    config,
    sessions,
    projects,
    admin,
    appState,
    codex,
    threadCatalog,
    buffers,
    ...(input.attachmentIo ? { attachmentIo: input.attachmentIo } : {}),
    ...(logger ? { logger } : {}),
  });

  let initializationPromise: Promise<void> | null = null;
  const initializeRuntime = (): Promise<void> => {
    if (initializationPromise) {
      return initializationPromise;
    }
    initializationPromise = (async () => {
      try {
        await initializeBotRuntime({
          bot,
          sessions,
          codex,
          buffers,
          ...(logger ? { logger } : {}),
        });
      } catch (error) {
        logger?.error("startup topic reconciliation failed", error);
      }
    })();
    return initializationPromise;
  };

  if (input.autoInitialize !== false) {
    void initializeRuntime();
  }

  return {
    bot,
    buffers,
    initializeRuntime,
    initializationPromise,
  };
}

export function createBot(input: {
  config: AppConfig;
  sessions: SessionStore;
  projects: ProjectStore;
  admin: AdminStore;
  appState: AppStateStore;
  codex: CodexSdkRuntime;
  threadCatalog: CodexThreadCatalog;
  logger?: Logger;
  onAdminBound?: (userId: number) => void;
}): Bot {
  const bot = new Bot(input.config.telegramBotToken);
  wireBot({
    bot,
    ...input,
  });
  return bot;
}
