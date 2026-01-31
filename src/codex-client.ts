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
  isRequest,
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

// Rate limit window (5h or weekly)
export interface RateLimitWindow {
  usedPercent: number;
  resetsAt?: number; // Unix timestamp in seconds
  windowDurationMins?: number;
}

// Credits snapshot
export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

// Rate limits response
export interface RateLimits {
  primary?: RateLimitWindow; // 5h limit
  secondary?: RateLimitWindow; // Weekly limit
  credits?: CreditsSnapshot;
  planType?: 'free' | 'plus' | 'pro' | 'team' | 'business' | 'enterprise' | 'edu' | 'unknown';
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

// Approval requests may arrive as JSON-RPC requests (with an id) or notifications (no id).
export type ApprovalRequestWithId = ApprovalRequest & { rpcId?: number };

// Client configuration
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexClientConfig {
  /** Request timeout in ms (default: 60000) */
  requestTimeout?: number;
  /** Max restart attempts before giving up (default: 5) */
  maxRestartAttempts?: number;
  /** Initial backoff delay in ms (default: 1000) */
  initialBackoffMs?: number;
  /** Max backoff delay in ms (default: 30000) */
  maxBackoffMs?: number;
  /** Sandbox mode for command execution */
  sandboxMode?: SandboxMode;
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
  'approval:requested': (request: ApprovalRequestWithId) => void;
  'tokens:updated': (params: {
    inputTokens: number;
    outputTokens: number;
    contextWindow?: number;
    maxOutputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUsd?: number;
    totalTokens?: number;
    lastInputTokens?: number;
    lastOutputTokens?: number;
    lastTotalTokens?: number;
    lastCacheReadInputTokens?: number;
    lastCacheCreationInputTokens?: number;
    source?: 'token_count' | 'thread_token_usage';
  }) => void;

  // Thinking/reasoning events
  // NOTE: Codex encrypts thinking content - we can only detect when thinking happens,
  // not the actual content. The 'thinking:started' event signals reasoning began,
  // 'thinking:complete' signals it ended. Content will be empty or minimal summary.
  'thinking:started': (params: { itemId: string }) => void;
  'thinking:delta': (params: { content: string }) => void;
  'thinking:complete': (params: { itemId: string; durationMs: number }) => void;

  // Command execution lifecycle (from exec_command notifications)
  'command:started': (params: { itemId: string; threadId: string; turnId: string }) => void;
  'command:output': (params: { itemId: string; delta: string }) => void;
  'command:completed': (params: { itemId: string; threadId: string; turnId: string; exitCode?: number }) => void;
  'filechange:delta': (params: { itemId: string; delta: string }) => void;

  // Web search lifecycle (from web_search notifications)
  'websearch:started': (params: {
    itemId: string;
    query?: string;
    url?: string;
    threadId?: string;
    turnId?: string;
  }) => void;
  'websearch:completed': (params: {
    itemId: string;
    query?: string;
    url?: string;
    resultUrls?: string[];
    durationMs?: number;
    threadId?: string;
    turnId?: string;
  }) => void;

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

  // Turn completion deduplication: turn/completed and codex/event/task_complete can both arrive
  private recentTurnCompletions = new Map<string, number>(); // threadId:turnId -> timestamp
  private readonly TURN_COMPLETION_TTL_MS = 1000; // 1s TTL for dedup

  // Reasoning item tracking for thinking:started/complete events
  private reasoningItemStartTimes = new Map<string, number>(); // itemId -> startTime

  private readonly config: Required<CodexClientConfig>;
  private isShuttingDown = false;
  private sandboxMode?: SandboxMode;

  constructor(config: CodexClientConfig = {}) {
    super();
    this.config = {
      requestTimeout: config.requestTimeout ?? 60000,
      maxRestartAttempts: config.maxRestartAttempts ?? 5,
      initialBackoffMs: config.initialBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 30000,
      sandboxMode: config.sandboxMode ?? 'danger-full-access',
    };
    this.sandboxMode = this.config.sandboxMode;
  }

  /**
   * Start the App-Server process.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('App-Server already running');
    }

    this.isShuttingDown = false;
    // Use -c sandbox_mode config to properly disable sandbox for .git writes
    const args = this.sandboxMode
      ? ['app-server', '-c', `sandbox_mode="${this.sandboxMode}"`]
      : ['app-server'];
    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'inherit'], // stdin, stdout piped; stderr to console
    });
    this.process = proc;

    proc.on('error', (err) => {
      this.emit('error', err);
      this.handleProcessExit(null, proc);
    });

    proc.on('exit', (code) => {
      this.emit('server:died', code);
      this.handleProcessExit(code, proc);
    });

    // Handle stdout data (JSON-RPC messages)
    proc.stdout?.on('data', (data: Buffer) => {
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
  async stop(preserveListeners = false): Promise<void> {
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
      if (!preserveListeners) {
        this.removeAllListeners();
      }
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
      this.cleanup(preserveListeners);
      return;
    }

    // Phase 2: SIGTERM (2s)
    console.log('[codex-client] Sending SIGTERM...');
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    if (await this.waitForExit(proc, 2000)) {
      console.log('[codex-client] Process exited after SIGTERM');
      this.cleanup(preserveListeners);
      return;
    }

    // Phase 3: SIGKILL (1s) - force kill
    console.log('[codex-client] Sending SIGKILL...');
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await this.waitForExit(proc, 1000);
    console.log('[codex-client] Process killed');
    this.cleanup(preserveListeners);
  }

  private cleanup(preserveListeners = false): void {
    if (!preserveListeners) {
      this.removeAllListeners();
    }
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
   * Get the current sandbox mode (if explicitly set).
   */
  getSandboxMode(): SandboxMode | undefined {
    return this.sandboxMode;
  }

  /**
   * Restart the app-server with a new sandbox mode.
   * Preserves event listeners for live Slack integrations.
   */
  async restartWithSandbox(mode: SandboxMode): Promise<void> {
    if (this.sandboxMode === mode && this.process) {
      return;
    }
    this.sandboxMode = mode;
    if (this.process) {
      await this.stop(true);
    }
    await this.start();
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
   * Read thread information from Codex.
   * This is the source of truth for thread state, including turn count.
   *
   * @param threadId - The thread to read
   * @param includeTurns - Whether to include turn history (default: false)
   * @returns Thread info with optional turns array
   */
  async readThread(
    threadId: string,
    includeTurns = false
  ): Promise<{ thread: ThreadInfo; turns?: Array<{ id: string }> }> {
    const result = await this.rpc<{
      thread: ThreadInfo & { turns?: Array<{ id: string }> };
    }>('thread/read', {
      threadId,
      includeTurns,
    });
    return {
      thread: result.thread,
      turns: result.thread.turns,
    };
  }

  /**
   * Get the number of turns in a thread from Codex (source of truth).
   *
   * @param threadId - The thread to query
   * @returns The number of turns in the thread
   */
  async getThreadTurnCount(threadId: string): Promise<number> {
    const { turns } = await this.readThread(threadId, true);
    return turns?.length ?? 0;
  }

  /**
   * Find the index of a turn by its turnId in Codex (source of truth).
   * Returns -1 if not found.
   *
   * IMPORTANT: Codex has a format mismatch between events and thread/read:
   * - turn:started event returns turnId as "0", "1", "2" (0-indexed number strings)
   * - thread/read returns turns[].id as "turn-1", "turn-2" (1-indexed with "turn-" prefix)
   *
   * This function handles both formats for robustness.
   *
   * @param threadId - The thread to query
   * @param turnId - The turn ID to find (from turn:started event)
   * @returns The 0-based index of the turn, or -1 if not found
   */
  async findTurnIndex(threadId: string, turnId: string): Promise<number> {
    const { turns } = await this.readThread(threadId, true);
    if (!turns || turns.length === 0) return -1;

    // Try direct match first (in case Codex fixes the format mismatch)
    let index = turns.findIndex((t) => t.id === turnId);
    if (index >= 0) {
      console.log(`[codex-client] findTurnIndex: direct match for turnId="${turnId}" at index ${index}`);
      return index;
    }

    // Handle format mismatch: turnId from turn:started is "0", "1", etc.
    // but thread/read returns "turn-1", "turn-2", etc.
    // Convert "0" -> "turn-1", "1" -> "turn-2", etc.
    const numericId = parseInt(turnId, 10);
    if (!isNaN(numericId)) {
      const convertedId = `turn-${numericId + 1}`;
      index = turns.findIndex((t) => t.id === convertedId);
      if (index >= 0) {
        console.log(`[codex-client] findTurnIndex: converted "${turnId}" to "${convertedId}", found at index ${index}`);
        return index;
      }
    }

    // Also try the reverse: if turnId is "turn-1", extract the number
    const turnMatch = turnId.match(/^turn-(\d+)$/);
    if (turnMatch) {
      const turnNum = parseInt(turnMatch[1], 10);
      // Return 0-based index: "turn-1" -> index 0
      if (turnNum >= 1 && turnNum <= turns.length) {
        console.log(`[codex-client] findTurnIndex: extracted index ${turnNum - 1} from "${turnId}"`);
        return turnNum - 1;
      }
    }

    console.log(`[codex-client] findTurnIndex: turnId="${turnId}" not found in turns: [${turns.map(t => t.id).join(', ')}]`);
    return -1;
  }

  /**
   * Fork a thread (creates a full copy).
   * Note: Codex thread/fork does NOT support turnIndex parameter.
   * For point-in-time forking, use forkThread + rollbackThread.
   */
  async forkThread(threadId: string): Promise<ThreadInfo> {
    const result = await this.rpc<{ thread: ThreadInfo }>('thread/fork', { threadId });
    return result.thread;
  }

  /**
   * Fork a thread at a specific turn index (point-in-time fork).
   * This forks the thread, then rolls back to keep only turns up to turnIndex.
   *
   * ROBUST: Gets the actual turn count from Codex (source of truth), not our tracking.
   * This handles cases where user continued in CLI, /resumed elsewhere, etc.
   *
   * @param threadId - The thread to fork
   * @param turnIndex - The turn index to fork at (0-based, inclusive)
   * @returns The forked thread info
   */
  async forkThreadAtTurn(
    threadId: string,
    turnIndex: number
  ): Promise<ThreadInfo> {
    // Get ACTUAL turn count from Codex (source of truth)
    // This is robust against CLI usage, /resume elsewhere, bot restarts, etc.
    const totalTurns = await this.getThreadTurnCount(threadId);
    console.log(`[fork] Codex reports ${totalTurns} turns in source thread, forking at turn ${turnIndex}`);

    // Validate turnIndex is within bounds
    if (turnIndex < 0 || turnIndex >= totalTurns) {
      throw new Error(`Invalid turnIndex ${turnIndex}: thread has ${totalTurns} turns (0-${totalTurns - 1})`);
    }

    // First, create a full fork
    const forkedThread = await this.forkThread(threadId);

    // Calculate how many turns to rollback
    // If we have turns [0, 1, 2] and want to fork at turn 0, we keep 1 turn and drop 2
    const turnsToKeep = turnIndex + 1;
    const turnsToRollback = totalTurns - turnsToKeep;

    console.log(`[fork] Keeping ${turnsToKeep} turns, rolling back ${turnsToRollback} turns`);

    if (turnsToRollback > 0) {
      // Rollback the forked thread to the desired point
      await this.rollbackThread(forkedThread.id, turnsToRollback);
    }

    return forkedThread;
  }

  /**
   * Rollback a thread by dropping turns from the end.
   *
   * @param threadId - The thread to rollback
   * @param numTurns - Number of turns to drop from the end (must be >= 1)
   */
  async rollbackThread(threadId: string, numTurns: number): Promise<void> {
    if (numTurns < 1) {
      throw new Error('numTurns must be >= 1');
    }
    await this.rpc<{ thread: ThreadInfo }>('thread/rollback', {
      threadId,
      numTurns,
    });
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

  /**
   * Get account rate limits and credits.
   */
  async getRateLimits(): Promise<RateLimits | null> {
    try {
      const result = await this.rpc<{ rateLimits: RateLimits }>('account/rateLimits/read', {});
      return result.rateLimits;
    } catch {
      // May not be available
      return null;
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
    } else if (isRequest(message)) {
      this.handleRequest(message);
    }
  }

  private emitApprovalRequest(method: string, params: Record<string, unknown>, rpcId?: number): void {
    const approvalRequest = {
      method,
      params: params as ApprovalRequest['params'],
      ...(rpcId !== undefined ? { rpcId } : {}),
    } as ApprovalRequestWithId;

    this.emit('approval:requested', approvalRequest);
  }

  private handleRequest(request: JsonRpcRequest): void {
    const params = request.params || {};

    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.emitApprovalRequest(request.method, params, request.id);
        break;
      default:
        console.warn('Received unhandled JSON-RPC request:', request.method);
        break;
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.emit('notification', notification);

    const params = notification.params || {};
    const method = notification.method;

    // DEBUG: Log thinking-related notifications
    if (method.includes('reason') || method.includes('think')) {
      console.log(`[codex-client] Thinking notification: ${method}`, JSON.stringify(params).slice(0, 200));
    }

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
        // VERIFIED via test-multi-query.ts - two different structures:
        //
        // codex/event/task_complete:
        //   { id: "0", msg: { type: "task_complete", ... }, conversationId: "uuid" }
        //   - threadId is in params.conversationId
        //   - turnId is in params.id
        //
        // turn/completed:
        //   { threadId: "uuid", turn: { id: "0", status: "completed", ... } }
        //   - threadId is in params.threadId
        //   - turnId is in params.turn.id
        //   - status is in params.turn.status
        const p = params as Record<string, unknown>;
        const turn = p.turn as Record<string, unknown> | undefined;

        // Extract threadId from multiple locations
        const threadId = (p.threadId || p.conversationId || '') as string;

        // Extract turnId from multiple locations
        const turnId = (turn?.id || p.turnId || p.id || '') as string;

        // Extract status from multiple locations
        const rawStatus = (turn?.status || p.status) as string | undefined;
        let normalizedStatus: TurnStatus = 'completed'; // Default to completed for task_complete

        if (rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'done') {
          normalizedStatus = 'completed';
        } else if (rawStatus === 'interrupted' || rawStatus === 'cancelled' || rawStatus === 'aborted') {
          normalizedStatus = 'interrupted';
        } else if (rawStatus === 'failed' || rawStatus === 'error') {
          normalizedStatus = 'failed';
        }

        console.log(`[codex-client] ${method}: threadId="${threadId}" turnId="${turnId}" status="${normalizedStatus}"`);

        // Deduplicate turn completions (task_complete + turn/completed)
        const key = `${threadId}:${turnId}`;
        const now = Date.now();
        const lastSeen = this.recentTurnCompletions.get(key);
        if (lastSeen && now - lastSeen < this.TURN_COMPLETION_TTL_MS) {
          console.log(`[codex-client] turn:completed duplicate suppressed for key=${key}`);
          break;
        }
        this.recentTurnCompletions.set(key, now);
        // Cleanup old entries occasionally
        for (const [k, ts] of this.recentTurnCompletions) {
          if (now - ts > this.TURN_COMPLETION_TTL_MS * 10) {
            this.recentTurnCompletions.delete(k);
          }
        }

        this.emit('turn:completed', {
          threadId,
          turnId,
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

        // Emit thinking:started for Reasoning items
        // NOTE: Codex encrypts thinking content - we can only detect when it happens
        if (itemType === 'reasoning') {
          this.reasoningItemStartTimes.set(itemId, Date.now());
          this.emit('thinking:started', { itemId });
        }
        break;
      }

      case 'item/completed':
      case 'codex/event/item_completed': {
        const p = params as Record<string, unknown>;
        // Extract item from either format
        const msg = p.msg as Record<string, unknown> | undefined;
        const item = (msg?.item || p.item) as Record<string, unknown> | undefined;
        // Extract itemId and type
        const itemId = (item?.id || p.itemId || p.item_id || p.id || '') as string;
        let itemType = (item?.type || '') as string;
        // Normalize PascalCase to camelCase
        if (itemType && itemType.length > 0 && itemType[0] === itemType[0].toUpperCase()) {
          itemType = itemType[0].toLowerCase() + itemType.slice(1);
        }

        this.emit('item:completed', { itemId });

        // Emit thinking:complete for Reasoning items
        if (itemType === 'reasoning' || this.reasoningItemStartTimes.has(itemId)) {
          const startTime = this.reasoningItemStartTimes.get(itemId);
          const durationMs = startTime ? Date.now() - startTime : 0;
          this.reasoningItemStartTimes.delete(itemId);
          this.emit('thinking:complete', { itemId, durationMs });
        }
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
        this.emitApprovalRequest(notification.method, params as Record<string, unknown>);
        break;

      // Token usage events - VERIFIED via test-token-event.ts capturing actual server responses:
      //
      // codex/event/token_count structure:
      //   params.msg.info.total_token_usage.{input_tokens, cached_input_tokens, output_tokens, total_tokens}
      //   params.msg.info.last_token_usage.{input_tokens, cached_input_tokens, output_tokens, total_tokens}
      //   params.msg.info.model_context_window
      //
      // thread/tokenUsage/updated structure:
      //   params.tokenUsage.total.{inputTokens, cachedInputTokens, outputTokens} (camelCase!)
      //   params.tokenUsage.modelContextWindow
      case 'thread/tokenUsage/updated':
      case 'codex/event/token_count': {
        const p = params as {
          // codex/event/token_count: wrapped in msg
          msg?: {
            info?: {
              total_token_usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; total_tokens?: number };
              last_token_usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; total_tokens?: number };
              model_context_window?: number | null;
            };
          };
          // thread/tokenUsage/updated: direct tokenUsage (camelCase)
          tokenUsage?: {
            total?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens?: number };
            modelContextWindow?: number;
          };
        };

        // Extract from codex/event/token_count (msg.info, snake_case)
        const msgInfo = p.msg?.info;
        const msgUsage = msgInfo?.total_token_usage;
        const msgLastUsage = msgInfo?.last_token_usage;

        // Extract from thread/tokenUsage/updated (tokenUsage, camelCase)
        const threadUsage = p.tokenUsage?.total;

        // Merge both sources
        // Prefer explicit input/output when present; avoid defaulting to 0 when totalTokens exists.
        const inputTokens = msgUsage?.input_tokens ?? threadUsage?.inputTokens;
        const outputTokens = msgUsage?.output_tokens ?? threadUsage?.outputTokens;
        const totalTokens = msgUsage?.total_tokens ?? threadUsage?.totalTokens;
        const cacheReadInputTokens = msgUsage?.cached_input_tokens ?? threadUsage?.cachedInputTokens;
        const contextWindow = msgInfo?.model_context_window ?? p.tokenUsage?.modelContextWindow;
        const source = method === 'codex/event/token_count' ? 'token_count' : 'thread_token_usage';
        const lastInputTokens = msgLastUsage?.input_tokens;
        const lastOutputTokens = msgLastUsage?.output_tokens;
        const lastTotalTokens = msgLastUsage?.total_tokens;
        const lastCacheReadInputTokens = msgLastUsage?.cached_input_tokens;

        this.emit('tokens:updated', {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          totalTokens: totalTokens ?? undefined,
          contextWindow: contextWindow ?? undefined,
          cacheReadInputTokens,
          lastInputTokens,
          lastOutputTokens,
          lastTotalTokens,
          lastCacheReadInputTokens,
          source,
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

      // File change output streaming (patch/diff content)
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/output_delta': {
        const p = params as Record<string, unknown>;
        const msg = p.msg as Record<string, unknown> | undefined;
        const delta = (p.delta || p.content || p.text ||
          msg?.delta || msg?.content || msg?.text || '') as string;
        const itemId = (p.itemId || p.item_id || msg?.item_id || msg?.itemId || msg?.id || p.id || '') as string;
        if (delta) {
          this.emit('filechange:delta', { itemId, delta });
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

      // Web search lifecycle events
      case 'codex/event/web_search_begin': {
        const p = params as Record<string, unknown>;
        const msg = (p.msg as Record<string, unknown> | undefined) ?? p;

        const itemId = (msg.call_id || msg.item_id || msg.itemId || msg.search_id || msg.searchId || p.id || msg.id || '') as string;
        const query = (msg.query || msg.search_query || msg.searchQuery || msg.q || msg.text || msg.prompt ||
          (msg.input as Record<string, unknown> | undefined)?.query || msg.input) as string | undefined;
        const url = (msg.url || msg.search_url || msg.searchUrl || msg.endpoint) as string | undefined;
        const threadId = (p.conversationId || p.threadId || p.thread_id || msg.thread_id || msg.threadId || '') as string;
        const turnId = (msg.turn_id || p.turnId || p.turn_id || '') as string;

        if (threadId && turnId) {
          this.emit('context:turnId', { threadId, turnId });
        }

        this.emit('websearch:started', {
          itemId: itemId || `websearch-${Date.now()}`,
          query,
          url,
          threadId: threadId || undefined,
          turnId: turnId || undefined,
        });
        break;
      }

      case 'codex/event/web_search_end': {
        const p = params as Record<string, unknown>;
        const msg = (p.msg as Record<string, unknown> | undefined) ?? p;

        const itemId = (msg.call_id || msg.item_id || msg.itemId || msg.search_id || msg.searchId || p.id || msg.id || '') as string;
        const query = (msg.query || msg.search_query || msg.searchQuery || msg.q || msg.text || msg.prompt ||
          (msg.input as Record<string, unknown> | undefined)?.query || msg.input) as string | undefined;
        const durationMs = (msg.duration_ms || msg.elapsed_ms || msg.latency_ms || p.duration_ms || p.elapsed_ms) as number | undefined;
        const threadId = (p.conversationId || p.threadId || p.thread_id || msg.thread_id || msg.threadId || '') as string;
        const turnId = (msg.turn_id || p.turnId || p.turn_id || '') as string;

        const results = (msg.results || (msg.output as Record<string, unknown> | undefined)?.results ||
          msg.urls || msg.links) as unknown;
        let resultUrls: string[] | undefined;
        if (Array.isArray(results)) {
          resultUrls = results
            .map((r) => (r as Record<string, unknown>).url || (r as Record<string, unknown>).link || (r as Record<string, unknown>).href)
            .filter((u): u is string => typeof u === 'string' && u.length > 0);
        } else if (typeof results === 'string') {
          resultUrls = [results];
        }

        const url = (msg.url || msg.search_url || msg.searchUrl || msg.endpoint ||
          (resultUrls && resultUrls.length > 0 ? resultUrls[0] : undefined)) as string | undefined;

        this.emit('websearch:completed', {
          itemId: itemId || `websearch-${Date.now()}`,
          query,
          url,
          resultUrls,
          durationMs,
          threadId: threadId || undefined,
          turnId: turnId || undefined,
        });
        break;
      }

      // Informational events (log but don't emit)
      case 'thread/started':
      case 'account/rateLimits/updated':
      case 'codex/event/turn_diff':
      case 'codex/event/mcp_startup_update':
      case 'codex/event/mcp_startup_complete':
      case 'codex/event/user_message':
      case 'codex/event/agent_message':
      case 'codex/event/agent_reasoning':
      case 'codex/event/agent_reasoning_section_break':
      case 'codex/event/turn_aborted':
      case 'codex/event/patch_apply_end':
      case 'codex/event/turn_diff_updated':
      case 'turn/diff/updated':
        // These are informational - no action needed
        break;

      // Reasoning summary events - these contain the actual thinking content!
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/summaryTextDelta': {
        const p = params as Record<string, unknown>;
        const text = (p.text || p.delta || p.content || p.part || '') as string;
        if (text) {
          console.log(`[codex-client] Reasoning summary: ${method}`, text.slice(0, 100));
          this.emit('thinking:delta', { content: text });
        }
        break;
      }

      default:
        // Unknown notification - log but don't crash
        console.log('Unknown notification:', method);
    }
  }

  private handleProcessExit(code: number | null, proc?: ChildProcess | null): void {
    const active = this.process;
    if (!active) {
      return;
    }

    if (proc && active !== proc) {
      // Ignore stale process exits (e.g., during intentional restarts).
      return;
    }

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
