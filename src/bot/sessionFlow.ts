import type { Bot } from "grammy";
import {
  isSessionApprovalPolicy,
  isSessionReasoningEffort,
  type SessionApprovalPolicy,
  type SessionReasoningEffort,
  type SessionSandboxMode,
} from "../config.js";
import type { SandboxPolicy } from "../generated/codex-app-server/v2/SandboxPolicy.js";
import type { ThreadItem } from "../generated/codex-app-server/v2/ThreadItem.js";
import type { Logger } from "../runtime/logger.js";
import { projectSessionRuntimeState } from "../runtime/sessionRuntime.js";
import type { SessionStore, TelegramSession } from "../store/sessions.js";
import type { MessageBuffer } from "../telegram/messageBuffer.js";

export function turnBufferKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

export function sessionPendingBufferKey(sessionKey: string): string {
  return `pending:${sessionKey}`;
}

export function resolveTurnBufferKey(buffers: MessageBuffer, threadId: string, turnId: string): string {
  const exact = turnBufferKey(threadId, turnId);
  if (buffers.has(exact)) return exact;
  return turnBufferKey(threadId, "pending");
}

export function formatIsoTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
  });
}

export function formatCodexErrorDetail(
  message: string | null | undefined,
  additionalDetails: string | null | undefined,
): string | null {
  const normalizedMessage = message?.trim() || null;
  const normalizedDetails = additionalDetails?.trim() || null;
  if (normalizedMessage && normalizedDetails) {
    return `${normalizedMessage}: ${normalizedDetails}`;
  }
  return normalizedMessage ?? normalizedDetails;
}

export function truncateSingleLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatTurnPlan(
  explanation: string | null,
  plan: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>,
): string {
  const lines: string[] = [];
  if (explanation?.trim()) {
    lines.push(truncateSingleLine(explanation, 120));
  }
  for (const item of plan.slice(0, 6)) {
    lines.push(`${planStatusLabel(item.status)} ${truncateSingleLine(item.step, 100)}`);
  }
  return lines.join("\n");
}

export function formatStartedItemNote(item: ThreadItem): string | null {
  switch (item.type) {
    case "commandExecution":
      return `命令: ${truncateSingleLine(item.command, 120)}`;
    case "mcpToolCall":
      return `MCP: ${item.server}/${item.tool}`;
    case "dynamicToolCall":
      return `工具: ${item.tool}`;
    case "webSearch":
      return `搜索: ${truncateSingleLine(item.query, 120)}`;
    case "fileChange":
      return "正在应用文件修改";
    default:
      return null;
  }
}

export function formatCompletedItemNote(item: ThreadItem): string | null {
  switch (item.type) {
    case "commandExecution": {
      const exit = item.exitCode == null ? "" : `, exit ${item.exitCode}`;
      const prefix =
        item.status === "failed" ? "命令失败" : item.status === "declined" ? "命令被拒绝" : "命令完成";
      return `${prefix}: ${truncateSingleLine(item.command, 100)}${exit}`;
    }
    case "mcpToolCall":
      return item.error ? `MCP失败: ${item.server}/${item.tool}` : `MCP完成: ${item.server}/${item.tool}`;
    case "dynamicToolCall":
      return item.success === false ? `工具失败: ${item.tool}` : `工具完成: ${item.tool}`;
    case "webSearch":
      return `搜索完成: ${truncateSingleLine(item.query, 120)}`;
    case "fileChange":
      if (item.status === "failed") return `文件修改失败: ${item.changes.length} 项`;
      if (item.status === "declined") return `文件修改被拒绝: ${item.changes.length} 项`;
      return `文件修改完成: ${item.changes.length} 项`;
    default:
      return null;
  }
}

export function formatGuardianReviewNote(prefix: string, status: string, rationale: string | null): string {
  const reason = rationale?.trim() ? `: ${truncateSingleLine(rationale, 100)}` : "";
  return `${prefix}: ${status}${reason}`;
}

export async function refreshTopicStatusPin(
  bot: Bot,
  store: SessionStore,
  session: TelegramSession,
  logger?: Logger,
): Promise<TelegramSession> {
  return (
    (await projectSessionRuntimeState(bot, store, session.sessionKey, logger)) ??
    (store.get(session.sessionKey) ?? session)
  );
}

export function syncSessionFromCodexRuntime(
  store: SessionStore,
  sessionKey: string,
  runtime: {
    cwd?: string;
    model?: string;
    sandbox?: SandboxPolicy;
    approvalPolicy?: unknown;
    reasoningEffort?: SessionReasoningEffort | null;
  },
): TelegramSession | null {
  const patch: {
    cwd?: string;
    model?: string;
    sandboxMode?: SessionSandboxMode;
    approvalPolicy?: SessionApprovalPolicy;
    reasoningEffort?: SessionReasoningEffort | null;
  } = {};

  if (typeof runtime.cwd === "string") {
    patch.cwd = runtime.cwd;
  }
  if (typeof runtime.model === "string") {
    patch.model = runtime.model;
  }
  if (runtime.sandbox) {
    patch.sandboxMode = sandboxModeFromPolicy(runtime.sandbox);
  }

  const approvalPolicy = coerceSessionApprovalPolicy(runtime.approvalPolicy);
  if (approvalPolicy) {
    patch.approvalPolicy = approvalPolicy;
  }

  if (
    runtime.reasoningEffort === null ||
    (typeof runtime.reasoningEffort === "string" && isSessionReasoningEffort(runtime.reasoningEffort))
  ) {
    patch.reasoningEffort = runtime.reasoningEffort;
  }

  if (Object.keys(patch).length > 0) {
    store.syncRuntimeConfig(sessionKey, patch);
  }

  return store.get(sessionKey);
}

export function sessionLogFields(session: TelegramSession): Record<string, string | null> {
  return {
    sessionKey: session.sessionKey,
    chatId: session.chatId,
    messageThreadId: session.messageThreadId,
    cwd: session.cwd,
    model: session.model,
    sandboxMode: session.sandboxMode,
    approvalPolicy: session.approvalPolicy,
    reasoningEffort: session.reasoningEffort,
    runtimeStatus: session.runtimeStatus,
    runtimeStatusDetail: session.runtimeStatusDetail,
    codexThreadId: session.codexThreadId,
    activeTurnId: session.activeTurnId,
  };
}

export function isSessionBusy(session: TelegramSession): boolean {
  return (
    session.activeTurnId != null ||
    session.runtimeStatus === "preparing" ||
    session.runtimeStatus === "running" ||
    session.runtimeStatus === "waiting_approval" ||
    session.runtimeStatus === "waiting_input" ||
    session.runtimeStatus === "recovering"
  );
}

export function describeBusyStatus(status: TelegramSession["runtimeStatus"]): string {
  switch (status) {
    case "preparing":
      return "准备中";
    case "running":
      return "运行中";
    case "waiting_approval":
      return "等待批准";
    case "waiting_input":
      return "等待输入";
    case "recovering":
      return "恢复中";
    default:
      return "处理中";
  }
}

export function shouldHeartbeatSession(session: TelegramSession, nowIso: string): boolean {
  if (!isSessionBusy(session)) return false;
  const updatedAt = Date.parse(session.runtimeStatusUpdatedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(updatedAt) || Number.isNaN(now)) return true;
  return now - updatedAt >= 60_000;
}

function planStatusLabel(status: "pending" | "inProgress" | "completed"): string {
  switch (status) {
    case "completed":
      return "[完成]";
    case "inProgress":
      return "[进行中]";
    case "pending":
      return "[待办]";
  }
}

function sandboxModeFromPolicy(policy: SandboxPolicy): SessionSandboxMode {
  switch (policy.type) {
    case "dangerFullAccess":
      return "danger-full-access";
    case "workspaceWrite":
      return "workspace-write";
    case "readOnly":
    case "externalSandbox":
      return "read-only";
  }
}

function coerceSessionApprovalPolicy(value: unknown): SessionApprovalPolicy | undefined {
  return typeof value === "string" && isSessionApprovalPolicy(value) ? value : undefined;
}
