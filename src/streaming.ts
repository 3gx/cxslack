/**
 * Streaming handler for Codex events → Slack message updates.
 *
 * Handles:
 * - Real-time message streaming with throttling
 * - Turn lifecycle (started, completed, interrupted)
 * - Item events (agent message deltas)
 * - Approval request routing
 */

import type { WebClient } from '@slack/web-api';
import type { CodexClient, TurnStatus, ApprovalRequest } from './codex-client.js';
import { buildTextBlocks, buildStatusBlocks, buildHeaderBlock, Block } from './blocks.js';
import type { ApprovalPolicy } from './codex-client.js';
import {
  markProcessingStart,
  removeProcessingEmoji,
  markError,
  markAborted as markAbortedEmoji,
} from './emoji-reactions.js';
import { isAborted, clearAborted } from './abort-tracker.js';

// Default update rate in milliseconds
const DEFAULT_UPDATE_RATE_MS = 500;

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
  /** Accumulated message text */
  text: string;
  /** Whether we're actively streaming */
  isStreaming: boolean;
  /** Last update timestamp */
  lastUpdateTime: number;
  /** Pending update timer */
  updateTimer: ReturnType<typeof setTimeout> | null;
  /** Current turn status */
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  /** Accumulated input tokens */
  inputTokens: number;
  /** Accumulated output tokens */
  outputTokens: number;
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
   */
  startStreaming(context: StreamingContext): void {
    const key = makeConversationKey(context.channelId, context.threadTs);
    this.contexts.set(key, context);
    this.states.set(key, {
      text: '',
      isStreaming: true,
      lastUpdateTime: 0,
      updateTimer: null,
      status: 'running',
      inputTokens: 0,
      outputTokens: 0,
    });

    // Add eyes emoji to user's original message
    markProcessingStart(this.slack, context.channelId, context.originalTs).catch((err) => {
      console.error('Failed to add processing emoji:', err);
    });

    // Post initial processing message
    this.updateSlackMessage(key, true).catch((err) => {
      console.error('Failed to post initial message:', err);
    });
  }

  /**
   * Stop streaming for a conversation.
   */
  stopStreaming(conversationKey: string): void {
    const state = this.states.get(conversationKey);
    if (state?.updateTimer) {
      clearTimeout(state.updateTimer);
    }
    this.contexts.delete(conversationKey);
    this.states.delete(conversationKey);
  }

  /**
   * Get context for a conversation.
   */
  getContext(conversationKey: string): StreamingContext | undefined {
    return this.contexts.get(conversationKey);
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
    // Turn started
    this.codex.on('turn:started', ({ threadId, turnId }) => {
      const found = this.findContextByThreadId(threadId);
      if (found) {
        found.context.turnId = turnId;
      }
    });

    // Turn completed
    this.codex.on('turn:completed', async ({ threadId, turnId, status }) => {
      const found = this.findContextByThreadId(threadId);
      if (found) {
        const state = this.states.get(found.key);
        if (state) {
          // Check if aborted (takes precedence over other statuses)
          const wasAborted = isAborted(found.key);
          if (wasAborted) {
            status = 'interrupted'; // Override status
          }

          state.status = status;
          state.isStreaming = false;

          // Transition emoji based on final status
          // On success: just remove eyes (no checkmark - ccslack style)
          // On error/abort: remove eyes, add error/abort emoji
          const { channelId, originalTs } = found.context;
          try {
            if (status === 'completed') {
              // Just remove eyes, no success emoji
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

          // Final update
          this.updateSlackMessage(found.key, true).catch((err) => {
            console.error('Failed to update final message:', err);
          });
        }
      }
    });

    // Item delta (streaming text)
    this.codex.on('item:delta', ({ itemId, delta }) => {
      // Find context that might be receiving this delta
      // We match by looking for any active streaming context
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          state.text += delta;
          this.scheduleUpdate(key);
          break; // Assume one active stream at a time
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
      // Add tokens to the currently streaming context
      for (const [, state] of this.states) {
        if (state.isStreaming) {
          state.inputTokens += inputTokens;
          state.outputTokens += outputTokens;
          break; // Assume one active stream at a time
        }
      }
    });
  }

  private scheduleUpdate(conversationKey: string): void {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state || !state.isStreaming) {
      return;
    }

    const now = Date.now();
    const timeSinceLastUpdate = now - state.lastUpdateTime;
    const updateRate = context.updateRateMs || DEFAULT_UPDATE_RATE_MS;

    if (timeSinceLastUpdate >= updateRate) {
      // Enough time has passed, update now
      this.updateSlackMessage(conversationKey, false).catch((err) => {
        console.error('Failed to update message:', err);
      });
    } else if (!state.updateTimer) {
      // Schedule update for later
      const delay = updateRate - timeSinceLastUpdate;
      state.updateTimer = setTimeout(() => {
        state.updateTimer = null;
        if (this.states.has(conversationKey)) {
          this.updateSlackMessage(conversationKey, false).catch((err) => {
            console.error('Failed to update message:', err);
          });
        }
      }, delay);
    }
  }

  private async updateSlackMessage(conversationKey: string, force: boolean): Promise<void> {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state) {
      return;
    }

    state.lastUpdateTime = Date.now();

    // Build blocks based on current state
    const blocks: Block[] = [];

    if (state.status === 'completed') {
      // On success: just show the response text, no header/status
      if (state.text) {
        blocks.push(...buildTextBlocks(state.text));
      }
    } else if (state.status === 'interrupted') {
      // On abort: show aborted status
      blocks.push(...buildStatusBlocks({ status: 'aborted' }));
      if (state.text) {
        blocks.push(...buildTextBlocks(state.text));
      }
    } else if (state.status === 'failed') {
      // On error: show error status
      blocks.push(...buildStatusBlocks({ status: 'error' }));
      if (state.text) {
        blocks.push(...buildTextBlocks(state.text));
      }
    } else {
      // Processing: show processing status with abort button
      blocks.push(...buildStatusBlocks({ status: 'processing', conversationKey }));
      if (state.text) {
        blocks.push(...buildTextBlocks(state.text));
      }
    }

    // Update the Slack message
    try {
      await this.slack.chat.update({
        channel: context.channelId,
        ts: context.messageTs,
        blocks,
        text: state.text || 'Processing...', // Fallback text
      });
    } catch (err) {
      console.error('Failed to update Slack message:', err);
    }
  }
}
