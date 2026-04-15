import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexConfigOverrides, tryParseCodexConfigOverrides } from "../codex/configOverrides.js";

test("parseCodexConfigOverrides accepts nested JSON objects made of scalar-like values", () => {
  assert.deepEqual(
    parseCodexConfigOverrides('{"model_verbosity":"high","nested":{"retries":2,"enabled":true,"list":["a",3,false]}}'),
    {
      model_verbosity: "high",
      nested: {
        retries: 2,
        enabled: true,
        list: ["a", 3, false],
      },
    },
  );
});

test("tryParseCodexConfigOverrides reports invalid stored config cleanly", () => {
  const result = tryParseCodexConfigOverrides('{"bad":null}');
  assert.equal(result.value, undefined);
  assert.match(result.error?.message ?? "", /may only contain string, number, boolean, array, or object values/i);
});
