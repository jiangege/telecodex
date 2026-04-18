import path from "node:path";
import { GrammyError, HttpError, InputFile, type Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { assertProjectScopedFile } from "../pathScope.js";
import type { Logger } from "../runtime/logger.js";
import { renderPlainChunksForTelegram, renderPlainForTelegram } from "./renderer.js";
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

export interface TelegramDeliveryRuntime {
  sleep: (ms: number) => Promise<void>;
}

export interface TelegramMediaMessageInput {
  chatId: number;
  messageThreadId: number | null;
  source: string;
  altText?: string | null;
  scope: TelegramMediaScope;
}

export interface TelegramMediaScope {
  projectRoot: string;
  workingDirectory?: string | null;
}

export interface TelegramReplyMarkupInput {
  replyMarkup?: InlineKeyboardMarkup | null | undefined;
}

function telegramReplyMarkup(replyMarkup: InlineKeyboardMarkup | null | undefined): { reply_markup?: InlineKeyboardMarkup } {
  if (replyMarkup === undefined) return {};
  if (replyMarkup === null) {
    return {
      reply_markup: { inline_keyboard: [] },
    };
  }
  return {
    reply_markup: replyMarkup,
  };
}

const defaultDeliveryRuntime: TelegramDeliveryRuntime = {
  sleep,
};

export async function sendHtmlMessage(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null; text: string } & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<{ message_id: number }> {
  return retryTelegramCall(
    bot.api,
    () =>
      bot.api.sendMessage(input.chatId, input.text, {
        ...(input.messageThreadId == null ? {} : { message_thread_id: input.messageThreadId }),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...telegramReplyMarkup(input.replyMarkup),
      }),
    logger,
    "telegram send retry scheduled",
    {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
    },
    {
      runtime,
    },
  );
}

export async function sendHtmlChunks(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null; text: string } & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<Array<{ message_id: number }>> {
  const messages: Array<{ message_id: number }> = [];
  for (const chunk of splitTelegramHtml(input.text)) {
    messages.push(await sendHtmlMessage(bot, { ...input, text: chunk }, logger, runtime));
  }
  return messages;
}

export async function sendPlainChunks(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null; text: string } & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<Array<{ message_id: number }>> {
  const messages: Array<{ message_id: number }> = [];
  for (const chunk of renderPlainChunksForTelegram(input.text)) {
    messages.push(await sendHtmlMessage(bot, { ...input, text: chunk }, logger, runtime));
  }
  return messages;
}

export async function sendMediaMessage(
  bot: Bot,
  input: TelegramMediaMessageInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<{ message_id: number }> {
  const attachment = new InputFile(resolveProjectScopedImagePath(input.source, input.scope));
  const options = {
    ...(input.messageThreadId == null ? {} : { message_thread_id: input.messageThreadId }),
    ...captionOptions(input.altText),
  };

  return retryTelegramCall(
    bot.api,
    () => bot.api.sendPhoto(input.chatId, attachment, options),
    logger,
    "telegram media retry scheduled",
    {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      source: input.source,
      projectRoot: input.scope.projectRoot,
    },
    {
      runtime,
    },
  );
}

export async function sendTypingAction(
  bot: Bot,
  input: { chatId: number; messageThreadId: number | null },
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
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
      runtime,
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
  } & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
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
            ...(input.replyMarkup !== undefined ? { replyMarkup: input.replyMarkup } : {}),
          },
          logger,
          runtime,
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
          ...(input.replyMarkup !== undefined ? { replyMarkup: input.replyMarkup } : {}),
        },
        logger,
        runtime,
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
      runtime,
    );
  }

  return firstMessageId ?? null;
}

export async function editHtmlMessage(
  bot: Bot,
  input: { chatId: number; messageId: number; text: string } & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<void> {
  await retryTelegramCall(
    bot.api,
    () =>
      bot.api.editMessageText(input.chatId, input.messageId, input.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...telegramReplyMarkup(input.replyMarkup),
      }),
    logger,
    "telegram edit retry scheduled",
    {
      chatId: input.chatId,
      messageId: input.messageId,
    },
    {
      allowNetworkRetry: true,
      runtime,
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

const PROJECT_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function resolveProjectScopedImagePath(source: string, scope: TelegramMediaScope): string {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("Media source cannot be empty.");
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("file://")) {
    throw new Error("Only project-scoped local image paths are allowed.");
  }

  const baseDirectory = scope.workingDirectory?.trim() ? path.resolve(scope.workingDirectory) : path.resolve(scope.projectRoot);
  const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDirectory, trimmed);
  const filePath = assertProjectScopedFile(candidate, scope.projectRoot);
  const extension = path.extname(filePath).toLowerCase();
  if (!PROJECT_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Only project-scoped image files can be sent: ${trimmed}`);
  }
  return filePath;
}

function captionOptions(altText: string | null | undefined): { caption?: string; parse_mode?: "HTML" } {
  const normalized = altText?.trim();
  if (!normalized) return {};
  return {
    caption: renderPlainForTelegram(truncateCaption(normalized)),
    parse_mode: "HTML",
  };
}

function truncateCaption(value: string): string {
  return value.length <= 1024 ? value : `${value.slice(0, 1021)}...`;
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
  context: Record<string, unknown>,
  options?: {
    allowNetworkRetry?: boolean;
    runtime?: TelegramDeliveryRuntime;
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
      await applyTelegramCooldown(cooldownKey, retry.delayMs, options?.runtime ?? defaultDeliveryRuntime);
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

async function applyTelegramCooldown(
  cooldownKey: object,
  delayMs: number,
  runtime: TelegramDeliveryRuntime,
): Promise<void> {
  const state = getTelegramCooldownState(cooldownKey);
  const previous = state.cooldown;
  const baseCooldown = previous
    ? previous.then(() => runtime.sleep(delayMs))
    : runtime.sleep(delayMs);
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
