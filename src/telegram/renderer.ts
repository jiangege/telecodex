import { toString } from "mdast-util-to-string";
import type {
  BlockContent,
  Code,
  Content,
  Delete,
  Emphasis,
  Heading,
  Html,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  type RenderedTelegramCaption,
  type RenderedTelegramMedia,
  type RenderedTelegramMessage,
  type RenderedTelegramText,
  type TelegramMessageEntity,
  type TelegramBlock,
  type TelegramInline,
  type TelegramListItem,
  type TelegramListItemState,
  type TelegramNoticeBlock,
  type TelegramNoticeTone,
  type TelegramSemanticDoc,
  plainTextDoc,
  semanticDoc,
  semanticHeading,
  semanticParagraph,
  semanticText,
} from "./semantic.js";

const MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm);
const TABLE_COMPACT_MAX_WIDTH = 72;
const TABLE_COMPACT_MAX_COLUMNS = 6;
const LIST_INDENT = "\u00a0\u00a0";

export function renderPlainForTelegram(text: string): RenderedTelegramText {
  const normalized = text.trim();
  return {
    text: normalized || " ",
  };
}

export function renderMarkdownToTelegramSemanticDoc(markdown: string): TelegramSemanticDoc {
  const tree = MARKDOWN_PARSER.parse(markdown) as Root;
  return rootToSemanticDoc(tree);
}

export function renderMarkdownToTelegramMessage(markdown: string): RenderedTelegramMessage {
  return renderTelegramSemanticMessage(renderMarkdownToTelegramSemanticDoc(markdown));
}

export function renderTelegramSemanticMessage(document: TelegramSemanticDoc): RenderedTelegramMessage {
  const body = renderTelegramSemanticText(document);
  const media = document.media.map((entry): RenderedTelegramMedia => {
    const rendered: RenderedTelegramMedia = {
      source: entry.source,
    };
    const caption = entry.caption ? renderTelegramSemanticCaption(entry.caption) : undefined;
    const fallback = entry.fallback ? renderTelegramSemanticText(entry.fallback) : undefined;
    if (caption) {
      rendered.caption = caption;
    }
    if (fallback) {
      rendered.fallback = fallback;
    }
    return rendered;
  });

  if (body || media.length === 0) {
    return { body, media };
  }

  const fallbackBlocks = media
    .map((entry) => entry.fallback)
    .filter((entry): entry is RenderedTelegramText => entry != null && entry.text.trim().length > 0)
    .map((entry) => semanticParagraph(entry.text));

  return {
    body: fallbackBlocks.length > 0 ? renderTelegramSemanticText(semanticDoc(fallbackBlocks)) : null,
    media,
  };
}

export function renderTelegramSemanticText(document: TelegramSemanticDoc): RenderedTelegramText | null {
  const builder = new RenderedTextBuilder();

  for (const block of document.blocks) {
    const rendered = renderBlock(block);
    if (!rendered || !rendered.text) continue;
    if (builder.length > 0) {
      builder.appendText("\n\n");
    }
    builder.appendRendered(rendered);
  }

  return builder.finish();
}

export function renderTelegramSemanticCaption(document: TelegramSemanticDoc): RenderedTelegramCaption | undefined {
  const rendered = renderTelegramSemanticText(document);
  if (!rendered) return undefined;
  return {
    caption: rendered.text,
    ...(rendered.entities && rendered.entities.length > 0 ? { caption_entities: rendered.entities } : {}),
  };
}

export function renderMarkdownForTelegram(markdown: string): RenderedTelegramText[] {
  const message = renderMarkdownToTelegramMessage(markdown);
  return message.body ? [message.body] : [];
}

function rootToSemanticDoc(root: Root): TelegramSemanticDoc {
  const media: RenderedTelegramMediaSeed[] = [];
  const blocks = root.children.flatMap((child) => rootContentToBlocks(child, media));
  return semanticDoc(blocks, media);
}

function rootContentToBlocks(node: RootContent, media: RenderedTelegramMediaSeed[]): TelegramBlock[] {
  switch (node.type) {
    case "paragraph":
      return paragraphToBlocks(node, media);
    case "heading":
      return headingToBlocks(node, media);
    case "blockquote":
      return [
        {
          type: "quote",
          blocks: node.children.flatMap((child) => rootContentToBlocks(child, media)),
        },
      ];
    case "code":
      return [codeToBlock(node)];
    case "list":
      return [{ type: "list", items: flattenList(node, 0, media) }];
    case "table":
      return [tableToBlock(node)];
    case "thematicBreak":
      return [semanticParagraph("---")];
    case "html":
      return [semanticParagraph(node.value)];
    default: {
      const fallback = toString(node).trim();
      return fallback ? [semanticParagraph(fallback)] : [];
    }
  }
}

function paragraphToBlocks(node: Paragraph, media: RenderedTelegramMediaSeed[]): TelegramBlock[] {
  const content = compactInlines(transformPhrasingNodes(node.children, media));
  return content.length > 0 ? [semanticParagraph(content)] : [];
}

function headingToBlocks(node: Heading, media: RenderedTelegramMediaSeed[]): TelegramBlock[] {
  const content = compactInlines(transformPhrasingNodes(node.children, media));
  return content.length > 0 ? [semanticHeading(content, node.depth)] : [];
}

function codeToBlock(node: Code) {
  return {
    type: "code_block" as const,
    code: node.value,
    ...(node.lang ? { language: node.lang } : {}),
  };
}

function tableToBlock(node: Table) {
  const [headerRow, ...dataRows] = node.children;
  const header = headerRow ? rowToCells(headerRow.children) : null;
  const rows = dataRows.map((row) => rowToCells(row.children));
  return {
    type: "table" as const,
    header,
    rows,
  };
}

function rowToCells(cells: Table["children"][number]["children"]): string[] {
  return cells.map((cell) => toString(cell).trim());
}

function transformPhrasingNodes(
  nodes: PhrasingContent[],
  media: RenderedTelegramMediaSeed[],
): TelegramInline[] {
  const inlines: TelegramInline[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        inlines.push(semanticText(node.value));
        break;
      case "strong":
        appendWrappedInline(inlines, "bold", node, media);
        break;
      case "emphasis":
        appendWrappedInline(inlines, "italic", node, media);
        break;
      case "delete":
        appendWrappedInline(inlines, "strikethrough", node, media);
        break;
      case "inlineCode":
        inlines.push({
          type: "code",
          text: node.value,
        });
        break;
      case "link":
        appendLinkInline(inlines, node, media);
        break;
      case "break":
        inlines.push(semanticText("\n"));
        break;
      case "image":
        appendImageInline(inlines, node, media);
        break;
      case "html":
        inlines.push(semanticText(node.value));
        break;
      default: {
        const fallback = toString(node).trim();
        if (fallback) {
          inlines.push(semanticText(fallback));
        }
        break;
      }
    }
  }

  return compactInlines(inlines);
}

function appendWrappedInline(
  inlines: TelegramInline[],
  type: Extract<TelegramInline["type"], "bold" | "italic" | "strikethrough">,
  node: Strong | Emphasis | Delete,
  media: RenderedTelegramMediaSeed[],
): void {
  const children = compactInlines(transformPhrasingNodes(node.children, media));
  if (children.length === 0) return;
  inlines.push({
    type,
    children,
  });
}

function appendLinkInline(inlines: TelegramInline[], node: Link, media: RenderedTelegramMediaSeed[]): void {
  const href = sanitizeTelegramHref(node.url);
  const children = compactInlines(transformPhrasingNodes(node.children, media));
  if (!href) {
    if (children.length > 0) {
      inlines.push(...children);
    } else {
      const fallback = toString(node).trim();
      if (fallback) inlines.push(semanticText(fallback));
    }
    return;
  }

  inlines.push({
    type: "link",
    href,
    children: children.length > 0 ? children : [semanticText(href)],
  });
}

function appendImageInline(inlines: TelegramInline[], node: Image, media: RenderedTelegramMediaSeed[]): void {
  const source = node.url.trim();
  const altText = (node.alt ?? "").trim() || source;
  if (!source) {
    if (altText) inlines.push(semanticText(altText));
    return;
  }

  if (isTelegramMediaCandidate(source)) {
    const fallback = plainTextDoc(altText || source);
    const rendered: RenderedTelegramMediaSeed = {
      source,
      altText: altText || source,
      fallback,
    };
    if (altText) {
      rendered.caption = plainTextDoc(altText);
    }
    media.push(rendered);
    return;
  }

  const href = sanitizeTelegramHref(source);
  if (href) {
    inlines.push({
      type: "link",
      href,
      children: [semanticText(altText || href)],
    });
    return;
  }

  if (altText) {
    inlines.push(semanticText(altText));
  }
}

function flattenList(node: List, depth: number, media: RenderedTelegramMediaSeed[]): TelegramListItem[] {
  const items: TelegramListItem[] = [];
  let ordinal = node.start ?? 1;

  for (const child of node.children) {
    const content = listItemContent(child, media);
    const kind = child.checked == null ? (node.ordered ? "ordered" : "bullet") : "task";
    const state = child.checked == null ? undefined : child.checked ? "done" : "todo";

    items.push({
      kind,
      depth,
      content: content.length > 0 ? content : [semanticText(toString(child).trim() || "")],
      ...(kind === "ordered" ? { ordinal } : {}),
      ...(state ? { state } : {}),
    });
    ordinal += 1;

    for (const grandchild of child.children) {
      if (grandchild.type === "list") {
        items.push(...flattenList(grandchild, depth + 1, media));
      }
    }
  }

  return items;
}

function listItemContent(item: ListItem, media: RenderedTelegramMediaSeed[]): TelegramInline[] {
  for (const child of item.children) {
    if (child.type === "paragraph") {
      return compactInlines(transformPhrasingNodes(child.children, media));
    }
    if (child.type !== "list") {
      const fallback = toString(child).trim();
      if (fallback) return [semanticText(fallback)];
    }
  }
  return [];
}

function compactInlines(inlines: TelegramInline[]): TelegramInline[] {
  const compacted: TelegramInline[] = [];
  for (const inline of inlines) {
    if (inline.type === "text" && inline.text.length === 0) continue;
    const previous = compacted.at(-1);
    if (previous?.type === "text" && inline.type === "text") {
      previous.text += inline.text;
      continue;
    }
    compacted.push(inline);
  }
  return compacted;
}

function renderBlock(block: TelegramBlock): RenderedTelegramText | null {
  switch (block.type) {
    case "paragraph":
      return renderInlineBlock(block.content);
    case "heading":
      return renderInlineBlock([{ type: "bold", children: block.content }]);
    case "quote":
      return renderQuoteBlock(block.blocks);
    case "code_block":
      return renderCodeBlock(block.code, block.language);
    case "list":
      return renderListBlock(block.items);
    case "table":
      return renderTableBlock(block.header, block.rows);
    case "notice":
      return renderNoticeBlock(block);
  }
}

function renderInlineBlock(content: TelegramInline[]): RenderedTelegramText | null {
  const builder = new RenderedTextBuilder();
  renderInlines(builder, content);
  return builder.finish();
}

function renderQuoteBlock(blocks: TelegramBlock[]): RenderedTelegramText | null {
  const inner = renderTelegramSemanticText(semanticDoc(blocks));
  if (!inner) return null;
  const builder = new RenderedTextBuilder();
  builder.wrapEntity({ type: "blockquote" }, () => {
    builder.appendRendered(inner);
  });
  return builder.finish();
}

function renderCodeBlock(code: string, language?: string | null): RenderedTelegramText | null {
  if (!code) return null;
  const builder = new RenderedTextBuilder();
  builder.wrapEntity(language ? { type: "pre", language } : { type: "pre" }, () => {
    builder.appendText(code);
  });
  return builder.finish();
}

function renderListBlock(items: TelegramListItem[]): RenderedTelegramText | null {
  if (items.length === 0) return null;

  const builder = new RenderedTextBuilder();
  items.forEach((item, index) => {
    if (index > 0) builder.appendText("\n");
    builder.appendText(listItemPrefix(item));
    renderInlines(builder, item.content);
  });
  return builder.finish();
}

function listItemPrefix(item: TelegramListItem): string {
  const indent = LIST_INDENT.repeat(item.depth);
  if (item.kind === "ordered") {
    return `${indent}${item.ordinal ?? 1}. `;
  }
  if (item.kind === "task") {
    return `${indent}${taskStateEmoji(item.state)} `;
  }
  return `${indent}- `;
}

function taskStateEmoji(state: TelegramListItemState | undefined): string {
  switch (state) {
    case "doing":
      return "⏳";
    case "done":
      return "✅";
    case "blocked":
      return "⚠️";
    case "todo":
    default:
      return "☐";
  }
}

function renderTableBlock(header: string[] | null, rows: string[][]): RenderedTelegramText | null {
  const columnCount = Math.max(header?.length ?? 0, ...rows.map((row) => row.length), 0);
  if (columnCount === 0) return null;

  const normalizedHeader = padRow(header ?? [], columnCount);
  const normalizedRows = rows.map((row) => padRow(row, columnCount));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...[normalizedHeader, ...normalizedRows].map((row) => row[column]?.length ?? 0)),
  );
  const estimatedWidth = widths.reduce((sum, width) => sum + width, 0) + (columnCount - 1) * 3;

  if (estimatedWidth <= TABLE_COMPACT_MAX_WIDTH && columnCount <= TABLE_COMPACT_MAX_COLUMNS) {
    const lines = [];
    if (header) {
      lines.push(formatTableLine(normalizedHeader, widths));
      lines.push(widths.map((width) => "-".repeat(Math.max(1, width))).join(" | "));
    }
    for (const row of normalizedRows) {
      lines.push(formatTableLine(row, widths));
    }
    return renderCodeBlock(lines.join("\n").trimEnd());
  }

  const builder = new RenderedTextBuilder();
  const labels = header ? normalizedHeader : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  builder.wrapEntity({ type: "bold" }, () => {
    builder.appendText("Table");
  });

  normalizedRows.forEach((row, rowIndex) => {
    builder.appendText("\n\n");
    builder.wrapEntity({ type: "bold" }, () => {
      builder.appendText(`Row ${rowIndex + 1}`);
    });
    row.forEach((cell, columnIndex) => {
      builder.appendText(`\n${labels[columnIndex] ?? `Column ${columnIndex + 1}`}: ${cell || "-"}`);
    });
  });

  return builder.finish();
}

function renderNoticeBlock(block: TelegramNoticeBlock): RenderedTelegramText | null {
  const builder = new RenderedTextBuilder();
  const prefix = `${noticeToneEmoji(block.tone)} `;

  if (block.title && block.title.length > 0) {
    builder.appendText(prefix);
    builder.wrapEntity({ type: "bold" }, () => {
      renderInlines(builder, block.title ?? []);
    });
  } else {
    builder.appendText(prefix.trim());
  }

  const body = renderTelegramSemanticText(semanticDoc(block.blocks));
  if (body) {
    if (builder.length > 0) builder.appendText("\n");
    builder.appendRendered(body);
  }

  return builder.finish();
}

function noticeToneEmoji(tone: TelegramNoticeTone): string {
  switch (tone) {
    case "note":
      return "📝";
    case "success":
      return "✅";
    case "warning":
      return "⚠️";
    case "error":
      return "❌";
    case "info":
    default:
      return "ℹ️";
  }
}

function renderInlines(builder: RenderedTextBuilder, inlines: TelegramInline[]): void {
  for (const inline of inlines) {
    switch (inline.type) {
      case "text":
        builder.appendText(inline.text);
        break;
      case "code":
        builder.wrapEntity({ type: "code" }, () => {
          builder.appendText(inline.text);
        });
        break;
      case "bold":
        builder.wrapEntity({ type: "bold" }, () => renderInlines(builder, inline.children));
        break;
      case "italic":
        builder.wrapEntity({ type: "italic" }, () => renderInlines(builder, inline.children));
        break;
      case "underline":
        builder.wrapEntity({ type: "underline" }, () => renderInlines(builder, inline.children));
        break;
      case "strikethrough":
        builder.wrapEntity({ type: "strikethrough" }, () => renderInlines(builder, inline.children));
        break;
      case "spoiler":
        builder.wrapEntity({ type: "spoiler" }, () => renderInlines(builder, inline.children));
        break;
      case "link":
        builder.wrapEntity({ type: "text_link", url: inline.href }, () => renderInlines(builder, inline.children));
        break;
      case "mention":
        builder.wrapEntity({ type: "text_link", url: `tg://user?id=${inline.userId}` }, () => renderInlines(builder, inline.children));
        break;
    }
  }
}

function padRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

function formatTableLine(row: string[], widths: number[]): string {
  return row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ").trimEnd();
}

function sanitizeTelegramHref(value: string | null | undefined): string | null {
  if (!value) return null;
  const href = value.trim();
  if (!href) return null;

  try {
    const url = new URL(href);
    switch (url.protocol) {
      case "http:":
      case "https:":
      case "mailto:":
      case "tg:":
        return url.toString();
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isTelegramMediaCandidate(source: string): boolean {
  return !/^(?:[a-z]+:)?\/\//i.test(source) && !/^[a-z]+:/i.test(source);
}

class RenderedTextBuilder {
  private text = "";
  private readonly entities: TelegramMessageEntity[] = [];

  get length(): number {
    return this.text.length;
  }

  appendText(value: string): void {
    if (!value) return;
    this.text += value;
  }

  appendRendered(value: RenderedTelegramText): void {
    const offset = this.text.length;
    this.text += value.text;
    for (const entity of value.entities ?? []) {
      this.entities.push({
        ...entity,
        offset: entity.offset + offset,
      });
    }
  }

  wrapEntity(entity: EntityInput, render: () => void): void {
    const start = this.text.length;
    render();
    const length = this.text.length - start;
    if (length <= 0) return;
    this.entities.push({
      ...entity,
      offset: start,
      length,
    });
  }

  finish(): RenderedTelegramText | null {
    if (!this.text) return null;
    return {
      text: this.text,
      ...(this.entities.length > 0 ? { entities: sortEntities(this.entities) } : {}),
    };
  }
}

interface RenderedTelegramMediaSeed {
  source: string;
  altText: string;
  caption?: TelegramSemanticDoc;
  fallback?: TelegramSemanticDoc;
}

type EntityInput = Omit<TelegramMessageEntity, "offset" | "length">;

function sortEntities(entities: TelegramMessageEntity[]): TelegramMessageEntity[] {
  return [...entities].sort((left, right) => {
    if (left.offset !== right.offset) return left.offset - right.offset;
    if (left.length !== right.length) return right.length - left.length;
    return left.type.localeCompare(right.type);
  });
}
