import assert from "node:assert/strict";
import path from "node:path";
import { Bot } from "grammy";
import type { AppConfig } from "../../config.js";
import { wireBot } from "../../bot/createBot.js";
import type { TelegramAttachmentIo } from "../../telegram/attachments.js";
import { createFakeThreadCatalog, createNoopLogger, createTestStores } from "../helpers.js";
import { FakeClock } from "./fakeClock.js";
import { ScriptedCodexRuntime } from "./scriptedCodexRuntime.js";
import { TelegramApiRecorder } from "./telegramApiRecorder.js";
import { TEST_GROUP_CHAT_ID, TEST_USER_ID, UpdateFactory } from "./updateFactory.js";

const TEST_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "telecodex",
  username: "telecodex_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_manage_bots: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: true,
  allows_users_to_create_topics: false,
};

export function createScenarioHarness(input?: {
  cwd?: string;
  updateIntervalMs?: number;
  attachmentIo?: Partial<TelegramAttachmentIo>;
}) {
  const stores = createTestStores();
  const recorder = new TelegramApiRecorder();
  const bot = new Bot("test-token");
  bot.botInfo = TEST_BOT_INFO as typeof bot.botInfo;
  recorder.install(bot);

  const clock = new FakeClock();
  const codex = new ScriptedCodexRuntime({
    now: () => clock.now(),
  });
  const threadCatalog = createFakeThreadCatalog();
  const updates = new UpdateFactory();
  const logger = createNoopLogger();
  let attachmentCounter = 0;
  const config: AppConfig = {
    telegramBotToken: "test-token",
    defaultCwd: input?.cwd ?? process.cwd(),
    defaultModel: "gpt-5.4",
    codexBin: "codex",
    updateIntervalMs: input?.updateIntervalMs ?? 1,
  };

  stores.store.claimAuthorizedUserId(TEST_USER_ID);

  const wired = wireBot({
    bot,
    config,
    store: stores.store,
    projects: stores.projects,
    codex: codex as never,
    threadCatalog,
    bootstrapCode: null,
    logger,
    autoInitialize: false,
    bufferOptions: {
      scheduler: clock,
    },
    attachmentIo: {
      fetchBytes: async () => new Uint8Array([1, 2, 3]),
      saveBytes: async ({ source, filePath }) => {
        attachmentCounter += 1;
        return `/tmp/telecodex-attachment-${attachmentCounter}${resolveExtension(source.fileName, filePath)}`;
      },
      ...(input?.attachmentIo ?? {}),
    },
  });

  return {
    bot,
    recorder,
    clock,
    codex,
    threadCatalog,
    config,
    ...stores,
    async initializeRuntime(): Promise<void> {
      await wired.initializeRuntime();
      await flush(clock);
    },
    async sendUpdate(update: Parameters<Bot["handleUpdate"]>[0]): Promise<void> {
      await bot.handleUpdate(update);
      await flush(clock);
    },
    async sendGroupText(text: string, messageThreadId?: number): Promise<void> {
      await this.sendUpdate(
        updates.text({
          text,
          chatId: TEST_GROUP_CHAT_ID,
          chatType: "supergroup",
          messageThreadId: messageThreadId ?? null,
          fromId: TEST_USER_ID,
        }),
      );
    },
    async sendGroupCommand(command: string, args = "", messageThreadId?: number): Promise<void> {
      const text = args ? `/${command} ${args}` : `/${command}`;
      await this.sendGroupText(text, messageThreadId);
    },
    async sendPrivateText(text: string): Promise<void> {
      await this.sendUpdate(
        updates.text({
          text,
          chatId: TEST_USER_ID,
          chatType: "private",
          fromId: TEST_USER_ID,
        }),
      );
    },
    async sendGroupPhoto(
      messageThreadId: number,
      input: { caption?: string; photo: Array<{ file_id: string; width?: number; height?: number; file_size?: number }> },
    ): Promise<void> {
      await this.sendUpdate(
        updates.photo({
          ...input,
          chatId: TEST_GROUP_CHAT_ID,
          messageThreadId,
          fromId: TEST_USER_ID,
        }),
      );
    },
    async advance(ms: number): Promise<void> {
      await clock.tick(ms);
    },
    async waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
      const deadline = clock.now() + timeoutMs;
      while (clock.now() <= deadline) {
        if (predicate()) return;
        await clock.tick(5);
      }
      assert.ok(predicate(), "condition was not met before timeout");
    },
    get sendMessageCalls() {
      return recorder.getCalls("sendMessage");
    },
    get editMessageTextCalls() {
      return recorder.getCalls("editMessageText");
    },
    get sendChatActionCalls() {
      return recorder.getCalls("sendChatAction");
    },
    async cleanup(): Promise<void> {
      wired.buffers.dispose();
      await stores.store.flush();
      stores.cleanup();
    },
  };
}

async function flush(clock: FakeClock): Promise<void> {
  await clock.flush();
  await Promise.resolve();
  await Promise.resolve();
}

function resolveExtension(fileName: string | undefined, filePath: string): string {
  const fromName = fileName ? path.extname(fileName) : "";
  if (fromName) return fromName;
  const fromPath = path.extname(filePath);
  if (fromPath) return fromPath;
  return ".jpg";
}
