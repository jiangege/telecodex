import { existsSync } from "node:fs";
import { GrammyError, type Bot } from "grammy";
import type { CodexGateway } from "../../codex/CodexGateway.js";
import type { SessionStore, TelegramSession } from "../../store/sessions.js";
import type { Logger } from "../../runtime/logger.js";
import type { MaintenanceTask } from "../MaintenanceRunner.js";
import {
  deleteTelegramTopic,
  isDeletedTopicError,
  sendCleanupNoticeToGeneral,
  type TopicBindingCleanupRecord,
} from "../../telegram/topicCleanup.js";
import { retryTelegramCall } from "../../telegram/delivery.js";

const RECONCILE_INTERVAL_MS = 15 * 60_000;

export function createReconcileTelegramTopicsTask(input: {
  bot: Bot;
  store: SessionStore;
  gateway: CodexGateway;
  logger: Logger;
}): MaintenanceTask {
  const { bot, store, gateway, logger } = input;

  return {
    name: "reconcile-telegram-topics",
    intervalMs: RECONCILE_INTERVAL_MS,
    runOnStart: true,
    async run(): Promise<void> {
      const sessions = store.listTopicSessions();
      if (sessions.length === 0) return;

      logger.info("running telegram topic reconciliation", {
        topicSessions: sessions.length,
      });

      const cleanedByChat = new Map<string, TopicBindingCleanupRecord[]>();
      for (const session of sessions) {
        const cleanedBinding = await reconcileBinding(bot, store, gateway, session, logger);
        if (!cleanedBinding) continue;

        if (session.codexThreadId) {
          store.removeTurnDeliveriesForThread(session.codexThreadId);
        }
        store.remove(session.sessionKey);
        const cleaned = cleanedByChat.get(session.chatId) ?? [];
        cleaned.push(cleanedBinding);
        cleanedByChat.set(session.chatId, cleaned);

        logger.warn("removed stale telegram topic binding", {
          sessionKey: session.sessionKey,
          chatId: session.chatId,
          messageThreadId: session.messageThreadId,
          codexThreadId: session.codexThreadId,
          reason: cleanedBinding.reason,
          topicDeleted: cleanedBinding.topicDeleted,
        });
      }

      for (const [chatId, cleaned] of cleanedByChat.entries()) {
        await sendCleanupNoticeToGeneral(bot, Number(chatId), cleaned, logger);
      }
    },
  };
}

async function reconcileBinding(
  bot: Bot,
  store: SessionStore,
  gateway: CodexGateway,
  session: TelegramSession,
  logger: Logger,
) : Promise<TopicBindingCleanupRecord | null> {
  const topicName = await resolveTopicName(store, gateway, session, logger);
  if (topicName && (await isDeletedTelegramTopic(bot, session, topicName, logger))) {
    return {
      messageThreadId: session.messageThreadId ?? "?",
      codexThreadId: session.codexThreadId,
      reason: "telegram-topic-missing",
      topicDeleted: false,
    };
  }

  const codexThreadState = session.codexThreadId ? await probeCodexThreadState(gateway, session, logger) : "healthy";
  if (codexThreadState !== "healthy") {
    const topicDeleted = await deleteTelegramTopic(bot, session, logger);
    return {
      messageThreadId: session.messageThreadId ?? "?",
      codexThreadId: session.codexThreadId,
      reason: codexThreadState === "archived" ? "codex-thread-archived" : "codex-thread-missing",
      topicDeleted,
    };
  }

  if (!topicName && !session.codexThreadId) {
    logger.warn("skipping topic reconciliation because both topic name and codex thread are unknown", {
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
    });
  }

  return null;
}

async function isDeletedTelegramTopic(bot: Bot, session: TelegramSession, topicName: string, logger: Logger): Promise<boolean> {
  const chatId = Number(session.chatId);
  const messageThreadId = Number(session.messageThreadId);

  try {
    await retryTelegramCall(
      () => bot.api.editForumTopic(chatId, messageThreadId, { name: topicName }),
      logger,
      "telegram edit topic rate limited",
      {
        chatId,
        messageThreadId,
      },
    );
    return false;
  } catch (error) {
    if (isTopicNotModifiedError(error)) {
      return false;
    }
    if (isDeletedTopicError(error)) {
      return true;
    }

    logger.warn("telegram topic reconciliation probe failed", {
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      error,
    });
    return false;
  }
}

async function probeCodexThreadState(
  gateway: CodexGateway,
  session: TelegramSession,
  logger: Logger,
): Promise<"healthy" | "archived" | "missing"> {
  const threadId = session.codexThreadId;
  if (!threadId) return "healthy";

  try {
    const thread = await gateway.readThread(threadId, false);
    if (isArchivedCodexThreadPath(thread.path)) {
      logger.info("codex thread is archived", {
        sessionKey: session.sessionKey,
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        codexThreadId: threadId,
        rolloutPath: thread.path,
      });
      return "archived";
    }
    if (thread.path && !existsSync(thread.path)) {
      logger.warn("codex thread rollout path is missing on disk", {
        sessionKey: session.sessionKey,
        chatId: session.chatId,
        messageThreadId: session.messageThreadId,
        codexThreadId: threadId,
        rolloutPath: thread.path,
      });
      return "missing";
    }
    return "healthy";
  } catch (error) {
    if (isMissingCodexThreadError(error)) {
      return "missing";
    }

    logger.warn("codex thread reconciliation probe failed", {
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      codexThreadId: threadId,
      error,
    });
    return "healthy";
  }
}

async function resolveTopicName(
  store: SessionStore,
  gateway: CodexGateway,
  session: TelegramSession,
  logger: Logger,
): Promise<string | null> {
  if (session.telegramTopicName?.trim()) {
    return session.telegramTopicName.trim();
  }
  if (!session.codexThreadId) {
    return null;
  }

  try {
    const thread = await gateway.readThread(session.codexThreadId, false);
    const topicName = formatTopicName(thread.name, thread.preview, "Resumed Thread");
    store.setTelegramTopicName(session.sessionKey, topicName);
    logger.info("backfilled telegram topic name for legacy binding", {
      sessionKey: session.sessionKey,
      topicName,
      codexThreadId: session.codexThreadId,
    });
    return topicName;
  } catch (error) {
    logger.warn("failed to backfill telegram topic name", {
      sessionKey: session.sessionKey,
      codexThreadId: session.codexThreadId,
      error,
    });
    return null;
  }
}

function isTopicNotModifiedError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const description = error.description.toLowerCase();
  return description.includes("topic_not_modified") || description.includes("topic not modified");
}

function isMissingCodexThreadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("thread not loaded") ||
    message.includes("no rollout found") ||
    message.includes("empty session file") ||
    (message.includes("thread") && message.includes("not found"))
  );
}

function isArchivedCodexThreadPath(rolloutPath: string | null): boolean {
  if (!rolloutPath) return false;
  return rolloutPath.includes("/archived_sessions/") || rolloutPath.includes("\\archived_sessions\\");
}

function formatTopicName(name: string | null | undefined, preview: string, fallback: string): string {
  const raw = name?.trim() || truncateSingleLine(preview, 60) || fallback;
  return raw.slice(0, 128);
}

function truncateSingleLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
