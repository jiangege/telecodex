import type { Bot, Transformer } from "grammy";

interface ApiResponseLike<T = unknown> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: Record<string, unknown>;
}

type RecorderHandler = (payload: Record<string, unknown>) => Promise<ApiResponseLike | unknown> | ApiResponseLike | unknown;

export interface TelegramApiCallRecord {
  seq: number;
  method: string;
  payload: Record<string, unknown>;
  response: unknown;
}

export class TelegramApiRecorder {
  readonly calls: TelegramApiCallRecord[] = [];
  private nextSeq = 1;
  private nextMessageId = 1;
  private readonly queuedHandlers = new Map<string, RecorderHandler[]>();
  private readonly persistentHandlers = new Map<string, RecorderHandler>();

  install(bot: Bot): void {
    bot.api.config.use(this.transformer);
  }

  setHandler(method: string, handler: RecorderHandler): void {
    this.persistentHandlers.set(method, handler);
  }

  enqueueHandler(method: string, handler: RecorderHandler): void {
    const queue = this.queuedHandlers.get(method) ?? [];
    queue.push(handler);
    this.queuedHandlers.set(method, queue);
  }

  getCalls(method?: string): TelegramApiCallRecord[] {
    return method ? this.calls.filter((call) => call.method === method) : [...this.calls];
  }

  lastCall(method: string): TelegramApiCallRecord | null {
    const calls = this.getCalls(method);
    return calls.at(-1) ?? null;
  }

  private readonly transformer: Transformer = async (_prev, method, payload) => {
    const response = await this.resolveResponse(String(method), payload as Record<string, unknown>);
    const normalized = normalizeApiResponse(response);
    this.calls.push({
      seq: this.nextSeq++,
      method: String(method),
      payload: clone(payload),
      response: clone(normalized.ok ? normalized.result : normalized),
    });
    return normalized as any;
  };

  private async resolveResponse(method: string, payload: Record<string, unknown>): Promise<ApiResponseLike | unknown> {
    const queued = this.queuedHandlers.get(method);
    if (queued && queued.length > 0) {
      const handler = queued.shift();
      if (queued.length === 0) {
        this.queuedHandlers.delete(method);
      }
      return handler?.(payload);
    }

    const persistent = this.persistentHandlers.get(method);
    if (persistent) {
      return persistent(payload);
    }

    return this.defaultResponse(method, payload);
  }

  private defaultResponse(method: string, payload: Record<string, unknown>): unknown {
    switch (method) {
      case "sendMessage":
        return {
          message_id: this.nextMessageId++,
          date: 0,
          text: payload.text,
          chat: {
            id: payload.chat_id,
            type: resolveChatType(payload.chat_id),
          },
          ...(payload.message_thread_id == null ? {} : { message_thread_id: payload.message_thread_id }),
        };
      case "editMessageText":
      case "sendChatAction":
      case "setMyCommands":
      case "editForumTopic":
      case "deleteForumTopic":
      case "answerCallbackQuery":
        return true;
      case "getFile":
        return {
          file_id: payload.file_id,
          file_path: `photos/${String(payload.file_id ?? "file")}.jpg`,
        };
      default:
        throw new Error(`Unhandled Telegram API method in recorder: ${method}`);
    }
  }
}

function normalizeApiResponse(value: unknown): ApiResponseLike {
  if (isApiResponseLike(value)) {
    return value;
  }
  return {
    ok: true,
    result: value,
  };
}

function isApiResponseLike(value: unknown): value is ApiResponseLike {
  return typeof value === "object" && value != null && "ok" in value;
}

function resolveChatType(chatId: unknown): "private" | "supergroup" {
  return typeof chatId === "number" && chatId < 0 ? "supergroup" : "private";
}

function clone<T>(value: T): T {
  return typeof value === "undefined" ? value : structuredClone(value);
}
