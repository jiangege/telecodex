import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  requireScopedSession,
} from "../commandContext.js";
import { handleUserInput, handleUserText } from "../run/runOrchestrator.js";
import { refreshSessionIfActiveTurnIsStale } from "../run/staleRunRecovery.js";
import { decodeStopCallbackData } from "../run/stopButton.js";
import { telegramImageMessageToCodexInput } from "../../telegram/attachments.js";
import { replyError, replyNotice } from "../../telegram/replyDocument.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";
import { interruptActiveRun } from "./operationalHandlers.js";

export function registerMessageHandlers(deps: BotHandlerDeps): void {
  const { bot, config, sessions, projects, codex, buffers, attachmentIo, logger } = deps;

  bot.on("callback_query:data", wrapUserFacingHandler("callback_query:data", logger, async (ctx) => {
    const scoped = decodeStopCallbackData(ctx.callbackQuery.data);
    if (!scoped) return;

    if (ctx.chat?.id !== scoped.chatId || ctx.callbackQuery.message?.message_thread_id !== scoped.messageThreadId) {
      await ctx.answerCallbackQuery({
        text: "This Stop button does not belong to the current topic.",
        show_alert: false,
      });
      return;
    }

    const session = await requireScopedSession(ctx, sessions, projects, config);
    if (!session) return;

    const latest = await refreshSessionIfActiveTurnIsStale(session, sessions, codex, buffers, bot, logger);
    if (!codex.isRunning(latest.sessionKey)) {
      await ctx.answerCallbackQuery({
        text: "There is no active run.",
        show_alert: false,
      });
      return;
    }

    await interruptActiveRun({
      sessionKey: latest.sessionKey,
      codex,
    });
    await ctx.answerCallbackQuery({
      text: "Interrupt requested.",
      show_alert: false,
    });
  }));

  bot.on("message:text", wrapUserFacingHandler("message:text", logger, async (ctx) => {
    const text = ctx.message.text;
    logger?.info("received telegram text message", {
      ...contextLogFields(ctx),
      textLength: text.length,
      isCommand: text.startsWith("/"),
    });
    if (text.startsWith("/")) return;

    const session = await requireScopedSession(ctx, sessions, projects, config);
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
      sessions,
      projects,
      codex,
      buffers,
      bot,
      ...(logger ? { logger } : {}),
    });
  }));

  bot.on(["message:photo", "message:document"], wrapUserFacingHandler("message:attachment", logger, async (ctx) => {
    const session = await requireScopedSession(ctx, sessions, projects, config);
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
        sessions,
        projects,
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
