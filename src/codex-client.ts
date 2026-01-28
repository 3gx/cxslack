/**
 * Codex App-Server client wrapper.
 *
 * Spawns and manages the `codex app-server` process, handling JSON-RPC 2.0
 * communication over stdin/stdout.
 *
 * Key features:
 * - Process lifecycle management (spawn, restart, graceful shutdown)
 * - JSON-RPC request/response correlation
 * - Notification event streaming
 * - Exponential backoff on process restarts
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  createRequest,
  serializeMessage,
  parseMessage,
  isResponse,
  isNotification,
  createPendingRequestTracker,
  JsonRpcNotification,
  JsonRpcRequest,
} from './json-rpc.js';
import { Errors } from './errors.js';

// Approval policy types (maps to Codex config)
export type ApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';

// Reasoning effort levels
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Turn input content types
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  url: string;
  mediaType: string;
}

export type TurnContent = TextContent | ImageContent;

// Thread information
export interface ThreadInfo {
  id: string;
  workingDirectory: string;
  createdAt: string;
}

// Account information
export interface AccountInfo {
  type: 'chatgpt' | 'apiKey';
  email?: string;
  isPlus?: boolean;
}

// Turn status
export type TurnStatus = 'running' | 'completed' | 'interrupted' | 'failed';

// Approval request types
export interface CommandApprovalRequest {
  method: 'item/commandExecution/requestApproval';
  params: {
    itemId: string;
    threadId: string;
    turnId: string;
    parsedCmd: string;
    risk: string;
    sandboxed: boolean;
  };
}

export interface FileChangeApprovalRequest {
  method: 'item/fileChange/requestApproval';
  params: {
    itemId: string;
    threadId: string;
    turnId: string;
    reason: string;
    filePath: string;
  };
}

export type ApprovalRequest = CommandApprovalRequest | FileChangeApprovalRequest;

// Client configuration
export interface CodexClientConfig {
  /** Request timeout in ms (default: 60000) */
  requestTimeout?: number;
  /** Max restart attempts before giving up (default: 5) */
  maxRestartAttempts?: number;
  /** Initial backoff delay in ms (default: 1000) */
  initialBackoffMs?: number;
  /** Max backoff delay in ms (default: 30000) */
  maxBackoffMs?: number;
}

/**
 * Events emitted by the CodexClient.
 */
export interface CodexClientEvents {
  // Process lifecycle
  'server:started': () => void;
  'server:died': (code: number | null) => void;
  'server:restarting': (attempt: number) => void;
  'server:restart-failed': (error: Error) => void;

  // Notifications from Codex
  'notification': (notification: JsonRpcNotification) => void;
  'turn:started': (params: { threadId: string; turnId: string }) => void;
  'turn:completed': (params: { threadId: string; turnId: string; status: TurnStatus }) => void;
  'item:started': (params: { itemId: string; itemType: string }) => void;
  'item:delta': (params: { itemId: string; delta: string }) => void;
  'item:completed': (params: { itemId: string }) => void;
  'approval:requested': (request: ApprovalRequest) => void;
  'tokens:updated': (params: { inputTokens: number; outputTokens: number }) => void;

  // Thinking/reasoning events
  'thinking:delta': (params: { content: string }) => void;
  'thinking:complete': (params: { content: string; durationMs: number }) => void;

  // Errors
  'error': (error: Error) => void;
}

/**
 * Codex App-Server client.
 */
export class CodexClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private pendingRequests = createPendingRequestTracker();
  private lineBuffer = '';
  private initialized = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  // Delta deduplication to prevent text duplication from multiple event types
  // Uses content-only hash (no itemId) since different event types have different itemIds
  private recentDeltaHashes = new Map<string, number>(); // hash -> timestamp
  private readonly DELTA_HASH_TTL_MS = 100; // 100ms TTL - same content within 100ms is duplicate

  private readonly config: Required<CodexClientConfig>;

  constructor(config: CodexClientConfig = {}) {
    super();
    this.config = {
      requestTimeout: config.requestTimeout ?? 60000,
      maxRestartAttempts: config.maxRestartAttempts ?? 5,
      initialBackoffMs: config.initialBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 30000,
    };
  }

  /**
   * Start the App-Server process.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('App-Server already running');
    }

    this.process = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'], // stdin, stdout piped; stderr to console
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
      this.handleProcessExit(null);
    });

    this.process.on('exit', (code) => {
      this.emit('server:died', code);
      this.handleProcessExit(code);
    });

    // Handle stdout data (JSON-RPC messages)
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdoutData(data);
    });

    // Initialize the client
    await this.rpc('initialize', {
      clientInfo: { name: 'cxslack', version: '1.0.0' },
    });

    this.initialized = true;
    this.restartAttempts = 0;
    this.emit('server:started');
  }

  /**
   * Stop the App-Server process gracefully.
   */
  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.process) {
      return;
    }

    // Send shutdown request (don't wait for response)
    try {
      const request = createRequest('shutdown', {});
      this.process.stdin?.write(serializeMessage(request));
    } catch {
      // Ignore errors during shutdown
    }

    // Give it time to shut down gracefully
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGTERM');
        resolve();
      }, 5000);

      this.process?.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.pendingRequests.rejectAll(new Error('Client stopped'));
    this.process = null;
    this.initialized = false;
  }

  /**
   * Check if the client is connected and initialized.
   */
  get isConnected(): boolean {
    return this.process !== null && this.initialized;
  }

  /**
   * Send a JSON-RPC request and wait for response.
   */
  async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.process?.stdin) {
      throw Errors.codexProcessDied();
    }

    const request = createRequest(method, params);

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.add(
        request.id,
        method,
        (result) => resolve(result as T),
        reject,
        this.config.requestTimeout
      );

      try {
        this.process!.stdin!.write(serializeMessage(request));
      } catch (err) {
        this.pendingRequests.rejectAll(err as Error);
        throw err;
      }
    });
  }

  /**
   * Respond to an approval request.
   */
  async respondToApproval(
    requestId: number,
    decision: 'accept' | 'decline'
  ): Promise<void> {
    if (!this.process?.stdin) {
      throw Errors.codexProcessDied();
    }

    // Approval responses are sent as JSON-RPC responses
    const response = {
      jsonrpc: '2.0' as const,
      id: requestId,
      result: { decision },
    };

    this.process.stdin.write(serializeMessage(response));
  }

  // --- High-level API methods ---

  /**
   * Check account authentication status.
   */
  async getAccount(refreshToken = false): Promise<AccountInfo | null> {
    const result = await this.rpc<{ account: AccountInfo | null }>('account/read', {
      refreshToken,
    });
    return result.account;
  }

  /**
   * Start a new thread.
   */
  async startThread(workingDirectory: string): Promise<ThreadInfo> {
    const result = await this.rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory,
    });
    return result.thread;
  }

  /**
   * Resume an existing thread.
   */
  async resumeThread(threadId: string): Promise<ThreadInfo> {
    const result = await this.rpc<{ thread: ThreadInfo }>('thread/resume', {
      threadId,
    });
    return result.thread;
  }

  /**
   * Fork a thread at a specific turn index.
   */
  async forkThread(threadId: string, turnIndex?: number): Promise<ThreadInfo> {
    const params: Record<string, unknown> = { threadId };
    if (turnIndex !== undefined) {
      params.turnIndex = turnIndex;
    }
    const result = await this.rpc<{ thread: ThreadInfo }>('thread/fork', params);
    return result.thread;
  }

  /**
   * Start a new turn in a thread.
   */
  async startTurn(
    threadId: string,
    input: TurnContent[],
    options: {
      approvalPolicy?: ApprovalPolicy;
      reasoningEffort?: ReasoningEffort;
      model?: string;
    } = {}
  ): Promise<string> {
    const params: Record<string, unknown> = {
      threadId,
      input,
    };
    if (options.approvalPolicy) {
      params.approvalPolicy = options.approvalPolicy;
    }
    if (options.reasoningEffort) {
      params.reasoningEffort = options.reasoningEffort;
    }
    if (options.model) {
      params.model = options.model;
    }
    const result = await this.rpc<{ turnId: string }>('turn/start', params);
    return result.turnId;
  }

  /**
   * Interrupt (abort) a running turn.
   */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.rpc('turn/interrupt', { threadId, turnId });
  }

  /**
   * List available models.
   * Note: This may not be supported by all App-Server versions.
   */
  async listModels(): Promise<string[]> {
    try {
      const result = await this.rpc<{ models?: string[] }>('model/list', {});
      return result.models ?? [];
    } catch {
      // model/list may not be implemented - return empty array
      return [];
    }
  }

  // --- Private methods ---

  private handleStdoutData(data: Buffer): void {
    // Append to buffer and process complete lines
    this.lineBuffer += data.toString();

    let newlineIndex: number;
    while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

      if (line) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    const message = parseMessage(line);
    if (!message) {
      console.error('Failed to parse JSON-RPC message:', line);
      return;
    }

    if (isResponse(message)) {
      // Correlate with pending request
      const handled = this.pendingRequests.resolve(message);
      if (!handled) {
        console.warn('Received response for unknown request:', message.id);
      }
    } else if (isNotification(message)) {
      this.handleNotification(message);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.emit('notification', notification);

    const params = notification.params || {};
    const method = notification.method;

    // Handle both old-style (turn/*, item/*) and new-style (codex/event/*) notifications
    switch (method) {
      // Task/Turn lifecycle
      case 'turn/started':
      case 'codex/event/task_started':
        this.emit('turn:started', params as { threadId: string; turnId: string });
        break;

      case 'turn/completed':
      case 'codex/event/task_complete': {
        // Normalize status: Codex may send 'success', 'done', 'completed', or omit status entirely
        const rawStatus = (params as { status?: string }).status;
        let normalizedStatus: TurnStatus = 'completed'; // Default to completed for task_complete

        if (rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'done') {
          normalizedStatus = 'completed';
        } else if (rawStatus === 'interrupted' || rawStatus === 'cancelled' || rawStatus === 'aborted') {
          normalizedStatus = 'interrupted';
        } else if (rawStatus === 'failed' || rawStatus === 'error') {
          normalizedStatus = 'failed';
        }
        // Note: 'running' status in a task_complete event doesn't make sense, ignore it

        this.emit('turn:completed', {
          threadId: (params as { threadId?: string }).threadId ?? '',
          turnId: (params as { turnId?: string }).turnId ?? '',
          status: normalizedStatus,
        });
        break;
      }

      // Item lifecycle
      case 'item/started':
      case 'codex/event/item_started':
        this.emit('item:started', params as { itemId: string; itemType: string });
        break;

      case 'item/completed':
      case 'codex/event/item_completed':
        this.emit('item:completed', params as { itemId: string });
        break;

      // Message content streaming
      case 'item/agentMessage/delta':
      case 'codex/event/agent_message_content_delta':
      case 'codex/event/agent_message_delta': {
        // Extract delta text from various possible structures:
        // - Old style: params.delta / params.content / params.text
        // - New style: params.msg.delta / params.msg.content / params.msg.text
        const p = params as Record<string, unknown>;
        const msg = p.msg as Record<string, unknown> | undefined;

        const delta = p.delta || p.content || p.text ||
                      msg?.delta || msg?.content || msg?.text || '';

        const itemId = p.itemId || p.item_id || msg?.item_id || '';

        // Deduplication: prevent duplicate deltas from different event types
        // Use content-only hash since itemId differs between event types
        const deltaStr = delta as string;
        if (deltaStr) {
          const hash = deltaStr.slice(0, 100); // Use first 100 chars as hash
          const now = Date.now();

          // Clean expired hashes
          for (const [h, ts] of this.recentDeltaHashes) {
            if (now - ts > this.DELTA_HASH_TTL_MS) {
              this.recentDeltaHashes.delete(h);
            }
          }

          // Skip if duplicate (same content within 100ms is from different event types)
          if (this.recentDeltaHashes.has(hash)) {
            return;
          }
          this.recentDeltaHashes.set(hash, now);

          this.emit('item:delta', { itemId: itemId as string, delta: deltaStr });
        }
        break;
      }

      // Approval requests
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.emit('approval:requested', {
          method: notification.method,
          params: params as ApprovalRequest['params'],
        } as ApprovalRequest);
        break;

      // Token usage events
      case 'thread/tokenUsage/updated':
      case 'codex/event/token_count': {
        const p = params as {
          inputTokens?: number;
          outputTokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        };
        this.emit('tokens:updated', {
          inputTokens: p.inputTokens ?? p.input_tokens ?? 0,
          outputTokens: p.outputTokens ?? p.output_tokens ?? 0,
        });
        break;
      }

      // Thinking/reasoning content streaming
      case 'codex/event/reasoning_content_delta':
      case 'codex/event/agent_reasoning_delta': {
        const p = params as Record<string, unknown>;
        const content = (p.delta || p.content || p.text || '') as string;
        if (content) {
          this.emit('thinking:delta', { content });
        }
        break;
      }

      // Informational events (log but don't emit)
      case 'thread/started':
      case 'account/rateLimits/updated':
      case 'codex/event/mcp_startup_update':
      case 'codex/event/mcp_startup_complete':
      case 'codex/event/user_message':
      case 'codex/event/agent_message':
      case 'codex/event/agent_reasoning':
      case 'codex/event/agent_reasoning_section_break':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/summaryTextDelta':
        // These are informational - no action needed
        break;

      default:
        // Unknown notification - log but don't crash
        console.log('Unknown notification:', method);
    }
  }

  private handleProcessExit(code: number | null): void {
    this.process = null;
    this.initialized = false;
    this.pendingRequests.rejectAll(Errors.codexProcessDied(code ?? undefined));

    // Attempt restart with exponential backoff
    if (this.restartAttempts < this.config.maxRestartAttempts) {
      this.restartAttempts++;
      const delay = Math.min(
        this.config.initialBackoffMs * Math.pow(2, this.restartAttempts - 1),
        this.config.maxBackoffMs
      );

      this.emit('server:restarting', this.restartAttempts);

      this.restartTimer = setTimeout(async () => {
        try {
          await this.start();
        } catch (err) {
          this.emit('error', err as Error);
        }
      }, delay);
    } else {
      this.emit('server:restart-failed', new Error('Max restart attempts exceeded'));
    }
  }
}

// Type-safe event emitter
export interface CodexClient {
  on<K extends keyof CodexClientEvents>(event: K, listener: CodexClientEvents[K]): this;
  once<K extends keyof CodexClientEvents>(event: K, listener: CodexClientEvents[K]): this;
  off<K extends keyof CodexClientEvents>(event: K, listener: CodexClientEvents[K]): this;
  emit<K extends keyof CodexClientEvents>(event: K, ...args: Parameters<CodexClientEvents[K]>): boolean;
}
