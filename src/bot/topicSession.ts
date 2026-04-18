import type { Context } from "grammy";
import type { AppConfig } from "../config.js";
import { SessionStore, makeSessionKey, type TelegramSession } from "../store/sessionStore.js";

export function sessionFromContext(
  ctx: Context,
  sessions: SessionStore,
  config: AppConfig,
): TelegramSession {
  const chatId = ctx.chat?.id;
  if (chatId == null) throw new Error("Missing Telegram chat id");
  const messageThreadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
  const sessionKey = makeSessionKey(chatId, messageThreadId);
  return sessions.getOrCreate({
    sessionKey,
    chatId: String(chatId),
    messageThreadId: messageThreadId == null ? null : String(messageThreadId),
    telegramTopicName: null,
    defaultCwd: config.defaultCwd,
    defaultModel: config.defaultModel,
  });
}

export function numericChatId(session: TelegramSession): number {
  return Number(session.chatId);
}

export function numericMessageThreadId(session: TelegramSession): number | null {
  return session.messageThreadId == null ? null : Number(session.messageThreadId);
}
