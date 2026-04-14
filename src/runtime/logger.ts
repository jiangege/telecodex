import pino, { type Logger as PinoLogger } from "pino";
import type { SonicBoom } from "sonic-boom";
import { getLogFilePath } from "./appPaths.js";

export interface Logger {
  readonly filePath: string;
  child(scope: string): Logger;
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  flush(): void;
}

class PinoLoggerAdapter implements Logger {
  readonly filePath: string;

  constructor(
    private readonly base: PinoLogger,
    private readonly destination: SonicBoom,
    private readonly scope: string,
    filePath: string,
  ) {
    this.filePath = filePath;
  }

  child(scope: string): Logger {
    return new PinoLoggerAdapter(this.base, this.destination, `${this.scope}/${scope}`, this.filePath);
  }

  debug(message: string, details?: unknown): void {
    logWithDetails(this.base.debug.bind(this.base), this.scope, message, details);
  }

  info(message: string, details?: unknown): void {
    logWithDetails(this.base.info.bind(this.base), this.scope, message, details);
  }

  warn(message: string, details?: unknown): void {
    logWithDetails(this.base.warn.bind(this.base), this.scope, message, details);
  }

  error(message: string, details?: unknown): void {
    logWithDetails(this.base.error.bind(this.base), this.scope, message, details);
  }

  flush(): void {
    try {
      this.destination.flushSync();
    } catch {
      // Ignore flush races during early startup failure and process teardown.
    }
  }
}

export function createLogger(filePath = getLogFilePath()): Logger {
  const destination = pino.destination({
    dest: filePath,
    mkdir: true,
    sync: false,
  });
  const base = pino(
    {
      level: process.env.TELECODEX_LOG_LEVEL ?? "info",
      base: {
        service: "telecodex",
        pid: process.pid,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    destination,
  );

  return new PinoLoggerAdapter(base, destination, "telecodex", filePath);
}

function logWithDetails(
  log: (obj: object, msg?: string) => void,
  scope: string,
  message: string,
  details?: unknown,
): void {
  if (details === undefined) {
    log({ scope }, message);
    return;
  }

  if (details instanceof Error) {
    log({ scope, err: details }, message);
    return;
  }

  if (isRecord(details)) {
    log({ ...details, scope }, message);
    return;
  }

  log({ scope, value: details }, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
