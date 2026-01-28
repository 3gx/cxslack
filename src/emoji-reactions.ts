/**
 * Emoji reaction management for Slack messages.
 *
 * Uses mutex to serialize concurrent emoji operations on the same message,
 * preventing race conditions with Slack's API.
 *
 * Emoji state transitions:
 * - Start:           +eyes
 * - Approval wait:   +question (eyes stays)
 * - Approval done:   -question (eyes stays, continues)
 * - Complete:        -eyes +white_check_mark
 * - Error:           -eyes -question +x
 * - Abort:           -eyes -question +octagonal_sign
 */

import { Mutex } from 'async-mutex';
import type { WebClient } from '@slack/web-api';

// Mutex cache per message (channel:ts)
const emojiMutexes = new Map<string, Mutex>();

/**
 * Get or create a mutex for a specific message.
 */
function getMutex(channel: string, ts: string): Mutex {
  const key = `${channel}:${ts}`;
  if (!emojiMutexes.has(key)) {
    emojiMutexes.set(key, new Mutex());
  }
  return emojiMutexes.get(key)!;
}

/**
 * Clean up mutex for a message (call after processing completes).
 */
export function cleanupMutex(channel: string, ts: string): void {
  const key = `${channel}:${ts}`;
  emojiMutexes.delete(key);
}

/**
 * Add a reaction emoji to a message.
 * Silently handles 'already_reacted' errors.
 */
export async function addReaction(
  client: WebClient,
  channel: string,
  ts: string,
  name: string
): Promise<void> {
  const mutex = getMutex(channel, ts);
  await mutex.runExclusive(async () => {
    try {
      await client.reactions.add({ channel, timestamp: ts, name });
    } catch (e: unknown) {
      const err = e as { data?: { error?: string } };
      if (err?.data?.error !== 'already_reacted') {
        console.error(`Failed to add :${name}:`, err?.data?.error);
      }
    }
  });
}

/**
 * Remove a reaction emoji from a message.
 * Silently handles 'no_reaction' errors.
 */
export async function removeReaction(
  client: WebClient,
  channel: string,
  ts: string,
  name: string
): Promise<void> {
  const mutex = getMutex(channel, ts);
  await mutex.runExclusive(async () => {
    try {
      await client.reactions.remove({ channel, timestamp: ts, name });
    } catch (e: unknown) {
      const err = e as { data?: { error?: string } };
      if (err?.data?.error !== 'no_reaction') {
        console.error(`Failed to remove :${name}:`, err?.data?.error);
      }
    }
  });
}

/**
 * Transition emojis for processing start.
 */
export async function markProcessingStart(
  client: WebClient,
  channel: string,
  ts: string
): Promise<void> {
  await addReaction(client, channel, ts, 'eyes');
}

/**
 * Transition emojis for approval wait.
 */
export async function markApprovalWait(
  client: WebClient,
  channel: string,
  ts: string
): Promise<void> {
  await addReaction(client, channel, ts, 'question');
}

/**
 * Transition emojis for approval complete (continuing).
 */
export async function markApprovalDone(
  client: WebClient,
  channel: string,
  ts: string
): Promise<void> {
  await removeReaction(client, channel, ts, 'question');
}

/**
 * Transition emojis for successful completion.
 */
export async function markComplete(
  client: WebClient,
  channel: string,
  ts: string
): Promise<void> {
  await removeReaction(client, channel, ts, 'eyes');
  await removeReaction(client, channel, ts, 'question');
  await addReaction(client, channel, ts, 'white_check_mark');
  cleanupMutex(channel, ts);
}

/**
 * Transition emojis for error state.
 */
export async function markError(
  client: WebClient,
  channel: string,
  ts: string
): Promise<void> {
  await removeReaction(client, channel, ts, 'eyes');
  await removeReaction(client, channel, ts, 'question');
  await addReaction(client, channel, ts, 'x');
  cleanupMutex(channel, ts);
}

/**
 * Transition emojis for abort state.
 */
export async function markAborted(
  client: WebClient,
  channel: string,
  ts: string
): Promise<void> {
  await removeReaction(client, channel, ts, 'eyes');
  await removeReaction(client, channel, ts, 'question');
  await addReaction(client, channel, ts, 'octagonal_sign');
  cleanupMutex(channel, ts);
}
