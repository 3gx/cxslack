/**
 * DM notification manager for approval requests.
 *
 * Sends direct messages to users when approval is needed,
 * with debouncing to prevent notification spam.
 */

import type { WebClient } from '@slack/web-api';
import { withSlackRetry } from './slack-retry.js';

// Debounce tracking: debounceKey -> lastNotificationTime
// Use conversationKey + title to debounce per-turn and per-notification type
const lastDmTime = new Map<string, number>();
const DM_DEBOUNCE_MS = 15000; // 15 seconds

function buildDebounceKey(userId: string, conversationKey: string, title: string): string {
  return `${userId}:${conversationKey}:${title}`;
}

/**
 * Truncate query text for DM notification preview.
 * Removes backticks (would break formatting) and collapses whitespace.
 */
export function truncateQueryForPreview(query: string | undefined, maxLength: number = 50): string {
  if (!query) return '';
  const cleaned = query.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + '...';
}

/**
 * Send a DM notification to a user.
 *
 * @param client - Slack WebClient
 * @param userId - User to notify
 * @param channelId - Channel where approval was requested
 * @param messageTs - Message timestamp for permalink
 * @param conversationKey - Conversation key for debouncing
 * @param emoji - Emoji to show in DM (e.g., :white_check_mark:)
 * @param title - Notification title (used for debounce)
 * @param subtitle - Optional subtitle line
 * @param queryPreview - Optional query preview text
 */
export async function sendDmNotification(params: {
  client: WebClient;
  userId: string;
  channelId: string;
  messageTs: string;
  conversationKey: string;
  emoji: string;
  title: string;
  subtitle?: string;
  queryPreview?: string;
}): Promise<void> {
  const {
    client,
    userId,
    channelId,
    messageTs,
    conversationKey,
    emoji,
    title,
    subtitle,
    queryPreview,
  } = params;

  // Skip for DMs - no need to DM about a DM
  if (!userId || channelId.startsWith('D')) return;

  // Skip bot users
  try {
    const userInfo = await client.users.info({ user: userId });
    if (userInfo.user?.is_bot) {
      return; // Don't DM bots
    }
  } catch {
    // If we can't check, proceed anyway
  }

  // Debounce check per conversation + title (notification type)
  const debounceKey = buildDebounceKey(userId, conversationKey, title);
  const now = Date.now();
  const lastTime = lastDmTime.get(debounceKey) || 0;
  if (now - lastTime < DM_DEBOUNCE_MS) {
    return; // Skip, too soon for this conversation
  }
  lastDmTime.set(debounceKey, now);

  try {
    // Get channel name for friendly message
    let channelName = 'the channel';
    try {
      const channelInfo = await client.conversations.info({ channel: channelId });
      if (channelInfo.ok && channelInfo.channel?.name) {
        channelName = `#${channelInfo.channel.name}`;
      }
    } catch {
      // Keep fallback channel name
    }

    // Get permalink to original message
    const permalink = await withSlackRetry(
      () => client.chat.getPermalink({ channel: channelId, message_ts: messageTs }),
      'getPermalink'
    );

    // Open DM with user
    const dm = await client.conversations.open({ users: userId });
    if (!dm.channel?.id) return;

    const cleanedPreview = truncateQueryForPreview(queryPreview);
    const queryClause = cleanedPreview ? ` \`${cleanedPreview}\`` : '';
    const text = `${emoji}${queryClause} in ${channelName}`;

    const blocks = permalink.permalink
      ? [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${text}${subtitle ? `\n${subtitle}` : ''}`,
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'View →', emoji: true },
              url: permalink.permalink,
              action_id: 'dm_notification_view',
            },
          },
        ]
      : undefined;

    await withSlackRetry(
      () =>
        client.chat.postMessage({
          channel: dm.channel!.id!,
          text,
          blocks,
          unfurl_links: false,
        }),
      'dm.post'
    );
  } catch (e: unknown) {
    // User may have DMs disabled - don't crash
    const err = e as { data?: { error?: string } };
    console.error('Failed to send DM notification:', err?.data?.error);
  }
}

/**
 * Clear debounce state for a conversation.
 * Call this when a turn completes.
 */
export function clearDmDebounce(userId: string, conversationKey: string, title?: string): void {
  if (title) {
    lastDmTime.delete(buildDebounceKey(userId, conversationKey, title));
    return;
  }
  const prefix = `${userId}:${conversationKey}:`;
  for (const key of lastDmTime.keys()) {
    if (key.startsWith(prefix)) {
      lastDmTime.delete(key);
    }
  }
}
