import type { Bot, Context } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { Logger } from "../runtime/logger.js";
import { sendTextChunks } from "./delivery.js";
import { renderTelegramSemanticText } from "./renderer.js";
import type { RenderedTelegramText, TelegramInline, TelegramSemanticDoc } from "./semantic.js";
import { semanticDoc, semanticParagraph, semanticText } from "./semantic.js";

export type ReplyFieldValue = string | number | boolean | null | undefined;

export interface ReplyField {
  label: string;
  value: ReplyFieldValue;
  style?: "plain" | "code";
}

export interface ReplySection {
  title?: string;
  fields?: ReplyField[];
  lines?: string[];
}

export interface ReplyDocument {
  title: string;
  fields?: ReplyField[];
  sections?: ReplySection[];
  footer?: string | string[];
}

export interface ReplyTarget {
  chatId: number;
  messageThreadId: number | null;
}

type ReplyContent = string | string[] | RenderedTelegramText;

export function textField(label: string, value: ReplyFieldValue): ReplyField {
  return {
    label,
    value,
    style: "plain",
  };
}

export function codeField(label: string, value: ReplyFieldValue): ReplyField {
  return {
    label,
    value,
    style: "code",
  };
}

export function replyDocumentToTelegramSemanticDoc(document: ReplyDocument): TelegramSemanticDoc {
  const blocks = [sectionBlock(document.title, document.fields)];

  for (const section of document.sections ?? []) {
    blocks.push(sectionBlock(section.title, section.fields, section.lines));
  }

  if (document.footer != null) {
    blocks.push(semanticParagraph(normalizeLines(document.footer).join("\n")));
  }

  return semanticDoc(blocks.filter((block) => block.content.length > 0));
}

export function renderReplyDocument(document: ReplyDocument): RenderedTelegramText {
  return renderTelegramSemanticText(replyDocumentToTelegramSemanticDoc(document)) ?? { text: " " };
}

export async function replyDocument(ctx: Context, document: ReplyDocument): Promise<void> {
  await replyFormatted(ctx, renderReplyDocument(document));
}

export async function sendReplyDocument(bot: Bot, target: ReplyTarget, document: ReplyDocument, logger?: Logger): Promise<void> {
  await sendFormatted(bot, target, renderReplyDocument(document), logger);
}

export async function replyNotice(ctx: Context, content: ReplyContent): Promise<void> {
  await replyFormatted(ctx, renderNotice(content));
}

export async function sendReplyNotice(bot: Bot, target: ReplyTarget, content: ReplyContent, logger?: Logger): Promise<void> {
  await sendFormatted(bot, target, renderNotice(content), logger);
}

export async function replyError(ctx: Context, message: string, detail?: string | string[]): Promise<void> {
  await replyNotice(ctx, detail == null ? message : [message, ...normalizeLines(detail)]);
}

export async function sendReplyError(
  bot: Bot,
  target: ReplyTarget,
  message: string,
  detail?: string | string[],
  logger?: Logger,
): Promise<void> {
  await sendReplyNotice(bot, target, detail == null ? message : [message, ...normalizeLines(detail)], logger);
}

export async function replyUsage(ctx: Context, usage: string | string[]): Promise<void> {
  await replyNotice(ctx, Array.isArray(usage) ? ["Usage:", ...usage] : `Usage: ${usage}`);
}

export async function sendReplyUsage(bot: Bot, target: ReplyTarget, usage: string | string[], logger?: Logger): Promise<void> {
  await sendReplyNotice(bot, target, Array.isArray(usage) ? ["Usage:", ...usage] : `Usage: ${usage}`, logger);
}

export async function replyFormatted(ctx: Context, message: RenderedTelegramText): Promise<void> {
  const target = targetFromContext(ctx);
  if (target && typeof ctx.api?.sendMessage === "function") {
    await sendFormattedViaApi(ctx.api, target, message);
    return;
  }
  await ctx.reply(message.text, {
    ...toMessageOptions(message),
  });
}

export async function sendFormatted(bot: Bot, target: ReplyTarget, message: RenderedTelegramText, logger?: Logger): Promise<void> {
  await sendFormattedViaApi(bot.api, target, message, logger);
}

function renderNotice(content: ReplyContent): RenderedTelegramText {
  if (typeof content === "object" && content != null && "text" in content) {
    return content;
  }
  return renderTelegramSemanticText(semanticDoc([semanticParagraph(normalizeLines(content).join("\n"))])) ?? { text: " " };
}

function toMessageOptions(message: RenderedTelegramText): {
  entities?: MessageEntity[];
  link_preview_options: { is_disabled: true };
} {
  return {
    ...(message.entities && message.entities.length > 0 ? { entities: message.entities as MessageEntity[] } : {}),
    link_preview_options: { is_disabled: true },
  };
}

async function sendFormattedViaApi(
  api: Pick<Bot["api"], "sendMessage">,
  target: ReplyTarget,
  message: RenderedTelegramText,
  logger?: Logger,
): Promise<void> {
  await sendTextChunks({ api } as Bot, {
    chatId: target.chatId,
    messageThreadId: target.messageThreadId,
    message,
  }, logger);
}

function targetFromContext(ctx: Context): ReplyTarget | null {
  const chatId = ctx.chat?.id;
  if (chatId == null) return null;
  return {
    chatId,
    messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null,
  };
}

function sectionBlock(title?: string, fields?: ReplyField[], lines?: string[]) {
  const content: TelegramInline[] = [];
  if (title) {
    content.push({ type: "bold", children: [semanticText(title)] });
  }
  for (const field of fields ?? []) {
    appendLine(content, fieldLine(field));
  }
  for (const line of lines ?? []) {
    appendLine(content, [semanticText(line)]);
  }
  return semanticParagraph(content);
}

function fieldLine(field: ReplyField): TelegramInline[] {
  const value = formatValue(field.value);
  if (field.style === "code") {
    return [
      semanticText(`${field.label}: `),
      { type: "code", text: value },
    ];
  }
  return [semanticText(`${field.label}: ${value}`)];
}

function appendLine(content: TelegramInline[], line: TelegramInline[]): void {
  if (line.length === 0) return;
  if (content.length > 0) {
    content.push(semanticText("\n"));
  }
  content.push(...line);
}

function normalizeLines(lines: string | string[]): string[] {
  return Array.isArray(lines) ? lines : [lines];
}

function formatValue(value: ReplyFieldValue): string {
  if (value == null) return "none";
  return String(value);
}
