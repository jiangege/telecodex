import type { Bot } from "grammy";
import {
  editHtmlMessage,
  isMessageNotModifiedError,
  replaceOrSendHtmlChunks,
  sendHtmlMessage,
  sendTypingAction,
  shouldFallbackToNewMessage,
} from "./delivery.js";
import type { Logger } from "../runtime/logger.js";
import { renderMarkdownForTelegram, renderPlainChunksForTelegram, renderPlainForTelegram } from "./renderer.js";

const DEFAULT_ACTIVITY_PULSE_INTERVAL_MS = 4_000;
const DEFAULT_ACTIVITY_IDLE_MS = 60_000;
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
  activityIdleMs?: number;
  scheduler?: MessageBufferScheduler;
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
  text: string;
  progressLines: string[];
  planText: string;
  reasoningSummaryText: string;
  toolOutputText: string;
  timer: MessageBufferTimer | null;
  activityTimer: MessageBufferTimer | null;
  activityInFlight: boolean;
  lastActivityAt: number;
  lastSentText: string;
  queue: Promise<void>;
}

export class MessageBuffer {
  private readonly states = new Map<string, BufferState>();
  private readonly activityPulseIntervalMs: number;
  private readonly activityIdleMs: number;
  private readonly scheduler: MessageBufferScheduler;

  constructor(
    private readonly bot: Bot,
    private readonly updateIntervalMs: number,
    private readonly logger?: Logger,
    input?: MessageBufferOptions,
  ) {
    this.activityPulseIntervalMs = input?.activityPulseIntervalMs ?? DEFAULT_ACTIVITY_PULSE_INTERVAL_MS;
    this.activityIdleMs = input?.activityIdleMs ?? DEFAULT_ACTIVITY_IDLE_MS;
    this.scheduler = input?.scheduler ?? defaultScheduler;
  }

  async create(key: string, input: { chatId: number; messageThreadId: number | null }): Promise<number> {
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
        text: "Starting Codex...",
      },
      this.logger,
    );
    const state: BufferState = {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      messageId: message.message_id,
      phase: "starting",
      text: "",
      progressLines: [],
      planText: "",
      reasoningSummaryText: "",
      toolOutputText: "",
      timer: null,
      activityTimer: null,
      activityInFlight: false,
      lastActivityAt: this.scheduler.now(),
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
    this.touchActivity(state);
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
    this.touchActivity(state);
    this.scheduleFlush(key, state);
  }

  markTurnStarted(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.phase === "running") return;
    state.phase = "running";
    this.touchActivity(state);
    this.scheduleFlush(key, state);
  }

  setPlan(key: string, text: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.planText = text.trim();
    this.touchActivity(state);
    this.scheduleFlush(key, state);
  }

  setReasoningSummary(key: string, text: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.reasoningSummaryText = text.trim();
    this.touchActivity(state);
    this.scheduleFlush(key, state);
  }

  setToolOutput(key: string, text: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.toolOutputText = truncateTail(text.replace(/\r/g, "").trim(), 2000);
    this.touchActivity(state);
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

  async complete(key: string, finalMarkdown?: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) this.scheduler.clearTimeout(state.timer);
    this.stopActivityPulse(state);
    await this.enqueue(state, async () => {
      const text = (finalMarkdown ?? state.text).trim();
      const chunks = text
        ? renderMarkdownForTelegram(text)
        : renderPlainChunksForTelegram("Codex finished, but returned no text to send.");
      await this.replaceWithChunks(state, chunks);
      this.states.delete(key);
    });
  }

  async fail(key: string, message: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) this.scheduler.clearTimeout(state.timer);
    this.stopActivityPulse(state);
    await this.enqueue(state, async () => {
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
      const text = renderPlainForTelegram(truncateForEdit(composePendingText(latest), latest.phase));
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
    if (this.scheduler.now() - state.lastActivityAt >= this.activityIdleMs) {
      this.stopActivityPulse(state);
      return;
    }
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

  private touchActivity(state: BufferState): void {
    state.lastActivityAt = this.scheduler.now();
    if (!state.activityTimer) {
      this.startActivityPulse(state);
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

function truncateForEdit(text: string, phase: BufferState["phase"]): string {
  if (text.length <= 3800) return text || pendingBanner(phase);
  return `${text.slice(0, 3800)}\n\n...`;
}

function composePendingText(state: BufferState): string {
  const sections = [pendingBanner(state.phase)];

  if (state.planText) {
    sections.push(`[Plan]\n${state.planText}`);
  }

  const reasoningSummary = state.reasoningSummaryText.trim();
  if (reasoningSummary) {
    sections.push(`[Reasoning Summary]\n${reasoningSummary}`);
  }

  if (state.progressLines.length > 0) {
    sections.push(`[Progress]\n${state.progressLines.join("\n")}`);
  }

  const toolOutput = state.toolOutputText.trim();
  if (toolOutput) {
    sections.push(`[Tool Output]\n${toolOutput}`);
  }

  const replyDraft = state.text.trim();
  if (replyDraft) {
    sections.push(`[Draft Reply]\n${replyDraft}`);
  }

  return sections.join("\n\n");
}

function pendingBanner(phase: BufferState["phase"]): string {
  return phase === "running" ? "Codex is working..." : "Starting Codex...";
}

function truncateTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}
