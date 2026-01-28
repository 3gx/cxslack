/**
 * DM notification manager for approval requests.
 *
 * Sends direct messages to users when approval is needed,
 * with debouncing to prevent notification spam.
 */

import type { WebClient } from '@slack/web-api';
import { withSlackRetry } from './slack-retry.js';

// Debounce tracking: debounceKey -> lastNotificationTime
// Use conversationKey (not just userId) to debounce per-turn not per-user
const lastDmTime = new Map<string, number>();
const DM_DEBOUNCE_MS = 15000; // 15 seconds

/**
 * Send a DM notification to a user.
 *
 * @param client - Slack WebClient
 * @param userId - User to notify
 * @param channelId - Channel where approval was requested
 * @param messageTs - Message timestamp for permalink
 * @param conversationKey - Conversation key for debouncing
 * @param title - Notification title
 * @param preview - Optional preview text
 */
export async function sendDmNotification(
  client: WebClient,
  userId: string,
  channelId: string,
  messageTs: string,
  conversationKey: string,
  title: string,
  preview?: string
): Promise<void> {
  // Skip bot users
  try {
    const userInfo = await client.users.info({ user: userId });
    if (userInfo.user?.is_bot) {
      return; // Don't DM bots
    }
  } catch {
    // If we can't check, proceed anyway
  }

  // Debounce check per conversation (not just user)
  const debounceKey = `${userId}:${conversationKey}`;
  const now = Date.now();
  const lastTime = lastDmTime.get(debounceKey) || 0;
  if (now - lastTime < DM_DEBOUNCE_MS) {
    return; // Skip, too soon for this conversation
  }
  lastDmTime.set(debounceKey, now);

  try {
    // Get permalink to original message
    const permalink = await withSlackRetry(
      () => client.chat.getPermalink({ channel: channelId, message_ts: messageTs }),
      'getPermalink'
    );

    // Open DM with user
    const dm = await client.conversations.open({ users: userId });
    if (!dm.channel?.id) return;

    // Build message text
    const parts = [`:bell: ${title}`];
    if (preview) {
      parts.push(preview);
    }
    if (permalink.permalink) {
      parts.push(`<${permalink.permalink}|View in channel>`);
    }

    // Send notification
    await withSlackRetry(
      () =>
        client.chat.postMessage({
          channel: dm.channel!.id!,
          text: parts.join('\n'),
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
export function clearDmDebounce(userId: string, conversationKey: string): void {
  const debounceKey = `${userId}:${conversationKey}`;
  lastDmTime.delete(debounceKey);
}
