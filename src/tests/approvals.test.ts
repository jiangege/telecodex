import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalManager } from "../codex/approvals.js";
import { createNoopLogger, createFakeBot, createTestSessionStore } from "./helpers.js";

test("approval request updates runtime state and renders command context", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:55",
      chatId: "-100",
      messageThreadId: "55",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-55");

    const gateway = {
      respond: () => undefined,
      reject: () => undefined,
    } as never;

    const approvals = new ApprovalManager(bot, gateway, store, createNoopLogger());
    await approvals.handleServerRequest({
      id: "req-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-55",
        turnId: "turn-55",
        itemId: "item-55",
        command: "npm test",
        cwd: process.cwd(),
        reason: "run verification",
        availableDecisions: ["accept", "decline"],
      },
    } as never);

    const latest = store.get(session.sessionKey);
    assert.equal(latest?.runtimeStatus, "waiting_approval");
    assert.match(latest?.runtimeStatusDetail ?? "", /approval: npm test/);
    assert.match(sent.at(-1)?.text ?? "", /Codex 请求执行命令/);
    assert.match(sent.at(-1)?.text ?? "", /thread-55/);
    assert.match(sent.at(-1)?.text ?? "", /turn-55/);
    assert.match(sent.at(-1)?.text ?? "", /run verification/);
  } finally {
    cleanup();
  }
});

test("legacy patch approval renders file summary", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:56",
      chatId: "-100",
      messageThreadId: "56",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-56");

    const gateway = {
      respond: () => undefined,
      reject: () => undefined,
    } as never;

    const approvals = new ApprovalManager(bot, gateway, store, createNoopLogger());
    await approvals.handleServerRequest({
      id: "req-2",
      method: "applyPatchApproval",
      params: {
        conversationId: "thread-56",
        callId: "call-56",
        reason: "write project files",
        grantRoot: process.cwd(),
        fileChanges: {
          "src/a.ts": { status: "added" },
          "src/b.ts": { status: "modified" },
        },
      },
    } as never);

    assert.match(sent.at(-1)?.text ?? "", /文件数:/);
    assert.match(sent.at(-1)?.text ?? "", /src\/a\.ts/);
    assert.match(sent.at(-1)?.text ?? "", /src\/b\.ts/);
  } finally {
    cleanup();
  }
});

test("approval callback can be handled after manager recreation", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:57",
      chatId: "-100",
      messageThreadId: "57",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-57");

    const responses: unknown[] = [];
    const gateway = {
      respond: (_requestId: string, payload: unknown) => responses.push(payload),
      reject: () => undefined,
    } as never;

    const first = new ApprovalManager(bot, gateway, store, createNoopLogger());
    await first.handleServerRequest({
      id: "req-3",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-57",
        turnId: "turn-57",
        itemId: "item-57",
        command: "npm run lint",
        cwd: process.cwd(),
      },
    } as never);

    const pending = store.getOldestPendingInteractionForSession(session.sessionKey);
    assert.ok(pending);

    const second = new ApprovalManager(bot, gateway, store, createNoopLogger());
    const handled = await second.handleCallback({
      callbackQuery: {
        data: `approval:${pending!.interactionId}:accept`,
      },
      answerCallbackQuery: async () => undefined,
    } as never);

    assert.equal(handled, true);
    assert.deepEqual(responses.at(-1), { decision: "accept" });
    assert.equal(store.getPendingInteraction(pending!.interactionId), null);
  } finally {
    cleanup();
  }
});

test("tool request user input can be answered by text reply", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:58",
      chatId: "-100",
      messageThreadId: "58",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-58");

    const responses: unknown[] = [];
    const replies: string[] = [];
    const gateway = {
      respond: (_requestId: string, payload: unknown) => responses.push(payload),
      reject: () => undefined,
    } as never;

    const approvals = new ApprovalManager(bot, gateway, store, createNoopLogger());
    await approvals.handleServerRequest({
      id: "req-4",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-58",
        turnId: "turn-58",
        itemId: "item-58",
        questions: [
          {
            id: "language",
            header: "Language",
            question: "Choose a language",
            isOther: false,
            isSecret: false,
            options: [
              { label: "TypeScript", description: "preferred" },
              { label: "Python", description: "fallback" },
            ],
          },
        ],
      },
    } as never);

    const handled = await approvals.handleTextReply({
      chat: { id: -100 },
      message: {
        text: "TypeScript",
        message_thread_id: 58,
      },
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    } as never);

    assert.equal(handled, true);
    assert.deepEqual(responses.at(-1), {
      answers: {
        language: {
          answers: ["TypeScript"],
        },
      },
    });
    assert.match(replies.at(-1) ?? "", /已提交给 Codex/);
  } finally {
    cleanup();
  }
});

test("permissions approval grants requested scope", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:59",
      chatId: "-100",
      messageThreadId: "59",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-59");

    const responses: unknown[] = [];
    const gateway = {
      respond: (_requestId: string, payload: unknown) => responses.push(payload),
      reject: () => undefined,
    } as never;

    const approvals = new ApprovalManager(bot, gateway, store, createNoopLogger());
    await approvals.handleServerRequest({
      id: "req-5",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-59",
        turnId: "turn-59",
        itemId: "item-59",
        reason: "need writes",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: [process.cwd()],
            write: [process.cwd()],
          },
        },
      },
    } as never);

    const pending = store.getOldestPendingInteractionForSession(session.sessionKey);
    assert.ok(pending);
    await approvals.handleCallback({
      callbackQuery: {
        data: `approval:${pending!.interactionId}:acceptForSession`,
      },
      answerCallbackQuery: async () => undefined,
    } as never);

    assert.deepEqual(responses.at(-1), {
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: [process.cwd()],
          write: [process.cwd()],
        },
      },
      scope: "session",
    });
  } finally {
    cleanup();
  }
});

test("mcp form request can be answered by structured text reply", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:60",
      chatId: "-100",
      messageThreadId: "60",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-60");

    const responses: unknown[] = [];
    const gateway = {
      respond: (_requestId: string, payload: unknown) => responses.push(payload),
      reject: () => undefined,
    } as never;

    const approvals = new ApprovalManager(bot, gateway, store, createNoopLogger());
    await approvals.handleServerRequest({
      id: "req-6",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-60",
        turnId: "turn-60",
        serverName: "docs",
        mode: "form",
        _meta: null,
        message: "Need repository details",
        requestedSchema: {
          type: "object",
          properties: {
            owner: { type: "string", title: "Owner" },
            stars: { type: "integer", title: "Stars" },
          },
          required: ["owner", "stars"],
        },
      },
    } as never);

    const handled = await approvals.handleTextReply({
      chat: { id: -100 },
      message: {
        text: "owner: openai\nstars: 42",
        message_thread_id: 60,
      },
      reply: async () => undefined,
    } as never);

    assert.equal(handled, true);
    assert.deepEqual(responses.at(-1), {
      action: "accept",
      content: {
        owner: "openai",
        stars: 42,
      },
      _meta: null,
    });
  } finally {
    cleanup();
  }
});

test("mcp url request can be resolved by callback action", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:61",
      chatId: "-100",
      messageThreadId: "61",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-61");

    const responses: unknown[] = [];
    const gateway = {
      respond: (_requestId: string, payload: unknown) => responses.push(payload),
      reject: () => undefined,
    } as never;

    const approvals = new ApprovalManager(bot, gateway, store, createNoopLogger());
    await approvals.handleServerRequest({
      id: "req-7",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-61",
        turnId: "turn-61",
        serverName: "github",
        mode: "url",
        _meta: null,
        message: "Open the authorization page",
        url: "https://example.com/auth",
      },
    } as never);

    const latest = store.get(session.sessionKey);
    assert.equal(latest?.runtimeStatus, "waiting_input");
    assert.match(sent.at(-1)?.text ?? "", /外部步骤/);
    assert.match(sent.at(-1)?.text ?? "", /https:\/\/example\.com\/auth/);

    const pending = store.getOldestPendingInteractionForSession(session.sessionKey);
    assert.ok(pending);

    const handled = await approvals.handleCallback({
      callbackQuery: {
        data: `interaction:${pending!.interactionId}:action:accept`,
      },
      answerCallbackQuery: async () => undefined,
    } as never);

    assert.equal(handled, true);
    assert.deepEqual(responses.at(-1), {
      action: "accept",
      content: null,
      _meta: null,
    });
  } finally {
    cleanup();
  }
});
