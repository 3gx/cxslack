/**
 * Unit tests for emoji reactions.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  addReaction,
  removeReaction,
  markProcessingStart,
  markApprovalWait,
  markApprovalDone,
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

  describe('markApprovalWait', () => {
    it('adds question emoji (eyes stays)', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
        },
      };

      await markApprovalWait(mockClient as any, 'C123', '456.789');

      expect(mockClient.reactions.add).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '456.789',
        name: 'question',
      });
      // Does NOT remove eyes
      cleanupMutex('C123', '456.789');
    });
  });

  describe('markApprovalDone', () => {
    it('removes question emoji only', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      await markApprovalDone(mockClient as any, 'C123', '456.789');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith({
        channel: 'C123',
        timestamp: '456.789',
        name: 'question',
      });
      // Does NOT remove eyes
      expect(mockClient.reactions.remove).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
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

  describe('emoji state transitions', () => {
    it('processing -> complete: eyes removed, no emoji added', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      // Start processing
      await markProcessingStart(mockClient as any, 'C123', '456.789');
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );

      // Complete - should only remove eyes, not add anything
      mockClient.reactions.add.mockClear();
      await removeProcessingEmoji(mockClient as any, 'C123', '456.789');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.add).not.toHaveBeenCalled();
    });

    it('processing -> error: eyes removed, x added', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      // Start processing
      await markProcessingStart(mockClient as any, 'C123', '456.790');
      mockClient.reactions.add.mockClear();

      // Error
      await markError(mockClient as any, 'C123', '456.790');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'x' })
      );
    });

    it('processing -> aborted: eyes removed, stop added', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      // Start processing
      await markProcessingStart(mockClient as any, 'C123', '456.791');
      mockClient.reactions.add.mockClear();

      // Abort
      await markAborted(mockClient as any, 'C123', '456.791');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'octagonal_sign' })
      );
    });

    it('processing -> approval -> complete: eyes->eyes+question->eyes->none', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      // Start processing
      await markProcessingStart(mockClient as any, 'C123', '456.792');
      expect(mockClient.reactions.add).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );

      // Approval wait - adds question, keeps eyes
      await markApprovalWait(mockClient as any, 'C123', '456.792');
      expect(mockClient.reactions.add).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'question' })
      );

      // Approval done - removes question, keeps eyes
      await markApprovalDone(mockClient as any, 'C123', '456.792');
      expect(mockClient.reactions.remove).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'question' })
      );

      // Complete - removes eyes, no success emoji
      mockClient.reactions.add.mockClear();
      await removeProcessingEmoji(mockClient as any, 'C123', '456.792');
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.add).not.toHaveBeenCalled();
    });

    it('processing -> approval -> error: eyes->eyes+question->x', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      // Start processing
      await markProcessingStart(mockClient as any, 'C123', '456.793');

      // Approval wait
      await markApprovalWait(mockClient as any, 'C123', '456.793');

      // Error - removes both eyes and question, adds x
      await markError(mockClient as any, 'C123', '456.793');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'question' })
      );
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'x' })
      );
    });

    it('processing -> approval -> aborted: eyes->eyes+question->stop', async () => {
      const mockClient = {
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      };

      // Start processing
      await markProcessingStart(mockClient as any, 'C123', '456.794');

      // Approval wait
      await markApprovalWait(mockClient as any, 'C123', '456.794');

      // Abort - removes both eyes and question, adds octagonal_sign
      await markAborted(mockClient as any, 'C123', '456.794');

      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'eyes' })
      );
      expect(mockClient.reactions.remove).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'question' })
      );
      expect(mockClient.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'octagonal_sign' })
      );
    });
  });
});
