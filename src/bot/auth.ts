import type { Context, NextFunction } from "grammy";
import type { Logger } from "../runtime/logger.js";
import type { BindingCodeState, SessionStore } from "../store/sessions.js";
import { replyError, replyNotice } from "../telegram/formatted.js";

export function authMiddleware(input: {
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
        await replyError(
          ctx,
          "This message was sent as the group identity or as an anonymous admin. telecodex cannot verify the operator. Send it from your personal account instead.",
        );
      }
      return;
    }

    const authorizedUserId = input.store.getAuthorizedUserId();
    const binding = input.store.getBindingCodeState();
    const messageText = ctx.message?.text?.trim();
    if (authorizedUserId != null) {
      if (authorizedUserId === userId) {
        await next();
        return;
      }

      if (ctx.chat?.type === "private" && binding?.mode === "rebind" && messageText) {
        const handled = await handleBindingCodeMessage({
          ctx,
          userId,
          text: messageText,
          binding,
          store: input.store,
          success: async () => {
            input.store.rebindAuthorizedUserId(userId);
            await replyNotice(ctx, "Admin handoff succeeded. This Telegram account is now authorized to use telecodex.");
          },
          mismatchLabel: "Admin handoff code did not match.",
          exhaustedLabel: "Admin handoff code exhausted its attempt limit and was invalidated. Issue a new one from the currently authorized account.",
        });
        if (handled) return;
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

    if (!binding || binding.mode !== "bootstrap") {
      await deny(ctx, "This bot is not initialized yet, or the binding code expired. Restart telecodex locally to issue a new binding code.");
      return;
    }

    if (ctx.chat?.type !== "private") {
      await deny(ctx, "Send the admin bootstrap code to the bot in a private chat first.");
      return;
    }

    if (messageText) {
      const handled = await handleBindingCodeMessage({
        ctx,
        userId,
        text: messageText,
        binding,
        store: input.store,
        success: async () => {
          const claimedUserId = input.store.claimAuthorizedUserId(userId);
          if (claimedUserId === userId) {
            input.onAdminBound?.(userId);
            await replyNotice(ctx, "Admin binding succeeded. Only this Telegram account can use this bot from now on.");
            return;
          }
          await deny(ctx, "An admin account has already claimed this bot.");
        },
        mismatchLabel: "Binding code did not match.",
        exhaustedLabel: "Binding code exhausted its attempt limit and was invalidated. Restart telecodex locally to issue a new one.",
      });
      if (handled) return;
    }

    await replyNotice(ctx, "This bot is not initialized yet. Send the binding code shown in the startup logs to complete the one-time admin binding.");
  };
}

async function handleBindingCodeMessage(input: {
  ctx: Context;
  userId: number;
  text: string;
  binding: BindingCodeState;
  store: SessionStore;
  success: () => Promise<void>;
  mismatchLabel: string;
  exhaustedLabel: string;
}): Promise<boolean> {
  if (input.text === input.binding.code) {
    await input.success();
    return true;
  }

  if (input.text.startsWith("/")) {
    return false;
  }

  const attempt = input.store.recordBindingCodeFailure();
  if (!attempt) {
    await replyError(input.ctx, "The binding code is no longer active. Issue a new one and try again.");
    return true;
  }

  if (attempt.exhausted) {
    await replyError(input.ctx, input.exhaustedLabel);
    return true;
  }

  await replyError(input.ctx, input.mismatchLabel, `Remaining attempts: ${attempt.remaining}`);
  return true;
}

async function deny(ctx: Context, text: string): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text, show_alert: false });
    return;
  }
  if (ctx.chat?.type === "private") {
    await replyError(ctx, text);
  }
}
