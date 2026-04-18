import type { InlineKeyboardMarkup } from "grammy/types";

const STOP_CALLBACK_PREFIX = "stop";

export function encodeStopCallbackData(input: {
  chatId: number;
  messageThreadId: number;
}): string {
  return `${STOP_CALLBACK_PREFIX}:${input.chatId}:${input.messageThreadId}`;
}

export function decodeStopCallbackData(value: string): {
  chatId: number;
  messageThreadId: number;
} | null {
  const match = /^stop:(-?\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const chatId = Number(match[1]);
  const messageThreadId = Number(match[2]);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageThreadId)) {
    return null;
  }
  return {
    chatId,
    messageThreadId,
  };
}

export function stopInlineKeyboard(input: {
  chatId: number;
  messageThreadId: number | null;
}): InlineKeyboardMarkup | undefined {
  if (input.messageThreadId == null) return undefined;
  return {
    inline_keyboard: [[{ text: "Stop", callback_data: encodeStopCallbackData(input as { chatId: number; messageThreadId: number }) }]],
  };
}
