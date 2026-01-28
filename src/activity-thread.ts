/**
 * Activity thread manager for posting tool/thinking activity to Slack threads.
 *
 * Batches activity entries and posts them to the conversation thread.
 * Handles long content by uploading as markdown attachments.
 */

import type { WebClient } from '@slack/web-api';
import { withSlackRetry } from './slack-retry.js';

// Max chars before converting to .md attachment
const MAX_MESSAGE_LENGTH = 2900;
const THINKING_TRUNCATE_LENGTH = 500;

/**
 * Activity entry types for tracking tool/thinking progress.
 */
export interface ActivityEntry {
  type: 'starting' | 'thinking' | 'tool_start' | 'tool_complete' | 'generating' | 'error' | 'aborted';
  timestamp: number;
  tool?: string;
  toolInput?: string;
  toolUseId?: string; // For race condition tracking in batch updates
  durationMs?: number;
  message?: string;
  charCount?: number;
}

/**
 * Batch of activity entries for a conversation.
 */
export interface ActivityBatch {
  entries: ActivityEntry[];
  postedTs?: string; // Slack ts of posted batch message
  postedToolUseIds: string[]; // Tool use IDs included in posted message (race fix)
  lastPostTime: number; // For rate limiting
}

// Spinner frames for animated status
export const SPINNER_FRAMES = ['\u25D0', '\u25D3', '\u25D1', '\u25D2'];

// Tool emoji mapping
const TOOL_EMOJI: Record<string, string> = {
  Read: ':mag:',
  Glob: ':mag:',
  Grep: ':mag:',
  Edit: ':memo:',
  Write: ':memo:',
  Bash: ':computer:',
  Shell: ':computer:',
  WebFetch: ':globe_with_meridians:',
  Task: ':robot_face:',
};

/**
 * Get emoji for a tool name.
 */
export function getToolEmoji(tool: string): string {
  return TOOL_EMOJI[tool] || ':gear:';
}

/**
 * Activity thread manager handles posting activity to Slack threads.
 */
export class ActivityThreadManager {
  private batches = new Map<string, ActivityBatch>();

  /**
   * Add an activity entry to the batch for a conversation.
   */
  addEntry(conversationKey: string, entry: ActivityEntry): void {
    const batch = this.batches.get(conversationKey) || {
      entries: [],
      postedToolUseIds: [],
      lastPostTime: 0,
    };
    batch.entries.push(entry);
    this.batches.set(conversationKey, batch);
  }

  /**
   * Get current entries for a conversation.
   */
  getEntries(conversationKey: string): ActivityEntry[] {
    return this.batches.get(conversationKey)?.entries || [];
  }

  /**
   * Clear entries for a conversation.
   */
  clearEntries(conversationKey: string): void {
    this.batches.delete(conversationKey);
  }

  /**
   * Post batched entries to thread.
   */
  async flushBatch(
    conversationKey: string,
    client: WebClient,
    channel: string,
    threadTs: string
  ): Promise<void> {
    const batch = this.batches.get(conversationKey);
    if (!batch || batch.entries.length === 0) return;

    const text = this.formatBatch(batch.entries);

    // Check if content exceeds Slack limit
    if (text.length > MAX_MESSAGE_LENGTH) {
      await this.postAsAttachment(client, channel, threadTs, text, 'activity.md');
    } else if (batch.postedTs) {
      // Update existing message
      try {
        await withSlackRetry(
          () => client.chat.update({ channel, ts: batch.postedTs!, text }),
          'activity.update'
        );
      } catch {
        // If update fails (message too old), post new
        const result = await withSlackRetry(
          () => client.chat.postMessage({ channel, thread_ts: threadTs, text }),
          'activity.post'
        );
        batch.postedTs = result.ts;
      }
    } else {
      // Post new message
      const result = await withSlackRetry(
        () => client.chat.postMessage({ channel, thread_ts: threadTs, text }),
        'activity.post'
      );
      batch.postedTs = result.ts;
    }

    // Track posted tool IDs for race condition prevention
    batch.postedToolUseIds = batch.entries
      .filter((e) => e.toolUseId)
      .map((e) => e.toolUseId!);
    batch.lastPostTime = Date.now();
  }

  /**
   * Post thinking content (truncated with full in attachment if long).
   */
  async postThinking(
    client: WebClient,
    channel: string,
    threadTs: string,
    content: string
  ): Promise<void> {
    if (content.length <= MAX_MESSAGE_LENGTH) {
      await withSlackRetry(
        () =>
          client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `:brain: *Thinking*\n${content}`,
          }),
        'thinking.post'
      );
    } else {
      // Truncate for preview, attach full
      const preview = '...' + content.slice(-THINKING_TRUNCATE_LENGTH);
      await this.postAsAttachment(
        client,
        channel,
        threadTs,
        content,
        'thinking.md',
        `:brain: *Thinking* _[${content.length} chars]_\n${preview}`
      );
    }
  }

  /**
   * Post as markdown attachment.
   */
  private async postAsAttachment(
    client: WebClient,
    channel: string,
    threadTs: string,
    content: string,
    filename: string,
    previewText?: string
  ): Promise<void> {
    await withSlackRetry(
      () =>
        client.files.uploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          filename,
          content,
          initial_comment: previewText || `_Content in attachment (${content.length} chars)_`,
        }),
      'file.upload'
    );
  }

  /**
   * Format batch of entries as text.
   */
  private formatBatch(entries: ActivityEntry[]): string {
    // Limit to last 20 entries (rolling window)
    const displayEntries = entries.slice(-20);
    const hiddenCount = entries.length - displayEntries.length;

    let text = '';
    if (hiddenCount > 0) {
      text += `_... ${hiddenCount} earlier entries (see full log after completion) ..._\n`;
    }

    text += displayEntries.map((e) => this.formatEntry(e)).join('\n');
    return text;
  }

  /**
   * Format a single activity entry.
   */
  private formatEntry(entry: ActivityEntry): string {
    const emoji = entry.tool ? getToolEmoji(entry.tool) : ':gear:';
    const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';

    switch (entry.type) {
      case 'starting':
        return ':brain: *Analyzing request...*';
      case 'thinking':
        return `:brain: *Thinking...* ${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
      case 'tool_start':
        return `${emoji} *${entry.tool}*${entry.toolInput ? ` \`${entry.toolInput}\`` : ''} [in progress]`;
      case 'tool_complete':
        return `:white_check_mark: *${entry.tool}*${entry.toolInput ? ` \`${entry.toolInput}\`` : ''}${duration}`;
      case 'generating':
        return `:pencil: *Generating...*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
      case 'error':
        return `:x: ${entry.message || 'Error'}`;
      case 'aborted':
        return ':octagonal_sign: *Aborted by user*';
      default:
        return `${emoji} ${entry.message || entry.type}${duration}`;
    }
  }
}

/**
 * Build activity log text from entries with rolling window.
 * Shows most recent entries, reducing count if text exceeds maxChars.
 * @param entries - Activity entries to format
 * @param maxEntries - Maximum number of entries to show (default: 20)
 * @param maxChars - Maximum characters for output (default: 1000)
 */
export function buildActivityLogText(
  entries: ActivityEntry[],
  maxEntries = 20,
  maxChars = 1000
): string {
  const manager = new ActivityThreadManager();

  // Start with maxEntries, reduce until text fits within maxChars
  // This ensures we always show the MOST RECENT entries (end of array)
  let entriesToShow = Math.min(entries.length, maxEntries);

  while (entriesToShow > 0) {
    const displayEntries = entries.slice(-entriesToShow);
    const hiddenCount = entries.length - displayEntries.length;

    let text = '';
    if (hiddenCount > 0) {
      text += `_... ${hiddenCount} earlier entries ..._\n`;
    }

    text += displayEntries.map((e) => (manager as any).formatEntry(e)).join('\n');

    // If fits within maxChars, return it
    if (text.length <= maxChars) {
      return text;
    }

    // Reduce entries and try again
    entriesToShow--;
  }

  // Edge case: even 0 entries somehow exceeds (shouldn't happen)
  return '_... activity too long ..._';
}
