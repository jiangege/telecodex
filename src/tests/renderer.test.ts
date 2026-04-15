import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownForTelegram } from "../telegram/renderer.js";

test("renderMarkdownForTelegram escapes anchor attributes safely", () => {
  const rendered = renderMarkdownForTelegram('[link](https://example.com/?q="hello"&x=1)').join("");
  assert.match(rendered, /<a href="https:\/\/example.com\/\?q=%22hello%22&amp;x=1">link<\/a>/);
});

test("renderMarkdownForTelegram drops unsafe link protocols", () => {
  const rendered = renderMarkdownForTelegram("[link](javascript:alert(1))").join("");
  assert.doesNotMatch(rendered, /<a href=/);
  assert.match(rendered, /link/);
});
