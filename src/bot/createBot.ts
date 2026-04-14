import { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { CodexGateway } from "../codex/CodexGateway.js";
import { ApprovalManager } from "../codex/approvals.js";
import type { ProjectStore } from "../store/projects.js";
import type { SessionStore } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import type { Logger } from "../runtime/logger.js";
import { authMiddleware } from "./auth.js";
import { handleCodexNotification } from "./codexNotificationHandler.js";
import {
  handleUserText,
  recoverActiveTopicSessions,
  refreshSessionIfActiveTurnIsStale,
} from "./inputService.js";
import { registerHandlers } from "./registerHandlers.js";

export {
  handleUserText,
  refreshSessionIfActiveTurnIsStale,
} from "./inputService.js";
export { handleCodexNotification } from "./codexNotificationHandler.js";
export { recoverPendingTurnDeliveries, refreshLiveSessionHeartbeats } from "./turnDeliveryService.js";

export function createBot(input: {
  config: AppConfig;
  store: SessionStore;
  projects: ProjectStore;
  gateway: CodexGateway;
  bootstrapCode: string | null;
  logger?: Logger;
  onAdminBound?: (userId: number) => void;
}): Bot {
  const { config, store, projects, gateway, bootstrapCode, logger, onAdminBound } = input;
  const bot = new Bot(config.telegramBotToken);
  const buffers = new MessageBuffer(bot, config.updateIntervalMs, logger?.child("message-buffer"));
  const approvals = new ApprovalManager(bot, gateway, store);

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

  gateway.onNotification((event) => {
    void handleCodexNotification(event, store, buffers, bot, gateway, logger);
  });
  gateway.onServerRequest((request) => {
    void approvals.handleServerRequest(request);
  });

  registerHandlers({
    bot,
    approvals,
    config,
    store,
    projects,
    gateway,
    buffers,
    ...(logger ? { logger } : {}),
  });

  void recoverActiveTopicSessions(store, gateway, buffers, bot, logger);
  return bot;
}
