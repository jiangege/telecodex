import { EventEmitter } from "node:events";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ClientNotification,
  ClientRequest,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
} from "../generated/codex-app-server/index.js";

type JsonRpcId = string | number;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

type ServerMessage = JsonRpcResponse | ServerNotification | ServerRequest;

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly emitter = new EventEmitter();
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly options: {
      codexBin: string;
      cwd: string;
      requestTimeoutMs?: number;
    },
  ) {}

  onNotification(handler: (notification: ServerNotification) => void): () => void {
    this.emitter.on("notification", handler);
    return () => this.emitter.off("notification", handler);
  }

  onServerRequest(handler: (request: ServerRequest) => void): () => void {
    this.emitter.on("serverRequest", handler);
    return () => this.emitter.off("serverRequest", handler);
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.emitter.on("exit", handler);
    return () => this.emitter.off("exit", handler);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request<T>(method: ClientRequest["method"], params?: unknown, timeoutMs?: number): Promise<T> {
    await this.start();
    const id = this.nextId++;
    const message = { method, id, params };
    return this.sendRequest<T>(id, message, timeoutMs);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.send({ id, result });
  }

  rejectServerRequest(id: JsonRpcId, message: string): void {
    this.send({ id, error: { code: -32000, message } });
  }

  async initialize(): Promise<InitializeResponse> {
    const response = await this.request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "telecodex",
        title: "telecodex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    const notification: ClientNotification = { method: "initialized" };
    this.send(notification);
    return response;
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server stopped"));
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    this.proc?.kill();
    this.proc = null;
  }

  private async startProcess(): Promise<void> {
    this.proc = spawn(this.options.codexBin, ["app-server"], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: addPathPrefix(process.env.PATH ?? "", ["/opt/homebrew/bin", "/usr/local/bin"]),
      },
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      this.rl?.close();
      this.rl = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Codex app-server exited with code ${code ?? "null"}`));
      }
      this.pending.clear();
      this.emitter.emit("exit", code, signal);
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.initialize();
  }

  private sendRequest<T>(id: JsonRpcId, message: unknown, timeoutMs?: number): Promise<T> {
    const effectiveTimeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120_000;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${id}`));
      }, effectiveTimeout);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: unknown): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: ServerMessage;
    try {
      message = JSON.parse(line) as ServerMessage;
    } catch {
      process.stderr.write(`[codex-app-server stdout] ${line}\n`);
      return;
    }

    if ("id" in message && "method" in message) {
      this.emitter.emit("serverRequest", message);
      return;
    }

    if ("id" in message) {
      this.handleResponse(message);
      return;
    }

    if ("method" in message) {
      this.emitter.emit("notification", message);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message || `Codex app-server error ${response.error.code}`));
      return;
    }
    pending.resolve(response.result);
  }
}

function addPathPrefix(pathValue: string, prefixes: string[]): string {
  const parts = pathValue.split(":").filter(Boolean);
  for (const prefix of prefixes.reverse()) {
    if (!parts.includes(prefix)) parts.unshift(prefix);
  }
  return parts.join(":");
}
