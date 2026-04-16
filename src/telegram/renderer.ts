import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { splitTelegramHtml, splitTelegramText } from "./splitMessage.js";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderMarkdownForTelegram(markdown: string): string[] {
  return splitTelegramHtml(renderMarkdownToTelegramHtml(markdown));
}

export function renderPlainForTelegram(text: string): string {
  return escapeHtml(text.trim() || " ");
}

export function renderPlainChunksForTelegram(text: string): string[] {
  return splitTelegramText(renderPlainForTelegram(text));
}

export function renderMarkdownToTelegramHtml(markdown: string): string {
  const tokens = md.parse(markdown, {});
  const html = renderTokens(tokens).replace(/\n{3,}/g, "\n\n").trim();
  return html || escapeHtml(markdown.trim() || " ");
}

function renderTokens(tokens: Token[]): string {
  let out = "";
  const listStack: Array<{ kind: "ordered" | "bullet"; index: number }> = [];
  let pendingListPrefix: { indent: string; marker: string } | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    switch (token.type) {
      case "table_open": {
        flushPendingListPrefix();
        const table = consumeTable(tokens, index);
        out += table.html;
        index = table.nextIndex;
        break;
      }
      case "heading_open":
        flushPendingListPrefix();
        out += "<b>";
        break;
      case "heading_close":
        out += "</b>\n\n";
        break;
      case "paragraph_open":
        break;
      case "paragraph_close": {
        const nextType = tokens[index + 1]?.type ?? null;
        if (listStack.length > 0) {
          if (nextType === "bullet_list_open" || nextType === "ordered_list_open") {
            out += "\n";
          } else if (nextType !== "list_item_close") {
            out += "\n";
          }
        } else {
          out += "\n\n";
        }
        break;
      }
      case "inline": {
        const taskMarker = pendingListPrefix ? extractTaskMarker(token.content) : null;
        if (pendingListPrefix) {
          out += `${pendingListPrefix.indent}${taskMarker ?? pendingListPrefix.marker}`;
          pendingListPrefix = null;
        }
        out += renderInline(token.children ?? [], { stripLeadingTaskMarker: taskMarker != null });
        break;
      }
      case "bullet_list_open":
        flushPendingListPrefix();
        listStack.push({ kind: "bullet", index: 0 });
        break;
      case "bullet_list_close":
        listStack.pop();
        if (listStack.length === 0) {
          out += "\n";
        }
        break;
      case "ordered_list_open":
        flushPendingListPrefix();
        listStack.push({ kind: "ordered", index: Number(token.attrGet("start") ?? "1") });
        break;
      case "ordered_list_close":
        listStack.pop();
        if (listStack.length === 0) {
          out += "\n";
        }
        break;
      case "list_item_open":
        pendingListPrefix = nextListPrefix(listStack);
        break;
      case "list_item_close": {
        flushPendingListPrefix();
        const nextType = tokens[index + 1]?.type ?? null;
        if (nextType !== "bullet_list_close" && nextType !== "ordered_list_close" && nextType !== "list_item_close") {
          out += "\n";
        }
        break;
      }
      case "blockquote_open":
        flushPendingListPrefix();
        out += "<blockquote>";
        break;
      case "blockquote_close":
        out += "</blockquote>\n\n";
        break;
      case "fence":
      case "code_block":
        flushPendingListPrefix();
        out += `<pre><code>${escapeHtml(token.content)}</code></pre>\n\n`;
        break;
      case "hr":
        flushPendingListPrefix();
        out += "\n---\n\n";
        break;
      case "softbreak":
      case "hardbreak":
        out += "\n";
        break;
      case "text":
        flushPendingListPrefix();
        out += escapeHtml(token.content);
        break;
      default:
        break;
    }
  }

  return out;

  function flushPendingListPrefix(): void {
    if (!pendingListPrefix) return;
    out += `${pendingListPrefix.indent}${pendingListPrefix.marker}`;
    pendingListPrefix = null;
  }
}

function renderInline(tokens: Token[], options?: { stripLeadingTaskMarker?: boolean }): string {
  let out = "";
  const linkStack: boolean[] = [];
  let stripLeadingTaskMarker = options?.stripLeadingTaskMarker === true;

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        let content = token.content;
        if (stripLeadingTaskMarker) {
          content = content.replace(/^\[(?: |x|X)\]\s+/, "");
          stripLeadingTaskMarker = false;
        }
        out += escapeHtml(content);
        break;
      }
      case "code_inline":
        out += `<code>${escapeHtml(token.content)}</code>`;
        break;
      case "strong_open":
        out += "<b>";
        break;
      case "strong_close":
        out += "</b>";
        break;
      case "em_open":
        out += "<i>";
        break;
      case "em_close":
        out += "</i>";
        break;
      case "s_open":
        out += "<s>";
        break;
      case "s_close":
        out += "</s>";
        break;
      case "link_open": {
        const href = sanitizeTelegramHref(token.attrGet("href"));
        const opened = Boolean(href);
        linkStack.push(opened);
        if (href) {
          out += `<a href="${escapeHtmlAttribute(href)}">`;
        }
        break;
      }
      case "link_close":
        if (linkStack.pop()) {
          out += "</a>";
        }
        break;
      case "softbreak":
      case "hardbreak":
        out += "\n";
        break;
      case "html_inline":
        out += escapeHtml(token.content);
        break;
      default:
        if (token.children) out += renderInline(token.children);
        break;
    }
  }

  return out;
}

function renderInlinePlain(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "code_inline":
        out += token.content;
        break;
      case "softbreak":
      case "hardbreak":
        out += "\n";
        break;
      default:
        if (token.children) {
          out += renderInlinePlain(token.children);
        }
        break;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function nextListPrefix(listStack: Array<{ kind: "ordered" | "bullet"; index: number }>): { indent: string; marker: string } {
  const depth = Math.max(0, listStack.length - 1);
  const indent = "&#160;&#160;".repeat(depth);
  const current = listStack.at(-1);

  if (!current || current.kind === "bullet") {
    return {
      indent,
      marker: "- ",
    };
  }

  const marker = `${current.index}. `;
  current.index += 1;
  return {
    indent,
    marker,
  };
}

function extractTaskMarker(content: string): string | null {
  if (/^\[(?: )\]\s+/.test(content)) return "[ ] ";
  if (/^\[(?:x|X)\]\s+/.test(content)) return "[x] ";
  return null;
}

function consumeTable(tokens: Token[], startIndex: number): { html: string; nextIndex: number } {
  let header: string[] | null = null;
  const rows: string[][] = [];
  let currentRow: string[] | null = null;
  let currentCell = "";
  let inHeader = false;

  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    switch (token.type) {
      case "thead_open":
        inHeader = true;
        break;
      case "thead_close":
        inHeader = false;
        break;
      case "tr_open":
        currentRow = [];
        break;
      case "tr_close":
        if (currentRow) {
          if (inHeader && header == null) {
            header = currentRow;
          } else {
            rows.push(currentRow);
          }
        }
        currentRow = null;
        break;
      case "th_open":
      case "td_open":
        currentCell = "";
        break;
      case "inline":
        currentCell += renderInlinePlain(token.children ?? []);
        break;
      case "th_close":
      case "td_close":
        currentRow?.push(currentCell.trim());
        currentCell = "";
        break;
      case "table_close":
        return {
          html: `${renderTable(header, rows)}\n\n`,
          nextIndex: index,
        };
      default:
        break;
    }
  }

  return {
    html: "",
    nextIndex: tokens.length - 1,
  };
}

function renderTable(header: string[] | null, rows: string[][]): string {
  const columnCount = Math.max(header?.length ?? 0, ...rows.map((row) => row.length), 0);
  if (columnCount === 0) return "";

  const normalizedHeader = padRow(header ?? [], columnCount);
  const normalizedRows = rows.map((row) => padRow(row, columnCount));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...[normalizedHeader, ...normalizedRows].map((row) => row[column]?.length ?? 0)),
  );
  const estimatedWidth = widths.reduce((sum, width) => sum + width, 0) + (columnCount - 1) * 3;

  if (estimatedWidth <= 72 && columnCount <= 6) {
    const lines = [];
    if (header) {
      lines.push(formatTableLine(normalizedHeader, widths));
      lines.push(widths.map((width) => "-".repeat(Math.max(1, width))).join(" | "));
    }
    for (const row of normalizedRows) {
      lines.push(formatTableLine(row, widths));
    }
    return `<pre><code>${escapeHtml(lines.join("\n").trim())}</code></pre>`;
  }

  const labels = header ? normalizedHeader : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  const sections = ["<b>Table</b>"];
  normalizedRows.forEach((row, rowIndex) => {
    sections.push(`<b>Row ${rowIndex + 1}</b>`);
    row.forEach((cell, columnIndex) => {
      sections.push(`${escapeHtml(labels[columnIndex] ?? `Column ${columnIndex + 1}`)}: ${escapeHtml(cell || "-")}`);
    });
    if (rowIndex < normalizedRows.length - 1) {
      sections.push("");
    }
  });
  return sections.join("\n");
}

function padRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? "");
}

function formatTableLine(row: string[], widths: number[]): string {
  return row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ").trimEnd();
}

function sanitizeTelegramHref(value: string | null): string | null {
  if (!value) return null;
  const href = value.trim();
  if (!href) return null;

  try {
    const url = new URL(href);
    return isAllowedTelegramProtocol(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isAllowedTelegramProtocol(protocol: string): boolean {
  switch (protocol) {
    case "http:":
    case "https:":
    case "mailto:":
    case "tg:":
      return true;
    default:
      return false;
  }
}
