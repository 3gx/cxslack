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
  ApprovalRequest,
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

/**
 * Pending approval request.
 */
interface PendingApproval {
  /** JSON-RPC request ID for responding */
  requestId: number;
  /** Original approval request */
  request: ApprovalRequest;
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

  /**
   * Handle an incoming approval request from Codex.
   * Posts approval buttons to Slack and tracks the pending request.
   */
  async handleApprovalRequest(
    request: ApprovalRequest,
    channelId: string,
    threadTs?: string,
    userId?: string
  ): Promise<void> {
    const requestId = this.generateRequestId();

    // Build blocks based on request type
    let blocks: Block[];
    let previewText: string | undefined;
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
      previewText = `Command: \`${cmdRequest.params.parsedCmd}\``;
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
      previewText = `File: \`${fileRequest.params.filePath}\``;
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

    // Send DM notification if userId is provided
    if (userId) {
      const conversationKey = makeConversationKey(channelId, threadTs);
      await sendDmNotification(
        this.slack,
        userId,
        channelId,
        result.ts,
        conversationKey,
        ':question: Approval needed',
        previewText
      ).catch((err) => {
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
    return true;
  }

  /**
   * Get command string from approval request (for display).
   */
  private getCommandFromRequest(request: ApprovalRequest): string | undefined {
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
