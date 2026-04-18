import { FormattedString, type TextWithEntities } from "@grammyjs/parse-mode";
import type { Bot, Context } from "grammy";
import type { Logger } from "../runtime/logger.js";
import { retryTelegramCall } from "./delivery.js";
import { TELEGRAM_SAFE_TEXT_LIMIT } from "./splitMessage.js";

export type ReplyFieldValue = string | number | boolean | null | undefined;

export interface ReplyField {
  label: string;
  value: ReplyFieldValue;
  style?: "plain" | "code";
}

export interface ReplySection {
  title?: string;
  fields?: ReplyField[];
  lines?: ReplyLine[];
}

export interface ReplyDocument {
  title: string;
  fields?: ReplyField[];
  sections?: ReplySection[];
  footer?: ReplyLine | ReplyLine[];
}

export interface ReplyTarget {
  chatId: number;
  messageThreadId: number | null;
}

type ReplyLine = string | TextWithEntities;
type ReplyContent = ReplyLine | ReplyLine[];

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

export function renderReplyDocument(document: ReplyDocument): FormattedString {
  const lines: ReplyLine[] = [formatTitle(document.title)];

  if (document.fields?.length) {
    lines.push(...document.fields.map(formatField));
  }

  for (const section of document.sections ?? []) {
    appendBlankLine(lines);
    if (section.title) {
      lines.push(formatTitle(section.title));
    }
    if (section.fields?.length) {
      lines.push(...section.fields.map(formatField));
    }
    if (section.lines?.length) {
      lines.push(...section.lines);
    }
  }

  if (document.footer != null) {
    appendBlankLine(lines);
    lines.push(...normalizeLines(document.footer));
  }

  return joinLines(trimBlankLines(lines));
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

export async function replyError(ctx: Context, message: ReplyLine, detail?: ReplyContent): Promise<void> {
  await replyNotice(ctx, detail == null ? message : [message, ...normalizeLines(detail)]);
}

export async function sendReplyError(
  bot: Bot,
  target: ReplyTarget,
  message: ReplyLine,
  detail?: ReplyContent,
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

export async function replyFormatted(ctx: Context, message: TextWithEntities): Promise<void> {
  const target = targetFromContext(ctx);
  if (target && typeof ctx.api?.sendMessage === "function") {
    await sendFormattedViaApi(ctx.api, ctx.api, target, message);
    return;
  }
  await ctx.reply(message.text, {
    ...toMessageOptions(message),
  });
}

export async function sendFormatted(bot: Bot, target: ReplyTarget, message: TextWithEntities, logger?: Logger): Promise<void> {
  await sendFormattedViaApi(bot.api, bot.api, target, message, logger);
}

function renderNotice(content: ReplyContent): FormattedString {
  return joinLines(trimBlankLines(normalizeLines(content)));
}

function toMessageOptions(message: TextWithEntities): {
  entities?: NonNullable<TextWithEntities["entities"]>;
  link_preview_options: { is_disabled: true };
} {
  return {
    ...(message.entities && message.entities.length > 0 ? { entities: message.entities } : {}),
    link_preview_options: { is_disabled: true },
  };
}

async function sendFormattedViaApi(
  api: Pick<Bot["api"], "sendMessage">,
  cooldownKey: object,
  target: ReplyTarget,
  message: TextWithEntities,
  logger?: Logger,
): Promise<void> {
  for (const chunk of splitTextWithEntities(message)) {
    await retryTelegramCall(
      cooldownKey,
      () =>
        api.sendMessage(target.chatId, chunk.text, {
          ...(target.messageThreadId == null ? {} : { message_thread_id: target.messageThreadId }),
          ...toMessageOptions(chunk),
        }),
      logger,
      "telegram send rate limited",
      {
        chatId: target.chatId,
        messageThreadId: target.messageThreadId,
      },
    );
  }
}

function splitTextWithEntities(message: TextWithEntities, limit = TELEGRAM_SAFE_TEXT_LIMIT): TextWithEntities[] {
  if (message.text.length <= limit) {
    return [message];
  }

  const chunks: TextWithEntities[] = [];
  let start = 0;
  while (start < message.text.length) {
    const remaining = message.text.length - start;
    const end = remaining <= limit
      ? message.text.length
      : start + chooseSplitPoint(message.text.slice(start, start + limit), limit);
    chunks.push(sliceTextWithEntities(message, start, Math.max(start + 1, end)));
    start = Math.max(start + 1, end);
  }

  return chunks;
}

function sliceTextWithEntities(message: TextWithEntities, start: number, end: number): TextWithEntities {
  const text = message.text.slice(start, end);
  const entities = message.entities?.flatMap((entity) => {
    const overlapStart = Math.max(entity.offset, start);
    const overlapEnd = Math.min(entity.offset + entity.length, end);
    if (overlapStart >= overlapEnd) return [];
    return [
      {
        ...entity,
        offset: overlapStart - start,
        length: overlapEnd - overlapStart,
      },
    ];
  });

  return entities && entities.length > 0
    ? { text, entities }
    : { text };
}

function chooseSplitPoint(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const slice = text.slice(0, limit);
  const splitAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  return splitAt > limit * 0.55 ? splitAt : limit;
}

function targetFromContext(ctx: Context): ReplyTarget | null {
  const chatId = ctx.chat?.id;
  if (chatId == null) return null;
  return {
    chatId,
    messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null,
  };
}

function formatTitle(value: string): FormattedString {
  return FormattedString.bold(value);
}

function formatField(field: ReplyField): ReplyLine {
  const value = formatValue(field.value);
  if (field.style === "code") {
    return FormattedString.join([`${field.label}: `, FormattedString.code(value)]);
  }
  return `${field.label}: ${value}`;
}

function joinLines(lines: ReplyLine[]): FormattedString {
  return FormattedString.join(lines, "\n");
}

function appendBlankLine(lines: ReplyLine[]): void {
  if (lines.length === 0 || lines.at(-1) === "") return;
  lines.push("");
}

function trimBlankLines(lines: ReplyLine[]): ReplyLine[] {
  let start = 0;
  let end = lines.length;

  while (lines[start] === "") start += 1;
  while (lines[end - 1] === "") end -= 1;
  return lines.slice(start, end);
}

function normalizeLines(lines: ReplyLine | ReplyLine[]): ReplyLine[] {
  return Array.isArray(lines) ? lines : [lines];
}

function formatValue(value: ReplyFieldValue): string {
  if (value == null) return "none";
  return String(value);
}
