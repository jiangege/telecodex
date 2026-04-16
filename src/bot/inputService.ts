import type { Bot } from "grammy";
import type {
  CommandExecutionItem,
  FileChangeItem,
  Input,
  McpToolCallItem,
  ThreadEvent,
  ThreadItem,
  TodoListItem,
  WebSearchItem,
} from "@openai/codex-sdk";
import type { Logger } from "../runtime/logger.js";
import { applySessionRuntimeEvent } from "../runtime/sessionRuntime.js";
import { formatCodexErrorForUser } from "../codex/errorFormatting.js";
import { type SessionStore, type StoredCodexInput, type TelegramSession } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { sendReplyNotice } from "../telegram/formatted.js";
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
  return handleUserInput({
    prompt: input.text,
    session: input.session,
    store: input.store,
    codex: input.codex,
    buffers: input.buffers,
    bot: input.bot,
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.enqueueIfBusy == null ? {} : { enqueueIfBusy: input.enqueueIfBusy }),
  });
}

export async function handleUserInput(input: {
  prompt: StoredCodexInput;
  session: TelegramSession;
  store: SessionStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  logger?: Logger;
  enqueueIfBusy?: boolean;
}): Promise<HandleUserTextResult> {
  const { prompt, store, codex, buffers, bot, logger } = input;
  const enqueueIfBusy = input.enqueueIfBusy ?? true;
  const session = await refreshSessionIfActiveTurnIsStale(input.session, store, codex, bot, logger);

  if (isSessionBusy(session) || codex.isRunning(session.sessionKey)) {
    if (!enqueueIfBusy) {
      return {
        status: "busy",
        consumed: false,
      };
    }

    const queued = store.enqueueInput(session.sessionKey, prompt);
    const queueDepth = store.getQueuedInputCount(session.sessionKey);
    await sendReplyNotice(
      bot,
      {
        chatId: numericChatId(session),
        messageThreadId: numericMessageThreadId(session),
      },
      [
        `Codex is still ${describeBusyStatus(session.runtimeStatus)}. Your message was added to the queue.`,
        `queue position: ${queueDepth}`,
        `queued at: ${formatIsoTimestamp(queued.createdAt)}`,
        "It will be processed automatically after the current run finishes.",
      ],
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
      detail: "waiting for first Codex SDK event",
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

  void runSessionPrompt({
    sessionKey: session.sessionKey,
    prompt,
    store,
    codex,
    buffers,
    bot,
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
      message: "The previous run was lost. Send the message again.",
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
    await sendReplyNotice(
      bot,
      {
        chatId: numericChatId(refreshed),
        messageThreadId: numericMessageThreadId(refreshed),
      },
      "telecodex restarted and cannot resume the previous streamed run state. Send the message again if you want to continue.",
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
    const result = await handleUserInput({
      prompt: next.input,
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
  prompt: StoredCodexInput;
  store: SessionStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  bufferKey: string;
  logger?: Logger;
}): Promise<void> {
  const { sessionKey, prompt, store, codex, buffers, bot, bufferKey, logger } = input;
  const session = store.get(sessionKey);
  if (!session) return;

  logger?.info("starting codex sdk run", {
    ...sessionLogFields(session),
  });

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
        webSearchMode: session.webSearchMode,
        networkAccessEnabled: session.networkAccessEnabled,
        skipGitRepoCheck: session.skipGitRepoCheck,
        additionalDirectories: session.additionalDirectories,
        outputSchema: readOutputSchema(session, store, logger),
      },
      prompt: toSdkInput(prompt),
      callbacks: {
        onThreadStarted: async (threadId) => {
          store.bindThread(sessionKey, threadId);
          logger?.info("codex sdk thread started", {
            sessionKey,
            threadId,
          });
        },
        onEvent: async (event) => {
          await applyRuntimeStateForSdkEvent({
            event,
            sessionKey,
            store,
            bot,
            logger,
          });
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
        },
        logger,
      });
    }

    logger?.info("codex sdk run completed", {
      sessionKey,
      threadId: result.threadId,
    });
    await buffers.complete(bufferKey, result.finalResponse || undefined);
  } catch (error) {
    const userFacingMessage = isAbortError(error)
      ? "Current run interrupted."
      : formatCodexErrorForUser(error);
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
          }
          : {
            type: "turn.failed",
            message: userFacingMessage,
          },
        logger,
      });
    }

    logger?.warn("codex sdk run failed", {
      sessionKey,
      error,
    });
    await buffers.fail(bufferKey, userFacingMessage);
  } finally {
    await processNextQueuedInputForSession(sessionKey, store, codex, buffers, bot, logger);
  }
}

async function applyRuntimeStateForSdkEvent(input: {
  event: ThreadEvent;
  sessionKey: string;
  store: SessionStore;
  bot: Bot;
  logger: Logger | undefined;
}): Promise<void> {
  if (input.event.type !== "turn.started") {
    return;
  }

  const session = input.store.get(input.sessionKey);
  if (!session) return;
  if (session.runtimeStatus === "running") {
    return;
  }

  await applySessionRuntimeEvent({
    bot: input.bot,
    store: input.store,
    sessionKey: input.sessionKey,
    event: {
      type: "turn.started",
    },
    logger: input.logger,
  });
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
      buffers.markTurnStarted(key);
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
      buffers.note(key, `run failed: ${event.error.message}`);
      return;
    case "error":
      buffers.note(key, `error: ${event.message}`);
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
      buffers.note(key, `error: ${truncateSingleLine(item.message, 120)}`);
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
    buffers.note(key, `command: ${truncateSingleLine(item.command, 120)}`);
  } else if (phase === "item.completed") {
    const exitCode = item.exit_code == null ? "?" : String(item.exit_code);
    const prefix = item.status === "failed" ? "command failed" : "command completed";
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
    buffers.note(key, `file changes: ${item.changes.length} entries`);
    return;
  }

  if (phase === "item.completed") {
    const prefix = item.status === "failed" ? "file changes failed" : "file changes completed";
    buffers.note(key, `${prefix}: ${item.changes.length} entries`);
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
      item.error ? `MCP failed: ${item.server}/${item.tool}` : `MCP completed: ${item.server}/${item.tool}`,
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
    buffers.note(key, `web search completed: ${truncateSingleLine(item.query, 120)}`);
    return;
  }
  buffers.note(key, `web search: ${truncateSingleLine(item.query, 120)}`);
}

function projectTodoList(buffers: MessageBuffer, key: string, item: TodoListItem): void {
  const lines = item.items
    .slice(0, 6)
    .map((entry) => `${entry.completed ? "[done]" : "[todo]"} ${truncateSingleLine(entry.text, 96)}`);
  if (lines.length > 0) {
    buffers.setPlan(key, lines.join("\n"));
  }
}

function toSdkInput(input: StoredCodexInput): Input {
  return input;
}

function parseOutputSchema(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid stored output schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readOutputSchema(session: TelegramSession, store: SessionStore, logger?: Logger): unknown {
  try {
    return parseOutputSchema(session.outputSchema);
  } catch (error) {
    store.setOutputSchema(session.sessionKey, null);
    logger?.warn("cleared invalid stored output schema", {
      ...sessionLogFields(session),
      error,
    });
    return undefined;
  }
}
