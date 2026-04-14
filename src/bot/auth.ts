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
        await ctx.reply("这条消息是以群身份或匿名管理员身份发出的，telecodex 无法确认操作者。请切换为你的个人账号发送。");
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
      await deny(ctx, "未授权。");
      return;
    }

    if (!input.bootstrapCode) {
      await deny(ctx, "机器人尚未配置鉴权。");
      return;
    }

    if (ctx.chat?.type !== "private") {
      await deny(ctx, "请先私聊机器人发送管理员授权码。");
      return;
    }

    const messageText = ctx.message?.text?.trim();
    if (messageText === input.bootstrapCode) {
      const claimedUserId = input.store.claimAuthorizedUserId(userId);
      if (claimedUserId === userId) {
        input.onAdminBound?.(userId);
        await ctx.reply("管理员绑定成功。后续只有这个 Telegram 账号可以使用该机器人。");
      } else {
        await deny(ctx, "管理员已被其他账号绑定。");
      }
      return;
    }

    await ctx.reply("该机器人尚未初始化。请发送启动日志里显示的绑定码完成一次性绑定。");
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
