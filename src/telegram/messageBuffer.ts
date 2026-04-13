import type { Bot } from "grammy";
import { renderMarkdownForTelegram, renderPlainForTelegram } from "./renderer.js";

interface BufferState {
  chatId: number;
  messageThreadId: number | null;
  messageId: number;
  text: string;
  timer: NodeJS.Timeout | null;
  lastSentText: string;
}

export class MessageBuffer {
  private readonly states = new Map<string, BufferState>();

  constructor(
    private readonly bot: Bot,
    private readonly updateIntervalMs: number,
  ) {}

  async create(key: string, input: { chatId: number; messageThreadId: number | null }): Promise<number> {
    const message = await this.bot.api.sendMessage(input.chatId, "Codex 正在处理...", {
      ...(input.messageThreadId == null ? {} : { message_thread_id: input.messageThreadId }),
    });
    this.states.set(key, {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      messageId: message.message_id,
      text: "",
      timer: null,
      lastSentText: "",
    });
    return message.message_id;
  }

  append(key: string, delta: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.text += delta;
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flush(key);
    }, this.updateIntervalMs);
  }

  rename(from: string, to: string): void {
    const state = this.states.get(from);
    if (!state) return;
    this.states.delete(from);
    this.states.set(to, state);
  }

  async complete(key: string, finalMarkdown?: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    const text = finalMarkdown ?? state.text;
    const chunks = renderMarkdownForTelegram(text);
    const [first, ...rest] = chunks;
    if (first) {
      await this.safeEdit(state, first);
    }
    for (const chunk of rest) {
      await this.bot.api.sendMessage(state.chatId, chunk, {
        ...(state.messageThreadId == null ? {} : { message_thread_id: state.messageThreadId }),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
    this.states.delete(key);
  }

  async fail(key: string, message: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    await this.safeEdit(state, renderPlainForTelegram(`Codex 出错：${message}`));
    this.states.delete(key);
  }

  private async flush(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    const text = renderPlainForTelegram(truncateForEdit(state.text));
    if (text === state.lastSentText) return;
    await this.safeEdit(state, text);
  }

  private async safeEdit(state: BufferState, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(state.chatId, state.messageId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      state.lastSentText = text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("message is not modified")) {
        process.stderr.write(`[telegram edit failed] ${message}\n`);
      }
    }
  }
}

function truncateForEdit(text: string): string {
  if (text.length <= 3800) return text || "Codex 正在处理...";
  return `${text.slice(0, 3800)}\n\n...`;
}
