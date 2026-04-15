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
  const tokens = md.parse(markdown, {});
  const html = renderTokens(tokens).replace(/\n{3,}/g, "\n\n").trim();
  return splitTelegramHtml(html || escapeHtml(markdown || ""));
}

export function renderPlainForTelegram(text: string): string {
  return escapeHtml(text.trim() || " ");
}

export function renderPlainChunksForTelegram(text: string): string[] {
  return splitTelegramText(renderPlainForTelegram(text));
}

function renderTokens(tokens: Token[]): string {
  let out = "";
  const orderedStack: Array<{ index: number }> = [];

  for (const token of tokens) {
    switch (token.type) {
      case "heading_open":
        out += "<b>";
        break;
      case "heading_close":
        out += "</b>\n\n";
        break;
      case "paragraph_open":
        break;
      case "paragraph_close":
        out += "\n\n";
        break;
      case "inline":
        out += renderInline(token.children ?? []);
        break;
      case "bullet_list_open":
        break;
      case "bullet_list_close":
        out += "\n";
        break;
      case "ordered_list_open":
        orderedStack.push({ index: Number(token.attrGet("start") ?? "1") });
        break;
      case "ordered_list_close":
        orderedStack.pop();
        out += "\n";
        break;
      case "list_item_open": {
        const current = orderedStack.at(-1);
        if (current) {
          out += `${current.index}. `;
          current.index += 1;
        } else {
          out += "- ";
        }
        break;
      }
      case "list_item_close":
        out += "\n";
        break;
      case "blockquote_open":
        out += "<blockquote>";
        break;
      case "blockquote_close":
        out += "</blockquote>\n\n";
        break;
      case "fence":
      case "code_block":
        out += `<pre><code>${escapeHtml(token.content)}</code></pre>\n\n`;
        break;
      case "hr":
        out += "\n---\n\n";
        break;
      case "softbreak":
      case "hardbreak":
        out += "\n";
        break;
      case "text":
        out += escapeHtml(token.content);
        break;
      default:
        break;
    }
  }

  return out;
}

function renderInline(tokens: Token[]): string {
  let out = "";
  const linkStack: boolean[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text":
        out += escapeHtml(token.content);
        break;
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
