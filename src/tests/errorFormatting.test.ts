import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexErrorForUser } from "../codex/errorFormatting.js";

test("formatCodexErrorForUser normalizes upstream websocket 403 HTML failures", () => {
  const message =
    "Reconnecting... 2/5 (unexpected status 403 Forbidden: 154c\r\n<!DOCTYPE html>\n<html>challenge</html>, url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: 123-HKG)";

  assert.equal(
    formatCodexErrorForUser(new Error(message)),
    "Codex backend rejected the connection (403). Refresh the Codex login or try again later.",
  );
});

test("formatCodexErrorForUser strips generic upstream HTML blobs", () => {
  assert.equal(
    formatCodexErrorForUser("500 upstream failure <!DOCTYPE html><html><body>broken</body></html>"),
    "Codex returned an upstream HTML error. Try again later.",
  );
});
