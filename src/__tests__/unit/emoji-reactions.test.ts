/**
 * Unit tests for emoji reactions.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  addReaction,
  removeReaction,
  markProcessingStart,
  removeProcessingEmoji,
  markError,
  markAborted,
  cleanupMutex,
} from '../../emoji-reactions.js';

describe('Emoji Reactions', () => {
  describe('addReaction', () => {
    it('calls reactions.add with correct parameters', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
        },
      };

      await addReaction(mockClient as any, 'C123', '456.789', 'eyes');

      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '456.789',
        name: 'eyes',
      });

      cleanupMutex('C123', '456.789');
    });

    it('swallows already_reacted error silently', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockRejectedValue({ data: { error: 'already_reacted' } }),
        },
      };

      // Should not throw
      await expect(
        addReaction(mockClient as any, 'C123', '456.789', 'eyes')
      ).resolves.toBeUndefined();

      cleanupMutex('C123', '456.789');
    });

    it('logs other errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockClient = {
        reactions: {
          add: vi.fn().mockRejectedValue({ data: { error: 'channel_not_found' } }),
        },
      };

      await addReaction(mockClient as any, 'C123', '456.789', 'eyes');

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
      cleanupMutex('C123', '456.789');
    });
  });

  describe('removeReaction', () => {
    it('calls reactions.remove with correct parameters', async () => {
      const mockClient = {
        reactions: {
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      await removeReaction(mockClient as any, 'C123', '456.789', 'eyes');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '456.789',
        name: 'eyes',
      });

      cleanupMutex('C123', '456.789');
    });

    it('swallows no_reaction error silently', async () => {
      const mockClient = {
        reactions: {
          remove: vi.fn().mockRejectedValue({ data: { error: 'no_reaction' } }),
        },
      };

      // Should not throw
      await expect(
        removeReaction(mockClient as any, 'C123', '456.789', 'eyes')
      ).resolves.toBeUndefined();

      cleanupMutex('C123', '456.789');
    });
  });

  describe('markProcessingStart', () => {
    it('adds eyes emoji', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
        },
      };

      await markProcessingStart(mockClient as any, 'C123', '456.789');

      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '456.789',
        name: 'eyes',
      });

      cleanupMutex('C123', '456.789');
    });
  });

  describe('removeProcessingEmoji', () => {
    it('removes eyes/question without adding success emoji', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      await removeProcessingEmoji(mockClient as any, 'C123', '456.789');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'question' })
      );
      // Should NOT add any success emoji
      expect(mockClient.reactions.add).not.toHaveBeenCalled();
    });
  });

  describe('markError', () => {
    it('removes eyes/question and adds x', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      await markError(mockClient as any, 'C123', '456.789');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'x' })
      );
    });
  });

  describe('markAborted', () => {
    it('removes eyes/question and adds octagonal_sign', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      await markAborted(mockClient as any, 'C123', '456.789');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'octagonal_sign' })
      );
    });
  });

  describe('mutex serialization', () => {
    it('serializes concurrent calls to same message', async () => {
      const callOrder: number[] = [];
      let callCount = 0;

      const mockClient = {
        reactions: {
          add: vi.fn().mockImplementation(async () => {
            const myCall = ++callCount;
            // Simulate varying API response times
            await new Promise((r) => setTimeout(r, Math.random() * 10));
            callOrder.push(myCall);
          }),
        },
      };

      // Fire multiple concurrent calls
      await Promise.all([
        addReaction(mockClient as any, 'C123', '456.789', 'one'),
        addReaction(mockClient as any, 'C123', '456.789', 'two'),
        addReaction(mockClient as any, 'C123', '456.789', 'three'),
      ]);

      // All calls should complete and order should be sequential (due to mutex)
      expect(callOrder).toEqual([1, 2, 3]);

      cleanupMutex('C123', '456.789');
    });
  });
});
