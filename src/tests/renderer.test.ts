import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownForTelegram, renderMarkdownToTelegramHtml } from "../telegram/renderer.js";

test("renderMarkdownForTelegram escapes anchor attributes safely", () => {
  const rendered = renderMarkdownForTelegram('[link](https://example.com/?q="hello"&x=1)').join("");
  assert.match(rendered, /<a href="https:\/\/example.com\/\?q=%22hello%22&amp;x=1">link<\/a>/);
});

test("renderMarkdownForTelegram drops unsafe link protocols", () => {
  const rendered = renderMarkdownForTelegram("[link](javascript:alert(1))").join("");
  assert.doesNotMatch(rendered, /<a href=/);
  assert.match(rendered, /link/);
});

test("renderMarkdownToTelegramHtml keeps nested list hierarchy readable", () => {
  const rendered = renderMarkdownToTelegramHtml("- a\n  - b\n    1. c\n- d");
  assert.equal(rendered, "- a\n&#160;&#160;- b\n&#160;&#160;&#160;&#160;1. c\n- d");
});

test("renderMarkdownToTelegramHtml formats task lists without raw bullet markers", () => {
  const rendered = renderMarkdownToTelegramHtml("- [ ] todo\n- [x] done");
  assert.equal(rendered, "[ ] todo\n[x] done");
});

test("renderMarkdownToTelegramHtml renders compact tables as monospace blocks", () => {
  const rendered = renderMarkdownToTelegramHtml("| a | b |\n| - | - |\n| 1 | 2 |");
  assert.equal(rendered, "<pre><code>a | b\n- | -\n1 | 2</code></pre>");
});

test("renderMarkdownToTelegramHtml degrades wide tables into labeled rows", () => {
  const rendered = renderMarkdownToTelegramHtml(
    "| name | note |\n| - | - |\n| alpha | this is a very long note that should not stay as a compact monospace table on a narrow display |",
  );
  assert.match(rendered, /<b>Table<\/b>/);
  assert.match(rendered, /<b>Row 1<\/b>/);
  assert.match(rendered, /name: alpha/);
  assert.match(rendered, /note: this is a very long note/);
  assert.doesNotMatch(rendered, /<pre><code>/);
});
