import { GrammyError, type Bot } from "grammy";
import { MODE_PRESETS, REASONING_EFFORTS, presetFromProfile } from "../config.js";
import type { Logger } from "../runtime/logger.js";
import { formatSessionRuntimeStatus } from "../runtime/sessionRuntime.js";
import type { SessionStore, TelegramSession } from "../store/sessions.js";
import { numericChatId, numericMessageThreadId } from "../bot/session.js";
import {
  editHtmlMessage,
  isMessageNotModifiedError,
  retryTelegramCall,
  sendHtmlMessage,
  shouldFallbackToNewMessage,
} from "./delivery.js";
import { escapeHtml } from "./renderer.js";

export async function refreshAllTopicStatusPins(bot: Bot, store: SessionStore, logger?: Logger): Promise<void> {
  for (const session of store.listTopicSessions()) {
    await updateTopicStatusPin(bot, store, session, logger);
  }
}

export async function updateTopicStatusPin(
  bot: Bot,
  store: SessionStore,
  session: TelegramSession,
  logger?: Logger,
): Promise<TelegramSession> {
  const latest = store.get(session.sessionKey) ?? session;
  const messageThreadId = numericMessageThreadId(latest);
  if (messageThreadId == null) {
    return latest;
  }

  const chatId = numericChatId(latest);
  const text = formatTopicStatusText(latest, store.getQueuedInputCount(latest.sessionKey));
  let messageId = latest.pinnedStatusMessageId;

  try {
    if (messageId != null) {
      try {
        await editHtmlMessage(
          bot,
          {
            chatId,
            messageId,
            text,
          },
          logger,
        );
      } catch (error) {
        if (isMessageNotModifiedError(error)) {
          await pinTopicStatusMessage(bot, chatId, messageId, latest, logger);
          return store.get(latest.sessionKey) ?? latest;
        }
        if (!shouldReplaceStatusMessage(error)) {
          logger?.warn("failed to edit topic status message", {
            sessionKey: latest.sessionKey,
            chatId: latest.chatId,
            messageThreadId: latest.messageThreadId,
            messageId,
            error,
          });
          return latest;
        }
        messageId = null;
      }
    }

    if (messageId == null) {
      const message = await sendHtmlMessage(
        bot,
        {
          chatId,
          messageThreadId,
          text,
        },
        logger,
      );
      messageId = message.message_id;
      store.setPinnedStatusMessage(latest.sessionKey, messageId);
    }

    await pinTopicStatusMessage(bot, chatId, messageId, latest, logger);
  } catch (error) {
    logger?.warn("failed to refresh topic status pin", {
      sessionKey: latest.sessionKey,
      chatId: latest.chatId,
      messageThreadId: latest.messageThreadId,
      codexThreadId: latest.codexThreadId,
      error,
    });
  }

  return store.get(latest.sessionKey) ?? latest;
}

function formatTopicStatusText(session: TelegramSession, queueDepth: number): string {
  const detail = session.runtimeStatusDetail?.trim();
  return [
    "<b>Codex Thread</b>",
    formatCodeLine("thread", session.codexThreadId ?? "待创建"),
    formatCodeLine("state", describeSessionState(session)),
    ...(detail ? [formatCodeLine("detail", detail)] : []),
    formatCodeLine("active turn", session.activeTurnId ?? "无"),
    formatCodeLine("queue", String(queueDepth)),
    formatCodeLine("model", session.model),
    formatCodeLine("effort", describeReasoningEffort(session)),
    formatCodeLine("preset", String(presetFromProfile(session))),
    formatCodeLine("sandbox", session.sandboxMode),
    formatCodeLine("approval", session.approvalPolicy),
    formatCodeLine("yolo", isYoloEnabled(session) ? "on" : "off"),
    formatCodeLine("cwd", session.cwd),
    formatCodeLine("updated", formatUpdatedAt(session.runtimeStatusUpdatedAt)),
    "",
    "<b>修改命令</b>",
    "<code>/status</code>",
    "<code>/model &lt;id&gt;</code>",
    `<code>/effort default|${REASONING_EFFORTS.join("|")}</code>`,
    `<code>/mode ${MODE_PRESETS.join("|")}</code>`,
    "<code>/sandbox read-only|workspace-write|danger-full-access</code>",
    "<code>/approval on-request|on-failure|never</code>",
    "<code>/yolo on|off</code>",
    "<code>/cwd &lt;path&gt;</code>",
  ].join("\n");
}

function formatCodeLine(label: string, value: string): string {
  return `${escapeHtml(label)}: <code>${escapeHtml(value)}</code>`;
}

function describeReasoningEffort(session: TelegramSession): string {
  return session.reasoningEffort ?? "codex-default";
}

function describeSessionState(session: TelegramSession): string {
  return formatSessionRuntimeStatus(session.runtimeStatus);
}

function isYoloEnabled(session: TelegramSession): boolean {
  return session.sandboxMode === "danger-full-access" && session.approvalPolicy === "never";
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
  });
}

async function pinTopicStatusMessage(
  bot: Bot,
  chatId: number,
  messageId: number,
  session: TelegramSession,
  logger?: Logger,
): Promise<void> {
  try {
    await retryTelegramCall(
      () =>
        bot.api.pinChatMessage(chatId, messageId, {
          disable_notification: true,
        }),
      logger,
      "telegram pin message rate limited",
      {
        chatId,
        messageId,
      },
    );
  } catch (error) {
    if (isAlreadyPinnedError(error)) {
      return;
    }
    logger?.warn("failed to pin topic status message", {
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      messageId,
      error,
    });
  }
}

function shouldReplaceStatusMessage(error: unknown): boolean {
  return shouldFallbackToNewMessage(error);
}

function isAlreadyPinnedError(error: unknown): boolean {
  return error instanceof GrammyError && error.description.toLowerCase().includes("message is already pinned");
}
