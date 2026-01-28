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
import type { CodexClient, TurnStatus, ApprovalRequest } from './codex-client.js';
import { buildTextBlocks, buildActivityBlocks, Block } from './blocks.js';
import type { ApprovalPolicy } from './codex-client.js';
import {
  markProcessingStart,
  removeProcessingEmoji,
  markError,
  markAborted as markAbortedEmoji,
} from './emoji-reactions.js';
import { isAborted, clearAborted } from './abort-tracker.js';
import { ActivityThreadManager, ActivityEntry, getToolEmoji, buildActivityLogText } from './activity-thread.js';
import { withSlackRetry } from './slack-retry.js';

// Constants matching CCSLACK architecture
const MAX_LIVE_ENTRIES = 300; // Threshold for rolling window
const ROLLING_WINDOW_SIZE = 20; // Show last N entries when exceeded
const ACTIVITY_LOG_MAX_CHARS = 1000; // Max chars for activity display

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
  /** Accumulated thinking content */
  thinkingContent: string;
  /** Thinking start timestamp */
  thinkingStartTime: number;
  /** Whether thinking has completed (for display) */
  thinkingComplete: boolean;
  /** Track active tools by itemId */
  activeTools: Map<string, { tool: string; input?: string; startTime: number }>;
  /** The ONE activity message timestamp we update */
  activityMessageTs?: string;
  /** Whether an abort is pending (waiting for turnId) */
  pendingAbort?: boolean;
  /** Timeout for pending abort (safety net) */
  pendingAbortTimeout?: ReturnType<typeof setTimeout>;
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

    // Create state - REUSE initial message as activity message
    const state: StreamingState = {
      text: '',
      isStreaming: true,
      lastUpdateTime: 0,
      updateTimer: null,
      status: 'running',
      inputTokens: 0,
      outputTokens: 0,
      thinkingContent: '',
      thinkingStartTime: 0,
      thinkingComplete: false,
      activeTools: new Map(),
      activityMessageTs: context.messageTs, // REUSE initial message!
      pendingAbort: false,
      pendingAbortTimeout: undefined,
    };

    this.contexts.set(key, context);
    this.states.set(key, state);

    // Clear any previous activity entries
    this.activityManager.clearEntries(key);

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
      const found = this.findContextByThreadId(threadId);
      if (found) {
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

          // FINAL update - shows complete status and response
          await this.updateActivityMessage(found.key);

          // Post the full response as a separate message if long
          if (state.text && status === 'completed') {
            await this.postResponseMessage(found.key);
          }

          // Clean up activity entries
          this.activityManager.clearEntries(found.key);
        }
      }
    });

    // Item started (tool use) - FILTER non-tool items, timer handles updates
    this.codex.on('item:started', ({ itemId, itemType, command, commandActions }) => {
      // Skip non-tool items (userMessage, agentMessage, reasoning)
      if (!isToolItemType(itemType)) {
        console.log(`[streaming] Skipping non-tool item: ${itemType}`);
        return;
      }

      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          // Extract display command for commandExecution items
          let toolInput: string | undefined;
          if (itemType === 'commandExecution' || itemType === 'CommandExecution') {
            if (commandActions && commandActions.length > 0) {
              toolInput = commandActions[0].command; // e.g., "ls", "git status"
            } else if (command) {
              // Parse from "/bin/bash -lc <cmd>" format
              const match = command.match(/-lc\s+["']?(.+?)["']?$/);
              toolInput = match ? match[1] : command;
            }
          }

          // Track tool start (only actual tools now)
          state.activeTools.set(itemId, {
            tool: itemType,
            input: toolInput,
            startTime: Date.now(),
          });

          // Add activity entry for actual tools only
          this.activityManager.addEntry(key, {
            type: 'tool_start',
            timestamp: Date.now(),
            tool: itemType,
            toolInput,
            toolUseId: itemId,
          });
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

            // Add completion entry
            this.activityManager.addEntry(key, {
              type: 'tool_complete',
              timestamp: Date.now(),
              tool: toolInfo.tool,
              toolInput: toolInfo.input,
              toolUseId: itemId,
              durationMs,
            });

            state.activeTools.delete(itemId);
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

    // Thinking delta (reasoning content) - JUST ACCUMULATE, timer handles updates
    this.codex.on('thinking:delta', ({ content }) => {
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          if (!state.thinkingStartTime) {
            state.thinkingStartTime = Date.now();
            // Add thinking entry (will be updated by timer)
            this.activityManager.addEntry(key, {
              type: 'thinking',
              timestamp: Date.now(),
            });
          }
          state.thinkingContent += content;
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
    this.codex.on('tokens:updated', ({ inputTokens, outputTokens }) => {
      for (const [, state] of this.states) {
        if (state.isStreaming) {
          state.inputTokens += inputTokens;
          state.outputTokens += outputTokens;
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
        activityText += `\n:memo: *Response* _[${state.text.length} chars]_\n> ${preview}${state.text.length > 200 ? '...' : ''}`;
      }

      // Build blocks with status at bottom and abort button
      const elapsedMs = Date.now() - context.startTime;
      const blocks = buildActivityBlocks({
        activityText: activityText || ':gear: Starting...',
        status: state.status,
        conversationKey,
        elapsedMs,
      });

      const fallbackText = activityText || 'Processing...';
      const threadTs = context.threadTs || context.originalTs;

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
        }
      } catch (error) {
        console.error('Error updating activity message:', error);
        // Fallback: post new message if update fails
        try {
          const result = await withSlackRetry(
            () =>
              this.slack.chat.postMessage({
                channel: context.channelId,
                thread_ts: threadTs,
                blocks,
                text: fallbackText,
              }),
            'activity.fallback'
          );
          state.activityMessageTs = result.ts as string;
        } catch (fallbackError) {
          console.error('Fallback post also failed:', fallbackError);
        }
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

  /**
   * Post full response message to thread (separate from activity message).
   * Only posts if response is substantial and turn completed successfully.
   */
  private async postResponseMessage(conversationKey: string): Promise<void> {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state || !state.text) {
      return;
    }

    // Build response blocks
    const blocks: Block[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':speech_balloon: *Response*',
        },
      },
      ...buildTextBlocks(state.text),
    ];

    try {
      const threadTs = context.threadTs || context.originalTs;
      await withSlackRetry(
        () =>
          this.slack.chat.postMessage({
            channel: context.channelId,
            thread_ts: threadTs,
            blocks,
            text: state.text,
          }),
        'response.post'
      );
    } catch (err) {
      console.error('Failed to post response message:', err);
    }
  }
}
