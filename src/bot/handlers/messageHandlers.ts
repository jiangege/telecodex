import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  getScopedSession,
} from "../commandSupport.js";
import { handleUserText } from "../inputService.js";

export function registerMessageHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, codex, buffers, logger } = deps;

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

    await handleUserText({
      text,
      session,
      store,
      codex,
      buffers,
      bot,
      ...(logger ? { logger } : {}),
    });
  });
}
