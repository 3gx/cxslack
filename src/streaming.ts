/**
 * Streaming handler for Codex events → Slack message updates.
 *
 * Handles:
 * - Real-time message streaming with timer-based throttling
 * - Turn lifecycle (started, completed, interrupted)
 * - Item events (agent message deltas)
 * - Approval request routing
 *
 * Uses CCSLACK architecture:
 * - Timer-based updates (not event-driven)
 * - Single activity message that gets updated
 * - Rolling window of entries (max 20 shown)
 * - Status line at bottom
 * - Mutex for concurrent update protection
 */

import type { WebClient } from '@slack/web-api';
import { Mutex } from 'async-mutex';
import type {
  CodexClient,
  TurnStatus,
  ApprovalRequest,
  ApprovalPolicy,
  ReasoningEffort,
  SandboxMode,
} from './codex-client.js';
import {
  buildActivityBlocks,
  DEFAULT_CONTEXT_WINDOW,
  computeAutoCompactThreshold,
  buildActivityEntryBlocks,
  buildForkButton,
} from './blocks.js';
import {
  markProcessingStart,
  removeProcessingEmoji,
  markError,
  markAborted as markAbortedEmoji,
} from './emoji-reactions.js';
import { isAborted, clearAborted } from './abort-tracker.js';
import { saveSession, saveThreadSession, getThreadSession, getSession, LastUsage } from './session-manager.js';
import {
  ActivityThreadManager,
  ActivityEntry,
  getToolEmoji,
  buildActivityLogText,
  flushActivityBatchToThread,
  postThinkingToThread,
  postResponseToThread,
  postErrorToThread,
} from './activity-thread.js';
import { buildActivityEntryActionParams } from './blocks.js';
import { withSlackRetry } from './slack-retry.js';
import { THINKING_MESSAGE_SIZE } from './commands.js';

// Constants matching CCSLACK architecture
const MAX_LIVE_ENTRIES = 300; // Threshold for rolling window
const ROLLING_WINDOW_SIZE = 20; // Show last N entries when exceeded
const ACTIVITY_LOG_MAX_CHARS = 1000; // Max chars for activity display
const STATUS_SPINNER_FRAMES = ['\u25D0', '\u25D3', '\u25D1', '\u25D2'];

// Item types that should NOT be displayed as tool activity
// These are message lifecycle events, not tool executions
const NON_TOOL_ITEM_TYPES = new Set([
  'usermessage',    // User's input (already visible in Slack)
  'agentmessage',   // Agent's response (shown separately)
  'reasoning',      // Thinking (handled by thinking:delta events)
]);

/**
 * Check if an item type is a displayable tool.
 * Filters out message lifecycle events that shouldn't appear as tool activity.
 * Uses case-insensitive matching and normalizes separators.
 */
export function isToolItemType(itemType: unknown): boolean {
  // Type guard - handle null/undefined/non-string
  if (typeof itemType !== 'string' || itemType.length === 0) {
    return true; // Unknown types pass through (safe default)
  }

  // Normalize: convert to lowercase and remove separators
  const normalized = itemType
    .toLowerCase()
    .replace(/[-_]/g, '');

  return !NON_TOOL_ITEM_TYPES.has(normalized);
}

// Mutex management for concurrent update protection
const updateMutexes = new Map<string, Mutex>();

function getUpdateMutex(conversationKey: string): Mutex {
  if (!updateMutexes.has(conversationKey)) {
    updateMutexes.set(conversationKey, new Mutex());
  }
  return updateMutexes.get(conversationKey)!;
}

function cleanupMutex(conversationKey: string): void {
  updateMutexes.delete(conversationKey);
}

/**
 * Conversation context for a streaming turn.
 */
export interface StreamingContext {
  /** Slack channel ID */
  channelId: string;
  /** Slack thread timestamp (undefined for main channel) */
  threadTs?: string;
  /** Slack message timestamp being updated */
  messageTs: string;
  /** User's original message timestamp (for emoji reactions) */
  originalTs: string;
  /** User ID who initiated the request */
  userId?: string;
  /** Codex thread ID */
  threadId: string;
  /** Current turn ID */
  turnId: string;
  /** Current approval policy */
  approvalPolicy: ApprovalPolicy;
  /** Current reasoning effort */
  reasoningEffort?: ReasoningEffort;
  /** Current sandbox mode */
  sandboxMode?: SandboxMode;
  /** Update rate in ms */
  updateRateMs: number;
  /** Model being used */
  model?: string;
  /** Turn start time (for duration calculation) */
  startTime: number;
}

/**
 * Streaming state for a turn.
 */
interface StreamingState {
  /** Accumulated message text (response content) */
  text: string;
  /** Whether we're actively streaming */
  isStreaming: boolean;
  /** Last update timestamp */
  lastUpdateTime: number;
  /** Periodic update timer (interval, not timeout) */
  updateTimer: ReturnType<typeof setInterval> | null;
  /** Current turn status */
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  /** Accumulated input tokens */
  inputTokens: number;
  /** Accumulated output tokens */
  outputTokens: number;
  /** Cache read input tokens (if provided) */
  cacheReadInputTokens: number;
  /** Cache creation input tokens (if provided) */
  cacheCreationInputTokens: number;
  /** Baseline cumulative tokens at turn start (to compute deltas) */
  baseInputTokens?: number;
  baseOutputTokens?: number;
  baseCacheCreationInputTokens?: number;
  /** Context window size (if provided) */
  contextWindow?: number;
  /** Max output tokens (if provided) */
  maxOutputTokens?: number;
  /** Total cost in USD (if provided) */
  costUsd?: number;
  /** Accumulated thinking content */
  thinkingContent: string;
  /** Thinking start timestamp */
  thinkingStartTime: number;
  /** Whether thinking has completed (for display) */
  thinkingComplete: boolean;
  /** Thinking message ts for in-place updates (ccslack parity) */
  thinkingMessageTs?: string;
  /** Thinking item ID (for matching complete event) */
  thinkingItemId?: string;
  /** Last thinking message update time (rate limiting - 2s gap) */
  lastThinkingUpdateTime: number;
  /** Track active tools by itemId */
  activeTools: Map<string, {
    tool: string;
    input?: string;  // Display input (truncated command, file path, etc.)
    toolInput?: string | Record<string, unknown>;  // Full structured input for metrics
    startTime: number;
    // Bash command output accumulation (via command:output events)
    outputBuffer?: string;
    exitCode?: number;
    // Non-bash tools can store a short output preview (web search URLs, etc.)
    outputPreview?: string;
  }>;
  /** The ONE activity message timestamp we update */
  activityMessageTs?: string;
  /** Spinner index for status updates */
  spinnerIndex: number;
  /** Whether an abort is pending (waiting for turnId) */
  pendingAbort?: boolean;
  /** Timeout for pending abort (safety net) */
  pendingAbortTimeout?: ReturnType<typeof setTimeout>;
  // Activity thread batch state (for thread posting)
  /** User's message ts (thread parent) */
  threadParentTs: string | null;
  /** Entries waiting to post to thread */
  activityBatch: ActivityEntry[];
  /** Rate limiting (min 2s gap) */
  lastActivityPostTime: number;
  /** For batch updates when tool_result arrives */
  postedBatchTs: string | null;
  /** Race condition fix - track posted tool use IDs */
  postedBatchToolUseIds: Set<string>;
  /** Current thinking segment ID counter (increments when tool starts between thinking) */
  thinkingSegmentCounter: number;
  /** Current segment ID being streamed */
  currentThinkingSegmentId?: string;
  /** Flag to skip duplicate post in turn:completed (only set on successful flush) */
  thinkingPostedDuringStreaming: boolean;
}

/**
 * Create a unique conversation key from channel and thread.
 */
export function makeConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

/**
 * Parse a conversation key back to channel and thread.
 */
export function parseConversationKey(key: string): { channelId: string; threadTs?: string } {
  const parts = key.split(':');
  return {
    channelId: parts[0],
    threadTs: parts[1],
  };
}

/**
 * Streaming manager for handling Codex events and Slack updates.
 */
export class StreamingManager {
  private contexts = new Map<string, StreamingContext>();
  private states = new Map<string, StreamingState>();
  private slack: WebClient;
  private codex: CodexClient;
  private approvalCallback?: (request: ApprovalRequest, context: StreamingContext) => void;
  private activityManager = new ActivityThreadManager();

  constructor(slack: WebClient, codex: CodexClient) {
    this.slack = slack;
    this.codex = codex;
    this.setupEventHandlers();
  }

  /**
   * Set callback for approval requests.
   */
  onApprovalRequest(callback: (request: ApprovalRequest, context: StreamingContext) => void): void {
    this.approvalCallback = callback;
  }

  /**
   * Start streaming for a new turn.
   * Uses CCSLACK architecture: timer-based updates, reuses initial message.
   */
  startStreaming(context: StreamingContext): void {
    const key = makeConversationKey(context.channelId, context.threadTs);
    console.log(`[streaming] startStreaming: key="${key}" threadId="${context.threadId}"`);

    // CRITICAL: Clean up any existing state for this key to prevent:
    // 1. Orphaned timers that keep running
    // 2. State corruption from overlapping contexts
    // 3. Wrong emoji removal when turn:completed arrives for old turn
    const existingState = this.states.get(key);
    if (existingState) {
      console.log(`[streaming] Cleaning up existing state for ${key} before starting new turn`);
      if (existingState.updateTimer) {
        clearInterval(existingState.updateTimer);
      }
      if (existingState.pendingAbortTimeout) {
        clearTimeout(existingState.pendingAbortTimeout);
      }
      // Remove emoji from OLD message if still present (best effort)
      const existingContext = this.contexts.get(key);
      if (existingContext) {
        removeProcessingEmoji(this.slack, existingContext.channelId, existingContext.originalTs)
          .catch(() => { /* ignore - may already be removed */ });
      }
    }
    cleanupMutex(key);
    this.activityManager.clearEntries(key);

    // Create state - REUSE initial message as activity message
    const state: StreamingState = {
      text: '',
      isStreaming: true,
      lastUpdateTime: 0,
      updateTimer: null,
      status: 'running',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: undefined,
      maxOutputTokens: undefined,
      costUsd: undefined,
      thinkingContent: '',
      thinkingStartTime: 0,
      thinkingComplete: false,
      thinkingMessageTs: undefined,
      lastThinkingUpdateTime: 0,
      activeTools: new Map(),
      activityMessageTs: context.messageTs, // REUSE initial message!
      spinnerIndex: 0,
      pendingAbort: false,
      pendingAbortTimeout: undefined,
      // Activity thread batch state
      threadParentTs: context.originalTs, // User's message as thread parent
      activityBatch: [],
      lastActivityPostTime: 0,
      postedBatchTs: null,
      postedBatchToolUseIds: new Set(),
      // Thinking segment tracking for update-in-place
      thinkingSegmentCounter: 0,
      currentThinkingSegmentId: undefined,
      thinkingPostedDuringStreaming: false,
    };

    this.contexts.set(key, context);
    this.states.set(key, state);

    // Add "Analyzing request..." entry
    this.activityManager.addEntry(key, {
      type: 'starting',
      timestamp: Date.now(),
    });

    // Add eyes emoji to user's original message
    markProcessingStart(this.slack, context.channelId, context.originalTs).catch((err) => {
      console.error('Failed to add processing emoji:', err);
    });

    // Start timer AFTER state is set - uses context.updateRateMs (from /update-rate command)
    state.updateTimer = setInterval(() => {
      this.updateActivityMessage(key).catch((err) => {
        console.error('Failed to update activity message:', err);
      });
    }, context.updateRateMs);

    // Do initial update immediately
    this.updateActivityMessage(key).catch((err) => {
      console.error('Failed to post initial activity message:', err);
    });
  }

  /**
   * Stop streaming for a conversation.
   */
  stopStreaming(conversationKey: string): void {
    const state = this.states.get(conversationKey);
    if (state?.updateTimer) {
      clearInterval(state.updateTimer);
    }
    cleanupMutex(conversationKey);
    this.activityManager.clearEntries(conversationKey);
    this.contexts.delete(conversationKey);
    this.states.delete(conversationKey);
  }

  /**
   * Stop all streaming contexts (used during shutdown).
   */
  stopAllStreaming(): void {
    console.log(`[streaming] Stopping all streaming (${this.contexts.size} active)`);
    for (const [key, state] of this.states) {
      // Clear update timer
      if (state.updateTimer) {
        clearInterval(state.updateTimer);
        state.updateTimer = null;
      }
      // Clear pending abort timeout (from abort fix)
      if (state.pendingAbortTimeout) {
        clearTimeout(state.pendingAbortTimeout);
        state.pendingAbortTimeout = undefined;
      }
      // Clear mutex
      cleanupMutex(key);
      // Clear activity entries
      this.activityManager.clearEntries(key);
    }
    this.contexts.clear();
    this.states.clear();
  }

  /**
   * Clear the update timer (used by abort handler).
   */
  clearTimer(conversationKey: string): void {
    const state = this.states.get(conversationKey);
    if (state?.updateTimer) {
      clearInterval(state.updateTimer);
      state.updateTimer = null;
    }
    cleanupMutex(conversationKey);
  }

  /**
   * Get context for a conversation.
   */
  getContext(conversationKey: string): StreamingContext | undefined {
    return this.contexts.get(conversationKey);
  }

  /**
   * Check if a conversation is actively streaming.
   */
  isStreaming(conversationKey: string): boolean {
    return this.states.get(conversationKey)?.isStreaming ?? false;
  }

  /**
   * Check if ANY conversation is actively streaming.
   */
  isAnyStreaming(): boolean {
    for (const state of this.states.values()) {
      if (state.isStreaming) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update streaming refresh rate for an active conversation.
   */
  updateRate(conversationKey: string, updateRateMs: number): void {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);
    if (!context || !state || !state.isStreaming) {
      return;
    }

    context.updateRateMs = updateRateMs;

    if (state.updateTimer) {
      clearInterval(state.updateTimer);
      state.updateTimer = null;
    }

    state.updateTimer = setInterval(() => {
      this.updateActivityMessage(conversationKey).catch((err) => {
        console.error('[streaming] Failed to update activity message:', err);
      });
    }, updateRateMs);
  }

  /**
   * Queue an abort request. If turnId is available, executes immediately.
   * Otherwise, queues the abort to be executed when turn:started arrives.
   */
  queueAbort(conversationKey: string): boolean {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);
    if (!context || !state) {
      console.log(`[abort] No active context for ${conversationKey}`);
      return false;
    }
    if (context.turnId) {
      console.log(`[abort] Executing immediate abort for turnId: ${context.turnId}`);
      this.codex.interruptTurn(context.threadId, context.turnId).catch((err) => {
        console.error('[abort] Failed to interrupt turn:', err);
      });
      return true;
    } else {
      console.log(`[abort] Queueing abort (turnId not yet available)`);
      state.pendingAbort = true;
      // Safety timeout: if turnId never arrives, clear pending state after 10s
      state.pendingAbortTimeout = setTimeout(() => {
        if (state.pendingAbort) {
          console.error('[abort] Timeout waiting for turnId - abort may not have been sent to Codex');
          state.pendingAbort = false;
        }
      }, 10000);
      return true;
    }
  }

  /**
   * Find context by turn ID.
   */
  findContextByTurnId(turnId: string): { key: string; context: StreamingContext } | undefined {
    for (const [key, context] of this.contexts) {
      if (context.turnId === turnId) {
        return { key, context };
      }
    }
    return undefined;
  }

  /**
   * Find context by thread ID.
   */
  findContextByThreadId(threadId: string): { key: string; context: StreamingContext } | undefined {
    for (const [key, context] of this.contexts) {
      if (context.threadId === threadId) {
        return { key, context };
      }
    }
    return undefined;
  }

  private setupEventHandlers(): void {
    // Turn started - update turnId and check for pending abort
    this.codex.on('turn:started', ({ threadId, turnId }) => {
      const found = this.findContextByThreadId(threadId);
      if (found) {
        found.context.turnId = turnId;
        const state = this.states.get(found.key);
        if (state?.pendingAbort) {
          console.log(`[streaming] Executing pending abort for turnId: ${turnId}`);
          state.pendingAbort = false;
          if (state.pendingAbortTimeout) {
            clearTimeout(state.pendingAbortTimeout);
            state.pendingAbortTimeout = undefined;
          }
          this.codex.interruptTurn(threadId, turnId).catch((err) => {
            console.error('[streaming] Failed to execute pending abort:', err);
          });
        }
      }
    });

    // context:turnId - backup source for turnId from exec_command notifications
    this.codex.on('context:turnId', ({ threadId, turnId }) => {
      const found = this.findContextByThreadId(threadId);
      if (found && !found.context.turnId) {
        found.context.turnId = turnId;
        console.log(`[streaming] Got turnId from context:turnId: ${turnId}`);
        const state = this.states.get(found.key);
        if (state?.pendingAbort) {
          console.log(`[streaming] Executing pending abort from context:turnId`);
          state.pendingAbort = false;
          if (state.pendingAbortTimeout) {
            clearTimeout(state.pendingAbortTimeout);
            state.pendingAbortTimeout = undefined;
          }
          this.codex.interruptTurn(threadId, turnId).catch((err) => {
            console.error('[streaming] Failed to execute pending abort:', err);
          });
        }
      }
    });

    // Turn completed
    this.codex.on('turn:completed', async ({ threadId, turnId, status }) => {
      console.log(`[streaming] turn:completed HANDLER: threadId="${threadId}" status="${status}"`);
      console.log(`[streaming] Current contexts: ${Array.from(this.contexts.entries()).map(([k, c]) => `${k}→${c.threadId}`).join(', ')}`);

      const found = this.findContextByThreadId(threadId);
      if (!found) {
        console.log(`[streaming] turn:completed: NO CONTEXT FOUND for threadId="${threadId}"`);
        return;
      }

      console.log(`[streaming] turn:completed: FOUND context key="${found.key}"`);
      const state = this.states.get(found.key);
      if (state) {
          // IMMEDIATELY stop the timer
          if (state.updateTimer) {
            clearInterval(state.updateTimer);
            state.updateTimer = null;
          }

          // Check if aborted (takes precedence over other statuses)
          const wasAborted = isAborted(found.key);
          if (wasAborted) {
            status = 'interrupted'; // Override status
          }

          state.status = status;
          state.isStreaming = false;

          // Mark thinking as complete if we had thinking content
          if (state.thinkingContent) {
            state.thinkingComplete = true;
          }

          // Add response entry if we have response content
          if (state.text && status === 'completed') {
            this.activityManager.addEntry(found.key, {
              type: 'generating',
              timestamp: Date.now(),
              charCount: state.text.length,
            });
          }

          // Transition emoji based on final status
          const { channelId, originalTs } = found.context;
          try {
            if (status === 'completed') {
              await removeProcessingEmoji(this.slack, channelId, originalTs);
            } else if (status === 'interrupted' || wasAborted) {
              await markAbortedEmoji(this.slack, channelId, originalTs);
            } else {
              await markError(this.slack, channelId, originalTs);
            }
          } catch (err) {
            console.error('Failed to transition emoji:', err);
          }

          // Clear abort state for next turn
          clearAborted(found.key);

          // Save lastUsage to BOTH channel and thread sessions for /status command
          // (Channel session is needed when /status is called from main channel @bot mentions)
          if (status === 'completed') {
            // Compute per-turn deltas to avoid cumulative totals from resumed sessions
            const adjInput = Math.max(0, state.inputTokens - (state.baseInputTokens ?? 0));
            const adjOutput = Math.max(0, state.outputTokens - (state.baseOutputTokens ?? 0));
            const adjCacheCreation = Math.max(0, state.cacheCreationInputTokens - (state.baseCacheCreationInputTokens ?? 0));
            const lastUsage: LastUsage = {
              inputTokens: adjInput,
              outputTokens: adjOutput,
              cacheReadInputTokens: state.cacheReadInputTokens,
              cacheCreationInputTokens: adjCacheCreation || undefined,
              contextWindow: state.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
              model: found.context.model || 'unknown',
              maxOutputTokens: state.maxOutputTokens,
            };
            // Save to channel session (for main channel @bot mentions)
            await saveSession(channelId, { lastUsage })
              .catch((err) => console.error('[streaming] Failed to save lastUsage to channel:', err));
            // Save to thread session (for threaded conversations)
            if (found.context.threadTs) {
              await saveThreadSession(channelId, found.context.threadTs, { lastUsage })
                .catch((err) => console.error('[streaming] Failed to save lastUsage to thread:', err));
            }
          }

          // Integration point 4: Force flush activity batch on turn completion
          await flushActivityBatchToThread(
            this.activityManager,
            found.key,
            this.slack,
            channelId,
            state.threadParentTs || originalTs,
            {
              force: true,
              mapActivityTs: (ts, entry) => {
                const threadSession = getThreadSession(channelId, state.threadParentTs || originalTs);
                const messageTurnMap = threadSession?.messageTurnMap || {};
                messageTurnMap[ts] = found.context.turnId;
                const messageToolMap = threadSession?.messageToolMap || {};
                if (entry.toolUseId) {
                  messageToolMap[ts] = entry.toolUseId;
                }
                saveThreadSession(channelId, state.threadParentTs || originalTs, {
                  messageTurnMap,
                  messageToolMap,
                }).catch((err) => console.error('[streaming] Failed to save messageTurn/Tool map (final):', err));
              },
              buildActions: (entry, slackTs) => {
                // includeAttachThinking=false: full thinking content is posted by postThinkingToThread
                return buildActivityEntryActionParams(entry, found.key, found.context.turnId, slackTs || state.activityMessageTs || originalTs, false);
              },
            }
          ).catch((err) => console.error('[streaming] Final batch flush failed:', err));

          // FIX: Wait for any pending thinking flushes to complete before checking flag
          // turn:completed is async, so we CAN await here (unlike the sync event handlers)
          const mutex = getUpdateMutex(found.key);
          await mutex.runExclusive(async () => {
            // Empty body - just waits for any queued flush work to complete
          });

          // Integration point 3: Post thinking to thread when thinking completes
          // FIX: Always post thinking content here. The streaming flush only posts headers
          // (":bulb: Thinking... [X chars]"), not actual content. postThinkingToThread posts
          // the full content as a separate message.
          const sessionForLimit = found.context.threadTs
            ? getThreadSession(channelId, found.context.threadTs)
            : getSession(channelId);
          const threadCharLimit = sessionForLimit?.threadCharLimit;

          if (state.thinkingContent && state.thinkingContent.length > 100) {
            await postThinkingToThread(
              this.slack,
              channelId,
              state.threadParentTs || originalTs,
              state.thinkingContent,
              Date.now() - (state.thinkingStartTime || found.context.startTime),
              THINKING_MESSAGE_SIZE
            ).catch((err) => console.error('[streaming] Thinking post failed:', err));
          }

          // Integration point 5: Post response to thread
          if (state.text && state.text.length > 200 && status === 'completed') {
            await postResponseToThread(
              this.slack,
              channelId,
              state.threadParentTs || originalTs,
              state.text,
              Date.now() - found.context.startTime,
              threadCharLimit
            ).catch((err) => console.error('[streaming] Response post failed:', err));
          }

          // Integration point 6: Post error to thread
          if (status === 'failed') {
            await postErrorToThread(
              this.slack,
              channelId,
              state.threadParentTs || originalTs,
              'Turn failed'
            ).catch((err) => console.error('[streaming] Error post failed:', err));
          }

          // FINAL update - shows complete status and response
          await this.updateActivityMessage(found.key);

          // Clean up activity entries
          this.activityManager.clearEntries(found.key);

          // CRITICAL FIX: Delete context and state from Maps to prevent stale contexts
          // from being matched by findContextByThreadId on subsequent queries.
          // Without this, multiple top-level messages sharing the same Codex threadId
          // would accumulate contexts, and findContextByThreadId would always return
          // the first (oldest) one, causing turn:completed to be handled on wrong context.
          this.contexts.delete(found.key);
          this.states.delete(found.key);
          console.log(`[streaming] Cleaned up context and state for key="${found.key}"`);
        }
    });

    // Item started (tool use) - FILTER non-tool items, timer handles updates
    this.codex.on('item:started', ({ itemId, itemType, command, commandActions, toolInput: rawToolInput }) => {
      // Skip non-tool items (userMessage, agentMessage, reasoning)
      if (!isToolItemType(itemType)) {
        console.log(`[streaming] Skipping non-tool item: ${itemType}`);
        return;
      }

      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          // Extract display command for commandExecution items
          let displayInput: string | undefined;
          if (itemType === 'commandExecution' || itemType === 'CommandExecution') {
            if (commandActions && commandActions.length > 0) {
              displayInput = commandActions[0].command; // e.g., "ls", "git status"
            } else if (command) {
              // Parse from "/bin/bash -lc <cmd>" format
              const match = command.match(/-lc\s+["']?(.+?)["']?$/);
              displayInput = match ? match[1] : command;
            }
          }

          // FIX: Reset thinking segment tracking so next thinking gets NEW segment ID
          // This ensures thinking AFTER a tool starts appears as a separate message
          state.currentThinkingSegmentId = undefined;
          state.thinkingSegmentCounter = (state.thinkingSegmentCounter || 0) + 1;

          // Track tool start (only actual tools now)
          // Store both display input and full toolInput for metrics extraction
          state.activeTools.set(itemId, {
            tool: itemType,
            input: displayInput,
            toolInput: rawToolInput || displayInput,  // Full input for metrics
            startTime: Date.now(),
          });

          // For TodoWrite, store the full structured input for todo extraction
          // For other tools, use the display input string
          const toolInputValue = rawToolInput || displayInput;

          // If this tool was already seeded (e.g., web search begin), just update metadata
          if (state.activeTools.has(itemId)) {
            const existingTool = state.activeTools.get(itemId)!;
            if (!existingTool.input && displayInput) {
              existingTool.input = displayInput;
            }
            if (!existingTool.toolInput && toolInputValue) {
              existingTool.toolInput = toolInputValue;
            }
            break;
          }

          // Add activity entry for actual tools only
          this.activityManager.addEntry(key, {
            type: 'tool_start',
            timestamp: Date.now(),
            tool: itemType,
            toolInput: toolInputValue,
            toolUseId: itemId,
          });

          const context = this.contexts.get(key);
          if (context) {
            flushActivityBatchToThread(
              this.activityManager,
              key,
              this.slack,
              context.channelId,
              state.threadParentTs || context.originalTs,
              {
                force: false,
                mapActivityTs: (ts, entry) => {
                  const threadSession = getThreadSession(context.channelId, context.threadTs || context.originalTs);
                  const messageToolMap = threadSession?.messageToolMap || {};
                  const messageTurnMap = threadSession?.messageTurnMap || {};
                  messageToolMap[ts] = entry.toolUseId || itemId;
                  messageTurnMap[ts] = context.turnId;
                  saveThreadSession(context.channelId, context.threadTs || context.originalTs, {
                    messageToolMap,
                    messageTurnMap,
                  }).catch((err) => console.error('[streaming] Failed to save message maps:', err));
                },
                buildActions: (entry, slackTs) =>
                  // includeAttachThinking=false: full thinking content is posted by postThinkingToThread
                  buildActivityEntryActionParams(entry, key, context.turnId, slackTs || context.originalTs, false),
              }
            ).catch((err) => console.error('[streaming] Thread batch post failed:', err));
          }

          break;
        }
      }
    });

    // Item completed (tool finished)
    this.codex.on('item:completed', ({ itemId }) => {
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          const toolInfo = state.activeTools.get(itemId);
          if (toolInfo) {
            const durationMs = Date.now() - toolInfo.startTime;

            // Extract metrics from toolInput (ported from ccslack)
            const entry: ActivityEntry = {
              type: 'tool_complete',
              timestamp: Date.now(),
              tool: toolInfo.tool,
              toolInput: toolInfo.toolInput || toolInfo.input,
              toolUseId: itemId,
              durationMs,
            };

            // Extract metrics based on tool type
            const toolLower = (toolInfo.tool || '').toLowerCase();
            const toolInput = typeof toolInfo.toolInput === 'object' ? toolInfo.toolInput as Record<string, unknown> : undefined;

            // Edit: compute linesAdded/linesRemoved from input
            if (toolLower === 'edit' && toolInput) {
              const oldString = (toolInput.old_string as string) || '';
              const newString = (toolInput.new_string as string) || '';
              entry.linesRemoved = oldString.split('\n').length;
              entry.linesAdded = newString.split('\n').length;
            }

            // Write: compute lineCount from content
            if (toolLower === 'write' && toolInput) {
              const content = (toolInput.content as string) || '';
              entry.lineCount = content.split('\n').length;
            }

            // Bash/CommandExecution: store output and exit code
            if ((toolLower === 'bash' || toolLower === 'commandexecution') && toolInfo.outputBuffer) {
              const output = toolInfo.outputBuffer;
              const MAX_PREVIEW = 300;

              // Check for binary content
              const isBinary = /[\x00-\x08\x0E-\x1A\x1C-\x1F]/.test(output.slice(0, 1000));
              if (isBinary) {
                entry.toolOutputPreview = '[Binary content]';
              } else {
                entry.toolOutput = output;
                entry.toolOutputTruncated = output.length >= 50 * 1024;

                // Strip ANSI codes for clean preview
                const cleaned = output.replace(/\x1B\[[0-9;]*m/g, '');
                if (cleaned.length === 0) {
                  entry.toolOutputPreview = '[No output]';
                } else {
                entry.toolOutputPreview = cleaned.slice(0, MAX_PREVIEW);
                  if (cleaned.length > MAX_PREVIEW) {
                    entry.toolOutputPreview += '...';
                  }
                }

                // Line count from output
                entry.lineCount = cleaned.split('\n').filter(l => l.length > 0).length;
              }

              // Exit code indicates error
              if (toolInfo.exitCode !== undefined && toolInfo.exitCode !== 0) {
                entry.toolIsError = true;
                entry.toolErrorMessage = `Exit code ${toolInfo.exitCode}`;
              }
            }

            if (toolLower !== 'bash' && toolLower !== 'commandexecution' && toolInfo.outputPreview) {
              entry.toolOutputPreview = toolInfo.outputPreview;
            }

            // Add the entry with metrics
            this.activityManager.addEntry(key, entry);

            state.activeTools.delete(itemId);

            // Integration point 2: Flush activity batch to thread on tool completion
            const context = this.contexts.get(key);
            if (context) {
              flushActivityBatchToThread(
                this.activityManager,
                key,
                this.slack,
                context.channelId,
                state.threadParentTs || context.originalTs,
                {
                  force: false,
                  mapActivityTs: (ts, entry) => {
                    const threadSession = getThreadSession(context.channelId, context.threadTs || context.originalTs);
                    const messageToolMap = threadSession?.messageToolMap || {};
                    const messageTurnMap = threadSession?.messageTurnMap || {};
                    messageToolMap[ts] = entry.toolUseId || itemId;
                    messageTurnMap[ts] = context.turnId;
                    saveThreadSession(context.channelId, context.threadTs || context.originalTs, {
                      messageToolMap,
                      messageTurnMap,
                    }).catch((err) => console.error('[streaming] Failed to save message maps:', err));
                  },
                  buildActions: (entry, slackTs) =>
                    // includeAttachThinking=false: full thinking content is posted by postThinkingToThread
                    buildActivityEntryActionParams(entry, key, context.turnId, slackTs || context.originalTs, false),
                }
              ).catch((err) => {
                console.error('[streaming] Thread batch post failed:', err);
              });
            }
          }
          break;
        }
      }
    });

    // Web search lifecycle (adds query + URL context)
    this.codex.on('websearch:started', ({ itemId, query, url, threadId }) => {
      if (!itemId) return;
      for (const [key, state] of this.states) {
        if (!state.isStreaming) continue;

        const context = this.contexts.get(key);
        if (!context) continue;
        if (threadId && context.threadId && context.threadId !== threadId) continue;

        const toolInput: Record<string, unknown> = {};
        if (query) toolInput.query = query;
        if (url) toolInput.url = url;

        const displayInput = query || url;
        let created = false;

        if (state.activeTools.has(itemId)) {
          const existingTool = state.activeTools.get(itemId)!;
          existingTool.tool = existingTool.tool || 'webSearch';
          existingTool.toolInput = Object.keys(toolInput).length ? toolInput : existingTool.toolInput;
          existingTool.input = existingTool.input ?? displayInput;
        } else {
          state.activeTools.set(itemId, {
            tool: 'webSearch',
            input: displayInput,
            toolInput: Object.keys(toolInput).length ? toolInput : undefined,
            startTime: Date.now(),
          });
          created = true;
          this.activityManager.addEntry(key, {
            type: 'tool_start',
            timestamp: Date.now(),
            tool: 'webSearch',
            toolInput: Object.keys(toolInput).length ? toolInput : displayInput,
            toolUseId: itemId,
          });
        }

        // Update existing tool_start entry with richer input if present
        const entries = this.activityManager.getEntries(key);
        const startEntry = entries.find(
          (e) => e.type === 'tool_start' && e.toolUseId === itemId
        );
        if (startEntry && Object.keys(toolInput).length) {
          startEntry.toolInput = toolInput;
        }

        if (created) {
          flushActivityBatchToThread(
            this.activityManager,
            key,
            this.slack,
            context.channelId,
            state.threadParentTs || context.originalTs,
            {
              force: false,
              mapActivityTs: (ts, entry) => {
                const threadSession = getThreadSession(context.channelId, context.threadTs || context.originalTs);
                const messageToolMap = threadSession?.messageToolMap || {};
                const messageTurnMap = threadSession?.messageTurnMap || {};
                messageToolMap[ts] = entry.toolUseId || itemId;
                messageTurnMap[ts] = context.turnId;
                saveThreadSession(context.channelId, context.threadTs || context.originalTs, {
                  messageToolMap,
                  messageTurnMap,
                }).catch((err) => console.error('[streaming] Failed to save message maps:', err));
              },
              buildActions: (entry, slackTs) =>
                buildActivityEntryActionParams(entry, key, context.turnId, slackTs || context.originalTs, false),
            }
          ).catch((err) => console.error('[streaming] Thread batch post failed:', err));
        }
      }
    });

    this.codex.on('websearch:completed', ({ itemId, url, resultUrls, threadId }) => {
      if (!itemId) return;
      const previewUrl = (resultUrls && resultUrls.length > 0 ? resultUrls[0] : undefined) || url;

      for (const [key, state] of this.states) {
        if (!state.isStreaming) continue;

        const context = this.contexts.get(key);
        if (!context) continue;
        if (threadId && context.threadId && context.threadId !== threadId) continue;

        if (previewUrl) {
          const toolInfo = state.activeTools.get(itemId);
          if (toolInfo) {
            toolInfo.outputPreview = previewUrl;
          }

          const entries = this.activityManager.getEntries(key);
          const completeEntry = entries.find(
            (e) => e.type === 'tool_complete' && e.toolUseId === itemId
          );
          if (completeEntry) {
            completeEntry.toolOutputPreview = previewUrl;
          }
        }
      }
    });

    // Command output (Bash execution output streaming)
    this.codex.on('command:output', ({ itemId, delta }) => {
      for (const [, state] of this.states) {
        if (state.isStreaming) {
          const toolInfo = state.activeTools.get(itemId);
          if (toolInfo) {
            // Accumulate output (up to 50KB)
            const MAX_OUTPUT = 50 * 1024;
            const current = toolInfo.outputBuffer || '';
            if (current.length < MAX_OUTPUT) {
              toolInfo.outputBuffer = current + delta;
              if (toolInfo.outputBuffer.length > MAX_OUTPUT) {
                toolInfo.outputBuffer = toolInfo.outputBuffer.slice(0, MAX_OUTPUT);
              }
            }
          }
          break;
        }
      }
    });

    // Command completed (Bash execution finished with exit code)
    this.codex.on('command:completed', ({ itemId, exitCode }) => {
      for (const [, state] of this.states) {
        if (state.isStreaming) {
          const toolInfo = state.activeTools.get(itemId);
          if (toolInfo) {
            toolInfo.exitCode = exitCode;
          }
          break;
        }
      }
    });

    // Item delta (streaming response text) - JUST ACCUMULATE, timer handles updates
    this.codex.on('item:delta', ({ itemId, delta }) => {
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          state.text += delta;
          // Timer handles updates, no need to schedule
          break;
        }
      }
    });

    // Thinking started - Codex detected a Reasoning item started
    // Add activity entry with segment ID for update-in-place.
    // Flushes immediately to thread so thinking appears during streaming.
    this.codex.on('thinking:started', ({ itemId }) => {
      console.log(`[streaming] thinking:started itemId=${itemId}`);
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          state.thinkingItemId = itemId;

          // FIX: Check if segment already created by thinking:delta (event ordering)
          if (!state.currentThinkingSegmentId) {
            const segmentId = `thinking-${state.thinkingSegmentCounter}`;
            state.currentThinkingSegmentId = segmentId;

            const isFirstThinking = !state.thinkingStartTime;
            if (isFirstThinking) {
              state.thinkingStartTime = Date.now();
            }

            // Add entry with segment ID (mirrors toolUseId pattern)
            this.activityManager.addEntry(key, {
              type: 'thinking',
              timestamp: Date.now(),
              thinkingInProgress: true,
              thinkingSegmentId: segmentId,
            });
          }

          // FIX: Use existing mutex pattern (fire-and-forget - no await needed in sync handler)
          // Mutex serializes work internally even without await
          const context = this.contexts.get(key);
          if (context) {
            const mutex = getUpdateMutex(key);
            mutex.runExclusive(async () => {
              try {
                await flushActivityBatchToThread(
                  this.activityManager,
                  key,
                  this.slack,
                  context.channelId,
                  state.threadParentTs || context.originalTs,
                  { force: true }
                );
                state.thinkingPostedDuringStreaming = true;
              } catch (err) {
                console.error('[thinking:started] Flush failed:', err);
              }
            });
          }
          break;
        }
      }
    });

    // Thinking complete - Codex Reasoning item finished
    // Only updates activity entry duration - no thread messages (postThinkingToThread handles that)
    this.codex.on('thinking:complete', ({ itemId, durationMs }) => {
      console.log(`[streaming] thinking:complete itemId=${itemId} durationMs=${durationMs}`);
      for (const [key, state] of this.states) {
        if (state.isStreaming && (state.thinkingItemId === itemId || state.thinkingStartTime)) {
          // Mark thinking as complete in activity entries
          const entries = this.activityManager.getEntries(key);
          for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].type === 'thinking') {
              entries[i].thinkingInProgress = false;
              entries[i].durationMs = durationMs;
              break;
            }
          }
          // Reset for next thinking block
          state.thinkingItemId = undefined;
          break;
        }
      }
    });

    // Thinking delta (reasoning content) - accumulate content and flush to thread
    // FIX: Now flushes to thread so thinking appears during streaming (not just on turn completion)
    this.codex.on('thinking:delta', ({ content }) => {
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          state.thinkingContent += content;

          // FIX: Handle case where thinking:delta fires BEFORE thinking:started
          if (!state.currentThinkingSegmentId) {
            const segmentId = `thinking-${state.thinkingSegmentCounter}`;
            state.currentThinkingSegmentId = segmentId;

            const isFirstThinking = !state.thinkingStartTime;
            if (isFirstThinking) {
              state.thinkingStartTime = Date.now();
            }

            // Create entry since thinking:started hasn't fired yet
            this.activityManager.addEntry(key, {
              type: 'thinking',
              timestamp: Date.now(),
              thinkingInProgress: true,
              thinkingSegmentId: segmentId,
              charCount: state.thinkingContent.length,
            });
          } else {
            // Update charCount on existing thinking entry (find by segment ID)
            const entries = this.activityManager.getEntries(key);
            for (let i = entries.length - 1; i >= 0; i--) {
              if (entries[i].type === 'thinking' && entries[i].thinkingSegmentId === state.currentThinkingSegmentId) {
                entries[i].charCount = state.thinkingContent.length;
                entries[i].thinkingInProgress = true;
                break;
              }
            }
          }

          // FIX: Fire-and-forget mutex pattern (no await in sync handler)
          const context = this.contexts.get(key);
          if (context) {
            const mutex = getUpdateMutex(key);
            mutex.runExclusive(async () => {
              try {
                await flushActivityBatchToThread(
                  this.activityManager,
                  key,
                  this.slack,
                  context.channelId,
                  state.threadParentTs || context.originalTs
                  // No force=true, respects 2s rate limit
                );
                state.thinkingPostedDuringStreaming = true;
              } catch (err) {
                console.error('[thinking:delta] Flush failed:', err);
              }
            });
          }
          break;
        }
      }
    });

    // Approval requested
    this.codex.on('approval:requested', (request) => {
      const found = this.findContextByThreadId(request.params.threadId);
      if (found && this.approvalCallback) {
        this.approvalCallback(request, found.context);
      }
    });

    // Token usage updates
    this.codex.on('tokens:updated', ({ inputTokens, outputTokens, contextWindow, maxOutputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd }) => {
      for (const [, state] of this.states) {
        if (state.isStreaming) {
          // VERIFIED: Codex sends CUMULATIVE TOTALS, not deltas (test-token-accumulation.ts)
          // Capture baseline on first token update so we can compute deltas per turn
          if (state.baseInputTokens === undefined) {
            state.baseInputTokens = inputTokens;
          }
          if (state.baseOutputTokens === undefined) {
            state.baseOutputTokens = outputTokens;
          }
          if (state.baseCacheCreationInputTokens === undefined && cacheCreationInputTokens !== undefined) {
            state.baseCacheCreationInputTokens = cacheCreationInputTokens;
          }

          state.inputTokens = inputTokens;
          state.outputTokens = outputTokens;
          if (cacheReadInputTokens !== undefined) {
            state.cacheReadInputTokens = cacheReadInputTokens;
          }
          if (cacheCreationInputTokens !== undefined) {
            state.cacheCreationInputTokens = cacheCreationInputTokens;
          }
          if (contextWindow) {
            state.contextWindow = contextWindow;
          }
          if (maxOutputTokens) {
            state.maxOutputTokens = maxOutputTokens;
          }
          if (costUsd !== undefined) {
            state.costUsd = costUsd;
          }
          break;
        }
      }
    });
  }

  /**
   * Update the ONE activity message with current state.
   * Uses mutex for concurrent update protection (CCSLACK style).
   */
  private async updateActivityMessage(conversationKey: string): Promise<void> {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state) {
      return;
    }

    // Check if aborted - don't update
    if (isAborted(conversationKey)) {
      return;
    }

    const mutex = getUpdateMutex(conversationKey);
    await mutex.runExclusive(async () => {
      // Re-check abort status inside mutex
      if (isAborted(conversationKey)) {
        return;
      }

      // Get entries with rolling window
      const entries = this.activityManager.getEntries(conversationKey);
      const displayEntries =
        entries.length > MAX_LIVE_ENTRIES ? entries.slice(-ROLLING_WINDOW_SIZE) : entries;

      // Build activity text
      let activityText = buildActivityLogText(displayEntries, ROLLING_WINDOW_SIZE, ACTIVITY_LOG_MAX_CHARS);

      // Add hidden entries notice if needed
      if (entries.length > MAX_LIVE_ENTRIES) {
        const hidden = entries.length - ROLLING_WINDOW_SIZE;
        activityText = `_... ${hidden} earlier entries ..._\n` + activityText;
      }

      // Add thinking preview if we have thinking content
      if (state.thinkingContent) {
        const thinkingDuration = state.thinkingComplete
          ? (Date.now() - state.thinkingStartTime)
          : (Date.now() - state.thinkingStartTime);
        const thinkingDurationSec = (thinkingDuration / 1000).toFixed(1);
        const charCount = state.thinkingContent.length;
        const preview = state.thinkingContent.slice(-200).replace(/\n/g, ' ');
        activityText += `\n:brain: *Thinking* [${thinkingDurationSec}s] _[${charCount} chars]_\n> ...${preview}`;
      }

      // Add response preview if we have response content
      if (state.text) {
        const preview = state.text.slice(0, 200).replace(/\n/g, ' ');
        activityText += `\n:speech_balloon: *Response* _[${state.text.length} chars]_\n> ${preview}${state.text.length > 200 ? '...' : ''}`;
      }

      const elapsedMs = Date.now() - context.startTime;

      // Spinner frame (cycles each update)
      state.spinnerIndex = (state.spinnerIndex + 1) % STATUS_SPINNER_FRAMES.length;
      const spinner = STATUS_SPINNER_FRAMES[state.spinnerIndex];

      // Compute context usage - VERIFIED from Codex API:
      // total_tokens = input_tokens + output_tokens
      // (cached_input_tokens is a SUBSET of input_tokens, not additional)
      const adjInput = Math.max(0, state.inputTokens - (state.baseInputTokens ?? 0));
      const adjOutput = Math.max(0, state.outputTokens - (state.baseOutputTokens ?? 0));
      const contextTokens = adjInput + adjOutput;
      const contextWindow = state.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const contextPercent =
        contextTokens > 0
          ? Math.min(100, Math.max(0, Number(((contextTokens / contextWindow) * 100).toFixed(1))))
          : undefined;
      const autoCompactThreshold = computeAutoCompactThreshold(
        contextWindow,
        state.maxOutputTokens
      );
      const compactBase = autoCompactThreshold > 0 ? autoCompactThreshold : undefined;
      const compactPercent =
        compactBase && contextTokens > 0
          ? Math.max(
              0,
              Number(((compactBase - contextTokens) / compactBase * 100).toFixed(1))
            )
          : undefined;
      const tokensToCompact =
        compactBase && contextTokens > 0 ? Math.max(0, compactBase - contextTokens) : undefined;

      const includeFinalStats = state.status !== 'running';
      const hasTokenCounts = state.inputTokens > 0 || state.outputTokens > 0;
      const inputTokensForStats = includeFinalStats && hasTokenCounts ? adjInput : undefined;
      const outputTokensForStats = includeFinalStats && hasTokenCounts ? adjOutput : undefined;

      const threadTs = context.threadTs || context.originalTs;

      const blocks = buildActivityBlocks({
        activityText: activityText || ':gear: Starting...',
        status: state.status,
        conversationKey,
        elapsedMs,
        entries, // Pass for todo extraction
        approvalPolicy: context.approvalPolicy,
        model: context.model,
        reasoningEffort: context.reasoningEffort,
        sandboxMode: context.sandboxMode,
        sessionId: context.threadId,
        contextPercent,
        contextTokens: contextTokens > 0 ? contextTokens : undefined,
        contextWindow,
        // COMMENTED OUT: compactPercent and tokensToCompact use assumed values
        // that Codex does NOT provide. See blocks.ts for details.
        // compactPercent,
        // tokensToCompact,
        inputTokens: inputTokensForStats,
        outputTokens: outputTokensForStats,
        costUsd: includeFinalStats ? state.costUsd : undefined,
        spinner,
        forkTurnId: context.turnId,
        forkSlackTs: state.activityMessageTs || threadTs,
      });

      const fallbackText = activityText || 'Processing...';

      // Update or post with error fallback
      try {
        if (state.activityMessageTs) {
          await withSlackRetry(
            () =>
              this.slack.chat.update({
                channel: context.channelId,
                ts: state.activityMessageTs!,
                blocks,
                text: fallbackText,
              }),
            'activity.update'
          );
        } else {
          const result = await withSlackRetry(
            () =>
              this.slack.chat.postMessage({
                channel: context.channelId,
                thread_ts: threadTs,
                blocks,
                text: fallbackText,
              }),
            'activity.post'
          );
          state.activityMessageTs = result.ts as string;
          // Map activity message to turnId for future updates/actions
          if (context.threadTs) {
            const existing = getThreadSession(context.channelId, context.threadTs);
            const messageTurnMap = existing?.messageTurnMap || {};
            messageTurnMap[state.activityMessageTs] = context.turnId;
            await saveThreadSession(context.channelId, context.threadTs, { messageTurnMap });
          }
        }
      } catch (error) {
        console.error('Error updating activity message:', error);
        // To avoid duplicate activity posts, do not post a new message when an update fails.
        // We rely on the existing message; if it's missing, the next cycle will retry update.
      }

      // Trim entries if too many (memory management)
      if (entries.length > MAX_LIVE_ENTRIES * 2) {
        // Keep only last MAX_LIVE_ENTRIES
        const trimmed = entries.slice(-MAX_LIVE_ENTRIES);
        this.activityManager.clearEntries(conversationKey);
        trimmed.forEach((e) => this.activityManager.addEntry(conversationKey, e));
      }

      state.lastUpdateTime = Date.now();
    });
  }

}
