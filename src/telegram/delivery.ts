import { GrammyError, HttpError, type Bot } from "grammy";
import type { Logger } from "../runtime/logger.js";
import { renderPlainChunksForTelegram } from "./renderer.js";
import { splitTelegramHtml } from "./splitMessage.js";

const telegramCooldownByClient = new WeakMap<object, TelegramCooldownState>();
const MAX_TELEGRAM_RETRY_ATTEMPTS = 5;
const TELEGRAM_NETWORK_RETRY_BASE_MS = 100;
const TELEGRAM_NETWORK_RETRY_MAX_MS = 1_000;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export async function sendHtmlMessage(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null; text: string },
  logger?: Logger,
): Promise<{ message_id: number }> {
  return retryTelegramCall(
    bot.api,
    () =>
      bot.api.sendMessage(input.chatId, input.text, {
        ...(input.messageThreadId == null ? {} : { message_thread_id: input.messageThreadId }),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    logger,
    "telegram send retry scheduled",
    {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
    },
  );
}

export async function sendHtmlChunks(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null; text: string },
  logger?: Logger,
): Promise<Array<{ message_id: number }>> {
  const messages: Array<{ message_id: number }> = [];
  for (const chunk of splitTelegramHtml(input.text)) {
    messages.push(await sendHtmlMessage(bot, { ...input, text: chunk }, logger));
  }
  return messages;
}

export async function sendPlainChunks(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null; text: string },
  logger?: Logger,
): Promise<Array<{ message_id: number }>> {
  const messages: Array<{ message_id: number }> = [];
  for (const chunk of renderPlainChunksForTelegram(input.text)) {
    messages.push(await sendHtmlMessage(bot, { ...input, text: chunk }, logger));
  }
  return messages;
}

export async function sendTypingAction(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null },
  logger?: Logger,
): Promise<void> {
  await retryTelegramCall(
    bot.api,
    () =>
      bot.api.sendChatAction(input.chatId, "typing", {
        ...(input.messageThreadId == null ? {} : { message_thread_id: input.messageThreadId }),
      }),
    logger,
    "telegram chat action retry scheduled",
    {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
    },
    {
      allowNetworkRetry: true,
    },
  );
}

export async function replaceOrSendHtmlChunks(
  bot: Bot,
  input: {
    chatId: number;
    messageThreadId: number | null;
    messageId: number | null;
    chunks: string[];
  },
  logger?: Logger,
): Promise<number | null> {
  const [first, ...rest] = input.chunks;
  let firstMessageId = input.messageId;

  if (first) {
    let firstDelivered = false;
    if (input.messageId != null) {
      try {
        await editHtmlMessage(
          bot,
          {
            chatId: input.chatId,
            messageId: input.messageId,
            text: first,
          },
          logger,
        );
        firstDelivered = true;
      } catch (error) {
        if (isMessageNotModifiedError(error)) {
          firstDelivered = true;
        } else {
          logger?.warn("telegram final edit failed, falling back to send", {
            chatId: input.chatId,
            messageThreadId: input.messageThreadId,
            messageId: input.messageId,
            error,
          });
        }
      }
    }

    if (!firstDelivered) {
      const message = await sendHtmlMessage(
        bot,
        {
          chatId: input.chatId,
          messageThreadId: input.messageThreadId,
          text: first,
        },
        logger,
      );
      firstMessageId = message.message_id;
    }
  }

  for (const chunk of rest) {
    await sendHtmlMessage(
      bot,
      {
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        text: chunk,
      },
      logger,
    );
  }

  return firstMessageId ?? null;
}

export async function editHtmlMessage(
  bot: Bot,
  input: { chatId: number; messageId: number; text: string },
  logger?: Logger,
): Promise<void> {
  await retryTelegramCall(
    bot.api,
    () =>
      bot.api.editMessageText(input.chatId, input.messageId, input.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    logger,
    "telegram edit retry scheduled",
    {
      chatId: input.chatId,
      messageId: input.messageId,
    },
    {
      allowNetworkRetry: true,
    },
  );
}

export function isMessageNotModifiedError(error: unknown): boolean {
  return error instanceof GrammyError && descriptionOf(error)?.toLowerCase().includes("message is not modified") === true;
}

export function shouldFallbackToNewMessage(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const description = descriptionOf(error)?.toLowerCase();
  if (!description) return false;
  return description.includes("message to edit not found") || description.includes("message can't be edited");
}

function retryAfterMs(error: unknown): number | null {
  if (error instanceof GrammyError) {
    const retryAfter = error.parameters?.retry_after;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000;
    }
    const match = descriptionOf(error)?.match(/retry after\s+(\d+)/i);
    if (match) {
      return Number(match[1]) * 1000;
    }
  }
  return null;
}

function retryPlan(error: unknown, attempt: number): { kind: "rate-limit" | "network"; delayMs: number } | null {
  const rateLimitDelayMs = retryAfterMs(error);
  if (rateLimitDelayMs != null) {
    return {
      kind: "rate-limit",
      delayMs: rateLimitDelayMs + 250,
    };
  }

  if (isRetryableNetworkError(error)) {
    return {
      kind: "network",
      delayMs: Math.min(TELEGRAM_NETWORK_RETRY_BASE_MS * 2 ** attempt, TELEGRAM_NETWORK_RETRY_MAX_MS),
    };
  }

  return null;
}

function descriptionOf(error: GrammyError): string | null {
  return typeof error.description === "string" ? error.description : null;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  return isRetryableNetworkCause(error.error);
}

function isRetryableNetworkCause(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return false;
  }

  const code = readErrorCode(error);
  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  const message = readErrorMessage(error);
  if (!message) return false;

  return (
    message.includes("socket hang up") ||
    message.includes("connection reset") ||
    message.includes("network request failed") ||
    message.includes("fetch failed") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error == null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code ? code : null;
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  return null;
}

export async function retryTelegramCall<T>(
  cooldownKey: object,
  operation: () => Promise<T>,
  logger: Logger | undefined,
  message: string,
  context: Record<string, number | null>,
  options?: {
    allowNetworkRetry?: boolean;
  },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    await waitForTelegramCooldown(cooldownKey);
    try {
      return await operation();
    } catch (error) {
      const rateLimitDelayMs = retryAfterMs(error);
      const retry =
        options?.allowNetworkRetry === true
          ? retryPlan(error, attempt)
          : rateLimitDelayMs == null
            ? null
            : {
                kind: "rate-limit" as const,
                delayMs: rateLimitDelayMs + 250,
              };
      if (retry == null || attempt >= MAX_TELEGRAM_RETRY_ATTEMPTS) {
        throw error;
      }
      logger?.warn(message, {
        ...context,
        attempt: attempt + 1,
        retryKind: retry.kind,
        retryDelayMs: retry.delayMs,
        error,
      });
      await applyTelegramCooldown(cooldownKey, retry.delayMs);
    }
  }
}

async function waitForTelegramCooldown(cooldownKey: object): Promise<void> {
  for (;;) {
    const cooldown = telegramCooldownByClient.get(cooldownKey)?.cooldown ?? null;
    if (!cooldown) return;
    await cooldown;
  }
}

async function applyTelegramCooldown(cooldownKey: object, delayMs: number): Promise<void> {
  const state = getTelegramCooldownState(cooldownKey);
  const previous = state.cooldown;
  const baseCooldown = previous
    ? previous.then(() => sleep(delayMs))
    : sleep(delayMs);
  const cooldown = baseCooldown.finally(() => {
    if (state.cooldown === cooldown) {
      state.cooldown = null;
    }
  });
  state.cooldown = cooldown;
  await state.cooldown;
}

function getTelegramCooldownState(cooldownKey: object): TelegramCooldownState {
  let state = telegramCooldownByClient.get(cooldownKey);
  if (state) return state;
  state = {
    cooldown: null,
  };
  telegramCooldownByClient.set(cooldownKey, state);
  return state;
}

interface TelegramCooldownState {
  cooldown: Promise<void> | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
