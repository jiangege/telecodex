import { GrammyError, type Bot } from "grammy";
import type { Logger } from "../runtime/logger.js";
import type { TelegramSession } from "../store/sessions.js";
import { numericChatId, numericMessageThreadId } from "../bot/session.js";
import { retryTelegramCall, sendPlainChunks } from "./delivery.js";

export interface TopicBindingCleanupRecord {
  messageThreadId: string;
  codexThreadId: string | null;
  reason: "telegram-topic-missing" | "codex-thread-missing" | "codex-thread-archived";
  topicDeleted: boolean;
}

export async function deleteTelegramTopic(bot: Bot, session: TelegramSession, logger?: Logger): Promise<boolean> {
  const messageThreadId = numericMessageThreadId(session);
  if (messageThreadId == null) {
    return false;
  }

  try {
    await retryTelegramCall(
      () => bot.api.deleteForumTopic(numericChatId(session), messageThreadId),
      logger,
      "telegram delete topic rate limited",
      {
        chatId: numericChatId(session),
        messageThreadId,
      },
    );
    logger?.info("deleted telegram topic", {
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      codexThreadId: session.codexThreadId,
    });
    return true;
  } catch (error) {
    if (isDeletedTopicError(error)) {
      return true;
    }
    logger?.warn("failed to delete telegram topic", {
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      codexThreadId: session.codexThreadId,
      error,
    });
    return false;
  }
}

export async function sendCleanupNoticeToGeneral(
  bot: Bot,
  chatId: number,
  cleaned: TopicBindingCleanupRecord[],
  logger?: Logger,
): Promise<void> {
  const lines = [
    "telecodex 自动清理了失效的 topic 绑定。",
    ...cleaned.map(formatCleanupLine),
  ];

  try {
    await sendPlainChunks(
      bot,
      {
        chatId,
        messageThreadId: null,
        text: lines.join("\n"),
      },
      logger,
    );
  } catch (error) {
    logger?.warn("failed to send maintenance cleanup notice", {
      chatId,
      cleanedTopics: cleaned.length,
      error,
    });
  }
}

export function formatCleanupLine(item: TopicBindingCleanupRecord): string {
  const target = item.codexThreadId ? `topic ${item.messageThreadId} -> thread ${item.codexThreadId}` : `topic ${item.messageThreadId}`;
  if (item.reason === "telegram-topic-missing") {
    return `- ${target}: Telegram topic 已不存在，已移除绑定`;
  }
  if (item.reason === "codex-thread-archived") {
    if (item.topicDeleted) {
      return `- ${target}: Codex thread 已归档，已删除 Telegram topic 并移除绑定`;
    }
    return `- ${target}: Codex thread 已归档，已移除绑定；Telegram topic 删除失败`;
  }
  if (item.topicDeleted) {
    return `- ${target}: Codex thread 已不存在，已删除 Telegram topic 并移除绑定`;
  }
  return `- ${target}: Codex thread 已不存在，已移除绑定；Telegram topic 删除失败`;
}

export function isDeletedTopicError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const description = error.description.toLowerCase();
  return (
    description.includes("message thread not found") ||
    description.includes("message thread is not found") ||
    description.includes("topic not found") ||
    description.includes("topic was deleted") ||
    description.includes("message thread does not exist") ||
    description.includes("topic_id_invalid") ||
    description.includes("topic id invalid")
  );
}
