import { GrammyError, HttpError, type Context } from "grammy";
import type { Logger } from "../runtime/logger.js";
import { replyError } from "../telegram/formatted.js";
import { contextLogFields } from "./commandSupport.js";

type UserFacingHandler<TContext extends Context = Context> = (ctx: TContext) => Promise<void>;

export function wrapUserFacingHandler<TContext extends Context>(
  handlerName: string,
  logger: Logger | undefined,
  handler: UserFacingHandler<TContext>,
): UserFacingHandler<TContext> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (error) {
      logger?.error("telegram handler failed", {
        handler: handlerName,
        ...contextLogFields(ctx),
        error,
      });
      await safeReplyError(ctx, describeUserFacingError(error), logger, handlerName, error);
    }
  };
}

async function safeReplyError(
  ctx: Context,
  message: string,
  logger: Logger | undefined,
  handlerName: string,
  originalError: unknown,
): Promise<void> {
  try {
    await replyError(ctx, message);
  } catch (replyFailure) {
    logger?.error("failed to send telegram handler error reply", {
      handler: handlerName,
      ...contextLogFields(ctx),
      error: replyFailure,
      originalError,
    });
  }
}

function describeUserFacingError(error: unknown): string {
  if (error instanceof GrammyError) {
    return describeTelegramError(error);
  }
  if (error instanceof HttpError) {
    return "Telegram request failed before it reached the API. Check the local network and try again.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function describeTelegramError(error: GrammyError): string {
  const description = error.description || error.message;
  const normalized = description.toLowerCase();

  if (error.method === "createForumTopic") {
    if (normalized.includes("not enough rights")) {
      return "Telegram rejected topic creation because the bot lacks permission to create topics. Promote the bot to admin and grant topic management, then try again.";
    }
    if (
      normalized.includes("forum is disabled") ||
      normalized.includes("chat is not a forum") ||
      normalized.includes("topics are not enabled")
    ) {
      return "This supergroup does not currently allow forum topics. Enable topics for the group and try again.";
    }
    return `Failed to create the Telegram topic: ${description}`;
  }

  return description;
}
