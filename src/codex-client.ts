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
  'item:started': (params: {
    itemId: string;
    itemType: string;
    command?: string;
    commandActions?: Array<{ type: string; command: string }>;
    toolInput?: Record<string, unknown>;
  }) => void;
  'item:delta': (params: { itemId: string; delta: string }) => void;
  'item:completed': (params: { itemId: string }) => void;
  'approval:requested': (request: ApprovalRequest) => void;
  'tokens:updated': (params: {
    inputTokens: number;
    outputTokens: number;
    contextWindow?: number;
    maxOutputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUsd?: number;
  }) => void;

  // Thinking/reasoning events
  'thinking:delta': (params: { content: string }) => void;
  'thinking:complete': (params: { content: string; durationMs: number }) => void;

  // Command execution lifecycle (from exec_command notifications)
  'command:started': (params: { itemId: string; threadId: string; turnId: string }) => void;
  'command:output': (params: { itemId: string; delta: string }) => void;
  'command:completed': (params: { itemId: string; threadId: string; turnId: string; exitCode?: number }) => void;

  // Context update for abort fix (emitted when we extract valid threadId+turnId)
  'context:turnId': (params: { threadId: string; turnId: string }) => void;

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

  // Item deduplication: Codex sends same item via two event types (item/started + codex/event/item_started)
  private recentItemIds = new Map<string, number>(); // itemId -> timestamp
  private readonly ITEM_ID_TTL_MS = 500; // 500ms TTL for dedup

  private readonly config: Required<CodexClientConfig>;
  private isShuttingDown = false;

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
   * Stop the App-Server process gracefully with escalating signals.
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) return; // Prevent double-stop
    this.isShuttingDown = true;

    // Clear restart timer first
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Reject pending requests
    this.pendingRequests.rejectAll(new Error('Client stopped'));

    if (!this.process) {
      this.initialized = false;
      this.isShuttingDown = false;
      return;
    }

    const proc = this.process;
    console.log(`[codex-client] Stopping process (PID: ${proc.pid})...`);

    // Phase 1: Graceful shutdown via RPC (2s)
    try {
      const request = createRequest('shutdown', {});
      proc.stdin?.write(serializeMessage(request));
    } catch { /* ignore stdin errors */ }

    if (await this.waitForExit(proc, 2000)) {
      console.log('[codex-client] Process exited gracefully');
      this.cleanup();
      return;
    }

    // Phase 2: SIGTERM (2s)
    console.log('[codex-client] Sending SIGTERM...');
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    if (await this.waitForExit(proc, 2000)) {
      console.log('[codex-client] Process exited after SIGTERM');
      this.cleanup();
      return;
    }

    // Phase 3: SIGKILL (1s) - force kill
    console.log('[codex-client] Sending SIGKILL...');
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await this.waitForExit(proc, 1000);
    console.log('[codex-client] Process killed');
    this.cleanup();
  }

  private cleanup(): void {
    this.removeAllListeners();
    this.process = null;
    this.initialized = false;
    this.isShuttingDown = false;
  }

  private waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (proc.exitCode !== null || proc.killed) {
        resolve(true);
        return;
      }
      const timeout = setTimeout(() => {
        proc.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      proc.once('exit', onExit);
    });
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
      case 'codex/event/task_started': {
        // Extract threadId and turnId from various notification formats:
        // turn/started: { threadId, turn: { id } }
        // codex/event/task_started: { msg: { thread_id, turn_id } }
        const p = params as Record<string, unknown>;
        const msg = p.msg as Record<string, unknown> | undefined;
        const turn = p.turn as Record<string, unknown> | undefined;
        const threadId = (p.threadId || p.thread_id || msg?.thread_id || msg?.threadId || '') as string;
        const turnId = (turn?.id || p.turnId || p.turn_id || msg?.turn_id || msg?.turnId || '') as string;
        this.emit('turn:started', { threadId, turnId });
        break;
      }

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
      // Codex sends TWO formats for the same event:
      // 1. codex/event/item_started: { msg: { item: { type, id } }, ... }
      // 2. item/started: { item: { type, id }, ... }
      // We handle both and deduplicate by itemId
      case 'item/started':
      case 'codex/event/item_started': {
        const p = params as Record<string, unknown>;

        // Debug log to capture actual structure
        console.log('[codex-client] item/started params:', JSON.stringify(p));

        // Extract item from either format
        const msg = p.msg as Record<string, unknown> | undefined;
        const item = (msg?.item || p.item) as Record<string, unknown> | undefined;

        if (!item) {
          console.log('[codex-client] item/started: no item found, skipping');
          break;
        }

        // Extract itemId
        const itemId = (item.id || '') as string;
        if (!itemId) {
          console.log('[codex-client] item/started: no itemId found, skipping');
          break;
        }

        // Deduplicate: skip if we've seen this itemId recently
        const now = Date.now();
        const lastSeen = this.recentItemIds.get(itemId);
        if (lastSeen && now - lastSeen < this.ITEM_ID_TTL_MS) {
          console.log('[codex-client] item/started: duplicate itemId, skipping:', itemId);
          break;
        }
        this.recentItemIds.set(itemId, now);
        // Clean old entries
        for (const [id, ts] of this.recentItemIds) {
          if (now - ts > this.ITEM_ID_TTL_MS * 10) this.recentItemIds.delete(id);
        }

        // Extract item type - normalize to lowercase
        // Types: UserMessage, AgentMessage, Reasoning, commandExecution, mcpToolCall, etc.
        let itemType = (item.type || item.tool || item.name || 'unknown') as string;
        // Normalize PascalCase to camelCase: "UserMessage" -> "userMessage"
        if (itemType && itemType.length > 0 && itemType[0] === itemType[0].toUpperCase()) {
          itemType = itemType[0].toLowerCase() + itemType.slice(1);
        }

        // Extract command details for commandExecution items
        // These fields exist in the item object per user's logs:
        // {"item":{"type":"commandExecution","command":"/bin/bash -lc ls","commandActions":[{"type":"listFiles","command":"ls"}]}}
        const command = (item.command || '') as string;
        const commandActions = item.commandActions as Array<{ type: string; command: string }> | undefined;

        // Extract tool input for tools like TodoWrite
        // The input is in item.input as a structured object
        const toolInput = item.input as Record<string, unknown> | undefined;

        // Emit context:turnId for abort fix - item/started has turnId at top level
        const threadId = (p.threadId || msg?.thread_id || '') as string;
        const turnId = (p.turnId || msg?.turn_id || '') as string;
        if (threadId && turnId) {
          this.emit('context:turnId', { threadId, turnId });
        }

        this.emit('item:started', {
          itemId,
          itemType,
          command: command || undefined,
          commandActions: commandActions?.length ? commandActions : undefined,
          toolInput,
        });
        break;
      }

      case 'item/completed':
      case 'codex/event/item_completed': {
        const p = params as Record<string, unknown>;
        // Extract item from either format
        const msg = p.msg as Record<string, unknown> | undefined;
        const item = (msg?.item || p.item) as Record<string, unknown> | undefined;
        // Extract itemId
        const itemId = (item?.id || p.itemId || p.item_id || p.id || '') as string;
        this.emit('item:completed', { itemId });
        break;
      }

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
          contextWindow?: number;
          context_window?: number;
          maxOutputTokens?: number;
          max_output_tokens?: number;
          cacheReadInputTokens?: number;
          cache_read_input_tokens?: number;
          cacheCreationInputTokens?: number;
          cache_creation_input_tokens?: number;
          costUsd?: number;
          cost_usd?: number;
          totalCostUsd?: number;
          total_cost_usd?: number;
        };
        const costUsd =
          p.costUsd ??
          p.cost_usd ??
          p.totalCostUsd ??
          p.total_cost_usd;
        this.emit('tokens:updated', {
          inputTokens: p.inputTokens ?? p.input_tokens ?? 0,
          outputTokens: p.outputTokens ?? p.output_tokens ?? 0,
          contextWindow: p.contextWindow ?? p.context_window,
          maxOutputTokens: p.maxOutputTokens ?? p.max_output_tokens,
          cacheReadInputTokens: p.cacheReadInputTokens ?? p.cache_read_input_tokens,
          cacheCreationInputTokens: p.cacheCreationInputTokens ?? p.cache_creation_input_tokens,
          costUsd,
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

      // Command execution lifecycle events
      // MITIGATION: Defensive extraction - try multiple field name variants
      // Structure: { id, msg: { turn_id, call_id, ... }, conversationId }
      case 'codex/event/exec_command_begin': {
        const p = params as Record<string, unknown>;
        const msg = p.msg as Record<string, unknown> | undefined;

        // Extract from nested msg and top-level (conversationId = threadId)
        const itemId = (msg?.call_id || p.itemId || p.item_id || p.id || '') as string;
        const threadId = (p.conversationId || p.threadId || p.thread_id || msg?.thread_id || '') as string;
        const turnId = (msg?.turn_id || p.turnId || p.turn_id || '') as string;

        // Emit context:turnId for abort fix if we have valid values
        if (threadId && turnId) {
          this.emit('context:turnId', { threadId, turnId });
        }
        this.emit('command:started', { itemId, threadId, turnId });
        break;
      }

      case 'codex/event/exec_command_output_delta':
      case 'item/commandExecution/outputDelta': {
        const p = params as Record<string, unknown>;
        const itemId = (p.itemId || p.item_id || '') as string;
        const msg = p.msg as Record<string, unknown> | undefined;
        const delta = (p.delta || p.content || p.output ||
                       msg?.delta || msg?.content || msg?.output || '') as string;
        if (delta) {
          this.emit('command:output', { itemId, delta });
        }
        break;
      }

      // Structure: { id, msg: { turn_id, call_id, exit_code, ... }, conversationId }
      case 'codex/event/exec_command_end': {
        const p = params as Record<string, unknown>;
        const msg = p.msg as Record<string, unknown> | undefined;

        // Extract from nested msg and top-level (conversationId = threadId)
        const itemId = (msg?.call_id || p.itemId || p.item_id || p.id || '') as string;
        const threadId = (p.conversationId || p.threadId || p.thread_id || msg?.thread_id || '') as string;
        const turnId = (msg?.turn_id || p.turnId || p.turn_id || '') as string;
        const exitCode = (msg?.exit_code ?? p.exitCode ?? p.exit_code ?? p.code) as number | undefined;

        if (threadId && turnId) {
          this.emit('context:turnId', { threadId, turnId });
        }
        this.emit('command:completed', { itemId, threadId, turnId, exitCode });
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
      case 'codex/event/turn_aborted':
        // These are informational - no action needed
        break;

      default:
        // Unknown notification - log but don't crash
        console.log('Unknown notification:', method);
    }
  }

  private handleProcessExit(code: number | null): void {
    // CRITICAL: Don't restart during intentional shutdown
    if (this.isShuttingDown) {
      console.log('[codex-client] Process exited during shutdown, not restarting');
      return;
    }

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
