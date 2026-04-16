import type { Update } from "grammy/types";

export const TEST_USER_ID = 8631112361;
export const TEST_GROUP_CHAT_ID = -1003940193016;

export class UpdateFactory {
  private nextUpdateId = 1;
  private nextMessageId = 100;

  text(input: {
    text: string;
    chatId?: number;
    chatType?: "private" | "supergroup";
    messageThreadId?: number | null;
    fromId?: number;
  }): Update {
    return {
      update_id: this.nextUpdateId++,
      message: this.baseMessage({
        chatId: input.chatId ?? TEST_GROUP_CHAT_ID,
        chatType: input.chatType ?? "supergroup",
        fromId: input.fromId ?? TEST_USER_ID,
        messageThreadId: input.messageThreadId ?? null,
        text: input.text,
        entities: commandEntities(input.text),
      }),
    } as unknown as Update;
  }

  photo(input: {
    caption?: string;
    photo: Array<{ file_id: string; width?: number; height?: number; file_size?: number }>;
    chatId?: number;
    messageThreadId?: number | null;
    fromId?: number;
  }): Update {
    return {
      update_id: this.nextUpdateId++,
      message: {
        ...this.baseMessage({
          chatId: input.chatId ?? TEST_GROUP_CHAT_ID,
          chatType: "supergroup",
          fromId: input.fromId ?? TEST_USER_ID,
          messageThreadId: input.messageThreadId ?? null,
        }),
        ...(input.caption ? { caption: input.caption } : {}),
        photo: input.photo.map((photo) => ({
          ...photo,
          file_unique_id: `${photo.file_id}-unique`,
        })),
      },
    } as unknown as Update;
  }

  private baseMessage(input: {
    chatId: number;
    chatType: "private" | "supergroup";
    fromId: number;
    messageThreadId: number | null;
    text?: string;
    entities?: Array<{ offset: number; length: number; type: "bot_command" }> | undefined;
  }) {
    return {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: buildChat(input.chatId, input.chatType),
      from: {
        id: input.fromId,
        is_bot: false,
        first_name: "Test User",
      },
      ...(input.messageThreadId == null ? {} : { message_thread_id: input.messageThreadId, is_topic_message: true }),
      ...(input.text == null ? {} : { text: input.text }),
      ...(input.entities && input.entities.length > 0 ? { entities: input.entities } : {}),
    };
  }
}

function buildChat(chatId: number, chatType: "private" | "supergroup") {
  if (chatType === "private") {
    return {
      id: chatId,
      type: "private" as const,
      first_name: "Test User",
    };
  }
  return {
    id: chatId,
    type: "supergroup" as const,
    title: "telecodex test group",
  };
}

function commandEntities(text: string): Array<{ offset: number; length: number; type: "bot_command" }> | undefined {
  if (!text.startsWith("/")) return undefined;
  const firstSpace = text.indexOf(" ");
  const length = firstSpace >= 0 ? firstSpace : text.length;
  return [
    {
      offset: 0,
      length,
      type: "bot_command",
    },
  ];
}
