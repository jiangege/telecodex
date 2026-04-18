import type { Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
  editHtmlMessage,
  isMessageNotModifiedError,
  replaceOrSendHtmlChunks,
  type TelegramMediaScope,
  sendMediaMessage,
  sendHtmlMessage,
  sendTypingAction,
  shouldFallbackToNewMessage,
} from "./delivery.js";
import type { Logger } from "../runtime/logger.js";
import {
  escapeHtml,
  renderMarkdownForTelegramContent,
  renderMarkdownToTelegramHtml,
  renderPlainChunksForTelegram,
} from "./renderer.js";
import { splitTelegramHtml } from "./splitMessage.js";

const DEFAULT_ACTIVITY_PULSE_INTERVAL_MS = 4_000;
const MAX_PENDING_EDIT_LENGTH = 3_800;
const MAX_PLAN_LINES = 6;
const MAX_PROGRESS_LINES = 6;
const MAX_REASONING_LENGTH = 600;
const MAX_TOOL_OUTPUT_LENGTH = 1_000;
const MAX_REPLY_DRAFT_LENGTH = 1_400;
type MessageBufferTimer = unknown;

export interface MessageBufferScheduler {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => MessageBufferTimer;
  clearTimeout: (timer: MessageBufferTimer) => void;
  setInterval: (callback: () => void, ms: number) => MessageBufferTimer;
  clearInterval: (timer: MessageBufferTimer) => void;
}

export interface MessageBufferOptions {
  activityPulseIntervalMs?: number;
  scheduler?: MessageBufferScheduler;
}

export interface MessageBufferCompletionOptions {
  mediaScope?: TelegramMediaScope;
  clearReplyMarkup?: boolean;
}

const defaultScheduler: MessageBufferScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

interface BufferState {
  chatId: number;
  messageThreadId: number | null;
  messageId: number;
  phase: "starting" | "running";
  replyMarkup: InlineKeyboardMarkup | null | undefined;
  text: string;
  progressLines: string[];
  planText: string;
  reasoningSummaryText: string;
  toolOutputText: string;
  timer: MessageBufferTimer | null;
  activityTimer: MessageBufferTimer | null;
  activityInFlight: boolean;
  lastSentText: string;
  queue: Promise<void>;
}

export class MessageBuffer {
  private readonly states = new Map<string, BufferState>();
  private readonly activityPulseIntervalMs: number;
  private readonly scheduler: MessageBufferScheduler;

  constructor(
    private readonly bot: Bot,
    private readonly updateIntervalMs: number,
    private readonly logger?: Logger,
    input?: MessageBufferOptions,
  ) {
    this.activityPulseIntervalMs = input?.activityPulseIntervalMs ?? DEFAULT_ACTIVITY_PULSE_INTERVAL_MS;
    this.scheduler = input?.scheduler ?? defaultScheduler;
  }

  async create(
    key: string,
    input: { chatId: number; messageThreadId: number | null; replyMarkup?: InlineKeyboardMarkup | undefined },
  ): Promise<number> {
    const previous = this.states.get(key);
    if (previous) {
      if (previous.timer) this.scheduler.clearTimeout(previous.timer);
      this.stopActivityPulse(previous);
      this.states.delete(key);
    }

    const message = await sendHtmlMessage(
      this.bot,
      {
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        text: "Starting...",
        ...(input.replyMarkup !== undefined ? { replyMarkup: input.replyMarkup } : {}),
      },
      this.logger,
    );
    const state: BufferState = {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      messageId: message.message_id,
      phase: "starting",
      replyMarkup: input.replyMarkup,
      text: "",
      progressLines: [],
      planText: "",
      reasoningSummaryText: "",
      toolOutputText: "",
      timer: null,
      activityTimer: null,
      activityInFlight: false,
      lastSentText: "",
      queue: Promise.resolve(),
    };
    this.states.set(key, state);
    this.startActivityPulse(state);
    return message.message_id;
  }

  has(key: string): boolean {
    return this.states.has(key);
  }

  setReplyDraft(key: string, text: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.text = text;
    this.scheduleFlush(key, state);
  }

  note(key: string, line: string): void {
    const state = this.states.get(key);
    if (!state) return;
    const normalized = line.trim();
    if (!normalized) return;
    const existingIndex = state.progressLines.findIndex((entry) => entry === normalized);
    if (existingIndex >= 0) {
      state.progressLines.splice(existingIndex, 1);
    }
    state.progressLines.push(normalized);
    if (state.progressLines.length > 8) {
      state.progressLines.splice(0, state.progressLines.length - 8);
    }
    this.scheduleFlush(key, state);
  }

  markTurnStarted(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.phase === "running") return;
    state.phase = "running";
    this.scheduleFlush(key, state);
  }

  setPlan(key: string, text: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.planText = text.trim();
    this.scheduleFlush(key, state);
  }

  setReasoningSummary(key: string, text: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.reasoningSummaryText = text.trim();
    this.scheduleFlush(key, state);
  }

  setToolOutput(key: string, text: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.toolOutputText = truncateTail(text.replace(/\r/g, "").trim(), 2000);
    this.scheduleFlush(key, state);
  }

  rename(from: string, to: string): void {
    const state = this.states.get(from);
    if (!state) return;
    this.states.delete(from);
    this.states.set(to, state);
  }

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.timer) {
        this.scheduler.clearTimeout(state.timer);
        state.timer = null;
      }
      this.stopActivityPulse(state);
    }
    this.states.clear();
  }

  async complete(key: string, finalMarkdown?: string, options?: MessageBufferCompletionOptions): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) this.scheduler.clearTimeout(state.timer);
    this.stopActivityPulse(state);
    await this.enqueue(state, async () => {
      const text = (finalMarkdown ?? state.text).trim();
      const rendered = text ? renderMarkdownForTelegramContent(text) : null;
      if (options?.clearReplyMarkup !== false) {
        state.replyMarkup = null;
      }
      const chunks =
        rendered?.chunks.length
          ? rendered.chunks
          : renderPlainChunksForTelegram("Codex finished, but returned no text to send.");
      await this.replaceWithChunks(state, chunks);
      if (rendered?.media.length && options?.mediaScope) {
        for (const media of rendered.media) {
          try {
            await sendMediaMessage(
              this.bot,
              {
                chatId: state.chatId,
                messageThreadId: state.messageThreadId,
                source: media.source,
                altText: media.altText,
                scope: options.mediaScope,
              },
              this.logger,
            );
          } catch (error) {
            this.logger?.warn("telegram media send failed", {
              chatId: state.chatId,
              messageThreadId: state.messageThreadId,
              source: media.source,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else if (rendered?.media.length) {
        this.logger?.warn("telegram media send skipped because no media scope was provided", {
          chatId: state.chatId,
          messageThreadId: state.messageThreadId,
          mediaCount: rendered.media.length,
        });
      }
      this.states.delete(key);
    });
  }

  async fail(key: string, message: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) this.scheduler.clearTimeout(state.timer);
    this.stopActivityPulse(state);
    await this.enqueue(state, async () => {
      state.replyMarkup = null;
      await this.replaceWithChunks(state, renderPlainChunksForTelegram(`Codex error: ${message}`));
      this.states.delete(key);
    });
  }

  private async flush(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    await this.enqueue(state, async () => {
      const latest = this.states.get(key);
      if (!latest) return;
      const text = composePendingHtml(latest);
      if (text === latest.lastSentText) return;
      await this.safeEdit(latest, text);
    });
  }

  private scheduleFlush(key: string, state: BufferState): void {
    if (state.timer) return;
    state.timer = this.scheduler.setTimeout(() => {
      state.timer = null;
      void this.flush(key);
    }, this.updateIntervalMs);
  }

  private async safeEdit(state: BufferState, text: string): Promise<void> {
    try {
      await editHtmlMessage(this.bot, {
        chatId: state.chatId,
        messageId: state.messageId,
        text,
        ...(state.replyMarkup !== undefined ? { replyMarkup: state.replyMarkup } : {}),
      }, this.logger);
      state.lastSentText = text;
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        state.lastSentText = text;
        return;
      }
      if (shouldFallbackToNewMessage(error)) {
        const message = await sendHtmlMessage(
          this.bot,
          {
            chatId: state.chatId,
            messageThreadId: state.messageThreadId,
            text,
            ...(state.replyMarkup !== undefined ? { replyMarkup: state.replyMarkup } : {}),
          },
          this.logger,
        );
        state.messageId = message.message_id;
        state.lastSentText = text;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("telegram edit failed", {
        message,
        chatId: state.chatId,
        messageThreadId: state.messageThreadId,
        messageId: state.messageId,
      });
      process.stderr.write(`[telegram edit failed] ${message}\n`);
    }
  }

  private startActivityPulse(state: BufferState): void {
    if (state.activityTimer) return;
    void this.sendActivityPulse(state);
    const timer = this.scheduler.setInterval(() => {
      void this.sendActivityPulse(state);
    }, this.activityPulseIntervalMs);
    maybeUnref(timer);
    state.activityTimer = timer;
  }

  private stopActivityPulse(state: BufferState): void {
    if (!state.activityTimer) return;
    this.scheduler.clearInterval(state.activityTimer);
    state.activityTimer = null;
  }

  private async sendActivityPulse(state: BufferState): Promise<void> {
    if (state.activityInFlight) return;
    state.activityInFlight = true;
    try {
      await sendTypingAction(
        this.bot,
        {
          chatId: state.chatId,
          messageThreadId: state.messageThreadId,
        },
        this.logger,
      );
    } catch (error) {
      this.logger?.warn("telegram chat action failed", {
        chatId: state.chatId,
        messageThreadId: state.messageThreadId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.activityInFlight = false;
    }
  }

  private async replaceWithChunks(state: BufferState, chunks: string[]): Promise<void> {
    const messageId = await replaceOrSendHtmlChunks(
      this.bot,
      {
        chatId: state.chatId,
        messageThreadId: state.messageThreadId,
        messageId: state.messageId,
        chunks,
        ...(state.replyMarkup !== undefined ? { replyMarkup: state.replyMarkup } : {}),
      },
      this.logger,
    );
    if (messageId != null) {
      state.messageId = messageId;
    }
    const [first] = chunks;
    if (first) {
      state.lastSentText = first;
    }
  }

  private async enqueue(state: BufferState, work: () => Promise<void>): Promise<void> {
    const run = state.queue.then(work, work);
    state.queue = run.catch(() => undefined);
    await run;
  }
}

function maybeUnref(timer: MessageBufferTimer): void {
  if (typeof timer !== "object" || timer == null || !("unref" in timer)) return;
  const unref = (timer as { unref?: unknown }).unref;
  if (typeof unref === "function") {
    unref.call(timer);
  }
}

function composePendingHtml(state: BufferState): string {
  const sections = [`<b>${escapeHtml(pendingBanner(state.phase))}</b>`];

  const planSection = renderListSection("Plan", state.planText, {
    maxLines: MAX_PLAN_LINES,
  });
  if (planSection) {
    sections.push(planSection);
  }

  const reasoningSection = renderQuoteSection("Reasoning", state.reasoningSummaryText, MAX_REASONING_LENGTH);
  if (reasoningSection) {
    sections.push(reasoningSection);
  }

  const progressSection = renderListSection("Activity", state.progressLines.join("\n"), {
    maxLines: MAX_PROGRESS_LINES,
  });
  if (progressSection) {
    sections.push(progressSection);
  }

  const draftSection = renderDraftSection(state.text);
  if (draftSection) {
    sections.push(draftSection);
  }

  const toolOutputSection = renderCodeSection("Terminal", state.toolOutputText, MAX_TOOL_OUTPUT_LENGTH);
  if (toolOutputSection) {
    sections.push(toolOutputSection);
  }

  return takeFirstPendingChunk(
    sections.join("\n\n"),
    `<b>${escapeHtml(pendingBanner(state.phase))}</b>`,
  );
}

function pendingBanner(phase: BufferState["phase"]): string {
  return phase === "running" ? "Working..." : "Starting...";
}

function truncateTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

function takeFirstPendingChunk(html: string, fallback: string): string {
  return splitTelegramHtml(html, MAX_PENDING_EDIT_LENGTH)[0] ?? fallback;
}

function renderListSection(
  title: string,
  text: string,
  options: {
    maxLines: number;
  },
): string | null {
  const lines = normalizeMultiline(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, options.maxLines);
  if (lines.length === 0) return null;

  return `<b>${escapeHtml(title)}</b>\n${lines.map((line) => `- ${escapeHtml(line)}`).join("\n")}`;
}

function renderQuoteSection(title: string, text: string, maxLength: number): string | null {
  const normalized = truncatePreview(normalizeMultiline(text), maxLength);
  if (!normalized) return null;
  return `<b>${escapeHtml(title)}</b>\n<blockquote>${escapeHtml(normalized)}</blockquote>`;
}

function renderCodeSection(title: string, text: string, maxLength: number): string | null {
  const normalized = truncatePreview(normalizeMultiline(text), maxLength);
  if (!normalized) return null;
  return `<b>${escapeHtml(title)}</b>\n<pre><code>${escapeHtml(normalized)}</code></pre>`;
}

function renderDraftSection(text: string): string | null {
  const normalized = truncatePreview(normalizeMultiline(text), MAX_REPLY_DRAFT_LENGTH);
  if (!normalized) return null;

  return [
    `<b>Reply Draft</b>`,
    takeFirstPendingChunk(renderMarkdownToTelegramHtml(normalized), escapeHtml(normalized)),
  ].join("\n");
}

function normalizeMultiline(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function truncatePreview(text: string, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
