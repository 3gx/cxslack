/**
 * Integration tests for channel deletion flow.
 *
 * Tests the complete flow:
 * 1. Slack fires channel_deleted event
 * 2. Bot receives event and calls deleteChannelSession
 * 3. All session data for the channel is removed from sessions.json
 *
 * NOTE: Codex threads are NOT deleted - only the bot's metadata mapping.
 * Users can still /resume orphaned threads in another channel if they have the ID.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  saveSession,
  saveThreadSession,
  getSession,
  getThreadSession,
  deleteChannelSession,
  loadSessions,
} from '../../session-manager.js';

// Mock fs module
vi.mock('fs');

describe('Channel Deletion Flow', () => {
  const mockFs = vi.mocked(fs);
  let sessionStore: { channels: Record<string, unknown> };

  beforeEach(() => {
    vi.clearAllMocks();

    // Initialize empty session store
    sessionStore = { channels: {} };

    // Mock fs to use in-memory store
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => JSON.stringify(sessionStore));
    mockFs.writeFileSync.mockImplementation((_, data) => {
      sessionStore = JSON.parse(data as string);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('channel_deleted event handler behavior', () => {
    it('removes all session data for deleted channel', async () => {
      // Setup: Create channel with main session
      sessionStore = {
        channels: {
          C_TO_DELETE: {
            threadId: 'thread-main',
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act: Simulate channel_deleted event
      await deleteChannelSession('C_TO_DELETE');

      // Assert: Channel session is completely removed
      expect(sessionStore.channels['C_TO_DELETE']).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it('handles channel with multiple thread sessions', async () => {
      // Setup: Create channel with main + multiple thread sessions
      sessionStore = {
        channels: {
          C_COMPLEX: {
            threadId: 'thread-main',
            previousThreadIds: ['thread-v1', 'thread-v2'],
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
            threads: {
              '111.222': {
                threadId: 'thread-fork-1',
                forkedFrom: 'thread-main',
                workingDir: '/test',
                approvalPolicy: 'on-request',
                createdAt: 1000,
                lastActiveAt: 2000,
                pathConfigured: false,
                configuredPath: null,
                configuredBy: null,
                configuredAt: null,
              },
              '333.444': {
                threadId: 'thread-fork-2',
                forkedFrom: 'thread-main',
                workingDir: '/test',
                approvalPolicy: 'on-request',
                createdAt: 1000,
                lastActiveAt: 2000,
                pathConfigured: false,
                configuredPath: null,
                configuredBy: null,
                configuredAt: null,
              },
            },
          },
        },
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act
      await deleteChannelSession('C_COMPLEX');

      // Assert: All sessions removed
      expect(sessionStore.channels['C_COMPLEX']).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it('does not affect fork-to-channel target sessions', async () => {
      // Setup: Source channel and forked channel (separate entries)
      sessionStore = {
        channels: {
          C_SOURCE: {
            threadId: 'thread-source',
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
          C_FORKED: {
            threadId: 'thread-forked-copy',
            forkedFrom: 'thread-source',
            forkedAtTurnIndex: 3,
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1500,
            lastActiveAt: 2500,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act: Delete source channel
      await deleteChannelSession('C_SOURCE');

      // Assert: Source is gone, but forked channel is untouched
      expect(sessionStore.channels['C_SOURCE']).toBeUndefined();
      expect(sessionStore.channels['C_FORKED']).toBeDefined();
      expect((sessionStore.channels['C_FORKED'] as { threadId: string }).threadId).toBe('thread-forked-copy');
      consoleSpy.mockRestore();
    });

    it('handles non-existent channel gracefully', async () => {
      // Setup: Empty store
      sessionStore = { channels: {} };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act: Should not throw
      await expect(deleteChannelSession('C_NONEXISTENT')).resolves.not.toThrow();

      // Assert: Store unchanged, logged appropriately
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('No session found')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('error resilience', () => {
    it('logs errors but does not crash on deletion failure', async () => {
      // Setup
      sessionStore = {
        channels: {
          C123: {
            threadId: 'thread-abc',
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      // Make writeFileSync throw an error
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act & Assert: Should throw (mutex doesn't swallow errors)
      // But the event handler in slack-bot.ts catches this
      await expect(deleteChannelSession('C123')).rejects.toThrow('Permission denied');

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('session isolation', () => {
    it('only deletes the specified channel, preserves others', async () => {
      // Setup: Multiple channels
      sessionStore = {
        channels: {
          C_DELETE_ME: {
            threadId: 'thread-delete',
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
          C_KEEP_ME_1: {
            threadId: 'thread-keep-1',
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
          C_KEEP_ME_2: {
            threadId: 'thread-keep-2',
            workingDir: '/test',
            approvalPolicy: 'never',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act
      await deleteChannelSession('C_DELETE_ME');

      // Assert
      expect(sessionStore.channels['C_DELETE_ME']).toBeUndefined();
      expect(sessionStore.channels['C_KEEP_ME_1']).toBeDefined();
      expect(sessionStore.channels['C_KEEP_ME_2']).toBeDefined();
      expect(Object.keys(sessionStore.channels)).toHaveLength(2);
      consoleSpy.mockRestore();
    });
  });

  describe('Codex thread orphaning', () => {
    it('logs all orphaned Codex thread IDs for auditing', async () => {
      // Setup: Channel with multiple threads that will be orphaned
      sessionStore = {
        channels: {
          C_AUDIT: {
            threadId: 'codex-main',
            previousThreadIds: ['codex-old-1', 'codex-old-2'],
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
            threads: {
              '111.222': {
                threadId: 'codex-fork-1',
                forkedFrom: 'codex-main',
                workingDir: '/test',
                approvalPolicy: 'on-request',
                createdAt: 1000,
                lastActiveAt: 2000,
                pathConfigured: false,
                configuredPath: null,
                configuredBy: null,
                configuredAt: null,
              },
            },
          },
        },
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act
      await deleteChannelSession('C_AUDIT');

      // Assert: All Codex thread IDs were logged
      const allLogs = consoleSpy.mock.calls.map(call => call[0]).join(' ');
      expect(allLogs).toContain('codex-main');
      expect(allLogs).toContain('codex-old-1');
      expect(allLogs).toContain('codex-old-2');
      expect(allLogs).toContain('codex-fork-1');
      expect(allLogs).toContain('orphaned');

      consoleSpy.mockRestore();
    });

    it('explains that orphaned threads can be resumed', async () => {
      sessionStore = {
        channels: {
          C_RESUME: {
            threadId: 'codex-recoverable',
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Act
      await deleteChannelSession('C_RESUME');

      // Assert: Message indicates threads can be resumed
      const allLogs = consoleSpy.mock.calls.map(call => call[0]).join(' ');
      expect(allLogs).toContain('/resume');

      consoleSpy.mockRestore();
    });
  });
});
