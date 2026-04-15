import type { Bot } from "grammy";
import { GrammyError } from "grammy";
import type { Logger } from "../runtime/logger.js";
import type { SessionStore } from "../store/sessions.js";
import { sendTypingAction } from "../telegram/delivery.js";

export interface TopicCleanupSummary {
  total: number;
  checked: number;
  kept: number;
  removed: number;
  skipped: number;
  failed: number;
}

export async function cleanupMissingTopicBindings(input: {
  bot: Bot;
  store: SessionStore;
  logger?: Logger;
}): Promise<TopicCleanupSummary> {
  const sessions = input.store.listTopicSessions();
  const summary: TopicCleanupSummary = {
    total: sessions.length,
    checked: 0,
    kept: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const session of sessions) {
    const chatId = Number(session.chatId);
    const messageThreadId = Number(session.messageThreadId);
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageThreadId)) {
      summary.skipped += 1;
      input.logger?.warn("skipped topic binding cleanup for non-numeric telegram identifiers", {
        sessionKey: session.sessionKey,
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
      });
      continue;
    }

    summary.checked += 1;

    try {
      await sendTypingAction(
        input.bot,
        {
          chatId,
          messageThreadId,
        },
        input.logger,
      );
      summary.kept += 1;
    } catch (error) {
      if (!isMissingTopicBindingError(error)) {
        summary.failed += 1;
        input.logger?.warn("topic binding cleanup probe failed", {
          sessionKey: session.sessionKey,
          chatId,
          messageThreadId,
          error,
        });
        continue;
      }

      input.store.remove(session.sessionKey);
      summary.removed += 1;
      input.logger?.info("removed stale telegram topic binding", {
        sessionKey: session.sessionKey,
        chatId,
        messageThreadId,
        codexThreadId: session.codexThreadId,
        topicName: session.telegramTopicName,
      });
    }
  }

  input.logger?.info("topic binding cleanup finished", summary);
  return summary;
}

export function isMissingTopicBindingError(error: unknown): boolean {
  const description = describeError(error);
  if (!description) return false;
  return [
    "message thread not found",
    "message thread was not found",
    "forum topic not found",
    "topic not found",
    "thread not found",
    "topic deleted",
    "topic_deleted",
  ].some((fragment) => description.includes(fragment));
}

function describeError(error: unknown): string | null {
  if (error instanceof GrammyError) {
    return typeof error.description === "string" ? error.description.toLowerCase() : null;
  }
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  return typeof error === "string" ? error.toLowerCase() : null;
}
