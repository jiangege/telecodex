import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  getScopedSession,
} from "../commandSupport.js";
import { handleUserText } from "../inputService.js";
import { getSessionInputState } from "../inputTarget.js";
import { handleTerminalTextReply } from "../terminalBridge.js";

export function registerMessageHandlers(deps: BotHandlerDeps): void {
  const { bot, approvals, config, store, projects, gateway, buffers, logger } = deps;

  bot.on("callback_query:data", async (ctx) => {
    const handled = await approvals.handleCallback(ctx);
    if (!handled) await ctx.answerCallbackQuery();
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    logger?.info("received telegram text message", {
      ...contextLogFields(ctx),
      textLength: text.length,
      isCommand: text.startsWith("/"),
    });
    if (text.startsWith("/")) return;

    const session = getScopedSession(ctx, store, projects, config);
    if (!session) {
      logger?.warn("ignored telegram text message because no scoped session was available", {
        ...contextLogFields(ctx),
        textLength: text.length,
      });
      return;
    }

    const inputState = getSessionInputState(store, session);
    if (inputState.target === "tty" && inputState.activeBlocker?.consumesPlainText) {
      if (await handleTerminalTextReply({ ctx, store, gateway, ...(logger ? { logger } : {}) })) return;
    }
    if (inputState.target === "user_input" && inputState.activeBlocker?.consumesPlainText) {
      if (await approvals.handleTextReply(ctx)) return;
    }

    await handleUserText({
      text,
      session,
      store,
      gateway,
      buffers,
      bot,
      ...(logger ? { logger } : {}),
    });
  });
}
