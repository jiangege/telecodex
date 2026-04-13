import type { ServerNotification, ServerRequest } from "../generated/codex-app-server/index.js";
import type { GetAccountResponse } from "../generated/codex-app-server/v2/GetAccountResponse.js";
import type { GetAccountRateLimitsResponse } from "../generated/codex-app-server/v2/GetAccountRateLimitsResponse.js";
import type { ThreadResumeResponse } from "../generated/codex-app-server/v2/ThreadResumeResponse.js";
import type { ThreadStartResponse } from "../generated/codex-app-server/v2/ThreadStartResponse.js";
import type { TurnStartResponse } from "../generated/codex-app-server/v2/TurnStartResponse.js";
import type { SessionMode } from "../config.js";
import { CodexAppServerClient } from "./CodexAppServerClient.js";

export interface ThreadOptions {
  cwd: string;
  model: string;
  mode: SessionMode;
}

export class CodexGateway {
  private readonly loadedThreads = new Set<string>();

  constructor(private readonly client: CodexAppServerClient) {
    this.client.onExit(() => this.loadedThreads.clear());
    this.client.onNotification((event) => {
      if (event.method === "thread/started") {
        this.loadedThreads.add(event.params.thread.id);
      }
      if (event.method === "thread/closed") {
        this.loadedThreads.delete(event.params.threadId);
      }
    });
  }

  onNotification(handler: (notification: ServerNotification) => void): () => void {
    return this.client.onNotification(handler);
  }

  onServerRequest(handler: (request: ServerRequest) => void): () => void {
    return this.client.onServerRequest(handler);
  }

  async startThread(options: ThreadOptions): Promise<ThreadStartResponse> {
    const response = await this.client.request<ThreadStartResponse>("thread/start", {
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: sandboxForMode(options.mode),
      serviceName: "telecodex",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    this.loadedThreads.add(response.thread.id);
    return response;
  }

  async resumeThread(threadId: string, options: ThreadOptions): Promise<ThreadResumeResponse> {
    if (this.loadedThreads.has(threadId)) {
      return { thread: { id: threadId } } as ThreadResumeResponse;
    }
    const response = await this.client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: sandboxForMode(options.mode),
      persistExtendedHistory: true,
    });
    this.loadedThreads.add(response.thread.id);
    return response;
  }

  async startTurn(input: {
    threadId: string;
    text: string;
    cwd: string;
    model: string;
    mode: SessionMode;
  }): Promise<TurnStartResponse> {
    return this.client.request<TurnStartResponse>("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy:
        input.mode === "write"
          ? null
          : {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: true,
            },
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.client.request("turn/interrupt", { threadId, turnId }, 30_000);
  }

  async account(): Promise<GetAccountResponse> {
    return this.client.request<GetAccountResponse>("account/read", { refreshToken: false }, 30_000);
  }

  async rateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.client.request<GetAccountRateLimitsResponse>("account/rateLimits/read", undefined, 30_000);
  }

  respond(requestId: string | number, result: unknown): void {
    this.client.respond(requestId, result);
  }

  reject(requestId: string | number, message: string): void {
    this.client.rejectServerRequest(requestId, message);
  }
}

function sandboxForMode(mode: SessionMode): "read-only" | "workspace-write" {
  return mode === "write" ? "workspace-write" : "read-only";
}
