/**
 * Integration tests for path navigation flow.
 * Tests the fresh session workflow: /ls, /cd, /set-current-path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  handleLsCommand,
  handleCdCommand,
  handleSetCurrentPathCommand,
  handleCwdCommand,
  type CommandContext,
} from '../../commands.js';
import {
  getSession,
  getThreadSession,
  saveSession,
  saveThreadSession,
} from '../../session-manager.js';

// Mock fs for session persistence
vi.mock('fs');

describe('Path Navigation Flow Integration', () => {
  const mockFs = vi.mocked(fs);
  const baseContext: CommandContext = {
    channelId: 'C123',
    threadTs: undefined,
    userId: 'U123',
    text: '',
  };

  // Shared session store for simulating persistence
  let sessionStore: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Initialize session store with fresh session (pathConfigured: false)
    sessionStore = {
      channels: {
        C123: {
          threadId: null,
          workingDir: '/Users/test/projects',
          approvalPolicy: 'never',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: false,
          configuredPath: null,
          configuredBy: null,
          configuredAt: null,
          threads: {},
        },
      },
    };

    // Mock session file operations
    mockFs.existsSync.mockImplementation((p: any) => {
      if (p === './sessions.json') return true;
      // Simulate real filesystem for path validation
      if (p === '/Users/test/projects') return true;
      if (p === '/Users/test/projects/subdir') return true;
      if (p === '/nonexistent') return false;
      if (p === '/Users/test/file.txt') return true;
      return false;
    });

    mockFs.readFileSync.mockImplementation((p: any) => {
      if (p === './sessions.json') return JSON.stringify(sessionStore);
      throw new Error('File not found');
    });

    mockFs.writeFileSync.mockImplementation((p: any, data: any) => {
      if (p === './sessions.json') {
        sessionStore = JSON.parse(data as string);
      }
    });

    mockFs.statSync.mockImplementation((p: any) => {
      if (p === '/Users/test/projects' || p === '/Users/test/projects/subdir') {
        return { isDirectory: () => true } as fs.Stats;
      }
      if (p === '/Users/test/file.txt') {
        return { isDirectory: () => false } as fs.Stats;
      }
      throw new Error('ENOENT');
    });

    mockFs.readdirSync.mockImplementation((p: any) => {
      if (p === '/Users/test/projects') {
        return ['file1.ts', 'file2.ts', 'subdir'] as any;
      }
      if (p === '/Users/test/projects/subdir') {
        return ['nested.ts'] as any;
      }
      throw new Error('ENOENT');
    });

    mockFs.accessSync.mockImplementation(() => {});

    mockFs.realpathSync.mockImplementation((p: any) => p as string);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('/ls Command', () => {
    it('lists files in current working directory', async () => {
      const result = await handleLsCommand({ ...baseContext, text: '' });

      expect(result.text).toContain('/Users/test/projects');
      expect(result.text).toContain('3 total');
      expect(JSON.stringify(result.blocks)).toContain('file1.ts');
      expect(JSON.stringify(result.blocks)).toContain('subdir');
    });

    it('shows navigation hints when path not locked', async () => {
      const result = await handleLsCommand({ ...baseContext, text: '' });

      expect(JSON.stringify(result.blocks)).toContain('/cd');
      expect(JSON.stringify(result.blocks)).toContain('/set-current-path');
    });

    it('shows locked hint when path is locked', async () => {
      // Lock the path first
      sessionStore.channels.C123.pathConfigured = true;
      sessionStore.channels.C123.configuredPath = '/Users/test/projects';

      const result = await handleLsCommand({ ...baseContext, text: '' });

      expect(JSON.stringify(result.blocks)).toContain('locked');
      expect(JSON.stringify(result.blocks)).toContain('/Users/test/projects');
    });

    it('lists files in specified path', async () => {
      const result = await handleLsCommand({ ...baseContext, text: '/Users/test/projects/subdir' });

      expect(result.text).toContain('subdir');
      expect(JSON.stringify(result.blocks)).toContain('nested.ts');
    });

    it('returns error for nonexistent path', async () => {
      const result = await handleLsCommand({ ...baseContext, text: '/nonexistent' });

      expect(result.text).toContain('does not exist');
    });

    it('returns error for file path (not directory)', async () => {
      const result = await handleLsCommand({ ...baseContext, text: '/Users/test/file.txt' });

      expect(result.text).toContain('Not a directory');
    });
  });

  describe('/cd Command', () => {
    it('changes working directory when path not locked', async () => {
      const result = await handleCdCommand({ ...baseContext, text: '/Users/test/projects/subdir' });

      expect(result.text).toContain('/Users/test/projects/subdir');
      expect(JSON.stringify(result.blocks)).toContain('/set-current-path');

      // Verify session was updated
      expect(sessionStore.channels.C123.workingDir).toBe('/Users/test/projects/subdir');
    });

    it('shows current directory when no path provided', async () => {
      const result = await handleCdCommand({ ...baseContext, text: '' });

      expect(result.text).toContain('/Users/test/projects');
      expect(JSON.stringify(result.blocks)).toContain('/cd <path>');
    });

    it('returns error when path is locked', async () => {
      // Lock the path
      sessionStore.channels.C123.pathConfigured = true;
      sessionStore.channels.C123.configuredPath = '/Users/test/projects';

      const result = await handleCdCommand({ ...baseContext, text: '/Users/test/projects/subdir' });

      expect(result.text).toContain('disabled');
      expect(result.text).toContain('locked');
    });

    it('returns error for nonexistent path', async () => {
      const result = await handleCdCommand({ ...baseContext, text: '/nonexistent' });

      expect(result.text).toContain('does not exist');
    });

    it('returns error for file path (not directory)', async () => {
      const result = await handleCdCommand({ ...baseContext, text: '/Users/test/file.txt' });

      expect(result.text).toContain('Not a directory');
    });

    it('handles relative paths', async () => {
      const result = await handleCdCommand({ ...baseContext, text: 'subdir' });

      expect(result.text).toContain('/Users/test/projects/subdir');
    });
  });

  describe('/set-current-path Command', () => {
    it('locks current working directory', async () => {
      const result = await handleSetCurrentPathCommand(baseContext);

      expect(result.text).toContain('locked');
      expect(result.text).toContain('/Users/test/projects');
      expect(JSON.stringify(result.blocks)).toContain('/cd');
      expect(JSON.stringify(result.blocks)).toContain('disabled');

      // Verify session was updated
      expect(sessionStore.channels.C123.pathConfigured).toBe(true);
      expect(sessionStore.channels.C123.configuredPath).toBe('/Users/test/projects');
      expect(sessionStore.channels.C123.configuredBy).toBe('U123');
      expect(sessionStore.channels.C123.configuredAt).toBeGreaterThan(0);
    });

    it('returns error when path already locked', async () => {
      // Lock the path first
      sessionStore.channels.C123.pathConfigured = true;
      sessionStore.channels.C123.configuredPath = '/Users/test/projects';

      const result = await handleSetCurrentPathCommand(baseContext);

      expect(result.text).toContain('already locked');
    });
  });

  describe('Full Fresh Session Workflow', () => {
    it('simulates complete path navigation and locking flow', async () => {
      // Step 1: User runs /ls to explore
      const lsResult1 = await handleLsCommand({ ...baseContext, text: '' });
      expect(JSON.stringify(lsResult1.blocks)).toContain('file1.ts');
      expect(JSON.stringify(lsResult1.blocks)).toContain('/cd');

      // Step 2: User runs /cd to navigate
      const cdResult = await handleCdCommand({ ...baseContext, text: 'subdir' });
      expect(cdResult.text).toContain('subdir');

      // Step 3: User runs /ls again to confirm
      // Update mock to use new working directory
      sessionStore.channels.C123.workingDir = '/Users/test/projects/subdir';
      const lsResult2 = await handleLsCommand({ ...baseContext, text: '' });
      expect(JSON.stringify(lsResult2.blocks)).toContain('nested.ts');

      // Step 4: User runs /set-current-path to lock
      const lockResult = await handleSetCurrentPathCommand(baseContext);
      expect(lockResult.text).toContain('locked');

      // Step 5: Verify /cd is now disabled
      const cdAfterLock = await handleCdCommand({ ...baseContext, text: '/Users/test/projects' });
      expect(cdAfterLock.text).toContain('disabled');

      // Step 6: Verify /ls still works
      const lsAfterLock = await handleLsCommand({ ...baseContext, text: '' });
      expect(JSON.stringify(lsAfterLock.blocks)).toContain('locked');
    });
  });

  describe('Thread Session Handling', () => {
    it('saves path config to thread session when in thread', async () => {
      const threadContext: CommandContext = {
        ...baseContext,
        threadTs: '1234567890.000001',
      };

      // Initialize thread in session store
      sessionStore.channels.C123.threads = {
        '1234567890.000001': {
          threadId: null,
          forkedFrom: null,
          workingDir: '/Users/test/projects',
          approvalPolicy: 'never',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          pathConfigured: false,
          configuredPath: null,
          configuredBy: null,
          configuredAt: null,
        },
      };

      const result = await handleSetCurrentPathCommand(threadContext);

      expect(result.text).toContain('locked');
      expect(sessionStore.channels.C123.threads['1234567890.000001'].pathConfigured).toBe(true);
      expect(sessionStore.channels.C123.threads['1234567890.000001'].configuredPath).toBe('/Users/test/projects');
    });

    it('reads path config from channel session when in thread', async () => {
      const threadContext: CommandContext = {
        ...baseContext,
        threadTs: '1234567890.000001',
      };

      // Channel has path already locked (authoritative source)
      sessionStore.channels.C123.pathConfigured = true;
      sessionStore.channels.C123.configuredPath = '/Users/test/projects/subdir';
      sessionStore.channels.C123.workingDir = '/Users/test/projects/subdir';

      const result = await handleCdCommand({ ...threadContext, text: '/Users/test/projects' });

      expect(result.text).toContain('disabled');
      expect(result.text).toContain('locked');
    });

    it('/cd then /set-current-path in same thread locks correct path (regression test)', async () => {
      const threadContext: CommandContext = {
        ...baseContext,
        threadTs: '1234567890.000001',
      };

      // User runs /cd to navigate to a different directory
      const cdResult = await handleCdCommand({ ...threadContext, text: '/Users/test/projects/subdir' });
      expect(cdResult.text).toContain('/Users/test/projects/subdir');

      // User runs /set-current-path in the same thread
      // This should lock /Users/test/projects/subdir, NOT process.cwd()
      const lockResult = await handleSetCurrentPathCommand(threadContext);

      expect(lockResult.text).toContain('locked');
      expect(lockResult.text).toContain('/Users/test/projects/subdir');
      // Verify channel session has correct path
      expect(sessionStore.channels.C123.pathConfigured).toBe(true);
      expect(sessionStore.channels.C123.configuredPath).toBe('/Users/test/projects/subdir');
    });
  });

  describe('/cwd Command Interaction', () => {
    it('/cwd still works for immediate lock (legacy behavior)', async () => {
      const result = await handleCwdCommand({ ...baseContext, text: '/Users/test/projects/subdir' });

      expect(result.text).toContain('set to');
      expect(sessionStore.channels.C123.pathConfigured).toBe(true);
      expect(sessionStore.channels.C123.configuredPath).toBe('/Users/test/projects/subdir');
    });

    it('/cwd shows current directory when no args', async () => {
      const result = await handleCwdCommand({ ...baseContext, text: '' });

      expect(result.text).toContain('/Users/test/projects');
    });
  });
});
