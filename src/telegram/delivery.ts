import path from "node:path";
import { GrammyError, HttpError, InputFile, type Bot } from "grammy";
import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import { assertProjectScopedFile } from "../pathScope.js";
import type { Logger } from "../runtime/logger.js";
import type { RenderedTelegramCaption, RenderedTelegramText } from "./semantic.js";
import { TELEGRAM_SAFE_TEXT_LIMIT } from "./splitMessage.js";

const telegramCooldownByClient = new WeakMap<object, TelegramCooldownState>();
const MAX_TELEGRAM_RETRY_ATTEMPTS = 5;
const TELEGRAM_NETWORK_RETRY_BASE_MS = 100;
const TELEGRAM_NETWORK_RETRY_MAX_MS = 1_000;
const TELEGRAM_CAPTION_LIMIT = 1_024;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface TelegramDeliveryRuntime {
  sleep: (ms: number) => Promise<void>;
}

export interface TelegramMediaMessageInput {
  chatId: number;
  messageThreadId: number | null;
  source: string;
  caption?: RenderedTelegramCaption | null;
  scope: TelegramMediaScope;
}

export interface TelegramMediaScope {
  projectRoot: string;
  workingDirectory?: string | null;
}

export interface TelegramReplyMarkupInput {
  replyMarkup?: InlineKeyboardMarkup | null | undefined;
}

export interface TelegramTextMessageInput {
  chatId: number;
  messageThreadId: number | null;
  message: RenderedTelegramText;
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

export async function sendTextMessage(
  bot: Bot,
  input: TelegramTextMessageInput & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<{ message_id: number }> {
  return retryTelegramCall(
    bot.api,
    () =>
      bot.api.sendMessage(input.chatId, input.message.text, {
        ...(input.messageThreadId == null ? {} : { message_thread_id: input.messageThreadId }),
        ...textMessageOptions(input.message, input.replyMarkup),
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

export async function sendTextChunks(
  bot: Bot,
  input: TelegramTextMessageInput & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<Array<{ message_id: number }>> {
  const messages: Array<{ message_id: number }> = [];
  const [first, ...rest] = splitRenderedText(input.message);

  if (first) {
    messages.push(await sendTextMessage(bot, { ...input, message: first }, logger, runtime));
  }
  for (const chunk of rest) {
    messages.push(await sendTextMessage(bot, { ...input, message: chunk }, logger, runtime));
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
    ...captionOptions(input.caption),
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

export async function replaceOrSendTextChunks(
  bot: Bot,
  input: {
    chatId: number;
    messageThreadId: number | null;
    messageId: number | null;
    chunks: RenderedTelegramText[];
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
        await editTextMessage(
          bot,
          {
            chatId: input.chatId,
            messageId: input.messageId,
            message: first,
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
      const message = await sendTextMessage(
        bot,
        {
          chatId: input.chatId,
          messageThreadId: input.messageThreadId,
          message: first,
          ...(input.replyMarkup !== undefined ? { replyMarkup: input.replyMarkup } : {}),
        },
        logger,
        runtime,
      );
      firstMessageId = message.message_id;
    }
  }

  for (const chunk of rest) {
    await sendTextMessage(
      bot,
      {
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        message: chunk,
      },
      logger,
      runtime,
    );
  }

  return firstMessageId ?? null;
}

export async function editTextMessage(
  bot: Bot,
  input: { chatId: number; messageId: number; message: RenderedTelegramText } & TelegramReplyMarkupInput,
  logger?: Logger,
  runtime: TelegramDeliveryRuntime = defaultDeliveryRuntime,
): Promise<void> {
  await retryTelegramCall(
    bot.api,
    () =>
      bot.api.editMessageText(input.chatId, input.messageId, input.message.text, {
        ...textMessageOptions(input.message, input.replyMarkup),
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

export function splitRenderedText(message: RenderedTelegramText, limit = TELEGRAM_SAFE_TEXT_LIMIT): RenderedTelegramText[] {
  if (message.text.length <= limit) {
    return [message];
  }

  const chunks: RenderedTelegramText[] = [];
  let start = 0;
  while (start < message.text.length) {
    const remaining = message.text.length - start;
    const rawEnd = remaining <= limit
      ? message.text.length
      : start + chooseSplitPoint(message.text.slice(start, start + limit), limit);
    const end = normalizeChunkBoundary(message.text, start, Math.max(start + 1, rawEnd));
    chunks.push(sliceRenderedText(message, start, end));
    start = end;
  }
  return chunks;
}

export function truncateRenderedText(message: RenderedTelegramText, limit: number): RenderedTelegramText {
  if (message.text.length <= limit) {
    return message;
  }
  const [chunk] = splitRenderedText(message, limit);
  return chunk ?? sliceRenderedText(message, 0, limit);
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

function textMessageOptions(
  message: RenderedTelegramText,
  replyMarkup: InlineKeyboardMarkup | null | undefined,
): {
  entities?: MessageEntity[];
  link_preview_options: { is_disabled: true };
  reply_markup?: InlineKeyboardMarkup;
} {
  return {
    ...(message.entities && message.entities.length > 0 ? { entities: message.entities as MessageEntity[] } : {}),
    link_preview_options: { is_disabled: true },
    ...telegramReplyMarkup(replyMarkup),
  };
}

function sliceRenderedText(message: RenderedTelegramText, start: number, end: number): RenderedTelegramText {
  const text = message.text.slice(start, end);
  const entities = message.entities?.flatMap((entity) => {
    const overlapStart = Math.max(entity.offset, start);
    const overlapEnd = Math.min(entity.offset + entity.length, end);
    if (overlapStart >= overlapEnd) return [];
    return [
      {
        ...entity,
        offset: overlapStart - start,
        length: overlapEnd - overlapStart,
      },
    ];
  });

  return entities && entities.length > 0
    ? { text, entities }
    : { text };
}

function chooseSplitPoint(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const slice = text.slice(0, limit);
  const splitAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  return splitAt > limit * 0.55 ? splitAt : limit;
}

function normalizeChunkBoundary(text: string, start: number, end: number): number {
  const clamped = Math.max(start + 1, Math.min(text.length, end));
  if (clamped >= text.length) return text.length;

  const safeBackward = previousGraphemeBoundary(text, clamped);
  if (safeBackward > start) {
    return safeBackward;
  }

  const safeForward = nextGraphemeBoundary(text, clamped);
  if (safeForward > start) {
    return Math.min(text.length, safeForward);
  }

  return clamped;
}

function previousGraphemeBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;

  let previous = 0;
  for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
    if (segment.index === index) {
      return index;
    }
    if (segment.index > index) {
      return previous;
    }
    previous = segment.index;
  }

  return adjustCodePointBoundaryBackward(text, index);
}

function nextGraphemeBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;

  for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
    if (segment.index === index) {
      return index;
    }
    if (segment.index > index) {
      return segment.index;
    }
  }

  return adjustCodePointBoundaryForward(text, index);
}

function adjustCodePointBoundaryBackward(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  return isGraphemeUnsafeBoundary(text, index) ? index - 1 : index;
}

function adjustCodePointBoundaryForward(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  return isGraphemeUnsafeBoundary(text, index) ? index + 1 : index;
}

function isGraphemeUnsafeBoundary(text: string, index: number): boolean {
  return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
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

function captionOptions(caption: RenderedTelegramCaption | null | undefined): { caption?: string; caption_entities?: MessageEntity[] } {
  if (!caption) return {};
  const truncated = truncateRenderedText(
    {
      text: caption.caption,
      ...(caption.caption_entities && caption.caption_entities.length > 0 ? { entities: caption.caption_entities } : {}),
    },
    TELEGRAM_CAPTION_LIMIT,
  );
  return {
    caption: truncated.text,
    ...(truncated.entities && truncated.entities.length > 0 ? { caption_entities: truncated.entities as MessageEntity[] } : {}),
  };
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

  if (error instanceof Error) {
    return RETRYABLE_NETWORK_ERROR_CODES.has(String((error as Error & { code?: string }).code ?? ""));
  }

  if (typeof error === "object" && error != null && "code" in error) {
    return RETRYABLE_NETWORK_ERROR_CODES.has(String((error as { code?: unknown }).code ?? ""));
  }

  return false;
}

export async function retryTelegramCall<T>(
  cooldownKey: object,
  callback: () => Promise<T>,
  logger?: Logger,
  logMessage = "telegram retry scheduled",
  fields?: Record<string, unknown>,
  options?: {
    allowNetworkRetry?: boolean;
    runtime?: TelegramDeliveryRuntime;
  },
): Promise<T> {
  const runtime = options?.runtime ?? defaultDeliveryRuntime;

  for (let attempt = 0; ; attempt += 1) {
    const cooldown = telegramCooldownByClient.get(cooldownKey)?.cooldown ?? null;
    if (cooldown != null && cooldown > Date.now()) {
      await runtime.sleep(Math.max(0, cooldown - Date.now()));
    }

    try {
      return await callback();
    } catch (error) {
      const plan = retryPlan(error, attempt);
      if (!plan) throw error;
      if (plan.kind === "network" && options?.allowNetworkRetry !== true) {
        throw error;
      }
      if (attempt + 1 >= MAX_TELEGRAM_RETRY_ATTEMPTS) {
        throw error;
      }
      const waitUntil = Date.now() + plan.delayMs;
      applyBotCooldown(cooldownKey, waitUntil);
      logger?.warn(logMessage, {
        ...(fields ?? {}),
        attempt: attempt + 1,
        delayMs: plan.delayMs,
        retryKind: plan.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      await runtime.sleep(plan.delayMs);
    }
  }
}

interface TelegramCooldownState {
  cooldown: number | null;
}

function applyBotCooldown(cooldownKey: object, cooldown: number): void {
  let state = telegramCooldownByClient.get(cooldownKey);
  if (!state) {
    state = { cooldown: null };
  }
  state.cooldown = cooldown;
  telegramCooldownByClient.set(cooldownKey, state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
