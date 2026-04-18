import assert from "node:assert/strict";
import test from "node:test";
import { splitRenderedText } from "../telegram/delivery.js";
import {
  renderMarkdownToTelegramMessage,
  renderTelegramSemanticMessage,
  renderTelegramSemanticText,
} from "../telegram/renderer.js";
import {
  plainTextDoc,
  semanticDoc,
  semanticHeading,
  semanticParagraph,
  semanticText,
  type RenderedTelegramText,
  type TelegramMessageEntity,
} from "../telegram/semantic.js";

test("markdown corpus preserves Telegram formatting invariants", () => {
  const scenarios = [
    {
      name: "rich inline with quote",
      markdown: [
        "# Title",
        "",
        "Paragraph with **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com/docs).",
        "",
        "> Quoted **note**",
      ].join("\n"),
      expectedEntityTypes: ["bold", "italic", "strikethrough", "code", "text_link", "blockquote"],
    },
    {
      name: "raw html and thematic break fallback",
      markdown: [
        "Intro",
        "",
        "---",
        "",
        "<details>open</details>",
        "",
        "[unsafe](javascript:alert(1))",
      ].join("\n"),
      expectedEntityTypes: [],
      expectedTextIncludes: ["Intro", "---", "<details>open</details>", "unsafe"],
    },
    {
      name: "code fence and compact table",
      markdown: [
        "```js",
        "console.log(1);",
        "```",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
      ].join("\n"),
      expectedEntityTypes: ["pre"],
      expectedTextIncludes: ["console.log(1);", "a | b", "1 | 2"],
    },
  ];

  for (const scenario of scenarios) {
    const rendered = renderMarkdownToTelegramMessage(scenario.markdown);
    assert.ok(rendered.body, `${scenario.name}: expected body`);
    assertRenderedTextIntegrity(`${scenario.name} body`, rendered.body);
    assertSplitRoundTrip(`${scenario.name} body`, rendered.body, 23);

    for (const entityType of scenario.expectedEntityTypes) {
      assert.ok(
        rendered.body.entities?.some((entity) => entity.type === entityType),
        `${scenario.name}: missing entity type ${entityType}`,
      );
    }

    for (const text of scenario.expectedTextIncludes ?? []) {
      assert.match(rendered.body.text, new RegExp(escapeRegExp(text)), `${scenario.name}: missing text ${text}`);
    }
  }
});

test("markdown media rendering preserves body, captions, and fallbacks", () => {
  const rendered = renderMarkdownToTelegramMessage(
    [
      "Body before media.",
      "",
      "![Local image](./mockup.png)",
      "",
      "Remote reference: ![Spec](https://example.com/spec.png)",
    ].join("\n"),
  );

  assert.equal(rendered.media.length, 1);
  assert.equal(rendered.media[0]?.source, "./mockup.png");
  assert.equal(rendered.media[0]?.caption?.caption, "Local image");
  assertRenderedTextIntegrity("media mixed body", rendered.body);
  assertSplitRoundTrip("media mixed body", rendered.body, 17);

  assert.ok(
    rendered.body?.entities?.some((entity) => entity.type === "text_link" && entity.url === "https://example.com/spec.png"),
  );
  assertCaptionIntegrity("media mixed caption", rendered.media[0]?.caption);
  assertRenderedTextIntegrity("media mixed fallback", rendered.media[0]?.fallback);
  assertSplitRoundTrip("media mixed fallback", rendered.media[0]?.fallback, 9);

  const imageOnly = renderMarkdownToTelegramMessage("![Generated concept](./concept.png)");
  assert.equal(imageOnly.media.length, 1);
  assert.equal(imageOnly.media[0]?.caption?.caption, "Generated concept");
  assert.equal(imageOnly.body?.text, "Generated concept");
  assertCaptionIntegrity("image only caption", imageOnly.media[0]?.caption);
  assertRenderedTextIntegrity("image only body", imageOnly.body);
});

test("semantic renderer covers internal Telegram-only inline and block features", () => {
  const rendered = renderTelegramSemanticText(
    semanticDoc([
      semanticHeading("Status"),
      {
        type: "notice",
        tone: "warning",
        title: [semanticText("Careful")],
        blocks: [
          semanticParagraph([
            { type: "underline", children: [semanticText("disk")] },
            semanticText(" "),
            { type: "spoiler", children: [semanticText("secret")] },
            semanticText(" "),
            { type: "mention", userId: 42, children: [semanticText("Alice")] },
          ]),
        ],
      },
      {
        type: "quote",
        blocks: [semanticParagraph([{ type: "italic", children: [semanticText("Quoted summary")] }])],
      },
      {
        type: "list",
        items: [
          { kind: "task", depth: 0, state: "doing", content: [semanticText("sync logs")] },
          { kind: "task", depth: 0, state: "blocked", content: [semanticText("ship build")] },
        ],
      },
      semanticParagraph([
        { type: "code", text: "npm test" },
        semanticText(" "),
        { type: "link", href: "https://example.com/runbook", children: [semanticText("runbook")] },
      ]),
    ]),
  );

  assert.ok(rendered);
  assert.match(rendered.text, /⚠️/);
  assert.match(rendered.text, /⏳ sync logs/);
  assert.match(rendered.text, /⚠️ ship build/);
  assert.ok(rendered.entities?.some((entity) => entity.type === "underline"));
  assert.ok(rendered.entities?.some((entity) => entity.type === "spoiler"));
  assert.ok(rendered.entities?.some((entity) => entity.type === "blockquote"));
  assert.ok(rendered.entities?.some((entity) => entity.type === "italic"));
  assert.ok(rendered.entities?.some((entity) => entity.type === "code"));
  assert.ok(rendered.entities?.some((entity) => entity.type === "text_link" && entity.url === "tg://user?id=42"));
  assert.ok(rendered.entities?.some((entity) => entity.type === "text_link" && entity.url === "https://example.com/runbook"));
  assertRenderedTextIntegrity("semantic renderer body", rendered);
  assertSplitRoundTrip("semantic renderer body", rendered, 19);
});

test("semantic media rendering preserves caption entities and synthesized fallback body", () => {
  const rendered = renderTelegramSemanticMessage(
    semanticDoc([], [
      {
        source: "./chart.png",
        altText: "Chart",
        caption: semanticDoc([
          semanticParagraph([
            { type: "bold", children: [semanticText("Chart")] },
            semanticText(" "),
            { type: "link", href: "https://example.com/spec", children: [semanticText("spec")] },
          ]),
        ]),
        fallback: plainTextDoc("Chart fallback"),
      },
      {
        source: "./notes.png",
        altText: "Notes",
        fallback: plainTextDoc("Notes fallback"),
      },
    ]),
  );

  assert.equal(rendered.body?.text, "Chart fallback\n\nNotes fallback");
  assertRenderedTextIntegrity("semantic media fallback body", rendered.body);
  assertSplitRoundTrip("semantic media fallback body", rendered.body, 11);

  assert.equal(rendered.media.length, 2);
  assert.equal(rendered.media[0]?.caption?.caption, "Chart spec");
  assertCaptionIntegrity("semantic media caption", rendered.media[0]?.caption);
  assert.ok(
    rendered.media[0]?.caption?.caption_entities?.some((entity) => entity.type === "text_link" && entity.url === "https://example.com/spec"),
  );
  assertRenderedTextIntegrity("semantic media item fallback", rendered.media[0]?.fallback);
  assertRenderedTextIntegrity("semantic media second fallback", rendered.media[1]?.fallback);
});

function assertCaptionIntegrity(label: string, caption: { caption: string; caption_entities?: TelegramMessageEntity[] } | undefined): void {
  assert.ok(caption, `${label}: expected caption`);
  if (!caption) return;
  const renderedCaption: RenderedTelegramText = caption.caption_entities
    ? { text: caption.caption, entities: caption.caption_entities }
    : { text: caption.caption };
  assertRenderedTextIntegrity(label, renderedCaption);
}

function assertRenderedTextIntegrity(label: string, rendered: RenderedTelegramText | null | undefined): void {
  assert.ok(rendered, `${label}: expected rendered text`);
  if (!rendered) return;

  const entities = rendered.entities ?? [];
  assert.deepEqual(entities, [...entities].sort(compareEntities), `${label}: entities are not sorted`);

  entities.forEach((entity, index) => {
    assert.ok(Number.isInteger(entity.offset), `${label}: entity ${index} offset must be an integer`);
    assert.ok(Number.isInteger(entity.length), `${label}: entity ${index} length must be an integer`);
    assert.ok(entity.length > 0, `${label}: entity ${index} length must be positive`);
    assert.ok(entity.offset >= 0, `${label}: entity ${index} offset must be non-negative`);
    assert.ok(
      entity.offset + entity.length <= rendered.text.length,
      `${label}: entity ${index} exceeds text length`,
    );
    assert.ok(
      rendered.text.slice(entity.offset, entity.offset + entity.length).length > 0,
      `${label}: entity ${index} must point to non-empty text`,
    );
    if (entity.type === "text_link") {
      assert.ok(entity.url, `${label}: text_link entity ${index} requires url`);
    }
  });
}

function assertSplitRoundTrip(label: string, rendered: RenderedTelegramText | null | undefined, limit: number): void {
  assert.ok(rendered, `${label}: expected rendered text`);
  if (!rendered) return;

  const chunks = splitRenderedText(rendered, limit);
  assert.ok(chunks.length > 0, `${label}: expected at least one chunk`);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), rendered.text, `${label}: chunks must rejoin to the original text`);

  const originalEntities = rendered.entities ?? [];
  const coverage = new Array<number>(originalEntities.length).fill(0);

  let cursor = 0;
  chunks.forEach((chunk, chunkIndex) => {
    assert.ok(chunk.text.length > 0, `${label}: chunk ${chunkIndex} must not be empty`);
    assertRenderedTextIntegrity(`${label} chunk ${chunkIndex}`, chunk);
    assert.equal(
      rendered.text.slice(cursor, cursor + chunk.text.length),
      chunk.text,
      `${label}: chunk ${chunkIndex} must preserve original text order`,
    );

    for (const entity of chunk.entities ?? []) {
      const absoluteStart = cursor + entity.offset;
      const absoluteEnd = absoluteStart + entity.length;
      const matchIndex = originalEntities.findIndex((original, index) =>
        sameEntityMetadata(original, entity) &&
        absoluteStart >= original.offset &&
        absoluteEnd <= original.offset + original.length &&
        (coverage[index] ?? 0) + entity.length <= original.length
      );

      if (matchIndex < 0) {
        assert.fail(`${label}: chunk ${chunkIndex} entity does not map back to the source entity set`);
      }
      coverage[matchIndex] = (coverage[matchIndex] ?? 0) + entity.length;
    }

    cursor += chunk.text.length;
  });

  assert.equal(cursor, rendered.text.length, `${label}: chunk cursor must consume the full text`);
  originalEntities.forEach((entity, index) => {
    assert.equal(
      coverage[index],
      entity.length,
      `${label}: entity ${index} coverage mismatch after splitting`,
    );
  });
}

function compareEntities(left: TelegramMessageEntity, right: TelegramMessageEntity): number {
  if (left.offset !== right.offset) return left.offset - right.offset;
  if (left.length !== right.length) return right.length - left.length;
  return left.type.localeCompare(right.type);
}

function sameEntityMetadata(left: TelegramMessageEntity, right: TelegramMessageEntity): boolean {
  return left.type === right.type && left.url === right.url && left.language === right.language;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
