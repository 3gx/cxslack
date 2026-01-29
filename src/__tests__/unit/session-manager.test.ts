/**
 * Unit tests for session manager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import {
  loadSessions,
  saveSessions,
  getSession,
  saveSession,
  getThreadSession,
  saveThreadSession,
  clearSession,
  getEffectiveWorkingDir,
  getEffectiveApprovalPolicy,
  getEffectiveThreadId,
  DEFAULT_APPROVAL_POLICY,
} from '../../session-manager.js';

// Mock fs module
vi.mock('fs');

describe('Session Manager', () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadSessions', () => {
    it('returns empty store when file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const store = loadSessions();
      expect(store).toEqual({ channels: {} });
    });

    it('loads and parses valid sessions file', () => {
      const mockData = {
        channels: {
          C123: {
            threadId: 'thread-123',
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

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockData));

      const store = loadSessions();
      expect(store).toEqual(mockData);
    });

    it('returns empty store on parse error', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const store = loadSessions();
      expect(store).toEqual({ channels: {} });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('returns empty store on invalid structure', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ invalid: true }));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const store = loadSessions();
      expect(store).toEqual({ channels: {} });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('saveSessions', () => {
    it('writes formatted JSON to file', () => {
      const store = {
        channels: {
          C123: {
            threadId: 'thread-123',
            workingDir: '/test',
            approvalPolicy: 'on-request' as const,
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
          },
        },
      };

      saveSessions(store);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        './sessions.json',
        JSON.stringify(store, null, 2)
      );
    });
  });

  describe('getSession', () => {
    it('returns null when channel not found', () => {
      mockFs.existsSync.mockReturnValue(false);

      const session = getSession('C999');
      expect(session).toBeNull();
    });

    it('returns session when found', () => {
      const mockSession = {
        threadId: 'thread-123',
        workingDir: '/test',
        approvalPolicy: 'on-request',
        createdAt: 1000,
        lastActiveAt: 2000,
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ channels: { C123: mockSession } })
      );

      const session = getSession('C123');
      expect(session).toEqual(mockSession);
    });
  });

  describe('saveSession', () => {
    it('creates new session with defaults', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockImplementation(() => {});

      await saveSession('C123', { threadId: 'thread-123' });

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      );

      expect(writtenData.channels.C123.threadId).toBe('thread-123');
      expect(writtenData.channels.C123.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY);
    });

    it('preserves existing session data on update', async () => {
      const existingSession = {
        threadId: 'thread-123',
        workingDir: '/original',
        approvalPolicy: 'never',
        model: 'test-model',
        createdAt: 1000,
        lastActiveAt: 1500,
        pathConfigured: true,
        configuredPath: '/configured',
        configuredBy: 'U123',
        configuredAt: 1200,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ channels: { C123: existingSession } })
      );
      mockFs.writeFileSync.mockImplementation(() => {});

      await saveSession('C123', { workingDir: '/updated' });

      const writtenData = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      );

      expect(writtenData.channels.C123.workingDir).toBe('/updated');
      expect(writtenData.channels.C123.model).toBe('test-model');
      expect(writtenData.channels.C123.configuredPath).toBe('/configured');
    });
  });

  describe('getEffectiveWorkingDir', () => {
    it('returns configured path if set', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              workingDir: '/default',
              configuredPath: '/configured',
              pathConfigured: true,
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              configuredBy: null,
              configuredAt: null,
            },
          },
        })
      );

      const dir = getEffectiveWorkingDir('C123');
      expect(dir).toBe('/configured');
    });

    it('returns workingDir if no configured path', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              workingDir: '/default',
              configuredPath: null,
              pathConfigured: false,
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              configuredBy: null,
              configuredAt: null,
            },
          },
        })
      );

      const dir = getEffectiveWorkingDir('C123');
      expect(dir).toBe('/default');
    });

    it('returns env default for unknown channel', () => {
      mockFs.existsSync.mockReturnValue(false);
      process.env.DEFAULT_WORKING_DIR = '/env-default';

      const dir = getEffectiveWorkingDir('C999');
      expect(dir).toBe('/env-default');

      delete process.env.DEFAULT_WORKING_DIR;
    });
  });

  describe('getEffectiveApprovalPolicy', () => {
    it('returns channel policy', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              approvalPolicy: 'never',
              threadId: null,
              workingDir: '/test',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
            },
          },
        })
      );

      const policy = getEffectiveApprovalPolicy('C123');
      expect(policy).toBe('never');
    });

    it('returns default for unknown channel', () => {
      mockFs.existsSync.mockReturnValue(false);

      const policy = getEffectiveApprovalPolicy('C999');
      expect(policy).toBe(DEFAULT_APPROVAL_POLICY);
    });

    it('returns thread policy when threadTs provided', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              approvalPolicy: 'never',
              threadId: null,
              workingDir: '/test',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {
                '123.456': {
                  approvalPolicy: 'untrusted',
                  threadId: null,
                  forkedFrom: null,
                  workingDir: '/test',
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
        })
      );

      const policy = getEffectiveApprovalPolicy('C123', '123.456');
      expect(policy).toBe('untrusted');
    });
  });

  describe('Thread Session Model Persistence', () => {
    it('saves model to thread session', async () => {
      // Initial state with channel but no thread session
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: null,
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {},
            },
          },
        })
      );
      mockFs.writeFileSync.mockImplementation(() => {});

      await saveThreadSession('C123', '1234.5678', { model: 'gpt-5.2-codex' });

      const writtenData = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      );

      expect(writtenData.channels.C123.threads['1234.5678'].model).toBe('gpt-5.2-codex');
    });

    it('retrieves model from thread session', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: null,
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {
                '1234.5678': {
                  threadId: 'codex-thread-id',
                  forkedFrom: null,
                  workingDir: '/test',
                  approvalPolicy: 'on-request',
                  model: 'gpt-5.2-codex',
                  reasoningEffort: 'high',
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
        })
      );

      const session = getThreadSession('C123', '1234.5678');
      expect(session?.model).toBe('gpt-5.2-codex');
      expect(session?.reasoningEffort).toBe('high');
    });

    it('preserves model when updating other thread session fields', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: null,
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {
                '1234.5678': {
                  threadId: 'codex-thread-id',
                  forkedFrom: null,
                  workingDir: '/test',
                  approvalPolicy: 'on-request',
                  model: 'gpt-5.2-codex',
                  reasoningEffort: 'high',
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
        })
      );
      mockFs.writeFileSync.mockImplementation(() => {});

      // Update only lastActiveAt, model should be preserved
      await saveThreadSession('C123', '1234.5678', { lastActiveAt: 3000 });

      const writtenData = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      );

      expect(writtenData.channels.C123.threads['1234.5678'].model).toBe('gpt-5.2-codex');
      expect(writtenData.channels.C123.threads['1234.5678'].reasoningEffort).toBe('high');
      expect(writtenData.channels.C123.threads['1234.5678'].lastActiveAt).toBe(3000);
    });

    it('thread session inherits model from channel session when not set', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: null,
              workingDir: '/test',
              approvalPolicy: 'on-request',
              model: 'channel-model',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {},
            },
          },
        })
      );
      mockFs.writeFileSync.mockImplementation(() => {});

      // Create new thread session without specifying model
      await saveThreadSession('C123', '1234.5678', { threadId: 'codex-thread-id' });

      const writtenData = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      );

      // Should inherit model from channel
      expect(writtenData.channels.C123.threads['1234.5678'].model).toBe('channel-model');
    });

    it('returns null for non-existent thread session', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: null,
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {},
            },
          },
        })
      );

      const session = getThreadSession('C123', 'nonexistent.thread');
      expect(session).toBeNull();
    });
  });

  describe('getEffectiveThreadId - Channel Fallback', () => {
    it('falls back to channel session when thread session has no threadId', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: 'channel-codex-thread',
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {
                '1111.0000': {
                  threadId: null, // Thread exists but has no threadId
                  forkedFrom: null,
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
        })
      );

      // Should fallback to channel threadId
      const threadId = getEffectiveThreadId('C123', '1111.0000');
      expect(threadId).toBe('channel-codex-thread');
    });

    it('falls back to channel session when thread session does not exist', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: 'channel-codex-thread',
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {},
            },
          },
        })
      );

      // Thread session doesn't exist at all, should fallback to channel
      const threadId = getEffectiveThreadId('C123', '2222.0000');
      expect(threadId).toBe('channel-codex-thread');
    });

    it('uses thread session threadId when available', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: 'channel-codex-thread',
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {
                '1111.0000': {
                  threadId: 'thread-specific-codex-thread',
                  forkedFrom: null,
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
        })
      );

      // Should use thread-specific threadId
      const threadId = getEffectiveThreadId('C123', '1111.0000');
      expect(threadId).toBe('thread-specific-codex-thread');
    });

    it('allows multiple main channel mentions to share same Codex thread', () => {
      // This tests the main channel session persistence fix:
      // First @bot from main channel saves threadId to channel session
      // Second @bot from main channel (different ts) finds it via fallback
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: 'shared-codex-thread', // Saved by first @bot
              workingDir: '/test',
              approvalPolicy: 'on-request',
              createdAt: 1000,
              lastActiveAt: 2000,
              pathConfigured: false,
              configuredPath: null,
              configuredBy: null,
              configuredAt: null,
              threads: {
                '1111.0000': {
                  // First @bot created this thread session
                  threadId: 'shared-codex-thread',
                  forkedFrom: null,
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
        })
      );

      // Second @bot has different ts, but should find the same Codex thread via fallback
      const threadId = getEffectiveThreadId('C123', '2222.0000');
      expect(threadId).toBe('shared-codex-thread');
    });
  });

  describe('clearSession', () => {
    it('moves threadId to previousThreadIds', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          channels: {
            C123: {
              threadId: 'thread-123',
              previousThreadIds: ['thread-100'],
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
        })
      );
      mockFs.writeFileSync.mockImplementation(() => {});

      await clearSession('C123');

      const writtenData = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      );

      expect(writtenData.channels.C123.threadId).toBeNull();
      expect(writtenData.channels.C123.previousThreadIds).toContain('thread-123');
      expect(writtenData.channels.C123.previousThreadIds).toContain('thread-100');
    });
  });
});
