import type { CodexOptions } from "@openai/codex-sdk";

export function parseCodexConfigOverrides(raw: string): NonNullable<CodexOptions["config"]> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Codex config overrides must be a JSON object.");
  }
  assertCodexConfigValue(parsed, "config");
  return parsed as NonNullable<CodexOptions["config"]>;
}

export function tryParseCodexConfigOverrides(raw: string | null): {
  value: NonNullable<CodexOptions["config"]> | undefined;
  error: Error | null;
} {
  if (!raw) {
    return {
      value: undefined,
      error: null,
    };
  }

  try {
    return {
      value: parseCodexConfigOverrides(raw),
      error: null,
    };
  } catch (error) {
    return {
      value: undefined,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function assertCodexConfigValue(value: unknown, path: string): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertCodexConfigValue(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!key) throw new Error("Codex config override key cannot be empty.");
      assertCodexConfigValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} may only contain string, number, boolean, array, or object values.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
