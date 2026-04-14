const TELEGRAM_SAFE_TEXT_LIMIT = 3900;

export function splitTelegramText(text: string, limit = TELEGRAM_SAFE_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const splitAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = splitAt > limit * 0.55 ? splitAt : limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function splitTelegramHtml(html: string, limit = TELEGRAM_SAFE_TEXT_LIMIT): string[] {
  if (html.length <= limit) return [html];

  const tokens = html.match(/<[^>]+>|[^<]+/g) ?? [];
  const chunks: string[] = [];
  const stack: HtmlTagFrame[] = [];
  let body = "";
  let chunkHasContent = false;

  for (const token of tokens) {
    if (token.startsWith("<")) {
      const parsed = parseHtmlTag(token);
      if (!parsed) {
        appendTextToken(token);
        continue;
      }

      if (parsed.kind === "close") {
        const matchingIndex = findMatchingStackIndex(stack, parsed.name);
        const nextStack = matchingIndex >= 0 ? stack.slice(0, matchingIndex) : stack;
        if (!canFit(token.length, closingSuffixLength(nextStack), body.length, limit) && chunkHasContent) {
          pushChunk();
        }
        body += token;
        if (matchingIndex >= 0) {
          stack.splice(matchingIndex, 1);
        }
        continue;
      }

      const nextStack = [...stack, parsed];
      if (!canFit(token.length, closingSuffixLength(nextStack), body.length, limit) && chunkHasContent) {
        pushChunk();
      }
      body += token;
      stack.push(parsed);
      continue;
    }

    appendTextToken(token);
  }

  if (chunkHasContent) {
    chunks.push(body + closingSuffix(stack));
  } else if (!chunks.length && body) {
    chunks.push(body);
  }

  return chunks.filter(Boolean);

  function appendTextToken(token: string): void {
    let remaining = token;
    while (remaining) {
      const available = limit - body.length - closingSuffixLength(stack);
      if (available <= 0 && chunkHasContent) {
        pushChunk();
        continue;
      }
      if (available <= 0) {
        body += remaining;
        chunkHasContent = true;
        remaining = "";
        continue;
      }

      if (remaining.length <= available) {
        body += remaining;
        chunkHasContent = true;
        remaining = "";
        continue;
      }

      const cut = chooseSplitPoint(remaining, available);
      body += remaining.slice(0, cut);
      chunkHasContent = true;
      remaining = remaining.slice(cut);
      pushChunk();
    }
  }

  function pushChunk(): void {
    if (!chunkHasContent) return;
    chunks.push(body + closingSuffix(stack));
    body = openingPrefix(stack);
    chunkHasContent = false;
  }
}

interface HtmlTagFrame {
  kind: "open";
  name: string;
  open: string;
  close: string;
}

function chooseSplitPoint(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const slice = text.slice(0, limit);
  const splitAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  return splitAt > limit * 0.55 ? splitAt : limit;
}

function parseHtmlTag(token: string): HtmlTagFrame | { kind: "close"; name: string } | null {
  const closeMatch = token.match(/^<\/([a-z]+)>$/i);
  if (closeMatch?.[1]) {
    return {
      kind: "close",
      name: closeMatch[1].toLowerCase(),
    };
  }

  const openMatch = token.match(/^<([a-z]+)(?:\s[^>]*)?>$/i);
  if (!openMatch?.[1]) return null;

  const name = openMatch[1].toLowerCase();
  return {
    kind: "open",
    name,
    open: token,
    close: `</${name}>`,
  };
}

function openingPrefix(stack: HtmlTagFrame[]): string {
  return stack.map((frame) => frame.open).join("");
}

function closingSuffix(stack: HtmlTagFrame[]): string {
  return [...stack].reverse().map((frame) => frame.close).join("");
}

function closingSuffixLength(stack: HtmlTagFrame[]): number {
  return stack.reduce((total, frame) => total + frame.close.length, 0);
}

function canFit(tokenLength: number, suffixLength: number, currentLength: number, limit: number): boolean {
  return currentLength + tokenLength + suffixLength <= limit;
}

function findMatchingStackIndex(stack: HtmlTagFrame[], name: string): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.name === name) return index;
  }
  return -1;
}
