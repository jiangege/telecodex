import { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { CodexSdkRuntime } from "../codex/sdkRuntime.js";
import type { Logger } from "../runtime/logger.js";
import type { ProjectStore } from "../store/projects.js";
import type { SessionStore } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { authMiddleware } from "./auth.js";
import { recoverActiveTopicSessions } from "./inputService.js";
import { registerHandlers } from "./registerHandlers.js";

export { handleUserText, refreshSessionIfActiveTurnIsStale } from "./inputService.js";

export function wireBot(input: {
  bot: Bot;
  config: AppConfig;
  store: SessionStore;
  projects: ProjectStore;
  codex: CodexSdkRuntime;
  bootstrapCode: string | null;
  logger?: Logger;
  onAdminBound?: (userId: number) => void;
}): {
  bot: Bot;
  buffers: MessageBuffer;
} {
  const { bot, config, store, projects, codex, bootstrapCode, logger, onAdminBound } = input;
  const buffers = new MessageBuffer(bot, config.updateIntervalMs, logger?.child("message-buffer"));

  bot.use(
    authMiddleware({
      bootstrapCode,
      store,
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
    store,
    projects,
    codex,
    buffers,
    ...(logger ? { logger } : {}),
  });

  void recoverActiveTopicSessions(store, codex, buffers, bot, logger);
  return {
    bot,
    buffers,
  };
}

export function createBot(input: {
  config: AppConfig;
  store: SessionStore;
  projects: ProjectStore;
  codex: CodexSdkRuntime;
  bootstrapCode: string | null;
  logger?: Logger;
  onAdminBound?: (userId: number) => void;
}): Bot {
  const { config } = input;
  const bot = new Bot(config.telegramBotToken);
  wireBot({
    bot,
    ...input,
  });
  return bot;
}
