import type { PendingInteraction, SessionStore, TelegramSession } from "../store/sessions.js";

export type SessionInputTarget = "new_turn" | "queue" | "approval" | "user_input" | "tty";

export interface ActiveBlocker {
  target: SessionInputTarget;
  interaction: PendingInteraction;
  summary: string;
  consumesPlainText: boolean;
}

export interface SessionInputState {
  target: SessionInputTarget;
  summary: string;
  activeBlocker: ActiveBlocker | null;
  pendingBlockers: number;
}

export function getSessionInputState(store: SessionStore, session: TelegramSession): SessionInputState {
  const interactions = store.listPendingInteractionsForSession(session.sessionKey);
  const activeBlocker = interactions.length > 0 ? mapInteractionToBlocker(interactions[0]!) : null;

  if (activeBlocker) {
    return {
      target: activeBlocker.target,
      summary: describeTarget(activeBlocker.target, activeBlocker.summary),
      activeBlocker,
      pendingBlockers: Math.max(0, interactions.length - 1),
    };
  }

  if (
    session.activeTurnId != null ||
    session.runtimeStatus === "preparing" ||
    session.runtimeStatus === "running" ||
    session.runtimeStatus === "recovering" ||
    session.runtimeStatus === "waiting_approval" ||
    session.runtimeStatus === "waiting_input"
  ) {
    return {
      target: "queue",
      summary: "普通文本会进入队列",
      activeBlocker: null,
      pendingBlockers: 0,
    };
  }

  return {
    target: "new_turn",
    summary: "普通文本会启动新任务",
    activeBlocker: null,
    pendingBlockers: 0,
  };
}

export function formatInputTargetForStatus(state: SessionInputState): string {
  switch (state.target) {
    case "new_turn":
      return "new_turn";
    case "queue":
      return "queue";
    case "approval":
      return "approval";
    case "user_input":
      return "user_input";
    case "tty":
      return "tty";
  }
}

export function formatActiveBlockerSummary(state: SessionInputState): string {
  if (!state.activeBlocker) return "无";
  return truncateSingleLine(state.activeBlocker.summary, 80);
}

function mapInteractionToBlocker(interaction: PendingInteraction): ActiveBlocker {
  switch (interaction.kind) {
    case "approval":
      return {
        target: "approval",
        interaction,
        summary: summarizeApproval(interaction.requestJson),
        consumesPlainText: false,
      };
    case "permissions":
      return {
        target: "approval",
        interaction,
        summary: summarizePermissions(interaction.requestJson),
        consumesPlainText: false,
      };
    case "mcp_elicitation_url":
      return {
        target: "approval",
        interaction,
        summary: summarizeMcpUrl(interaction.requestJson),
        consumesPlainText: false,
      };
    case "tool_user_input":
      return {
        target: "user_input",
        interaction,
        summary: summarizeToolInput(interaction.requestJson),
        consumesPlainText: true,
      };
    case "mcp_elicitation_form":
      return {
        target: "user_input",
        interaction,
        summary: summarizeMcpForm(interaction.requestJson),
        consumesPlainText: true,
      };
    case "terminal_stdin":
      return {
        target: "tty",
        interaction,
        summary: summarizeTerminal(interaction.requestJson),
        consumesPlainText: true,
      };
  }
}

function describeTarget(target: SessionInputTarget, summary: string): string {
  switch (target) {
    case "new_turn":
      return "普通文本会启动新任务";
    case "queue":
      return "普通文本会进入队列";
    case "approval":
      return `当前等你点按钮处理: ${summary}；普通文本会进入队列`;
    case "user_input":
      return `下一条普通文本会作为回答提交: ${summary}`;
    case "tty":
      return `下一条普通文本会写入终端 stdin: ${summary}`;
  }
}

function summarizeApproval(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return "审批";
  const command = getString(parsed, "params.command");
  const reason = getString(parsed, "params.reason");
  return truncateSingleLine(command ?? reason ?? "审批", 80);
}

function summarizePermissions(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return "额外权限";
  const reason = getString(parsed, "params.reason");
  return truncateSingleLine(reason ?? "额外权限", 80);
}

function summarizeToolInput(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return "需要补充输入";
  const header = getString(parsed, "params.questions.0.header");
  const question = getString(parsed, "params.questions.0.question");
  return truncateSingleLine(header ?? question ?? "需要补充输入", 80);
}

function summarizeMcpForm(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return "MCP 表单";
  const message = getString(parsed, "params.message");
  const server = getString(parsed, "params.serverName");
  return truncateSingleLine(message ?? server ?? "MCP 表单", 80);
}

function summarizeMcpUrl(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return "MCP 外部步骤";
  const server = getString(parsed, "params.serverName");
  const message = getString(parsed, "params.message");
  return truncateSingleLine(message ?? server ?? "MCP 外部步骤", 80);
}

function summarizeTerminal(raw: string): string {
  const parsed = parseJson(raw);
  if (!parsed) return "终端输入";
  const stdin = getString(parsed, "stdin");
  return truncateSingleLine(stdin ?? "终端输入", 80);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getString(value: unknown, path: string): string | null {
  const current = path.split(".").reduce<unknown>((acc, part) => {
    if (acc == null || typeof acc !== "object") return undefined;
    if (Array.isArray(acc)) {
      const index = Number(part);
      return Number.isInteger(index) ? acc[index] : undefined;
    }
    return (acc as Record<string, unknown>)[part];
  }, value);
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function truncateSingleLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
