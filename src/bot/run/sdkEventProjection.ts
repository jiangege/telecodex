import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadEvent,
  ThreadItem,
  TodoListItem,
  WebSearchItem,
} from "@openai/codex-sdk";
import type { Bot } from "grammy";
import { applySessionRuntimeEvent } from "../../runtime/sessionRuntime.js";
import type { Logger } from "../../runtime/logger.js";
import type { SessionStore } from "../../store/sessionStore.js";
import { MessageBuffer } from "../../telegram/messageBuffer.js";
import { truncateSingleLine } from "../sessionState.js";

export async function applyRuntimeStateForSdkEvent(input: {
  event: ThreadEvent;
  sessionKey: string;
  sessions: SessionStore;
  bot: Bot;
  logger: Logger | undefined;
}): Promise<void> {
  if (input.event.type !== "turn.started") {
    return;
  }

  const session = input.sessions.get(input.sessionKey);
  if (!session || session.runtimeStatus === "running") {
    return;
  }

  await applySessionRuntimeEvent({
    bot: input.bot,
    store: input.sessions,
    sessionKey: input.sessionKey,
    event: {
      type: "turn.started",
    },
    logger: input.logger,
  });
}

export async function projectSdkEventToTelegramBuffer(
  buffers: MessageBuffer,
  key: string,
  event: ThreadEvent,
): Promise<void> {
  switch (event.type) {
    case "thread.started":
      return;
    case "turn.started":
      buffers.markTurnStarted(key);
      return;
    case "turn.completed":
      return;
    case "item.started":
    case "item.updated":
    case "item.completed":
      projectItem(buffers, key, event.item, event.type);
      return;
    case "turn.failed":
      buffers.note(key, `Run failed: ${event.error.message}`);
      return;
    case "error":
      buffers.note(key, `Error: ${event.message}`);
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
      if (!isWorkingDraftPlaceholder(item.text)) {
        buffers.setReplyDraft(key, item.text);
      }
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
      buffers.note(key, `Error: ${truncateSingleLine(item.message, 120)}`);
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
    buffers.note(key, `Running command: ${truncateSingleLine(item.command, 120)}`);
  } else if (phase === "item.completed") {
    const exitCode = item.exit_code == null ? "?" : String(item.exit_code);
    const prefix = item.status === "failed" ? "Command failed" : "Command finished";
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
    buffers.note(key, `Preparing file changes: ${item.changes.length} entries`);
    return;
  }

  if (phase === "item.completed") {
    const prefix = item.status === "failed" ? "File changes failed" : "Applied file changes";
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
    buffers.note(key, `Calling MCP: ${item.server}/${item.tool}`);
    return;
  }

  if (phase === "item.completed") {
    buffers.note(
      key,
      item.error ? `MCP failed: ${item.server}/${item.tool}` : `MCP finished: ${item.server}/${item.tool}`,
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
    buffers.note(key, `Web search finished: ${truncateSingleLine(item.query, 120)}`);
    return;
  }
  buffers.note(key, `Searching web: ${truncateSingleLine(item.query, 120)}`);
}

function projectTodoList(buffers: MessageBuffer, key: string, item: TodoListItem): void {
  const lines = item.items
    .slice(0, 6)
    .map((entry) => `${entry.completed ? "[done]" : "[todo]"} ${truncateSingleLine(entry.text, 96)}`);
  if (lines.length > 0) {
    buffers.setPlan(key, lines.join("\n"));
  }
}

function isWorkingDraftPlaceholder(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "working" || normalized === "working..." || normalized === "working.";
}
