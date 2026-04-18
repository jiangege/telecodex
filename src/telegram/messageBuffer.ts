import type { Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
  editTextMessage,
  isMessageNotModifiedError,
  replaceOrSendTextChunks,
  type TelegramMediaScope,
  sendMediaMessage,
  sendTextChunks,
  sendTextMessage,
  sendTypingAction,
  shouldFallbackToNewMessage,
  splitRenderedText,
} from "./delivery.js";
import type { Logger } from "../runtime/logger.js";
import {
  renderMarkdownToTelegramMessage,
  renderMarkdownToTelegramSemanticDoc,
  renderPlainForTelegram,
  renderTelegramSemanticText,
} from "./renderer.js";
import {
  type RenderedTelegramText,
  type TelegramBlock,
  type TelegramListItem,
  semanticDoc,
  semanticHeading,
  semanticParagraph,
  semanticText,
} from "./semantic.js";

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
  lastSentSignature: string;
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

    const startingMessage = renderPendingMessage("starting");
    const message = await sendTextMessage(
      this.bot,
      {
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        message: startingMessage,
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
      lastSentSignature: signatureOf(startingMessage, input.replyMarkup),
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
    state.toolOutputText = truncateTail(text.replace(/\r/g, "").trim(), 2_000);
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
      const rendered = text ? renderMarkdownToTelegramMessage(text) : { body: null, media: [] };
      if (options?.clearReplyMarkup !== false) {
        state.replyMarkup = null;
      }

      const body = rendered.body ?? renderPlainForTelegram("Codex finished, but returned no text to send.");
      await this.replaceWithChunks(state, splitRenderedText(body));

      for (const media of rendered.media) {
        if (!options?.mediaScope) {
          this.logger?.warn("telegram media send skipped because no media scope was provided", {
            chatId: state.chatId,
            messageThreadId: state.messageThreadId,
            source: media.source,
          });
          if (media.fallback) {
            await sendTextChunks(
              this.bot,
              {
                chatId: state.chatId,
                messageThreadId: state.messageThreadId,
                message: media.fallback,
              },
              this.logger,
            );
          }
          continue;
        }

        try {
          await sendMediaMessage(
            this.bot,
            {
              chatId: state.chatId,
              messageThreadId: state.messageThreadId,
              source: media.source,
              ...(media.caption ? { caption: media.caption } : {}),
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
          if (media.fallback) {
            await sendTextChunks(
              this.bot,
              {
                chatId: state.chatId,
                messageThreadId: state.messageThreadId,
                message: media.fallback,
              },
              this.logger,
            );
          }
        }
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
      await this.replaceWithChunks(state, [renderPlainForTelegram(`Codex error: ${message}`)]);
      this.states.delete(key);
    });
  }

  private async flush(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    await this.enqueue(state, async () => {
      const latest = this.states.get(key);
      if (!latest) return;
      const message = composePendingMessage(latest);
      const signature = signatureOf(message, latest.replyMarkup);
      if (signature === latest.lastSentSignature) return;
      await this.safeEdit(latest, message);
    });
  }

  private scheduleFlush(key: string, state: BufferState): void {
    if (state.timer) return;
    state.timer = this.scheduler.setTimeout(() => {
      state.timer = null;
      void this.flush(key);
    }, this.updateIntervalMs);
  }

  private async safeEdit(state: BufferState, message: RenderedTelegramText): Promise<void> {
    try {
      await editTextMessage(
        this.bot,
        {
          chatId: state.chatId,
          messageId: state.messageId,
          message,
          ...(state.replyMarkup !== undefined ? { replyMarkup: state.replyMarkup } : {}),
        },
        this.logger,
      );
      state.lastSentSignature = signatureOf(message, state.replyMarkup);
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        state.lastSentSignature = signatureOf(message, state.replyMarkup);
        return;
      }
      if (shouldFallbackToNewMessage(error)) {
        const sent = await sendTextMessage(
          this.bot,
          {
            chatId: state.chatId,
            messageThreadId: state.messageThreadId,
            message,
            ...(state.replyMarkup !== undefined ? { replyMarkup: state.replyMarkup } : {}),
          },
          this.logger,
        );
        state.messageId = sent.message_id;
        state.lastSentSignature = signatureOf(message, state.replyMarkup);
        return;
      }
      const failure = error instanceof Error ? error.message : String(error);
      this.logger?.warn("telegram edit failed", {
        message: failure,
        chatId: state.chatId,
        messageThreadId: state.messageThreadId,
        messageId: state.messageId,
      });
      process.stderr.write(`[telegram edit failed] ${failure}\n`);
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

  private async replaceWithChunks(state: BufferState, chunks: RenderedTelegramText[]): Promise<void> {
    const messageId = await replaceOrSendTextChunks(
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
      state.lastSentSignature = signatureOf(first, state.replyMarkup);
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

function renderPendingMessage(phase: BufferState["phase"]): RenderedTelegramText {
  return renderTelegramSemanticText(semanticDoc([semanticHeading(pendingBanner(phase))])) ?? renderPlainForTelegram(pendingBanner(phase));
}

function composePendingMessage(state: BufferState): RenderedTelegramText {
  const blocks: TelegramBlock[] = [semanticHeading(pendingBanner(state.phase))];

  const planBlocks = renderListSection("Plan", state.planText, {
    maxLines: MAX_PLAN_LINES,
    interpretTaskState: true,
  });
  if (planBlocks.length > 0) {
    blocks.push(...planBlocks);
  }

  const reasoningBlocks = renderQuoteSection("Reasoning", state.reasoningSummaryText, MAX_REASONING_LENGTH);
  if (reasoningBlocks.length > 0) {
    blocks.push(...reasoningBlocks);
  }

  const progressBlocks = renderListSection("Activity", state.progressLines.join("\n"), {
    maxLines: MAX_PROGRESS_LINES,
  });
  if (progressBlocks.length > 0) {
    blocks.push(...progressBlocks);
  }

  const draftBlocks = renderDraftSection(state.text);
  if (draftBlocks.length > 0) {
    blocks.push(...draftBlocks);
  }

  const toolBlocks = renderCodeSection("Terminal", state.toolOutputText, MAX_TOOL_OUTPUT_LENGTH);
  if (toolBlocks.length > 0) {
    blocks.push(...toolBlocks);
  }

  return takeFirstPendingChunk(renderTelegramSemanticText(semanticDoc(blocks)) ?? renderPendingMessage(state.phase));
}

function pendingBanner(phase: BufferState["phase"]): string {
  return phase === "running" ? "Working..." : "Starting...";
}

function signatureOf(message: RenderedTelegramText, replyMarkup: InlineKeyboardMarkup | null | undefined): string {
  return JSON.stringify({
    text: message.text,
    entities: message.entities ?? [],
    replyMarkup,
  });
}

function truncateTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

function takeFirstPendingChunk(message: RenderedTelegramText): RenderedTelegramText {
  return splitRenderedText(message, MAX_PENDING_EDIT_LENGTH)[0] ?? renderPlainForTelegram("Working...");
}

function renderListSection(
  title: string,
  text: string,
  options: {
    maxLines: number;
    interpretTaskState?: boolean;
  },
): TelegramBlock[] {
  const lines = normalizeMultiline(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, options.maxLines);
  if (lines.length === 0) return [];

  const items = lines.map((line): TelegramListItem => {
    const parsed = options.interpretTaskState ? parseTaskLine(line) : null;
    if (parsed) return parsed;
    return {
      kind: "bullet",
      depth: 0,
      content: [semanticText(line)],
    };
  });

  return [
    semanticHeading(title, 2),
    {
      type: "list",
      items,
    },
  ];
}

function parseTaskLine(line: string): TelegramListItem | null {
  const match = line.match(/^\[(todo|doing|done|blocked)\]\s+(.*)$/i);
  if (!match) return null;
  const state = match[1]?.toLowerCase();
  const content = match[2] ?? "";
  if (!state || content.length === 0) return null;
  return {
    kind: "task",
    depth: 0,
    state: state as NonNullable<TelegramListItem["state"]>,
    content: [semanticText(content)],
  };
}

function renderQuoteSection(title: string, text: string, maxLength: number): TelegramBlock[] {
  const normalized = truncatePreview(normalizeMultiline(text), maxLength);
  if (!normalized) return [];
  return [
    semanticHeading(title, 2),
    {
      type: "quote",
      blocks: [semanticParagraph(normalized)],
    },
  ];
}

function renderCodeSection(title: string, text: string, maxLength: number): TelegramBlock[] {
  const normalized = truncatePreview(normalizeMultiline(text), maxLength);
  if (!normalized) return [];
  return [
    semanticHeading(title, 2),
    {
      type: "code_block",
      code: normalized,
    },
  ];
}

function renderDraftSection(text: string): TelegramBlock[] {
  const normalized = truncatePreview(normalizeMultiline(text), MAX_REPLY_DRAFT_LENGTH);
  if (!normalized) return [];

  return [
    semanticHeading("Reply Draft", 2),
    ...renderMarkdownToTelegramSemanticDoc(normalized).blocks,
  ];
}

function normalizeMultiline(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function truncatePreview(text: string, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
