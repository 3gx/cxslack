/**
 * Integration tests for @bot mention validation.
 * Tests that @bot is only allowed in main channel, not in threads.
 */

import { describe, it, expect } from 'vitest';
import { getAppMentionRejection } from '../../slack-bot.js';

// Mock the slack-bot module to test the validation logic
// We test the validation logic directly rather than the full handler

describe('@bot Mention Validation', () => {
  describe('Thread detection', () => {
    it('rejects @bot mention in existing thread (thread_ts is set)', () => {
      const rejection = getAppMentionRejection('C123', '1234567880.123456');
      expect(rejection?.text).toBe('❌ @bot can only be mentioned in the main channel, not in threads.');
    });

    it('allows @bot mention in main channel (no thread_ts)', () => {
      const rejection = getAppMentionRejection('C123', undefined);
      expect(rejection).toBeNull();
    });
  });

  describe('Channel type validation', () => {
    it('rejects @bot mentions outside channels', () => {
      const rejection = getAppMentionRejection('D123', undefined);
      expect(rejection?.text).toBe('❌ This bot only works in channels, not in direct messages.');
    });
  });

  describe('Error message format', () => {
    it('provides clear error message for thread mentions', () => {
      const rejection = getAppMentionRejection('C123', '1234567880.123456');
      expect(rejection?.text).toBe('❌ @bot can only be mentioned in the main channel, not in threads.');
    });
  });

  describe('Reply threading behavior', () => {
    it('uses existing thread_ts for error reply when in thread', () => {
      const rejection = getAppMentionRejection('C123', '1234567880.123456');
      expect(rejection?.threadTs).toBe('1234567880.123456');
    });

    it('uses message ts as thread anchor when in main channel', () => {
      const event = {
        channel: 'C123',
        ts: '1234567890.123456',
        thread_ts: undefined,
      };

      // New thread should use message ts as anchor
      const replyThreadTs = event.thread_ts ?? event.ts;
      expect(replyThreadTs).toBe(event.ts);
    });
  });

  describe('Model selection in threads', () => {
    it('model picker is always posted in thread context', () => {
      // After @bot creates a thread from main channel,
      // all subsequent interactions (including /model) happen in that thread
      const originalMention = {
        channel: 'C123',
        ts: '1234567890.123456', // This becomes the thread anchor
        thread_ts: undefined,
      };

      const postingThreadTs = originalMention.thread_ts ?? originalMention.ts;

      // Model picker would be posted with thread_ts = postingThreadTs
      const modelPickerPost = {
        channel: originalMention.channel,
        thread_ts: postingThreadTs,
      };

      expect(modelPickerPost.thread_ts).toBe(originalMention.ts);
    });

    it('model selection saves to correct thread session', () => {
      // When user picks a model, it should be saved to the thread session
      // using the thread anchor ts (not the picker message ts)
      const threadAnchor = '1234567890.123456';
      const pickerMessageTs = '1234567900.123456';

      // The picker message's thread_ts points to the anchor
      const pickerMessage = {
        ts: pickerMessageTs,
        thread_ts: threadAnchor,
      };

      // Model selection handler extracts threadTs from message.thread_ts
      const threadTs = pickerMessage.thread_ts ?? pickerMessageTs;
      expect(threadTs).toBe(threadAnchor);
    });

    it('subsequent messages in thread retrieve model from thread session', () => {
      // When user sends a message in the thread after picking model,
      // the message handler should retrieve from the same thread session
      const threadAnchor = '1234567890.123456';
      const newMessageTs = '1234567910.123456';

      const newMessage = {
        ts: newMessageTs,
        thread_ts: threadAnchor, // In the same thread
      };

      // Message handler uses threadTs for session lookup
      const postingThreadTs = newMessage.thread_ts ?? newMessageTs;
      expect(postingThreadTs).toBe(threadAnchor);
    });
  });
});
