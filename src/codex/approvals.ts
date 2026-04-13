import crypto from "node:crypto";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { ServerRequest } from "../generated/codex-app-server/index.js";
import type { CommandExecutionApprovalDecision } from "../generated/codex-app-server/v2/CommandExecutionApprovalDecision.js";
import type { FileChangeApprovalDecision } from "../generated/codex-app-server/v2/FileChangeApprovalDecision.js";
import type { CodexGateway } from "./CodexGateway.js";
import { SessionStore } from "../store/sessions.js";
import { escapeHtml } from "../telegram/renderer.js";

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

interface PendingApproval {
  request: ServerRequest;
  chatId: number;
  messageId: number;
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly bot: Bot,
    private readonly gateway: CodexGateway,
    private readonly sessions: SessionStore,
  ) {}

  async handleServerRequest(request: ServerRequest): Promise<void> {
    if (
      request.method !== "item/commandExecution/requestApproval" &&
      request.method !== "item/fileChange/requestApproval"
    ) {
      this.gateway.reject(request.id, `telecodex does not support server request: ${request.method}`);
      return;
    }

    const session = this.sessions.getByThreadId(request.params.threadId);
    if (!session) {
      this.gateway.reject(request.id, "No Telegram session is attached to this Codex thread");
      return;
    }

    const approvalId = crypto.randomBytes(4).toString("hex");
    const keyboard = buildKeyboard(approvalId, availableDecisions(request));
    const text = formatApprovalText(request);
    const message = await this.bot.api.sendMessage(Number(session.chatId), text, {
      ...(session.messageThreadId == null ? {} : { message_thread_id: Number(session.messageThreadId) }),
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    this.pending.set(approvalId, {
      request,
      chatId: Number(session.chatId),
      messageId: message.message_id,
    });
  }

  async handleCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith("approval:")) return false;

    const [, approvalId, decision] = data.split(":") as [string, string, ApprovalDecision | undefined];
    const pending = this.pending.get(approvalId);
    if (!pending || !decision) {
      await ctx.answerCallbackQuery({ text: "这个审批已经失效" });
      return true;
    }

    this.pending.delete(approvalId);
    this.respond(pending.request, decision);
    await ctx.answerCallbackQuery({ text: approvalLabel(decision) });
    await this.bot.api.editMessageText(
      pending.chatId,
      pending.messageId,
      `${formatApprovalText(pending.request)}\n\n<b>已选择：</b>${escapeHtml(approvalLabel(decision))}`,
      {
        parse_mode: "HTML",
      },
    );
    return true;
  }

  private respond(request: ServerRequest, decision: ApprovalDecision): void {
    if (request.method === "item/commandExecution/requestApproval") {
      this.gateway.respond(request.id, {
        decision: decision as CommandExecutionApprovalDecision,
      });
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      this.gateway.respond(request.id, {
        decision: decision as FileChangeApprovalDecision,
      });
      return;
    }
  }
}

function buildKeyboard(approvalId: string, decisions: ApprovalDecision[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const decision of decisions) {
    keyboard.text(approvalLabel(decision), `approval:${approvalId}:${decision}`);
  }
  return keyboard;
}

function availableDecisions(request: ServerRequest): ApprovalDecision[] {
  if (request.method === "item/fileChange/requestApproval") {
    return ["accept", "acceptForSession", "decline", "cancel"];
  }

  if (request.method !== "item/commandExecution/requestApproval") {
    return ["decline"];
  }

  const available = request.params.availableDecisions;
  if (!available) return ["accept", "acceptForSession", "decline", "cancel"];

  const stringDecisions = new Set(available.filter((decision): decision is ApprovalDecision => typeof decision === "string"));
  const ordered: ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];
  const filtered = ordered.filter((decision) => stringDecisions.has(decision));
  return filtered.length > 0 ? filtered : ["decline"];
}

function approvalLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case "accept":
      return "允许一次";
    case "acceptForSession":
      return "本会话允许";
    case "decline":
      return "拒绝";
    case "cancel":
      return "取消";
  }
}

function formatApprovalText(request: ServerRequest): string {
  if (request.method === "item/commandExecution/requestApproval") {
    const command = request.params.command ?? "(network or command approval)";
    const cwd = request.params.cwd ? `\n<b>CWD:</b> <code>${escapeHtml(request.params.cwd)}</code>` : "";
    const reason = request.params.reason ? `\n<b>原因:</b> ${escapeHtml(request.params.reason)}` : "";
    return `<b>Codex 请求执行命令</b>${cwd}${reason}\n\n<pre><code>${escapeHtml(command)}</code></pre>`;
  }

  if (request.method === "item/fileChange/requestApproval") {
    const root = request.params.grantRoot ? `\n<b>写入范围:</b> <code>${escapeHtml(request.params.grantRoot)}</code>` : "";
    const reason = request.params.reason ? `\n<b>原因:</b> ${escapeHtml(request.params.reason)}` : "";
    return `<b>Codex 请求修改文件</b>${root}${reason}`;
  }

  return `<b>Codex 请求审批</b>\n<code>${escapeHtml(request.method)}</code>`;
}
