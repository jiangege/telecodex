import crypto from "node:crypto";
import type { Bot, Context } from "grammy";
import type { ServerRequest } from "../generated/codex-app-server/index.js";
import { applySessionRuntimeEvent } from "../runtime/sessionRuntime.js";
import type { Logger } from "../runtime/logger.js";
import { makeSessionKey, type PendingInteraction, type SessionStore } from "../store/sessions.js";
import { escapeHtml } from "../telegram/renderer.js";
import type { CodexGateway } from "./CodexGateway.js";
import { buildPresentation } from "./approvalPresentation.js";
import {
  isSupportedServerRequest,
  parseCallbackAction,
  parseStoredRequest,
  requestThreadId,
  type SupportedServerRequest,
} from "./approvalProtocol.js";
import { parseInteractionTextReply, REJECT_RESPONSE, resolveCallbackResult } from "./approvalResolution.js";

export class ApprovalManager {
  constructor(
    private readonly bot: Bot,
    private readonly gateway: CodexGateway,
    private readonly sessions: SessionStore,
    private readonly logger?: Logger,
  ) {}

  async handleServerRequest(request: ServerRequest): Promise<void> {
    if (!isSupportedServerRequest(request)) {
      this.gateway.reject(request.id, `telecodex does not support server request: ${request.method}`);
      return;
    }

    const threadId = requestThreadId(request);
    const session = threadId ? this.sessions.getByThreadId(threadId) : null;
    if (!session) {
      this.gateway.reject(request.id, "No Telegram session is attached to this Codex thread");
      return;
    }

    const interactionId = crypto.randomBytes(6).toString("hex");
    const presentation = buildPresentation(request, interactionId);

    await applySessionRuntimeEvent({
      bot: this.bot,
      store: this.sessions,
      sessionKey: session.sessionKey,
      event: presentation.runtimeEvent,
      logger: this.logger,
    });

    this.sessions.putPendingInteraction({
      interactionId,
      sessionKey: session.sessionKey,
      kind: presentation.kind,
      requestJson: JSON.stringify(request),
      messageId: null,
    });

    try {
      const message = await this.bot.api.sendMessage(Number(session.chatId), presentation.text, {
        ...(session.messageThreadId == null ? {} : { message_thread_id: Number(session.messageThreadId) }),
        parse_mode: "HTML",
        ...(presentation.keyboard ? { reply_markup: presentation.keyboard } : {}),
      });
      this.sessions.setPendingInteractionMessage(interactionId, message.message_id);
    } catch (error) {
      this.sessions.removePendingInteraction(interactionId);
      this.logger?.error("failed to deliver telegram interaction prompt", {
        sessionKey: session.sessionKey,
        threadId,
        requestId: request.id,
        method: request.method,
        error,
      });
      this.gateway.reject(request.id, "Failed to deliver Telegram interaction prompt");
    }
  }

  async handleCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    if (!data) return false;

    const action = parseCallbackAction(data);
    if (!action) return false;

    const interaction = this.sessions.getPendingInteraction(action.interactionId);
    if (!interaction) {
      await ctx.answerCallbackQuery({ text: "这个交互已经失效" });
      return true;
    }

    const request = parseStoredRequest(interaction);
    if (!request) {
      this.sessions.removePendingInteraction(interaction.interactionId);
      await ctx.answerCallbackQuery({ text: "这个交互已经失效" });
      return true;
    }

    const result = resolveCallbackResult(interaction, request, action);
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: result.message });
      return true;
    }

    this.finishInteraction(interaction, request, result.appendedText, result.response);
    await ctx.answerCallbackQuery({ text: result.answerText });
    return true;
  }

  async handleTextReply(ctx: Context): Promise<boolean> {
    const text = ctx.message?.text?.trim();
    const chatId = ctx.chat?.id;
    const messageThreadId = ctx.message?.message_thread_id ?? null;
    if (!text || chatId == null || messageThreadId == null) return false;

    const sessionKey = makeSessionKey(chatId, messageThreadId);
    const interaction = this.sessions.getOldestPendingInteractionForSession(sessionKey, [
      "tool_user_input",
      "mcp_elicitation_form",
    ]);
    if (!interaction) return false;

    const request = parseStoredRequest(interaction);
    if (!request) {
      this.sessions.removePendingInteraction(interaction.interactionId);
      await ctx.reply("这个待处理交互已经失效，请重新触发。");
      return true;
    }

    const result = parseInteractionTextReply(interaction, request, text);
    if (!result.ok) {
      await ctx.reply(result.message);
      return true;
    }

    this.finishInteraction(interaction, request, result.appendedText, result.response);
    await ctx.reply("已提交给 Codex，等待继续处理。");
    return true;
  }

  private finishInteraction(
    interaction: PendingInteraction,
    request: SupportedServerRequest,
    appendedText: string,
    response: unknown,
  ): void {
    try {
      if (response === REJECT_RESPONSE) {
        this.gateway.reject(request.id, appendedText);
      } else {
        this.gateway.respond(request.id, response);
      }
    } finally {
      this.sessions.removePendingInteraction(interaction.interactionId);
      void this.appendInteractionResult(interaction, request, appendedText);
    }
  }

  private async appendInteractionResult(
    interaction: PendingInteraction,
    request: SupportedServerRequest,
    appendedText: string,
  ): Promise<void> {
    const session = this.sessions.get(interaction.sessionKey);
    if (!session || interaction.messageId == null) return;

    try {
      await this.bot.api.editMessageText(
        Number(session.chatId),
        interaction.messageId,
        `${buildPresentation(request, interaction.interactionId).text}\n\n<b>已处理：</b>${escapeHtml(appendedText)}`,
        { parse_mode: "HTML" },
      );
    } catch (error) {
      this.logger?.debug("failed to append interaction result to telegram prompt", {
        sessionKey: interaction.sessionKey,
        interactionId: interaction.interactionId,
        error,
      });
    }
  }
}
