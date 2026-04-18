export type TelegramListItemState = "todo" | "doing" | "done" | "blocked";
export type TelegramNoticeTone = "info" | "note" | "success" | "warning" | "error";

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export type TelegramInline =
  | { type: "text"; text: string }
  | { type: "bold"; children: TelegramInline[] }
  | { type: "italic"; children: TelegramInline[] }
  | { type: "underline"; children: TelegramInline[] }
  | { type: "strikethrough"; children: TelegramInline[] }
  | { type: "spoiler"; children: TelegramInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: TelegramInline[] }
  | { type: "mention"; userId: number; children: TelegramInline[] };

export interface TelegramParagraphBlock {
  type: "paragraph";
  content: TelegramInline[];
}

export interface TelegramHeadingBlock {
  type: "heading";
  level: number;
  content: TelegramInline[];
}

export interface TelegramQuoteBlock {
  type: "quote";
  blocks: TelegramBlock[];
}

export interface TelegramCodeBlock {
  type: "code_block";
  code: string;
  language?: string | null;
}

export interface TelegramListItem {
  kind: "bullet" | "ordered" | "task";
  depth: number;
  content: TelegramInline[];
  ordinal?: number;
  state?: TelegramListItemState;
}

export interface TelegramListBlock {
  type: "list";
  items: TelegramListItem[];
}

export interface TelegramTableBlock {
  type: "table";
  header: string[] | null;
  rows: string[][];
}

export interface TelegramNoticeBlock {
  type: "notice";
  tone: TelegramNoticeTone;
  title?: TelegramInline[];
  blocks: TelegramBlock[];
}

export type TelegramBlock =
  | TelegramParagraphBlock
  | TelegramHeadingBlock
  | TelegramQuoteBlock
  | TelegramCodeBlock
  | TelegramListBlock
  | TelegramTableBlock
  | TelegramNoticeBlock;

export interface TelegramSemanticMedia {
  source: string;
  altText: string;
  caption?: TelegramSemanticDoc;
  fallback?: TelegramSemanticDoc;
}

export interface TelegramSemanticDoc {
  blocks: TelegramBlock[];
  media: TelegramSemanticMedia[];
}

export interface RenderedTelegramText {
  text: string;
  entities?: TelegramMessageEntity[];
}

export interface RenderedTelegramCaption {
  caption: string;
  caption_entities?: TelegramMessageEntity[];
}

export interface RenderedTelegramMedia {
  source: string;
  caption?: RenderedTelegramCaption;
  fallback?: RenderedTelegramText | null;
}

export interface RenderedTelegramMessage {
  body: RenderedTelegramText | null;
  media: RenderedTelegramMedia[];
}

export function semanticText(text: string): TelegramInline {
  return { type: "text", text };
}

export function semanticParagraph(content: TelegramInline[] | string): TelegramParagraphBlock {
  return {
    type: "paragraph",
    content: typeof content === "string" ? [semanticText(content)] : content,
  };
}

export function semanticHeading(content: TelegramInline[] | string, level = 1): TelegramHeadingBlock {
  return {
    type: "heading",
    level,
    content: typeof content === "string" ? [semanticText(content)] : content,
  };
}

export function semanticDoc(blocks: TelegramBlock[] = [], media: TelegramSemanticMedia[] = []): TelegramSemanticDoc {
  return { blocks, media };
}

export function plainTextDoc(text: string): TelegramSemanticDoc {
  const normalized = text.trim();
  return semanticDoc(normalized ? [semanticParagraph(normalized)] : []);
}
