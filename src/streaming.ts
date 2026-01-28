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
import { buildTextBlocks, buildStatusBlocks, Block } from './blocks.js';
import type { ApprovalPolicy } from './codex-client.js';
import {
  markProcessingStart,
  removeProcessingEmoji,
  markError,
  markAborted as markAbortedEmoji,
} from './emoji-reactions.js';
import { isAborted, clearAborted } from './abort-tracker.js';
import { ActivityThreadManager, ActivityEntry, getToolEmoji } from './activity-thread.js';
import { withSlackRetry } from './slack-retry.js';

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
  /** Accumulated message text (response content) */
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
  /** Accumulated thinking content */
  thinkingContent: string;
  /** Thinking start timestamp */
  thinkingStartTime: number;
  /** Whether we've posted the thinking message */
  thinkingPosted: boolean;
  /** Whether we've posted the response message */
  responsePosted: boolean;
  /** Track active tools by itemId */
  activeTools: Map<string, { tool: string; input?: string; startTime: number }>;
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
      thinkingContent: '',
      thinkingStartTime: 0,
      thinkingPosted: false,
      responsePosted: false,
      activeTools: new Map(),
    });

    // Clear any previous activity entries
    this.activityManager.clearEntries(key);

    // Add eyes emoji to user's original message
    markProcessingStart(this.slack, context.channelId, context.originalTs).catch((err) => {
      console.error('Failed to add processing emoji:', err);
    });

    // Post initial processing message
    this.updateStatusMessage(key).catch((err) => {
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
    this.activityManager.clearEntries(conversationKey);
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

          // Post thinking message if we have thinking content but haven't posted
          if (state.thinkingContent && !state.thinkingPosted) {
            await this.postThinkingMessage(found.key);
          }

          // Post response message if we have response content
          if (state.text && !state.responsePosted && status === 'completed') {
            await this.postResponseMessage(found.key);
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

          // Update status message to final state
          await this.updateStatusMessage(found.key);

          // Clean up activity entries
          this.activityManager.clearEntries(found.key);
        }
      }
    });

    // Item started (tool use)
    this.codex.on('item:started', ({ itemId, itemType }) => {
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          // Track tool start
          state.activeTools.set(itemId, {
            tool: itemType,
            startTime: Date.now(),
          });

          // Add activity entry
          this.activityManager.addEntry(key, {
            type: 'tool_start',
            timestamp: Date.now(),
            tool: itemType,
            toolUseId: itemId,
          });

          // Post tool activity to thread
          this.postToolActivity(key, itemId, itemType, 'start').catch((err) => {
            console.error('Failed to post tool activity:', err);
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
              toolUseId: itemId,
              durationMs,
            });

            state.activeTools.delete(itemId);
          }
          break;
        }
      }
    });

    // Item delta (streaming response text)
    this.codex.on('item:delta', ({ itemId, delta }) => {
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          state.text += delta;
          this.scheduleUpdate(key);
          break;
        }
      }
    });

    // Thinking delta (reasoning content)
    this.codex.on('thinking:delta', ({ content }) => {
      for (const [key, state] of this.states) {
        if (state.isStreaming) {
          if (!state.thinkingStartTime) {
            state.thinkingStartTime = Date.now();
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

  private scheduleUpdate(conversationKey: string): void {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state || !state.isStreaming) {
      return;
    }

    // For multi-message pattern, we don't update the status message on every delta
    // Response content will be posted as a separate message on completion
  }

  /**
   * Update the status message (Message 1 in the thread).
   */
  private async updateStatusMessage(conversationKey: string): Promise<void> {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state) {
      return;
    }

    state.lastUpdateTime = Date.now();

    // Build status blocks based on current state
    let blocks: Block[];
    let fallbackText: string;

    if (state.status === 'completed') {
      const durationMs = Date.now() - context.startTime;
      blocks = buildStatusBlocks({ status: 'complete', durationMs });
      fallbackText = 'Complete';
    } else if (state.status === 'interrupted') {
      blocks = buildStatusBlocks({ status: 'aborted' });
      fallbackText = 'Aborted';
    } else if (state.status === 'failed') {
      blocks = buildStatusBlocks({ status: 'error' });
      fallbackText = 'Error';
    } else {
      // Processing: show processing status with abort button
      blocks = buildStatusBlocks({
        status: 'processing',
        conversationKey,
        messageTs: context.messageTs,
      });
      fallbackText = 'Processing...';
    }

    // Update the Slack message
    try {
      await withSlackRetry(
        () =>
          this.slack.chat.update({
            channel: context.channelId,
            ts: context.messageTs,
            blocks,
            text: fallbackText,
          }),
        'status.update'
      );
    } catch (err) {
      console.error('Failed to update status message:', err);
    }
  }

  /**
   * Post thinking message to thread (Message 2).
   */
  private async postThinkingMessage(conversationKey: string): Promise<void> {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state || !state.thinkingContent || state.thinkingPosted) {
      return;
    }

    state.thinkingPosted = true;
    const durationMs = Date.now() - state.thinkingStartTime;
    const durationSec = (durationMs / 1000).toFixed(1);
    const charCount = state.thinkingContent.length;

    // Format thinking message
    const MAX_PREVIEW_LENGTH = 500;
    let text: string;

    if (charCount <= MAX_PREVIEW_LENGTH) {
      text = `:brain: *Thinking* [${durationSec}s]\n> ${state.thinkingContent.replace(/\n/g, '\n> ')}`;
    } else {
      const preview = state.thinkingContent.slice(-MAX_PREVIEW_LENGTH);
      text = `:brain: *Thinking* [${durationSec}s] _[${charCount} chars]_\n> ...${preview.replace(/\n/g, '\n> ')}`;
    }

    try {
      // Post thinking as a new message in thread
      const threadTs = context.threadTs || context.originalTs;
      await withSlackRetry(
        () =>
          this.slack.chat.postMessage({
            channel: context.channelId,
            thread_ts: threadTs,
            text,
          }),
        'thinking.post'
      );
    } catch (err) {
      console.error('Failed to post thinking message:', err);
    }
  }

  /**
   * Post tool activity to thread.
   */
  private async postToolActivity(
    conversationKey: string,
    itemId: string,
    tool: string,
    action: 'start' | 'complete',
    input?: string,
    durationMs?: number
  ): Promise<void> {
    const context = this.contexts.get(conversationKey);
    if (!context) return;

    const emoji = getToolEmoji(tool);
    let text: string;

    if (action === 'start') {
      text = `${emoji} *${tool}*${input ? ` \`${input}\`` : ''}`;
    } else {
      const duration = durationMs ? ` [${(durationMs / 1000).toFixed(1)}s]` : '';
      text = `:white_check_mark: *${tool}*${input ? ` \`${input}\`` : ''}${duration}`;
    }

    try {
      const threadTs = context.threadTs || context.originalTs;
      await withSlackRetry(
        () =>
          this.slack.chat.postMessage({
            channel: context.channelId,
            thread_ts: threadTs,
            text,
          }),
        'tool.activity'
      );
    } catch (err) {
      console.error('Failed to post tool activity:', err);
    }
  }

  /**
   * Post response message to thread (final message).
   */
  private async postResponseMessage(conversationKey: string): Promise<void> {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);

    if (!context || !state || !state.text || state.responsePosted) {
      return;
    }

    state.responsePosted = true;

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
