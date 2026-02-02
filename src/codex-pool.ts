import type { WebClient } from '@slack/web-api';
import { CodexClient } from './codex-client.js';
import { StreamingManager, type StreamingContext } from './streaming.js';
import { ApprovalHandler } from './approval-handler.js';

export interface CodexRuntime {
  codex: CodexClient;
  streaming: StreamingManager;
  approval: ApprovalHandler;
  createdAt: number;
  lastUsedAt: number;
}

export class CodexPool {
  private runtimes = new Map<string, CodexRuntime>();
  private pending = new Map<string, Promise<CodexRuntime>>();
  private slack: WebClient;

  constructor(slack: WebClient) {
    this.slack = slack;
  }

  getRuntimeIfExists(conversationKey: string): CodexRuntime | undefined {
    return this.runtimes.get(conversationKey);
  }

  async getRuntime(conversationKey: string): Promise<CodexRuntime> {
    const existing = this.runtimes.get(conversationKey);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const pending = this.pending.get(conversationKey);
    if (pending) {
      return await pending;
    }

    const createPromise = this.createRuntime(conversationKey);
    this.pending.set(conversationKey, createPromise);
    try {
      const runtime = await createPromise;
      this.runtimes.set(conversationKey, runtime);
      return runtime;
    } finally {
      this.pending.delete(conversationKey);
    }
  }

  private async createRuntime(conversationKey: string): Promise<CodexRuntime> {
    const codex = new CodexClient();
    codex.on('server:started', () => {
      console.log(`[codex:${conversationKey}] app-server started`);
    });
    codex.on('server:died', (code) => {
      console.error(`[codex:${conversationKey}] app-server died (code=${code ?? 'unknown'})`);
    });
    codex.on('server:restarting', (attempt) => {
      console.warn(`[codex:${conversationKey}] app-server restarting (attempt ${attempt})`);
    });
    codex.on('server:restart-failed', (error) => {
      console.error(`[codex:${conversationKey}] app-server restart failed:`, error);
    });
    codex.on('error', (error) => {
      console.error(`[codex:${conversationKey}] error:`, error);
    });

    await codex.start();

    const streaming = new StreamingManager(this.slack, codex);
    const approval = new ApprovalHandler(this.slack, codex);

    streaming.onApprovalRequest(async (request, context: StreamingContext) => {
      await approval.handleApprovalRequest(
        request,
        context.channelId,
        context.threadTs,
        context.userId
      );
    });

    const runtime: CodexRuntime = {
      codex,
      streaming,
      approval,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    return runtime;
  }

  findRuntimeByApprovalRequestId(requestId: number): CodexRuntime | undefined {
    let found: CodexRuntime | undefined;
    for (const runtime of this.runtimes.values()) {
      if (runtime.approval.hasPendingApproval(requestId)) {
        if (found) {
          return undefined;
        }
        found = runtime;
      }
    }
    return found;
  }

  async stopAll(): Promise<void> {
    const runtimes = Array.from(this.runtimes.values());
    this.runtimes.clear();
    this.pending.clear();

    for (const runtime of runtimes) {
      runtime.streaming.stopAllStreaming();
      await runtime.codex.stop();
    }
  }
}
