import type { TelegramSession } from "../store/sessions.js";

export function sessionBufferKey(sessionKey: string): string {
  return `session:${sessionKey}`;
}

export function formatIsoTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    hour12: false,
  });
}

export function truncateSingleLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
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
  return session.runtimeStatus === "preparing" || session.runtimeStatus === "running" || session.activeTurnId != null;
}

export function describeBusyStatus(status: TelegramSession["runtimeStatus"]): string {
  switch (status) {
    case "preparing":
      return "准备中";
    case "running":
      return "运行中";
    case "failed":
      return "故障后恢复中";
    default:
      return "处理中";
  }
}
