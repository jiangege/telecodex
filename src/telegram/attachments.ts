import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import { getAppHome } from "../runtime/appPaths.js";
import type { StoredCodexInput } from "../store/sessionStore.js";

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

interface TelegramImageMessage {
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramAttachmentIo {
  getFile: (input: { bot: Bot; fileId: string }) => Promise<{ file_path?: string }>;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  saveBytes: (input: {
    chatId: number;
    messageThreadId: number | null;
    source: { fileName?: string; mimeType?: string };
    filePath: string;
    bytes: Uint8Array;
  }) => Promise<string>;
}

export async function telegramImageMessageToCodexInput(input: {
  bot: Bot;
  config: AppConfig;
  chatId: number;
  messageThreadId: number | null;
  message: TelegramImageMessage;
}, io?: Partial<TelegramAttachmentIo>): Promise<StoredCodexInput | null> {
  const source = selectImageSource(input.message);
  if (!source) return null;
  const attachmentIo = resolveAttachmentIo(io);

  const file = await attachmentIo.getFile({
    bot: input.bot,
    fileId: source.fileId,
  });
  if (!file.file_path) {
    throw new Error("Telegram did not return a downloadable file_path.");
  }

  const url = `https://api.telegram.org/file/bot${input.config.telegramBotToken}/${file.file_path}`;
  const bytes = await attachmentIo.fetchBytes(url);
  const localPath = await attachmentIo.saveBytes({
    chatId: input.chatId,
    messageThreadId: input.messageThreadId,
    source,
    filePath: file.file_path,
    bytes,
  });

  const caption = input.message.caption?.trim();
  return [
    {
      type: "text",
      text: caption || "Continue based on this image.",
    },
    {
      type: "local_image",
      path: localPath,
    },
  ];
}

function resolveAttachmentIo(io?: Partial<TelegramAttachmentIo>): TelegramAttachmentIo {
  return {
    getFile: io?.getFile ?? defaultGetFile,
    fetchBytes: io?.fetchBytes ?? defaultFetchBytes,
    saveBytes: io?.saveBytes ?? defaultSaveBytes,
  };
}

async function defaultGetFile(input: { bot: Bot; fileId: string }): Promise<{ file_path?: string }> {
  return input.bot.api.getFile(input.fileId);
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download the Telegram image: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function defaultSaveBytes(input: {
  chatId: number;
  messageThreadId: number | null;
  source: { fileName?: string; mimeType?: string };
  filePath: string;
  bytes: Uint8Array;
}): Promise<string> {
  const directory = path.join(getAppHome(), "attachments");
  await mkdir(directory, { recursive: true });
  const localPath = path.join(
    directory,
    `${input.chatId}-${input.messageThreadId ?? "root"}-${Date.now()}-${randomUUID()}${extensionFor(input.source, input.filePath)}`,
  );
  await writeFile(localPath, Buffer.from(input.bytes));
  return localPath;
}

function selectImageSource(message: TelegramImageMessage): { fileId: string; fileName?: string; mimeType?: string } | null {
  if (message.photo?.length) {
    const sorted = [...message.photo].sort((left, right) => imageScore(right) - imageScore(left));
    const photo = sorted[0];
    return photo ? { fileId: photo.file_id } : null;
  }

  const document = message.document;
  if (!document?.file_id) return null;
  if (!document.mime_type?.startsWith("image/")) return null;
  return {
    fileId: document.file_id,
    ...(document.file_name ? { fileName: document.file_name } : {}),
    ...(document.mime_type ? { mimeType: document.mime_type } : {}),
  };
}

function imageScore(photo: TelegramPhotoSize): number {
  return photo.file_size ?? (photo.width ?? 0) * (photo.height ?? 0);
}

function extensionFor(source: { fileName?: string; mimeType?: string }, filePath: string): string {
  const fromName = source.fileName ? path.extname(source.fileName) : "";
  if (fromName) return fromName;
  const fromPath = path.extname(filePath);
  if (fromPath) return fromPath;
  if (source.mimeType === "image/png") return ".png";
  if (source.mimeType === "image/webp") return ".webp";
  return ".jpg";
}
