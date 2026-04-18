import type { FileStateStorage } from "./fileState.js";

export type BindingCodeMode = "bootstrap" | "rebind";

export const BINDING_CODE_TTL_MS = 15 * 60 * 1000;
export const BINDING_CODE_MAX_ATTEMPTS = 5;

export interface BindingCodeState {
  code: string;
  mode: BindingCodeMode;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
  issuedByUserId: number | null;
}

export interface BindingCodeAttemptResult {
  attempts: number;
  remaining: number;
  exhausted: boolean;
}

export class AdminStore {
  constructor(private readonly storage: FileStateStorage) {}

  flush(): Promise<void> {
    return this.storage.flush();
  }

  getAuthorizedUserId(): number | null {
    const value = this.storage.getAppState("authorized_user_id");
    if (value == null) return null;
    const userId = Number(value);
    return Number.isSafeInteger(userId) ? userId : null;
  }

  getBindingCodeState(now = new Date()): BindingCodeState | null {
    const code = this.storage.getAppState("bootstrap_code");
    const createdAt = this.storage.getAppState("binding_code_created_at");
    const expiresAt = this.storage.getAppState("binding_code_expires_at");
    if (!code || !createdAt || !expiresAt) return null;

    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
      this.clearBindingCode();
      return null;
    }

    const attempts = normalizeNonNegativeInteger(this.storage.getAppState("binding_code_attempts"));
    if (attempts >= BINDING_CODE_MAX_ATTEMPTS) {
      this.clearBindingCode();
      return null;
    }

    return {
      code,
      mode: normalizeBindingCodeMode(this.storage.getAppState("binding_code_mode")),
      createdAt,
      expiresAt,
      attempts,
      maxAttempts: BINDING_CODE_MAX_ATTEMPTS,
      issuedByUserId: normalizeOptionalUserId(this.storage.getAppState("binding_code_issued_by_user_id")),
    };
  }

  issueBindingCode(input: {
    code: string;
    mode: BindingCodeMode;
    now?: Date;
    ttlMs?: number;
    issuedByUserId?: number | null;
  }): BindingCodeState {
    const now = input.now ?? new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? BINDING_CODE_TTL_MS)).toISOString();

    this.storage.setAppState("bootstrap_code", input.code);
    this.storage.setAppState("binding_code_mode", input.mode);
    this.storage.setAppState("binding_code_created_at", createdAt);
    this.storage.setAppState("binding_code_expires_at", expiresAt);
    this.storage.setAppState("binding_code_attempts", "0");
    if (input.issuedByUserId == null) {
      this.storage.deleteAppState("binding_code_issued_by_user_id");
    } else {
      this.storage.setAppState("binding_code_issued_by_user_id", String(input.issuedByUserId));
    }

    return {
      code: input.code,
      mode: input.mode,
      createdAt,
      expiresAt,
      attempts: 0,
      maxAttempts: BINDING_CODE_MAX_ATTEMPTS,
      issuedByUserId: input.issuedByUserId ?? null,
    };
  }

  recordBindingCodeFailure(now = new Date()): BindingCodeAttemptResult | null {
    const state = this.getBindingCodeState(now);
    if (!state) return null;

    const attempts = state.attempts + 1;
    if (attempts >= state.maxAttempts) {
      this.clearBindingCode();
      return {
        attempts,
        remaining: 0,
        exhausted: true,
      };
    }

    this.storage.setAppState("binding_code_attempts", String(attempts));
    return {
      attempts,
      remaining: state.maxAttempts - attempts,
      exhausted: false,
    };
  }

  clearBindingCode(): void {
    this.storage.deleteAppState("bootstrap_code");
    this.storage.deleteAppState("binding_code_mode");
    this.storage.deleteAppState("binding_code_created_at");
    this.storage.deleteAppState("binding_code_expires_at");
    this.storage.deleteAppState("binding_code_attempts");
    this.storage.deleteAppState("binding_code_issued_by_user_id");
  }

  claimAuthorizedUserId(userId: number): number {
    const existing = this.getAuthorizedUserId();
    if (existing != null) return existing;

    this.storage.setAppState("authorized_user_id", String(userId));
    this.clearBindingCode();

    const current = this.getAuthorizedUserId();
    if (current == null) {
      throw new Error("Failed to persist authorized Telegram user id");
    }
    return current;
  }

  rebindAuthorizedUserId(userId: number): void {
    this.storage.setAppState("authorized_user_id", String(userId));
    this.clearBindingCode();
  }

  clearAuthorizedUserId(): void {
    this.storage.deleteAppState("authorized_user_id");
    this.clearBindingCode();
  }
}

function normalizeBindingCodeMode(value: string | null): BindingCodeMode {
  return value === "rebind" ? "rebind" : "bootstrap";
}

function normalizeNonNegativeInteger(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeOptionalUserId(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
