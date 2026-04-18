import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownToTelegramMessage } from "../telegram/renderer.js";

test("renderMarkdownToTelegramMessage preserves safe links as Telegram entities", () => {
  const rendered = renderMarkdownToTelegramMessage('[link](https://example.com/?q="hello"&x=1)');
  const body = rendered.body;

  assert.ok(body);
  assert.equal(body.text, "link");
  assert.ok(body.entities?.some((entity) => entity.type === "text_link" && entity.url === "https://example.com/?q=%22hello%22&x=1"));
});

test("renderMarkdownToTelegramMessage drops unsafe link protocols", () => {
  const rendered = renderMarkdownToTelegramMessage("[link](javascript:alert(1))");
  const body = rendered.body;

  assert.ok(body);
  assert.equal(body.text, "link");
  assert.ok((body.entities ?? []).every((entity) => entity.type !== "text_link"));
});

test("renderMarkdownToTelegramMessage keeps nested list hierarchy readable", () => {
  const rendered = renderMarkdownToTelegramMessage("- a\n  - b\n    1. c\n- d");
  assert.equal(rendered.body?.text, "- a\n\u00a0\u00a0- b\n\u00a0\u00a0\u00a0\u00a01. c\n- d");
});

test("renderMarkdownToTelegramMessage formats task lists with semantic emoji fallback", () => {
  const rendered = renderMarkdownToTelegramMessage("- [ ] todo\n- [x] done");
  assert.equal(rendered.body?.text, "☐ todo\n✅ done");
});

test("renderMarkdownToTelegramMessage preserves fenced code language on pre entities", () => {
  const rendered = renderMarkdownToTelegramMessage("```ts\nconst value = 1;\n```");
  const body = rendered.body;

  assert.ok(body);
  assert.equal(body.text, "const value = 1;");
  assert.ok(body.entities?.some((entity) => entity.type === "pre" && entity.language === "ts"));
});

test("renderMarkdownToTelegramMessage renders compact tables as monospace blocks", () => {
  const rendered = renderMarkdownToTelegramMessage("| a | b |\n| - | - |\n| 1 | 2 |");
  const body = rendered.body;

  assert.ok(body);
  assert.equal(body.text, "a | b\n- | -\n1 | 2");
  assert.ok(body.entities?.some((entity) => entity.type === "pre" && entity.offset === 0 && entity.length === body.text.length));
});

test("renderMarkdownToTelegramMessage degrades wide tables into labeled rows", () => {
  const rendered = renderMarkdownToTelegramMessage(
    "| name | note |\n| - | - |\n| alpha | this is a very long note that should not stay as a compact monospace table on a narrow display |",
  );
  const body = rendered.body;

  assert.ok(body);
  assert.match(body.text, /Table/);
  assert.match(body.text, /Row 1/);
  assert.match(body.text, /name: alpha/);
  assert.match(body.text, /note: this is a very long note/);
  assert.ok((body.entities ?? []).every((entity) => entity.type !== "pre"));
});

test("renderMarkdownToTelegramMessage extracts local images and degrades remote images into text links", () => {
  const rendered = renderMarkdownToTelegramMessage(
    "Here is the result.\n\n![Wireframe](/tmp/mockup.png)\n\nAnd a reference: ![Remote](https://example.com/ref.jpg)",
  );

  assert.equal(rendered.media.length, 1);
  assert.equal(rendered.media[0]?.source, "/tmp/mockup.png");
  assert.equal(rendered.media[0]?.caption?.caption, "Wireframe");

  const body = rendered.body;
  assert.ok(body);
  assert.match(body.text, /Here is the result\./);
  assert.match(body.text, /And a reference: Remote/);
  assert.ok(body.entities?.some((entity) => entity.type === "text_link" && entity.url === "https://example.com/ref.jpg"));
});
