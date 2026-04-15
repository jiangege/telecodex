import type { Context, NextFunction } from "grammy";
import type { Logger } from "../runtime/logger.js";
import type { SessionStore } from "../store/sessions.js";

export function authMiddleware(input: {
  bootstrapCode: string | null;
  store: SessionStore;
  onAdminBound?: (userId: number) => void;
  logger?: Logger;
}) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;
    if (!userId) {
      input.logger?.warn("telegram update ignored because it has no from.id", {
        chatId: ctx.chat?.id ?? null,
        chatType: ctx.chat?.type ?? null,
        messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null,
        senderChatId: ctx.message?.sender_chat?.id ?? ctx.callbackQuery?.message?.sender_chat?.id ?? null,
        hasTextMessage: Boolean(ctx.message?.text),
      });
      if (ctx.message?.text && ctx.chat?.type !== "private") {
        await ctx.reply(
          "This message was sent as the group identity or as an anonymous admin. telecodex cannot verify the operator. Send it from your personal account instead.",
        );
      }
      return;
    }

    const authorizedUserId = input.store.getAuthorizedUserId();
    if (authorizedUserId != null) {
      if (authorizedUserId === userId) {
        await next();
        return;
      }
      input.logger?.warn("telegram update denied because user is not authorized", {
        chatId: ctx.chat?.id ?? null,
        chatType: ctx.chat?.type ?? null,
        messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null,
        fromId: userId,
        authorizedUserId,
      });
      await deny(ctx, "Unauthorized.");
      return;
    }

    if (!input.bootstrapCode) {
      await deny(ctx, "Authentication is not configured for this bot yet.");
      return;
    }

    if (ctx.chat?.type !== "private") {
      await deny(ctx, "Send the admin bootstrap code to the bot in a private chat first.");
      return;
    }

    const messageText = ctx.message?.text?.trim();
    if (messageText === input.bootstrapCode) {
      const claimedUserId = input.store.claimAuthorizedUserId(userId);
      if (claimedUserId === userId) {
        input.onAdminBound?.(userId);
        await ctx.reply("Admin binding succeeded. Only this Telegram account can use this bot from now on.");
      } else {
        await deny(ctx, "An admin account has already claimed this bot.");
      }
      return;
    }

    await ctx.reply("This bot is not initialized yet. Send the binding code shown in the startup logs to complete the one-time admin binding.");
  };
}

async function deny(ctx: Context, text: string): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text, show_alert: false });
    return;
  }
  if (ctx.chat?.type === "private") {
    await ctx.reply(text);
  }
}
