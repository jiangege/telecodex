import { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { CodexThreadCatalog } from "../codex/sessionCatalog.js";
import type { CodexSdkRuntime } from "../codex/sdkRuntime.js";
import type { Logger } from "../runtime/logger.js";
import type { ProjectStore } from "../store/projects.js";
import type { SessionStore } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { authMiddleware } from "./auth.js";
import { recoverActiveTopicSessions } from "./inputService.js";
import { registerHandlers } from "./registerHandlers.js";
import { cleanupMissingTopicBindings } from "./topicCleanup.js";

export { handleUserText, refreshSessionIfActiveTurnIsStale } from "./inputService.js";

export function wireBot(input: {
  bot: Bot;
  config: AppConfig;
  store: SessionStore;
  projects: ProjectStore;
  codex: CodexSdkRuntime;
  threadCatalog: CodexThreadCatalog;
  bootstrapCode: string | null;
  logger?: Logger;
  onAdminBound?: (userId: number) => void;
}): {
  bot: Bot;
  buffers: MessageBuffer;
} {
  const { bot, config, store, projects, codex, threadCatalog, bootstrapCode, logger, onAdminBound } = input;
  const buffers = new MessageBuffer(bot, config.updateIntervalMs, logger?.child("message-buffer"));

  bot.use(
    authMiddleware({
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
    threadCatalog,
    buffers,
    ...(logger ? { logger } : {}),
  });

  void (async () => {
    try {
      await syncBotCommands(bot, logger);
      await cleanupMissingTopicBindings({
        bot,
        store,
        ...(logger ? { logger: logger.child("topic-cleanup") } : {}),
      });
      await recoverActiveTopicSessions(store, codex, buffers, bot, logger);
    } catch (error) {
      logger?.error("startup topic reconciliation failed", error);
    }
  })();

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
  threadCatalog: CodexThreadCatalog;
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

async function syncBotCommands(bot: Bot, logger?: Logger): Promise<void> {
  try {
    await bot.api.setMyCommands(privateCommands, {
      scope: { type: "all_private_chats" },
    });
    await bot.api.setMyCommands(groupCommands, {
      scope: { type: "all_group_chats" },
    });
  } catch (error) {
    logger?.warn("failed to sync telegram bot commands", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const privateCommands = [
  { command: "start", description: "Show help" },
  { command: "help", description: "Show help" },
  { command: "status", description: "Show bot status" },
  { command: "admin", description: "Show or hand off admin access" },
] as const;

const groupCommands = [
  { command: "help", description: "Show help" },
  { command: "status", description: "Show project or topic status" },
  { command: "project", description: "Show, bind, or unbind project" },
  { command: "thread", description: "List, resume, or create topics" },
  { command: "queue", description: "List, drop, or clear queued inputs" },
  { command: "stop", description: "Stop the active run" },
  { command: "cwd", description: "Show or set topic directory" },
  { command: "mode", description: "Switch preset mode" },
  { command: "sandbox", description: "Show or set sandbox mode" },
  { command: "approval", description: "Show or set approval mode" },
  { command: "yolo", description: "Enable or disable YOLO mode" },
  { command: "model", description: "Show or set model" },
  { command: "effort", description: "Show or set reasoning effort" },
  { command: "web", description: "Show or set web search" },
  { command: "network", description: "Show or set network access" },
  { command: "gitcheck", description: "Show or set git repo check" },
  { command: "adddir", description: "List or manage extra directories" },
  { command: "schema", description: "Show or set output schema" },
  { command: "codexconfig", description: "Show or set Codex config" },
] as const;
