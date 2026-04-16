import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  requireScopedSession,
} from "../commandSupport.js";
import { handleUserInput, handleUserText } from "../inputService.js";
import { telegramImageMessageToCodexInput } from "../../telegram/attachments.js";
import { replyError, replyNotice } from "../../telegram/formatted.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";

export function registerMessageHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, codex, buffers, attachmentIo, logger } = deps;

  bot.on("message:text", wrapUserFacingHandler("message:text", logger, async (ctx) => {
    const text = ctx.message.text;
    logger?.info("received telegram text message", {
      ...contextLogFields(ctx),
      textLength: text.length,
      isCommand: text.startsWith("/"),
    });
    if (text.startsWith("/")) return;

    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) {
      logger?.warn("ignored telegram text message because no scoped session was available", {
        ...contextLogFields(ctx),
        textLength: text.length,
      });
      return;
    }

    await handleUserText({
      text,
      session,
      store,
      codex,
      buffers,
      bot,
      ...(logger ? { logger } : {}),
    });
  }));

  bot.on(["message:photo", "message:document"], wrapUserFacingHandler("message:attachment", logger, async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) {
      logger?.warn("ignored telegram attachment because no scoped session was available", {
        ...contextLogFields(ctx),
      });
      return;
    }

    try {
      const prompt = await telegramImageMessageToCodexInput({
        bot,
        config,
        chatId: ctx.chat.id,
        messageThreadId: ctx.message.message_thread_id ?? null,
        message: ctx.message,
      }, attachmentIo);
      if (!prompt) {
        await replyNotice(ctx, "Only image attachments are supported.");
        return;
      }

      await handleUserInput({
        prompt,
        session,
        store,
        codex,
        buffers,
        bot,
        ...(logger ? { logger } : {}),
      });
    } catch (error) {
      logger?.warn("failed to handle telegram image attachment", {
        ...contextLogFields(ctx),
        error,
      });
      await replyError(ctx, error instanceof Error ? error.message : String(error));
    }
  }));
}
