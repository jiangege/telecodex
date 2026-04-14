import type { Bot } from "grammy";
import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadEvent,
  ThreadItem,
  TodoListItem,
  WebSearchItem,
} from "@openai/codex-sdk";
import type { Logger } from "../runtime/logger.js";
import { applySessionRuntimeEvent } from "../runtime/sessionRuntime.js";
import type { SessionStore, TelegramSession } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { sendPlainChunks } from "../telegram/delivery.js";
import { CodexSdkRuntime, isAbortError } from "../codex/sdkRuntime.js";
import { numericChatId, numericMessageThreadId } from "./session.js";
import {
  describeBusyStatus,
  formatIsoTimestamp,
  isSessionBusy,
  sessionBufferKey,
  sessionLogFields,
  truncateSingleLine,
} from "./sessionFlow.js";

export interface HandleUserTextResult {
  status: "started" | "queued" | "busy" | "failed";
  consumed: boolean;
}

export async function handleUserText(input: {
  text: string;
  session: TelegramSession;
  store: SessionStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  logger?: Logger;
  enqueueIfBusy?: boolean;
}): Promise<HandleUserTextResult> {
  const { text, store, codex, buffers, bot, logger } = input;
  const enqueueIfBusy = input.enqueueIfBusy ?? true;
  const session = await refreshSessionIfActiveTurnIsStale(input.session, store, codex, bot, logger);

  if (isSessionBusy(session) || codex.isRunning(session.sessionKey)) {
    if (!enqueueIfBusy) {
      return {
        status: "busy",
        consumed: false,
      };
    }

    const queued = store.enqueueInput(session.sessionKey, text);
    const queueDepth = store.getQueuedInputCount(session.sessionKey);
    await sendPlainChunks(
      bot,
      {
        chatId: numericChatId(session),
        messageThreadId: numericMessageThreadId(session),
        text: [
          `当前 Codex 任务仍在${describeBusyStatus(session.runtimeStatus)}，已把你的消息加入队列。`,
          `queue position: ${queueDepth}`,
          `queued at: ${formatIsoTimestamp(queued.createdAt)}`,
          "当前运行结束后会自动继续处理。",
        ].join("\n"),
      },
      logger,
    );
    return {
      status: "queued",
      consumed: true,
    };
  }

  await applySessionRuntimeEvent({
    bot,
    store,
    sessionKey: session.sessionKey,
    event: {
      type: "turn.preparing",
      detail: "starting codex sdk run",
    },
    logger,
  });

  const bufferKey = sessionBufferKey(session.sessionKey);
  let outputMessageId: number;
  try {
    outputMessageId = await buffers.create(bufferKey, {
      chatId: numericChatId(session),
      messageThreadId: numericMessageThreadId(session),
    });
  } catch (error) {
    store.setOutputMessage(session.sessionKey, null);
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: session.sessionKey,
      event: {
        type: "turn.failed",
        message: error instanceof Error ? error.message : String(error),
      },
      logger,
    });
    return {
      status: "failed",
      consumed: false,
    };
  }

  store.setOutputMessage(session.sessionKey, outputMessageId);
  const turnId = createLocalTurnId();
  await applySessionRuntimeEvent({
    bot,
    store,
    sessionKey: session.sessionKey,
    event: {
      type: "turn.started",
      turnId,
    },
    logger,
  });

  void runSessionPrompt({
    sessionKey: session.sessionKey,
    text,
    store,
    codex,
    buffers,
    bot,
    turnId,
    bufferKey,
    ...(logger ? { logger } : {}),
  });

  return {
    status: "started",
    consumed: true,
  };
}

export async function refreshSessionIfActiveTurnIsStale(
  session: TelegramSession,
  store: SessionStore,
  codex: CodexSdkRuntime,
  bot: Bot,
  logger?: Logger,
): Promise<TelegramSession> {
  const latest = store.get(session.sessionKey) ?? session;
  if (!isSessionBusy(latest)) return latest;
  if (codex.isRunning(latest.sessionKey)) return latest;

  store.setOutputMessage(latest.sessionKey, null);
  await applySessionRuntimeEvent({
    bot,
    store,
    sessionKey: latest.sessionKey,
    event: {
      type: "turn.failed",
      turnId: latest.activeTurnId,
      message: "上一次运行已丢失，请重新发送。",
    },
    logger,
  });

  logger?.warn("reset stale in-memory codex run state", {
    ...sessionLogFields(latest),
  });

  return store.get(latest.sessionKey) ?? latest;
}

export async function recoverActiveTopicSessions(
  store: SessionStore,
  codex: CodexSdkRuntime,
  _buffers: MessageBuffer,
  bot: Bot,
  logger?: Logger,
): Promise<void> {
  const sessions = store.listTopicSessions().filter((session) => isSessionBusy(session));
  if (sessions.length === 0) return;

  logger?.warn("recovering stale sdk-backed sessions after startup", {
    activeSessions: sessions.length,
  });

  for (const session of sessions) {
    const refreshed = await refreshSessionIfActiveTurnIsStale(session, store, codex, bot, logger);
    await sendPlainChunks(
      bot,
      {
        chatId: numericChatId(refreshed),
        messageThreadId: numericMessageThreadId(refreshed),
        text: "telecodex 重启后无法恢复上一轮流式运行状态，请重新发送需要继续的消息。",
      },
      logger,
    ).catch((error) => {
      logger?.warn("failed to notify session about stale sdk recovery", {
        ...sessionLogFields(refreshed),
        error,
      });
    });
  }
}

export async function processNextQueuedInputForSession(
  sessionKey: string,
  store: SessionStore,
  codex: CodexSdkRuntime,
  buffers: MessageBuffer,
  bot: Bot,
  logger?: Logger,
): Promise<void> {
  const session = store.get(sessionKey);
  if (!session || isSessionBusy(session) || codex.isRunning(sessionKey)) return;
  const next = store.peekNextQueuedInput(sessionKey);
  if (!next) return;

  try {
    const result = await handleUserText({
      text: next.text,
      session,
      store,
      codex,
      buffers,
      bot,
      enqueueIfBusy: false,
      ...(logger ? { logger } : {}),
    });
    if (result.consumed) {
      store.removeQueuedInput(next.id);
    }
  } catch (error) {
    logger?.warn("failed to process queued telegram input", {
      sessionKey,
      queuedInputId: next.id,
      error,
    });
  }
}

async function runSessionPrompt(input: {
  sessionKey: string;
  text: string;
  store: SessionStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  turnId: string;
  bufferKey: string;
  logger?: Logger;
}): Promise<void> {
  const { sessionKey, text, store, codex, buffers, bot, turnId, bufferKey, logger } = input;
  const session = store.get(sessionKey);
  if (!session) return;

  try {
    const result = await codex.run({
      profile: {
        sessionKey,
        threadId: session.codexThreadId,
        cwd: session.cwd,
        model: session.model,
        sandboxMode: session.sandboxMode,
        approvalPolicy: session.approvalPolicy,
        reasoningEffort: session.reasoningEffort,
      },
      prompt: text,
      callbacks: {
        onThreadStarted: async (threadId) => {
          store.bindThread(sessionKey, threadId);
        },
        onEvent: async (event) => {
          await projectEventToTelegramBuffer(buffers, bufferKey, event);
        },
      },
    });

    const latest = store.get(sessionKey);
    if (latest) {
      store.bindThread(sessionKey, result.threadId);
      store.setOutputMessage(sessionKey, null);
      await applySessionRuntimeEvent({
        bot,
        store,
        sessionKey,
        event: {
          type: "turn.completed",
          turnId,
        },
        logger,
      });
    }

    await buffers.complete(bufferKey, result.finalResponse || undefined);
  } catch (error) {
    const latest = store.get(sessionKey);
    if (latest) {
      store.setOutputMessage(sessionKey, null);
      await applySessionRuntimeEvent({
        bot,
        store,
        sessionKey,
        event: isAbortError(error)
          ? {
              type: "turn.interrupted",
              turnId,
            }
          : {
              type: "turn.failed",
              turnId,
              message: error instanceof Error ? error.message : String(error),
            },
        logger,
      });
    }

    if (isAbortError(error)) {
      await buffers.fail(bufferKey, "已中断当前运行。");
    } else {
      await buffers.fail(bufferKey, error instanceof Error ? error.message : String(error));
    }
  } finally {
    await processNextQueuedInputForSession(sessionKey, store, codex, buffers, bot, logger);
  }
}

async function projectEventToTelegramBuffer(
  buffers: MessageBuffer,
  key: string,
  event: ThreadEvent,
): Promise<void> {
  switch (event.type) {
    case "thread.started":
      buffers.note(key, `thread started: ${event.thread_id}`);
      return;
    case "turn.started":
      buffers.note(key, "开始处理");
      return;
    case "turn.completed":
      buffers.note(
        key,
        `token usage: in ${event.usage.input_tokens}, out ${event.usage.output_tokens}, cached ${event.usage.cached_input_tokens}`,
      );
      return;
    case "item.started":
    case "item.updated":
    case "item.completed":
      projectItem(buffers, key, event.item, event.type);
      return;
    case "turn.failed":
      buffers.note(key, `运行失败: ${event.error.message}`);
      return;
    case "error":
      buffers.note(key, `错误: ${event.message}`);
      return;
  }
}

function projectItem(
  buffers: MessageBuffer,
  key: string,
  item: ThreadItem,
  phase: "item.started" | "item.updated" | "item.completed",
): void {
  switch (item.type) {
    case "agent_message":
      buffers.setReplyDraft(key, item.text);
      return;
    case "reasoning":
      buffers.setReasoningSummary(key, item.text);
      return;
    case "command_execution":
      projectCommandExecution(buffers, key, item, phase);
      return;
    case "file_change":
      projectFileChange(buffers, key, item, phase);
      return;
    case "mcp_tool_call":
      projectMcpToolCall(buffers, key, item, phase);
      return;
    case "web_search":
      projectWebSearch(buffers, key, item, phase);
      return;
    case "todo_list":
      projectTodoList(buffers, key, item);
      return;
    case "error":
      buffers.note(key, `错误: ${truncateSingleLine(item.message, 120)}`);
      return;
  }
}

function projectCommandExecution(
  buffers: MessageBuffer,
  key: string,
  item: CommandExecutionItem,
  phase: "item.started" | "item.updated" | "item.completed",
): void {
  if (phase === "item.started") {
    buffers.note(key, `命令: ${truncateSingleLine(item.command, 120)}`);
  } else if (phase === "item.completed") {
    const exitCode = item.exit_code == null ? "?" : String(item.exit_code);
    const prefix = item.status === "failed" ? "命令失败" : "命令完成";
    buffers.note(key, `${prefix}: ${truncateSingleLine(item.command, 96)} (exit ${exitCode})`);
  }

  if (item.aggregated_output.trim()) {
    buffers.setToolOutput(key, item.aggregated_output);
  }
}

function projectFileChange(
  buffers: MessageBuffer,
  key: string,
  item: FileChangeItem,
  phase: "item.started" | "item.updated" | "item.completed",
): void {
  if (phase === "item.started") {
    buffers.note(key, `文件修改: ${item.changes.length} 项`);
    return;
  }

  if (phase === "item.completed") {
    const prefix = item.status === "failed" ? "文件修改失败" : "文件修改完成";
    buffers.note(key, `${prefix}: ${item.changes.length} 项`);
  }
}

function projectMcpToolCall(
  buffers: MessageBuffer,
  key: string,
  item: McpToolCallItem,
  phase: "item.started" | "item.updated" | "item.completed",
): void {
  if (phase === "item.started") {
    buffers.note(key, `MCP: ${item.server}/${item.tool}`);
    return;
  }

  if (phase === "item.completed") {
    buffers.note(
      key,
      item.error ? `MCP失败: ${item.server}/${item.tool}` : `MCP完成: ${item.server}/${item.tool}`,
    );
  }
}

function projectWebSearch(
  buffers: MessageBuffer,
  key: string,
  item: WebSearchItem,
  phase: "item.started" | "item.updated" | "item.completed",
): void {
  if (phase === "item.completed") {
    buffers.note(key, `搜索完成: ${truncateSingleLine(item.query, 120)}`);
    return;
  }
  buffers.note(key, `搜索: ${truncateSingleLine(item.query, 120)}`);
}

function projectTodoList(buffers: MessageBuffer, key: string, item: TodoListItem): void {
  const lines = item.items.slice(0, 6).map((entry) => `${entry.completed ? "[完成]" : "[待办]"} ${truncateSingleLine(entry.text, 96)}`);
  if (lines.length > 0) {
    buffers.setPlan(key, lines.join("\n"));
  }
}

function createLocalTurnId(): string {
  return `sdk-turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
