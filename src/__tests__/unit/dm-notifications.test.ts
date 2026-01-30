/**
 * Unit tests for DM notifications.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendDmNotification, clearDmDebounce } from '../../dm-notifications.js';

describe('DM Notifications', () => {
  beforeEach(() => {
    // Clear debounce state
    vi.useFakeTimers();
  });

  describe('sendDmNotification', () => {
    it('sends DM with permalink', async () => {
      const mockClient = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { is_bot: false } }),
        },
        chat: {
          getPermalink: vi.fn().mockResolvedValue({ permalink: 'https://slack.com/link' }),
          postMessage: vi.fn().mockResolvedValue({}),
        },
        conversations: {
          open: vi.fn().mockResolvedValue({ channel: { id: 'D123' } }),
          info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } }),
        },
      };

      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'conv-key',
        emoji: ':white_check_mark:',
        title: 'Test Title',
        subtitle: 'Done',
        queryPreview: 'Preview text',
      });

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'D123',
          text: expect.stringContaining(':white_check_mark:'),
          blocks: expect.any(Array),
          unfurl_links: false,
        })
      );
    });

    it('skips bot users', async () => {
      const mockClient = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { is_bot: true } }),
        },
        chat: {
          getPermalink: vi.fn(),
          postMessage: vi.fn(),
        },
        conversations: {
          open: vi.fn(),
        },
      };

      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'conv-key',
        emoji: ':question:',
        title: 'Test Title',
      });

      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });

    it('debounces rapid notifications per conversation (15s)', async () => {
      const mockClient = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { is_bot: false } }),
        },
        chat: {
          getPermalink: vi.fn().mockResolvedValue({ permalink: 'https://slack.com/link' }),
          postMessage: vi.fn().mockResolvedValue({}),
        },
        conversations: {
          open: vi.fn().mockResolvedValue({ channel: { id: 'D123' } }),
          info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } }),
        },
      };

      // First call should go through
      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'debounce-test',
        emoji: ':white_check_mark:',
        title: 'First',
      });
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      // Second call within debounce window should be skipped
      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'debounce-test',
        emoji: ':white_check_mark:',
        title: 'First',
      });
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      // Clean up
      clearDmDebounce('U123', 'debounce-test');
    });

    it('allows notification after debounce window', async () => {
      const mockClient = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { is_bot: false } }),
        },
        chat: {
          getPermalink: vi.fn().mockResolvedValue({ permalink: 'https://slack.com/link' }),
          postMessage: vi.fn().mockResolvedValue({}),
        },
        conversations: {
          open: vi.fn().mockResolvedValue({ channel: { id: 'D123' } }),
          info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } }),
        },
      };

      // First call
      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'debounce-window-test',
        emoji: ':white_check_mark:',
        title: 'First',
      });
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      // Advance time past debounce window (15s)
      vi.advanceTimersByTime(16000);

      // Second call should go through now
      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'debounce-window-test',
        emoji: ':white_check_mark:',
        title: 'First',
      });
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);

      // Clean up
      clearDmDebounce('U123', 'debounce-window-test');
    });

    it('handles DM disabled gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockClient = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { is_bot: false } }),
        },
        chat: {
          getPermalink: vi
            .fn()
            .mockRejectedValue({ data: { error: 'cannot_dm_bot' } }),
        },
        conversations: {
          open: vi.fn(),
          info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } }),
        },
      };

      // Should not throw
      await expect(
        sendDmNotification({
          client: mockClient as any,
          userId: 'U123',
          channelId: 'C456',
          messageTs: '789.012',
          conversationKey: 'dm-disabled-test',
          emoji: ':question:',
          title: 'Test',
        })
      ).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
      clearDmDebounce('U123', 'dm-disabled-test');
    });

    it('debounces per conversation not per user', async () => {
      const mockClient = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { is_bot: false } }),
        },
        chat: {
          getPermalink: vi.fn().mockResolvedValue({ permalink: 'https://slack.com/link' }),
          postMessage: vi.fn().mockResolvedValue({}),
        },
        conversations: {
          open: vi.fn().mockResolvedValue({ channel: { id: 'D123' } }),
          info: vi.fn().mockResolvedValue({ ok: true, channel: { name: 'general' } }),
        },
      };

      // Same user, different conversations
      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'conv-1',
        emoji: ':white_check_mark:',
        title: 'First',
      });
      await sendDmNotification({
        client: mockClient as any,
        userId: 'U123',
        channelId: 'C456',
        messageTs: '789.012',
        conversationKey: 'conv-2',
        emoji: ':white_check_mark:',
        title: 'Second',
      });

      // Both should go through (different conversation keys)
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);

      // Clean up
      clearDmDebounce('U123', 'conv-1');
      clearDmDebounce('U123', 'conv-2');
    });
  });
});
