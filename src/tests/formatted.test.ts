import assert from "node:assert/strict";
import test from "node:test";
import { GrammyError } from "grammy";
import { codeField, renderReplyDocument, replyDocument, replyError, replyNotice, replyUsage, sendReplyNotice, textField } from "../telegram/formatted.js";

test("reply documents enforce the standard Telegram reply shape", () => {
  const message = renderReplyDocument({
    title: "Saved Codex threads",
    fields: [
      codeField("project", "telecodex"),
      textField("state", "ready"),
    ],
    sections: [
      {
        title: "1. First saved thread",
        fields: [
          codeField("id", "thread-1"),
          codeField("resume", "/thread resume thread-1"),
        ],
      },
    ],
    footer: "Copy an id or resume command from the code-formatted fields above.",
  });

  assert.equal(
    message.text,
    [
      "Saved Codex threads",
      "project: telecodex",
      "state: ready",
      "",
      "1. First saved thread",
      "id: thread-1",
      "resume: /thread resume thread-1",
      "",
      "Copy an id or resume command from the code-formatted fields above.",
    ].join("\n"),
  );
  assert.ok(hasEntity(message.entities, message.text, "bold", "Saved Codex threads"));
  assert.ok(hasEntity(message.entities, message.text, "code", "telecodex"));
  assert.ok(hasEntity(message.entities, message.text, "bold", "1. First saved thread"));
  assert.ok(hasEntity(message.entities, message.text, "code", "thread-1"));
  assert.ok(hasEntity(message.entities, message.text, "code", "/thread resume thread-1"));
});

test("replyDocument sends text with entities and disables link previews", async () => {
  const replies: Array<{ text: string; options: unknown }> = [];
  const ctx = {
    async reply(text: string, options?: unknown) {
      replies.push({ text, options });
    },
  };

  await replyDocument(ctx as never, {
    title: "Header",
    fields: [codeField("id", "thread-1")],
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.text, "Header\nid: thread-1");
  const options = replies[0]!.options as {
    entities?: Array<{ type: string; offset: number; length: number }>;
    link_preview_options?: { is_disabled?: boolean };
    parse_mode?: string;
  };
  assert.equal(options.parse_mode, undefined);
  assert.deepEqual(options.link_preview_options, { is_disabled: true });
  assert.ok(hasEntity(options.entities, replies[0]!.text, "bold", "Header"));
  assert.ok(hasEntity(options.entities, replies[0]!.text, "code", "thread-1"));
});

test("short reply helpers keep notices, errors, and usage compact", async () => {
  const replies: Array<{ text: string; options: unknown }> = [];
  const ctx = {
    async reply(text: string, options?: unknown) {
      replies.push({ text, options });
    },
  };

  await replyNotice(ctx as never, "Saved.");
  await replyError(ctx as never, "Invalid preset.", "Usage: /mode write|read-only");
  await replyUsage(ctx as never, ["/thread list", "/thread resume <threadId>"]);

  assert.deepEqual(
    replies.map((reply) => reply.text),
    [
      "Saved.",
      "Invalid preset.\nUsage: /mode write|read-only",
      "Usage:\n/thread list\n/thread resume <threadId>",
    ],
  );
  for (const reply of replies) {
    const options = reply.options as {
      link_preview_options?: { is_disabled?: boolean };
      parse_mode?: string;
    };
    assert.equal(options.parse_mode, undefined);
    assert.deepEqual(options.link_preview_options, { is_disabled: true });
  }
});

test("sendReplyNotice sends entity-based Telegram messages without parse mode", async () => {
  const sent: Array<{ chatId: number; text: string; options: Record<string, unknown> | undefined }> = [];
  const bot = {
    api: {
      async sendMessage(chatId: number, text: string, options?: Record<string, unknown>) {
        sent.push({ chatId, text, options });
        return { message_id: 1 };
      },
    },
  };

  await sendReplyNotice(
    bot as never,
    {
      chatId: -100,
      messageThreadId: 42,
    },
    ["Ready.", codeField("cwd", "/repo").value ? "cwd: /repo" : ""],
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, -100);
  assert.equal(sent[0]!.text, "Ready.\ncwd: /repo");
  assert.deepEqual(sent[0]!.options?.link_preview_options, { is_disabled: true });
  assert.equal(sent[0]!.options?.parse_mode, undefined);
  assert.equal(sent[0]!.options?.message_thread_id, 42);
});

test("sendReplyNotice retries on Telegram 429", async () => {
  let calls = 0;
  const bot = {
    api: {
      async sendMessage() {
        calls += 1;
        if (calls < 3) {
          throw fakeGrammyError("Too Many Requests: retry after 0.001", 0.001);
        }
        return { message_id: 1 };
      },
    },
  };

  await sendReplyNotice(
    bot as never,
    {
      chatId: -100,
      messageThreadId: 42,
    },
    "retry me",
  );

  assert.equal(calls, 3);
});

test("sendReplyNotice splits long entity-based messages safely", async () => {
  const sent: Array<{ text: string; options: Record<string, unknown> | undefined }> = [];
  const bot = {
    api: {
      async sendMessage(_chatId: number, text: string, options?: Record<string, unknown>) {
        sent.push({ text, options });
        return { message_id: sent.length };
      },
    },
  };

  await sendReplyNotice(
    bot as never,
    {
      chatId: -100,
      messageThreadId: 42,
    },
    renderReplyDocument({
      title: "Schema",
      fields: [codeField("schema", "x".repeat(5000))],
    }),
  );

  assert.ok(sent.length > 1);
  for (const message of sent) {
    assert.ok(message.text.length <= 3900);
    assert.equal(message.options?.parse_mode, undefined);
    assert.deepEqual(message.options?.link_preview_options, { is_disabled: true });
    const entities = message.options?.entities as Array<{ type: string; offset: number; length: number }> | undefined;
    assert.ok(entities?.some((entity) => entity.type === "code") ?? false);
  }
});

test("sendReplyNotice preserves mixed entities across chunks", async () => {
  const sent: Array<{ text: string; options: Record<string, unknown> | undefined }> = [];
  const bot = {
    api: {
      async sendMessage(_chatId: number, text: string, options?: Record<string, unknown>) {
        sent.push({ text, options });
        return { message_id: sent.length };
      },
    },
  };

  await sendReplyNotice(
    bot as never,
    {
      chatId: -100,
      messageThreadId: 42,
    },
    renderReplyDocument({
      title: `Plan 😀 ${"alpha ".repeat(700)}`,
      sections: [
        {
          title: "Steps",
          fields: [
            codeField("resume", `/thread resume ${"thread-123 ".repeat(250)}`),
            textField("state", `ready 😀 ${"beta ".repeat(500)}`),
          ],
        },
      ],
    }),
  );

  assert.ok(sent.length > 1);
  assert.ok(sent.some((message) => (message.options?.entities as Array<{ type: string }> | undefined)?.some((entity) => entity.type === "bold")));
  assert.ok(sent.some((message) => (message.options?.entities as Array<{ type: string }> | undefined)?.some((entity) => entity.type === "code")));
});

function hasEntity(
  entities: Array<{ type: string; offset: number; length: number }> | undefined,
  text: string,
  type: string,
  value: string,
): boolean {
  const offset = text.indexOf(value);
  return entities?.some((entity) => entity.type === type && entity.offset === offset && entity.length === value.length) ?? false;
}

function fakeGrammyError(description: string, retryAfter: number): GrammyError {
  const error = new Error(description) as GrammyError & {
    description: string;
    parameters: { retry_after: number };
  };
  Object.setPrototypeOf(error, GrammyError.prototype);
  error.description = description;
  error.parameters = { retry_after: retryAfter };
  return error;
}
