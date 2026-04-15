import assert from "node:assert/strict";
import test from "node:test";
import { registerHandlers } from "../bot/registerHandlers.js";

test("registerHandlers wires the SDK-first command and message entrypoints", () => {
  const commands: string[][] = [];
  const events: Array<string | string[]> = [];

  const bot = {
    command(command: string | string[], _handler: unknown) {
      commands.push(Array.isArray(command) ? command : [command]);
      return this;
    },
    on(event: string | string[], _handler: unknown) {
      events.push(event);
      return this;
    },
  };

  registerHandlers({
    bot: bot as never,
    config: {} as never,
    store: {} as never,
    projects: {} as never,
    codex: {} as never,
    buffers: {} as never,
  });

  assert.deepEqual(
    new Set(commands.flat()),
    new Set([
      "start",
      "help",
      "status",
      "queue",
      "stop",
      "project",
      "thread",
      "cwd",
      "mode",
      "sandbox",
      "approval",
      "yolo",
      "model",
      "effort",
      "web",
      "network",
      "gitcheck",
      "adddir",
      "schema",
      "codexconfig",
    ]),
  );

  assert.deepEqual(events, [["message:forum_topic_created", "message:forum_topic_edited"], "message:text", ["message:photo", "message:document"]]);
});
