import { InlineKeyboard } from "grammy";
import type { PendingInteractionKind } from "../store/sessions.js";
import { escapeHtml } from "../telegram/renderer.js";
import {
  type ApprovalDecision,
  type ApprovalLikeRequest,
  type McpFormRequest,
  type McpUrlRequest,
  type PermissionsRequest,
  type SupportedServerRequest,
  type ToolUserInputRequest,
  interactionRuntimeDetail,
  isApprovalLikeRequest,
  requestItemId,
  requestThreadId,
  requestTurnId,
} from "./approvalProtocol.js";
import { approvalLabel, getSingleFieldAnswerOptions, getSingleQuestionOptions, mcpActionLabel, truncate } from "./approvalShared.js";

export interface InteractionPresentation {
  kind: PendingInteractionKind;
  text: string;
  keyboard: InlineKeyboard | null;
  runtimeEvent:
    | { type: "turn.waitingApproval"; turnId?: string | null; detail?: string | null }
    | { type: "turn.waitingInput"; turnId?: string | null; detail?: string | null };
}

export function buildPresentation(request: SupportedServerRequest, interactionId: string): InteractionPresentation {
  if (isApprovalLikeRequest(request)) {
    return {
      kind: request.method === "item/permissions/requestApproval" ? "permissions" : "approval",
      text: formatApprovalLikeText(request),
      keyboard: buildDecisionKeyboard(interactionId, availableApprovalDecisions(request)),
      runtimeEvent: {
        type: "turn.waitingApproval",
        turnId: requestTurnId(request),
        detail: interactionRuntimeDetail(request),
      },
    };
  }

  if (request.method === "item/tool/requestUserInput") {
    const singleChoice = getSingleQuestionOptions(request);
    return {
      kind: "tool_user_input",
      text: formatToolUserInputText(request),
      keyboard: singleChoice
        ? buildAnswerKeyboard(
            interactionId,
            singleChoice.options.map((option) => option.label),
            singleChoice.allowOther,
          )
        : buildActionKeyboard(interactionId, ["cancel"]),
      runtimeEvent: {
        type: "turn.waitingInput",
        turnId: requestTurnId(request),
        detail: interactionRuntimeDetail(request),
      },
    };
  }

  if (request.method === "mcpServer/elicitation/request" && request.params.mode === "url") {
    const urlRequest = request as McpUrlRequest;
    return {
      kind: "mcp_elicitation_url",
      text: formatMcpUrlText(urlRequest),
      keyboard: buildActionKeyboard(interactionId, ["accept", "decline", "cancel"]),
      runtimeEvent: {
        type: "turn.waitingInput",
        turnId: requestTurnId(urlRequest),
        detail: interactionRuntimeDetail(urlRequest),
      },
    };
  }

  const formRequest = request as McpFormRequest;
  const singleField = getSingleFieldAnswerOptions(formRequest);
  return {
    kind: "mcp_elicitation_form",
    text: formatMcpFormText(formRequest),
    keyboard: singleField ? buildAnswerKeyboard(interactionId, singleField, false) : buildActionKeyboard(interactionId, ["cancel"]),
    runtimeEvent: {
      type: "turn.waitingInput",
      turnId: requestTurnId(formRequest),
      detail: interactionRuntimeDetail(formRequest),
    },
  };
}

function buildDecisionKeyboard(interactionId: string, decisions: ApprovalDecision[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  decisions.forEach((decision, index) => {
    keyboard.text(approvalLabel(decision), `approval:${interactionId}:${decision}`);
    if (index % 2 === 1 && index < decisions.length - 1) {
      keyboard.row();
    }
  });
  return keyboard;
}

function buildActionKeyboard(
  interactionId: string,
  actions: Array<"accept" | "decline" | "cancel">,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  actions.forEach((action, index) => {
    keyboard.text(mcpActionLabel(action), `interaction:${interactionId}:action:${action}`);
    if (index % 2 === 1 && index < actions.length - 1) {
      keyboard.row();
    }
  });
  return keyboard;
}

function buildAnswerKeyboard(interactionId: string, labels: string[], allowOther: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  labels.forEach((label, index) => {
    keyboard.text(truncate(label, 28), `interaction:${interactionId}:answer:${index}`);
    keyboard.row();
  });
  void allowOther;
  keyboard.text("取消", `interaction:${interactionId}:action:cancel`);
  return keyboard;
}

function availableApprovalDecisions(request: SupportedServerRequest): ApprovalDecision[] {
  if (request.method === "item/fileChange/requestApproval" || request.method === "applyPatchApproval") {
    return ["accept", "acceptForSession", "decline", "cancel"];
  }
  if (request.method === "execCommandApproval" || request.method === "item/permissions/requestApproval") {
    return ["accept", "acceptForSession", "decline", "cancel"];
  }
  if (request.method !== "item/commandExecution/requestApproval") {
    return ["decline"];
  }
  const available = request.params.availableDecisions;
  if (!available) return ["accept", "acceptForSession", "decline", "cancel"];
  const ordered: ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];
  const set = new Set(available.filter((value): value is ApprovalDecision => typeof value === "string"));
  const filtered = ordered.filter((value) => set.has(value));
  return filtered.length > 0 ? filtered : ["decline"];
}

function formatApprovalLikeText(request: ApprovalLikeRequest): string {
  const common = formatCommonContext(request);

  if (request.method === "item/commandExecution/requestApproval") {
    const lines = [
      "<b>Codex 请求执行命令</b>",
      common,
      request.params.cwd ? `<b>CWD:</b> <code>${escapeHtml(request.params.cwd)}</code>` : null,
      request.params.reason ? `<b>原因:</b> ${escapeHtml(request.params.reason)}` : null,
      request.params.networkApprovalContext
        ? `<b>网络:</b> ${escapeHtml(`${request.params.networkApprovalContext.protocol}://${request.params.networkApprovalContext.host}`)}`
        : null,
      "",
      `<pre><code>${escapeHtml(request.params.command ?? "(managed command approval)")}</code></pre>`,
    ];
    return lines.filter(Boolean).join("\n");
  }

  if (request.method === "execCommandApproval") {
    return [
      "<b>Codex 请求执行命令</b>",
      common,
      `<b>CWD:</b> <code>${escapeHtml(request.params.cwd)}</code>`,
      request.params.reason ? `<b>原因:</b> ${escapeHtml(request.params.reason)}` : null,
      "",
      `<pre><code>${escapeHtml(request.params.command.join(" "))}</code></pre>`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (request.method === "item/fileChange/requestApproval") {
    return [
      "<b>Codex 请求修改文件</b>",
      common,
      request.params.grantRoot ? `<b>写入范围:</b> <code>${escapeHtml(request.params.grantRoot)}</code>` : null,
      request.params.reason ? `<b>原因:</b> ${escapeHtml(request.params.reason)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (request.method === "applyPatchApproval") {
    const files = Object.keys(request.params.fileChanges);
    return [
      "<b>Codex 请求修改文件</b>",
      common,
      request.params.grantRoot ? `<b>写入范围:</b> <code>${escapeHtml(request.params.grantRoot)}</code>` : null,
      request.params.reason ? `<b>原因:</b> ${escapeHtml(request.params.reason)}` : null,
      `<b>文件数:</b> ${files.length}`,
      files.length > 0 ? `<b>文件:</b>\n${formatBulletList(files)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "<b>Codex 请求额外权限</b>",
    common,
    request.params.reason ? `<b>原因:</b> ${escapeHtml(request.params.reason)}` : null,
    formatPermissionSummary(request),
  ]
    .filter(Boolean)
    .join("\n");
}

function formatToolUserInputText(request: ToolUserInputRequest): string {
  const questions = request.params.questions.map((question, index) => {
    const options =
      question.options && question.options.length > 0
        ? `\n选项:\n${question.options
            .map((option) => `• ${escapeHtml(option.label)}${option.description ? ` - ${escapeHtml(option.description)}` : ""}`)
            .join("\n")}`
        : "";
    const flags = [question.isOther ? "允许自定义" : null, question.isSecret ? "敏感输入" : null]
      .filter(Boolean)
      .join(" / ");
    return [
      `<b>${index + 1}. ${escapeHtml(question.header)}</b>`,
      escapeHtml(question.question),
      flags ? `<i>${escapeHtml(flags)}</i>` : null,
      options,
      `回复键: <code>${escapeHtml(question.id)}</code>`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return ["<b>Codex 需要你补充输入</b>", formatCommonContext(request), ...questions, "", toolUserInputReplyInstructions(request)].join(
    "\n\n",
  );
}

function formatMcpUrlText(request: McpUrlRequest): string {
  return [
    "<b>MCP 需要你继续完成一个外部步骤</b>",
    formatCommonContext(request),
    `<b>server:</b> <code>${escapeHtml(request.params.serverName)}</code>`,
    escapeHtml(request.params.message),
    `<b>打开链接:</b> ${escapeHtml(request.params.url)}`,
    "完成后点“接受”，如果不继续就点“拒绝”或“取消”。",
  ].join("\n\n");
}

function formatMcpFormText(request: McpFormRequest): string {
  const fields = Object.entries(request.params.requestedSchema.properties).map(([name, schema], index) =>
    [
      `<b>${index + 1}. ${escapeHtml(((schema as Record<string, unknown>).title as string | undefined) ?? name)}</b>`,
      (schema as Record<string, unknown>).description
        ? escapeHtml((schema as Record<string, unknown>).description as string)
        : null,
      `<i>字段键: ${escapeHtml(name)}</i>`,
      formatSchemaHint(schema as Record<string, unknown>),
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return [
    "<b>MCP 需要你补充表单信息</b>",
    formatCommonContext(request),
    `<b>server:</b> <code>${escapeHtml(request.params.serverName)}</code>`,
    escapeHtml(request.params.message),
    ...fields,
    "",
    mcpFormReplyInstructions(request),
  ].join("\n\n");
}

function toolUserInputReplyInstructions(request: ToolUserInputRequest): string {
  if (request.params.questions.length === 1) {
    const question = request.params.questions[0]!;
    if (question.options && question.options.length > 0 && !question.isOther) {
      return "直接点按钮，或者直接回复选项文字。";
    }
    return `直接回复答案，或者用 <code>${escapeHtml(question.id)}: 你的答案</code>。`;
  }
  return [
    "按下面格式逐行回复：",
    ...request.params.questions.map((question) => `<code>${escapeHtml(question.id)}: 你的答案</code>`),
    "多选用英文逗号分隔。",
  ].join("\n");
}

function mcpFormReplyInstructions(request: McpFormRequest): string {
  if (getSingleFieldAnswerOptions(request)) {
    return "直接点按钮，或者按字段键回复。";
  }
  return [
    "按下面格式逐行回复：",
    ...Object.keys(request.params.requestedSchema.properties).map((key) => `<code>${escapeHtml(key)}: 值</code>`),
    "多选用英文逗号分隔。",
  ].join("\n");
}

function formatPermissionSummary(request: PermissionsRequest): string {
  const lines: string[] = [];
  if (request.params.permissions.network) {
    lines.push(`<b>network:</b> ${request.params.permissions.network.enabled ? "enabled" : "disabled"}`);
  }
  if (request.params.permissions.fileSystem?.read?.length) {
    lines.push(`<b>read:</b>\n${formatBulletList(request.params.permissions.fileSystem.read)}`);
  }
  if (request.params.permissions.fileSystem?.write?.length) {
    lines.push(`<b>write:</b>\n${formatBulletList(request.params.permissions.fileSystem.write)}`);
  }
  return lines.join("\n");
}

function formatCommonContext(request: SupportedServerRequest): string {
  const lines = [
    requestThreadId(request) ? `<b>thread:</b> <code>${escapeHtml(requestThreadId(request)!)}</code>` : null,
    requestTurnId(request) ? `<b>turn:</b> <code>${escapeHtml(requestTurnId(request)!)}</code>` : null,
    requestItemId(request) ? `<b>item:</b> <code>${escapeHtml(requestItemId(request)!)}</code>` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function formatSchemaHint(schema: Record<string, unknown>): string | null {
  if (schema.type === "boolean") return "类型: boolean，可回复 true/false。";
  if (schema.type === "number" || schema.type === "integer") return `类型: ${schema.type}`;
  if (schema.type === "string" && Array.isArray(schema.enum)) {
    return `选项: ${(schema.enum as string[]).map(escapeHtml).join(", ")}`;
  }
  if (schema.type === "string" && Array.isArray(schema.oneOf)) {
    return `选项: ${(schema.oneOf as Array<{ const: string }>).map((item) => escapeHtml(item.const)).join(", ")}`;
  }
  if (schema.type === "array" && schema.items && typeof schema.items === "object") {
    const options = Array.isArray((schema.items as { enum?: string[] }).enum)
      ? ((schema.items as { enum: string[] }).enum ?? [])
      : Array.isArray((schema.items as { anyOf?: Array<{ const: string }> }).anyOf)
        ? (((schema.items as { anyOf: Array<{ const: string }> }).anyOf ?? []).map((item) => item.const))
        : [];
    return options.length > 0 ? `多选: ${options.map(escapeHtml).join(", ")}` : "类型: array";
  }
  return schema.type ? `类型: ${String(schema.type)}` : null;
}

function formatBulletList(items: string[], limit = 5): string {
  const visible = items.slice(0, limit).map((item) => `• <code>${escapeHtml(item)}</code>`);
  if (items.length > limit) {
    visible.push(`• 还有 ${items.length - limit} 项`);
  }
  return visible.join("\n");
}
