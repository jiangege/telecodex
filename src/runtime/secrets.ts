import { Entry } from "@napi-rs/keyring";
import type { AppStateStore } from "../store/appStateStore.js";

const SERVICE = "telecodex";
const ACCOUNT = "telegram-bot-token";
const FALLBACK_KEY = "telegram_bot_token";
export const PLAINTEXT_TOKEN_FALLBACK_ENV = "TELECODEX_ALLOW_PLAINTEXT_TOKEN_FALLBACK";

export type TokenStorageMode = "keyring" | "plaintext-fallback" | "existing";
export type TokenStorageBackend = "keyring" | "plaintext-fallback";

export interface TelegramTokenInspection {
  token: string | null;
  storageMode: TokenStorageBackend | null;
  availableToRuntime: boolean;
  fallbackEnabled: boolean;
}

export class SecretStore {
  private readonly entry = new Entry(SERVICE, ACCOUNT);

  constructor(
    private readonly appState: AppStateStore,
    private readonly options?: { allowPlaintextFallback?: boolean },
  ) {}

  getTelegramBotToken(): string | null {
    const inspection = this.inspectTelegramBotToken();
    return inspection.availableToRuntime ? inspection.token : null;
  }

  inspectTelegramBotToken(): TelegramTokenInspection {
    const fallbackEnabled = Boolean(this.options?.allowPlaintextFallback);
    try {
      const token = this.entry.getPassword();
      if (token) {
        return {
          token,
          storageMode: "keyring",
          availableToRuntime: true,
          fallbackEnabled,
        };
      }
    } catch {
      // Fallback below.
    }

    const fallbackToken = this.appState.get(FALLBACK_KEY);
    if (fallbackToken) {
      return {
        token: fallbackToken,
        storageMode: "plaintext-fallback",
        availableToRuntime: fallbackEnabled,
        fallbackEnabled,
      };
    }

    return {
      token: null,
      storageMode: null,
      availableToRuntime: false,
      fallbackEnabled,
    };
  }

  setTelegramBotToken(token: string): TokenStorageMode {
    try {
      this.entry.setPassword(token);
      this.appState.delete(FALLBACK_KEY);
      return "keyring";
    } catch {
      if (!this.options?.allowPlaintextFallback) {
        throw new Error(
          [
            "System keychain is unavailable, and plaintext Telegram bot token fallback is disabled.",
            `If you accept storing the token unencrypted in local state, set ${PLAINTEXT_TOKEN_FALLBACK_ENV}=1 and run telecodex again.`,
          ].join(" "),
        );
      }
      this.appState.set(FALLBACK_KEY, token);
      return "plaintext-fallback";
    }
  }
}
