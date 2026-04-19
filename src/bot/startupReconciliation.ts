import { Bot } from "grammy";
import type { Logger } from "../runtime/logger.js";
import type { SessionStore } from "../store/sessionStore.js";
import type { CodexSdkRuntime } from "../codex/sdkRuntime.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { cleanupMissingTopicBindings } from "./topicCleanup.js";
import { recoverActiveTopicSessions } from "./run/staleRunRecovery.js";

export async function initializeBotRuntime(input: {
  bot: Bot;
  sessions: SessionStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  logger?: Logger;
}): Promise<void> {
  await syncBotCommands(input.bot, input.logger);
  await cleanupMissingTopicBindings({
    bot: input.bot,
    store: input.sessions,
    ...(input.logger ? { logger: input.logger.child("topic-cleanup") } : {}),
  });
  await recoverActiveTopicSessions({
    sessions: input.sessions,
    codex: input.codex,
    buffers: input.buffers,
    bot: input.bot,
    ...(input.logger ? { logger: input.logger } : {}),
  });
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
  { command: "admin", description: "Show or hand off admin access" },
] as const;

const groupCommands = [
  { command: "help", description: "Show help" },
  { command: "status", description: "Show workspace or topic status" },
  { command: "workspace", description: "Show or set the working root" },
  { command: "thread", description: "List, resume, or create topics" },
  { command: "stop", description: "Fallback stop for the active run" },
  { command: "mode", description: "Switch preset mode" },
  { command: "model", description: "Show or set model" },
  { command: "effort", description: "Show or set reasoning effort" },
  { command: "web", description: "Show or set web search" },
  { command: "network", description: "Show or set network access" },
  { command: "gitcheck", description: "Show or set git repo check" },
  { command: "adddir", description: "List or manage extra directories" },
  { command: "schema", description: "Show or set output schema" },
  { command: "codexconfig", description: "Show or set Codex config" },
] as const;
