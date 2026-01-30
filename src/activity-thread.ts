/**
 * Activity thread manager for posting tool/thinking activity to Slack threads.
 *
 * Batches activity entries and posts them to the conversation thread.
 * Handles long content by uploading as markdown attachments.
 */

import type { WebClient } from '@slack/web-api';
import { withSlackRetry } from './slack-retry.js';
import { markdownToPng } from './markdown-png.js';
import {
  stripMarkdownCodeFence,
  markdownToSlack,
  truncateWithClosedFormatting,
  formatThreadActivityBatch,
  formatThreadActivityEntry,
  formatThreadStartingMessage,
  formatThreadThinkingMessage,
  formatThreadResponseMessage,
  formatThreadErrorMessage,
  buildActivityEntryBlocks,
  formatToolInputSummary,
  formatToolResultSummary,
  normalizeToolName,
} from './blocks.js';

/**
 * Escape Slack mrkdwn special characters to prevent formatting issues.
 */
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/[`*_~<>]/g, '\\$&');
}

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
  toolInput?: string | Record<string, unknown>; // String for display, Record for TodoWrite etc.
  toolUseId?: string; // For race condition tracking in batch updates
  durationMs?: number;
  message?: string;
  charCount?: number;

  // Result metrics (computed from input for Edit/Write, from output for Bash)
  lineCount?: number;           // Read/Write/Bash: lines in result/content
  matchCount?: number;          // Grep/Glob: number of matches/files (if available)
  linesAdded?: number;          // Edit: lines in new_string
  linesRemoved?: number;        // Edit: lines in old_string

  // Tool output (only available for Bash commands via command:output events)
  toolOutput?: string;               // Full output (up to 50KB)
  toolOutputPreview?: string;        // First 300 chars for display
  toolOutputTruncated?: boolean;     // True if output was truncated
  toolIsError?: boolean;             // True if tool returned error (exit code != 0)
  toolErrorMessage?: string;         // Error message if failed

  // In-progress tracking for thinking
  thinkingInProgress?: boolean;      // True while thinking is streaming

  /** Unique ID for thinking segment (like toolUseId for tools) */
  thinkingSegmentId?: string;
}

/**
 * Batch of activity entries for a conversation.
 */
export interface ActivityBatch {
  entries: ActivityEntry[];
  postedTs?: string; // Slack ts of posted batch message
  postedToolUseIds: string[]; // Tool use IDs included in posted message (race fix)
  lastPostTime: number; // For rate limiting
  postedCount: number; // How many entries have been emitted as thread replies
  toolIdToPostedTs: Map<string, string>; // toolUseId → message ts for update-in-place
  thinkingIdToPostedTs: Map<string, string>; // thinkingSegmentId → message ts for update-in-place
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
  const normalized = normalizeToolName(tool);
  return TOOL_EMOJI[normalized] || ':gear:';
}

/**
 * Activity thread manager handles posting activity to Slack threads.
 */
export class ActivityThreadManager {
  private batches = new Map<string, ActivityBatch>();

  /**
   * Add an activity entry to the batch for a conversation.
   */
  addEntry(conversationKey: string, entry: ActivityEntry): ActivityEntry[] {
    const batch: ActivityBatch = this.batches.get(conversationKey) || {
      entries: [],
      postedToolUseIds: [],
      lastPostTime: 0,
      postedCount: 0,
      toolIdToPostedTs: new Map(),
      thinkingIdToPostedTs: new Map(),
    };
    batch.entries.push(entry);
    this.batches.set(conversationKey, batch);
    return batch.entries;
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
  // Legacy flush kept for compatibility (used by tests)
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
        return `:brain: *Thinking...*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
      case 'tool_start': {
        // Type guard: only pass object input, not string
        const inputObj = typeof entry.toolInput === 'object' ? entry.toolInput : undefined;
        const inputSummary = formatToolInputSummary(entry.tool || '', inputObj);
        return `${emoji} *${normalizeToolName(entry.tool || '')}*${inputSummary} [in progress]`;
      }
      case 'tool_complete': {
        // Type guard: only pass object input, not string
        const inputObj = typeof entry.toolInput === 'object' ? entry.toolInput : undefined;
        const inputSummary = formatToolInputSummary(entry.tool || '', inputObj);
        const resultSummary = formatToolResultSummary(entry);
        const errorFlag = entry.toolIsError ? ' :warning:' : '';

        // Add output preview with arrow (escaped for mrkdwn safety)
        let outputHint = '';
        if (!entry.toolIsError && entry.toolOutputPreview) {
          const cleaned = escapeSlackMrkdwn(entry.toolOutputPreview.replace(/\s+/g, ' '));
          const truncated = cleaned.slice(0, 50);
          const ellipsis = cleaned.length > 50 ? '...' : '';
          outputHint = ` → \`${truncated}${ellipsis}\``;
        }

        return `${emoji} *${normalizeToolName(entry.tool || '')}*${inputSummary}${resultSummary}${outputHint}${duration}${errorFlag}`;
      }
      case 'generating':
        return `:memo: *Generating...*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
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

// ============================================================================
// Thread Posting Functions (Ported from ccslack)
// ============================================================================

// Default message size limit for Slack
export const MESSAGE_SIZE_DEFAULT = 2900;

// Polling config for files.uploadV2 shares (async file sharing)
const FILE_SHARES_POLL_INTERVAL_MS = 200; // Poll every 200ms
const FILE_SHARES_POLL_MAX_ATTEMPTS = 25; // Max 5 seconds (25 * 200ms)

// Rate limiting for activity batch posts (min 2s gap)
const ACTIVITY_BATCH_MIN_GAP_MS = 2000;

/**
 * Poll for file shares to be populated after files.uploadV2.
 * Slack's files.uploadV2 is async - it returns before the file is shared to the channel.
 * We need to poll files.info until shares[channelId] has a ts.
 *
 * @param client - Slack WebClient
 * @param fileId - ID of the uploaded file
 * @param channelId - Channel the file was shared to
 * @returns The message ts where the file was shared, or null if polling times out
 */
async function pollForFileShares(
  client: WebClient,
  fileId: string,
  channelId: string
): Promise<string | null> {
  for (let attempt = 0; attempt < FILE_SHARES_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const fileInfo = await client.files.info({ file: fileId });
      const shares = (fileInfo as any)?.file?.shares;

      // Check both public and private shares
      const ts = shares?.public?.[channelId]?.[0]?.ts ?? shares?.private?.[channelId]?.[0]?.ts;
      if (ts) {
        console.log(`[pollForFileShares] Got ts after ${attempt + 1} attempts: ${ts}`);
        return ts;
      }
    } catch (error) {
      console.error(`[pollForFileShares] files.info error on attempt ${attempt + 1}:`, error);
      // Continue polling despite errors
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, FILE_SHARES_POLL_INTERVAL_MS));
  }

  console.error(
    `[pollForFileShares] Timed out after ${FILE_SHARES_POLL_MAX_ATTEMPTS} attempts for file ${fileId}`
  );
  return null;
}

/**
 * Upload markdown content as both .md and .png files with properly formatted response text.
 * The PNG provides a nicely rendered preview of the markdown.
 * Falls back gracefully if PNG generation fails.
 *
 * Simplified behavior:
 * - Short response (< limit): post full text, then upload files
 * - Long response (> limit): post truncated text with closed formatting, then upload files
 *
 * Returns timestamps for the message, or null on complete failure.
 */
export async function uploadMarkdownAndPngWithResponse(
  client: WebClient,
  channelId: string,
  markdown: string,
  slackFormattedResponse: string,
  threadTs?: string,
  userId?: string,
  threadCharLimit?: number
): Promise<{ ts?: string; uploadSucceeded?: boolean } | null> {
  const limit = threadCharLimit ?? MESSAGE_SIZE_DEFAULT;

  // Strip markdown code fence wrapper if present (e.g., ```markdown ... ```)
  const cleanMarkdown = stripMarkdownCodeFence(markdown);

  try {
    // Step 1: Prepare text (truncated if needed)
    const textToPost =
      slackFormattedResponse.length <= limit
        ? slackFormattedResponse
        : truncateWithClosedFormatting(slackFormattedResponse, limit);

    // Track if response was truncated (for conditional file attachment)
    // Check the MARKDOWN content length, not the formatted preview length
    const wasTruncated = cleanMarkdown.length > limit;

    let textTs: string | undefined;

    // Step 2: Post message - with files if truncated, just text otherwise
    if (wasTruncated) {
      // Generate PNG from markdown (may return null on failure)
      const pngBuffer = await markdownToPng(cleanMarkdown);

      // Prepare files array - always include markdown
      const timestamp = Date.now();
      const files: Array<{ content: string | Buffer; filename: string; title: string }> = [
        {
          content: cleanMarkdown,
          filename: `response-${timestamp}.md`,
          title: 'Full Response (Markdown)',
        },
      ];

      // Add PNG if generation succeeded
      if (pngBuffer) {
        files.push({
          content: pngBuffer,
          filename: `response-${timestamp}.png`,
          title: 'Response Preview',
        });
      }

      if (!threadTs) {
        // MAIN CHANNEL / DM: Post text first, then attachments as thread reply
        const textResult = await withSlackRetry(
          () =>
            client.chat.postMessage({
              channel: channelId,
              text: textToPost,
            }),
          'thread.text'
        );
        textTs = (textResult as any).ts;

        // Upload files as thread reply to the response message
        if (textTs) {
          try {
            await withSlackRetry(
              () =>
                client.files.uploadV2({
                  channel_id: channelId,
                  thread_ts: textTs,
                  file_uploads: files.map((f) => ({
                    file:
                      typeof f.content === 'string' ? Buffer.from(f.content, 'utf-8') : f.content,
                    filename: f.filename,
                    title: f.title,
                  })),
                } as any),
              'thread.files'
            );
          } catch (fileError) {
            console.error('[uploadMarkdownAndPng] File upload failed after text post:', fileError);
            if (userId) {
              try {
                await client.chat.postEphemeral({
                  channel: channelId,
                  user: userId,
                  text: `Failed to attach files: ${fileError instanceof Error ? fileError.message : 'Unknown error'}`,
                });
              } catch {
                // Ignore ephemeral failure
              }
            }
          }
        }
      } else {
        // THREAD: Keep current bundled behavior (files + initial_comment together)
        const fileResult = await withSlackRetry(
          () =>
            client.files.uploadV2({
              channel_id: channelId,
              thread_ts: threadTs,
              initial_comment: textToPost,
              file_uploads: files.map((f) => ({
                file: typeof f.content === 'string' ? Buffer.from(f.content, 'utf-8') : f.content,
                filename: f.filename,
                title: f.title,
              })),
            } as any),
          'thread.bundled'
        );

        // Get ts from the file message
        const shares = (fileResult as any)?.files?.[0]?.shares;
        textTs = shares?.public?.[channelId]?.[0]?.ts ?? shares?.private?.[channelId]?.[0]?.ts;

        // files.uploadV2 is async - shares may be empty initially
        if (!textTs) {
          const fileId = (fileResult as any)?.files?.[0]?.files?.[0]?.id;
          if (fileId) {
            console.log(`[uploadMarkdownAndPng] shares empty, polling for file ${fileId}`);
            textTs = (await pollForFileShares(client, fileId, channelId)) ?? undefined;
          }
        }

        if (!textTs) {
          console.error('[uploadMarkdownAndPng] textTs extraction failed after polling');
        }
      }
    } else {
      // Short response - just post text (no files)
      const textResult = await withSlackRetry(
        () =>
          client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: textToPost,
          }),
        'thread.short'
      );

      textTs = (textResult as any).ts;
    }

    return {
      ts: textTs,
      uploadSucceeded: wasTruncated && !textTs,
    };
  } catch (error) {
    console.error('Failed to upload markdown/png files:', error);
    if (userId) {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Failed to attach files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      } catch {
        // Ignore ephemeral failure
      }
    }
    return null;
  }
}

/**
 * Post "Analyzing request..." starting message to thread.
 */
export async function postStartingToThread(
  client: WebClient,
  channel: string,
  threadTs: string
): Promise<string | null> {
  try {
    const result = await withSlackRetry(
      () =>
        client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: formatThreadStartingMessage(),
        }),
      'thread.starting'
    );
    return (result as any).ts || null;
  } catch (err) {
    console.error('[postStartingToThread] Failed:', err);
    return null;
  }
}

/**
 * Flush activity batch to thread.
 * Respects rate limiting (2s minimum gap) unless force=true.
 */
export async function flushActivityBatchToThread(
  manager: ActivityThreadManager,
  conversationKey: string,
  client: WebClient,
  channel: string,
  threadTs: string,
  options?: {
    force?: boolean;
    mapActivityTs?: (ts: string, entry: ActivityEntry) => void;
    buildActions?: (entry: ActivityEntry, slackTs?: string) => import('./blocks.js').ActivityEntryActionParams | undefined;
    useBlocks?: boolean;
  }
): Promise<void> {
  const entries = manager.getEntries(conversationKey);
  if (entries.length === 0) return;

  // Check rate limiting
  const batch = (manager as any).batches?.get(conversationKey);
  const force = options?.force ?? false;
  if (!force && batch) {
    const timeSinceLastPost = Date.now() - (batch.lastPostTime || 0);
    if (timeSinceLastPost < ACTIVITY_BATCH_MIN_GAP_MS) {
      return; // Skip, too soon
    }
  }

  const startIndex = batch?.postedCount ?? 0;
  const newEntries = entries.slice(startIndex);
  if (newEntries.length === 0) return;

  for (const entry of newEntries) {
    const text = formatThreadActivityEntry(entry);
    if (!text) {
      if (batch) batch.postedCount += 1;
      continue;
    }

    try {
      // Check if this is a tool_complete and we have an existing message to update
      const existingToolTs = entry.type === 'tool_complete' && entry.toolUseId && batch?.toolIdToPostedTs
        ? batch.toolIdToPostedTs.get(entry.toolUseId)
        : undefined;

      // Check for THINKING update-in-place (same pattern as tools)
      const existingThinkingTs = entry.type === 'thinking' && entry.thinkingSegmentId && batch?.thinkingIdToPostedTs
        ? batch.thinkingIdToPostedTs.get(entry.thinkingSegmentId)
        : undefined;

      const existingTs = existingToolTs || existingThinkingTs;
      let postedTs: string | undefined;

      if (existingTs) {
        // UPDATE existing tool_start message with completion info (update-in-place)
        const baseBlocks = options?.useBlocks === false
          ? undefined
          : buildActivityEntryBlocks({ text });

        await withSlackRetry(
          () => client.chat.update({
            channel,
            ts: existingTs,
            text,
            ...(baseBlocks ? { blocks: baseBlocks } : {}),
          }),
          'batch.entry.update-in-place'
        );

        postedTs = existingTs;
      } else {
        // Post new message
        const baseBlocks = options?.useBlocks === false
          ? undefined
          : buildActivityEntryBlocks({ text });

        const result = await withSlackRetry(
          () => client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text,
            ...(baseBlocks ? { blocks: baseBlocks, unfurl_links: false, unfurl_media: false } : {}),
          }),
          'batch.entry.post'
        );

        postedTs = (result as any).ts as string | undefined;

        // Track tool_start message ts for update-in-place on completion
        if (entry.type === 'tool_start' && entry.toolUseId && postedTs && batch?.toolIdToPostedTs) {
          batch.toolIdToPostedTs.set(entry.toolUseId, postedTs);
        }

        // Track thinking message ts for update-in-place (same pattern as tools)
        if (entry.type === 'thinking' && entry.thinkingSegmentId && postedTs && batch?.thinkingIdToPostedTs) {
          batch.thinkingIdToPostedTs.set(entry.thinkingSegmentId, postedTs);
        }
      }

      // Add actions if requested (for both new and updated messages)
      if (postedTs && options?.buildActions) {
        const actions = options.buildActions(entry, postedTs);
        if (actions) {
          const blocks = buildActivityEntryBlocks({ text, actions });
          await withSlackRetry(
            () => client.chat.update({ channel, ts: postedTs!, text, blocks }),
            'batch.entry.actions'
          );
        }
      }

      if (batch) {
        batch.postedTs = postedTs || batch.postedTs;
        batch.postedCount += 1;
        batch.lastPostTime = Date.now();
        if (entry.toolUseId) {
          batch.postedToolUseIds.push(entry.toolUseId);
        }
      }

      if (postedTs && options?.mapActivityTs) {
        options.mapActivityTs(postedTs, entry);
      }
    } catch (err) {
      console.error('[flushActivityBatchToThread] Failed:', err);
    }
  }
}

/**
 * Post thinking content to thread.
 * Uploads .md + .png if content is long.
 */
export async function postThinkingToThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  content: string,
  durationMs?: number,
  charLimit?: number
): Promise<string | null> {
  const limit = charLimit ?? MESSAGE_SIZE_DEFAULT;

  // Format header
  const header = formatThreadThinkingMessage(content, durationMs);

  if (content.length <= limit) {
    // Short thinking - post inline
    try {
      const result = await withSlackRetry(
        () =>
          client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `${header}\n\n${content}`,
          }),
        'thinking.short'
      );
      return (result as any).ts || null;
    } catch (err) {
      console.error('[postThinkingToThread] Failed:', err);
      return null;
    }
  }

  // Long thinking - upload with .md + .png
  const slackFormatted = markdownToSlack(content);
  const result = await uploadMarkdownAndPngWithResponse(
    client,
    channel,
    content,
    `${header}\n\n${slackFormatted}`,
    threadTs,
    undefined,
    limit
  );

  return result?.ts || null;
}

/**
 * Post response content to thread.
 * Uploads .md + .png if content is long.
 */
export async function postResponseToThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  content: string,
  durationMs?: number,
  charLimit?: number
): Promise<string | null> {
  const limit = charLimit ?? MESSAGE_SIZE_DEFAULT;

  // Format header
  const header = formatThreadResponseMessage(content, durationMs);

  if (content.length <= limit) {
    // Short response - post inline
    try {
      const result = await withSlackRetry(
        () =>
          client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `${header}\n\n${content}`,
          }),
        'response.short'
      );
      return (result as any).ts || null;
    } catch (err) {
      console.error('[postResponseToThread] Failed:', err);
      return null;
    }
  }

  // Long response - upload with .md + .png
  const slackFormatted = markdownToSlack(content);
  const result = await uploadMarkdownAndPngWithResponse(
    client,
    channel,
    content,
    `${header}\n\n${slackFormatted}`,
    threadTs,
    undefined,
    limit
  );

  return result?.ts || null;
}

/**
 * Post error message to thread.
 */
export async function postErrorToThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  message: string
): Promise<string | null> {
  try {
    const result = await withSlackRetry(
      () =>
        client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: formatThreadErrorMessage(message),
        }),
      'error.post'
    );
    return (result as any).ts || null;
  } catch (err) {
    console.error('[postErrorToThread] Failed:', err);
    return null;
  }
}
