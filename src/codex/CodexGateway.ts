import type { ServerNotification, ServerRequest } from "../generated/codex-app-server/index.js";
import type { GetAccountResponse } from "../generated/codex-app-server/v2/GetAccountResponse.js";
import type { GetAccountRateLimitsResponse } from "../generated/codex-app-server/v2/GetAccountRateLimitsResponse.js";
import type { SandboxPolicy } from "../generated/codex-app-server/v2/SandboxPolicy.js";
import type { Thread } from "../generated/codex-app-server/v2/Thread.js";
import type { ThreadListResponse } from "../generated/codex-app-server/v2/ThreadListResponse.js";
import type { ThreadReadResponse } from "../generated/codex-app-server/v2/ThreadReadResponse.js";
import type { ThreadResumeResponse } from "../generated/codex-app-server/v2/ThreadResumeResponse.js";
import type { ThreadStartResponse } from "../generated/codex-app-server/v2/ThreadStartResponse.js";
import type { TurnStartResponse } from "../generated/codex-app-server/v2/TurnStartResponse.js";
import type { SessionApprovalPolicy, SessionReasoningEffort, SessionSandboxMode } from "../config.js";
import { CodexAppServerClient } from "./CodexAppServerClient.js";

export interface ThreadOptions {
  cwd: string;
  model: string;
  sandboxMode: SessionSandboxMode;
  approvalPolicy: SessionApprovalPolicy;
  reasoningEffort: SessionReasoningEffort | null;
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
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: options.sandboxMode,
      serviceName: "telecodex",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    this.loadedThreads.add(response.thread.id);
    return response;
  }

  async resumeThread(threadId: string, options: ThreadOptions): Promise<ThreadResumeResponse> {
    if (this.loadedThreads.has(threadId)) {
      return {
        thread: { id: threadId },
        model: options.model,
        cwd: options.cwd,
        approvalPolicy: options.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: sandboxPolicyForMode(options.sandboxMode, options.cwd),
        reasoningEffort: options.reasoningEffort,
      } as ThreadResumeResponse;
    }
    const response = await this.client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: options.sandboxMode,
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
    sandboxMode: SessionSandboxMode;
    approvalPolicy: SessionApprovalPolicy;
    reasoningEffort: SessionReasoningEffort | null;
  }): Promise<TurnStartResponse> {
    return this.client.request<TurnStartResponse>("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: input.approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy: sandboxPolicyForMode(input.sandboxMode, input.cwd),
      effort: input.reasoningEffort,
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.client.request("turn/interrupt", { threadId, turnId }, 30_000);
  }

  async listThreads(input?: {
    cursor?: string | null;
    limit?: number;
    searchTerm?: string;
    archived?: boolean;
  }): Promise<ThreadListResponse> {
    return this.client.request<ThreadListResponse>("thread/list", {
      cursor: input?.cursor ?? null,
      limit: input?.limit ?? 20,
      sortKey: "updated_at",
      searchTerm: input?.searchTerm?.trim() || null,
      archived: input?.archived ?? false,
    });
  }

  async readThread(threadId: string, includeTurns = false): Promise<Thread> {
    const response = await this.client.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns,
    });
    return response.thread;
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

function sandboxPolicyForMode(sandboxMode: SessionSandboxMode, cwd: string): SandboxPolicy {
  switch (sandboxMode) {
    case "read-only":
      return {
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: true,
      };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
      return {
        type: "dangerFullAccess",
      };
  }
}
