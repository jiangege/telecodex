import { GrammyError, type Bot } from "grammy";
import type { Logger } from "../runtime/logger.js";
import { renderPlainChunksForTelegram } from "./renderer.js";
import { splitTelegramHtml } from "./splitMessage.js";

const telegramCooldownByClient = new WeakMap<object, TelegramCooldownState>();

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
    "telegram send rate limited",
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
    "telegram chat action rate limited",
    {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
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
    "telegram edit rate limited",
    {
      chatId: input.chatId,
      messageId: input.messageId,
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

function descriptionOf(error: GrammyError): string | null {
  return typeof error.description === "string" ? error.description : null;
}

export async function retryTelegramCall<T>(
  cooldownKey: object,
  operation: () => Promise<T>,
  logger: Logger | undefined,
  message: string,
  context: Record<string, number | null>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    await waitForTelegramCooldown(cooldownKey);
    try {
      return await operation();
    } catch (error) {
      const waitMs = retryAfterMs(error);
      if (waitMs == null || attempt >= 5) {
        throw error;
      }
      const cooldownMs = waitMs + 250;
      logger?.warn(message, {
        ...context,
        attempt: attempt + 1,
        retryAfterMs: waitMs,
        sharedCooldownMs: cooldownMs,
        error,
      });
      await applyTelegramCooldown(cooldownKey, cooldownMs);
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
