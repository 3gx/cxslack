/**
 * Approval handler for Codex tool approval requests.
 *
 * Handles the flow:
 * 1. Codex sends requestApproval event
 * 2. Bot posts approval buttons in Slack
 * 3. User clicks Approve/Deny
 * 4. Bot responds to Codex with decision
 */

import type { WebClient } from '@slack/web-api';
import type {
  CodexClient,
  ApprovalRequestWithId,
  CommandApprovalRequest,
  FileChangeApprovalRequest,
} from './codex-client.js';
import {
  buildCommandApprovalBlocks,
  buildFileChangeApprovalBlocks,
  buildApprovalGrantedBlocks,
  buildApprovalDeniedBlocks,
  Block,
} from './blocks.js';
import { sendDmNotification } from './dm-notifications.js';
import { makeConversationKey } from './streaming.js';

// Tool approval reminder configuration (matches ccslack behavior)
export const TOOL_APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const TOOL_APPROVAL_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const TOOL_APPROVAL_MAX_REMINDERS = Math.floor(
  TOOL_APPROVAL_EXPIRY_MS / TOOL_APPROVAL_REMINDER_INTERVAL_MS
); // 42 reminders

/**
 * Pending approval request.
 */
interface PendingApproval {
  /** JSON-RPC request ID for responding (server-provided if present) */
  requestId: number;
  /** Original approval request */
  request: ApprovalRequestWithId;
  /** Slack channel ID */
  channelId: string;
  /** Slack thread timestamp */
  threadTs?: string;
  /** Slack message timestamp of approval message */
  messageTs: string;
  /** User ID who should be notified */
  userId?: string;
  /** Timestamp when approval was requested */
  createdAt: number;
}

/**
 * Approval handler manages pending approval requests and their responses.
 */
export class ApprovalHandler {
  private slack: WebClient;
  private codex: CodexClient;
  private pendingApprovals = new Map<number, PendingApproval>();
  private requestIdCounter = 0;
  private reminderIntervals = new Map<number, NodeJS.Timeout>();
  private reminderCounts = new Map<number, number>();
  private reminderStartTimes = new Map<number, number>();

  constructor(slack: WebClient, codex: CodexClient) {
    this.slack = slack;
    this.codex = codex;
  }

  /**
   * Generate a unique request ID for tracking.
   */
  private generateRequestId(): number {
    return ++this.requestIdCounter;
  }

  private formatTimeRemaining(ms: number): string {
    if (ms <= 0) return '0 mins';

    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

    const parts: string[] = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (mins > 0 || parts.length === 0) parts.push(`${mins} min${mins !== 1 ? 's' : ''}`);

    return parts.join(' ');
  }

  private getApprovalLabel(request: ApprovalRequestWithId): string {
    if (request.method === 'item/commandExecution/requestApproval') {
      const cmdRequest = request as CommandApprovalRequest;
      return `\`${cmdRequest.params.parsedCmd}\``;
    }
    const fileRequest = request as FileChangeApprovalRequest;
    return `\`${fileRequest.params.filePath}\``;
  }

  private clearApprovalReminder(requestId: number): void {
    const interval = this.reminderIntervals.get(requestId);
    if (interval) {
      clearInterval(interval);
      this.reminderIntervals.delete(requestId);
    }
    this.reminderCounts.delete(requestId);
    this.reminderStartTimes.delete(requestId);
  }

  private startApprovalReminder(requestId: number, label: string): void {
    const startTime = Date.now();
    this.reminderStartTimes.set(requestId, startTime);
    this.reminderCounts.set(requestId, 0);

    const interval = setInterval(async () => {
      const pending = this.pendingApprovals.get(requestId);
      if (!pending) {
        this.clearApprovalReminder(requestId);
        return;
      }

      const count = this.reminderCounts.get(requestId) || 0;
      if (count >= TOOL_APPROVAL_MAX_REMINDERS) {
        this.clearApprovalReminder(requestId);
        this.pendingApprovals.delete(requestId);

        try {
          await this.codex.respondToApproval(requestId, 'decline');
        } catch (error) {
          console.error('[approval] Failed to auto-decline expired approval:', error);
        }

        try {
          await this.slack.chat.update({
            channel: pending.channelId,
            ts: pending.messageTs,
            text: `⏰ Expired: ${label} (no response after 7 days)`,
            blocks: [],
          });
        } catch (error) {
          console.error('[approval] Failed to update expired approval message:', error);
        }
        return;
      }

      const elapsedMs = Date.now() - startTime;
      const remainingMs = TOOL_APPROVAL_EXPIRY_MS - elapsedMs;
      const expiresIn = this.formatTimeRemaining(remainingMs);

      try {
        await this.slack.chat.postMessage({
          channel: pending.channelId,
          thread_ts: pending.threadTs,
          text: `⏰ *Reminder:* Still waiting for approval of ${label}\nExpires in ${expiresIn}`,
        });
      } catch (error) {
        console.error('[approval] Error posting reminder:', error);
      }

      this.reminderCounts.set(requestId, count + 1);
    }, TOOL_APPROVAL_REMINDER_INTERVAL_MS);

    this.reminderIntervals.set(requestId, interval);
  }

  /**
   * Handle an incoming approval request from Codex.
   * Posts approval buttons to Slack and tracks the pending request.
   */
  async handleApprovalRequest(
    request: ApprovalRequestWithId,
    channelId: string,
    threadTs?: string,
    userId?: string
  ): Promise<void> {
    const requestId = request.rpcId ?? this.generateRequestId();

    // Build blocks based on request type
    let blocks: Block[];
    let previewText: string | undefined;
    let subtitle: string | undefined;
    if (request.method === 'item/commandExecution/requestApproval') {
      const cmdRequest = request as CommandApprovalRequest;
      blocks = buildCommandApprovalBlocks({
        itemId: cmdRequest.params.itemId,
        threadId: cmdRequest.params.threadId,
        turnId: cmdRequest.params.turnId,
        parsedCmd: cmdRequest.params.parsedCmd,
        risk: cmdRequest.params.risk,
        sandboxed: cmdRequest.params.sandboxed,
        requestId,
      });
      previewText = `Command: ${cmdRequest.params.parsedCmd}`;
      subtitle = 'Tool approval needed';
    } else {
      const fileRequest = request as FileChangeApprovalRequest;
      blocks = buildFileChangeApprovalBlocks({
        itemId: fileRequest.params.itemId,
        threadId: fileRequest.params.threadId,
        turnId: fileRequest.params.turnId,
        filePath: fileRequest.params.filePath,
        reason: fileRequest.params.reason,
        requestId,
      });
      previewText = `File: ${fileRequest.params.filePath}`;
      subtitle = 'Tool approval needed';
    }

    // Post approval message to Slack
    const result = await this.slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks,
      text: 'Approval requested', // Fallback text
    });

    if (!result.ts) {
      throw new Error('Failed to post approval message');
    }

    // Track the pending approval
    this.pendingApprovals.set(requestId, {
      requestId,
      request,
      channelId,
      threadTs,
      messageTs: result.ts,
      userId,
      createdAt: Date.now(),
    });

    this.startApprovalReminder(requestId, this.getApprovalLabel(request));

    // Send DM notification if userId is provided
    if (userId) {
      const conversationKey = makeConversationKey(channelId, threadTs);
      await sendDmNotification({
        client: this.slack,
        userId,
        channelId,
        messageTs: result.ts,
        conversationKey,
        emoji: ':wrench:',
        title: 'Tool approval needed',
        subtitle,
        queryPreview: previewText,
      }).catch((err) => {
        console.error('Failed to send DM notification:', err);
      });
    }
  }

  /**
   * Handle user's approval decision from Slack button click.
   */
  async handleApprovalDecision(
    requestId: number,
    decision: 'accept' | 'decline'
  ): Promise<boolean> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      console.warn(`No pending approval found for request ID ${requestId}`);
      return false;
    }

    // Respond to Codex
    await this.codex.respondToApproval(requestId, decision);

    // Update the Slack message to show the decision
    const blocks =
      decision === 'accept'
        ? buildApprovalGrantedBlocks(this.getCommandFromRequest(pending.request))
        : buildApprovalDeniedBlocks(this.getCommandFromRequest(pending.request));

    await this.slack.chat.update({
      channel: pending.channelId,
      ts: pending.messageTs,
      blocks,
      text: decision === 'accept' ? 'Approved' : 'Denied',
    });

    // Remove from pending
    this.pendingApprovals.delete(requestId);
    this.clearApprovalReminder(requestId);
    return true;
  }

  /**
   * Get command string from approval request (for display).
   */
  private getCommandFromRequest(request: ApprovalRequestWithId): string | undefined {
    if (request.method === 'item/commandExecution/requestApproval') {
      return (request as CommandApprovalRequest).params.parsedCmd;
    }
    return undefined;
  }

  /**
   * Clean up stale pending approvals (older than timeout).
   */
  cleanupStaleApprovals(timeoutMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [requestId, pending] of this.pendingApprovals) {
      if (now - pending.createdAt > timeoutMs) {
        this.pendingApprovals.delete(requestId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get number of pending approvals.
   */
  get pendingCount(): number {
    return this.pendingApprovals.size;
  }
}
