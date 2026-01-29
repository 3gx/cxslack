/**
 * Integration-ish test covering command routing for /resume.
 * Ensures the router dispatches to handleResumeCommand and persists session updates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodexClient } from '../../codex-client.js';
import { handleCommand, type CommandContext } from '../../commands.js';

vi.mock('../../session-manager.js', () => {
  const saveSession = vi.fn();
  const saveThreadSession = vi.fn();

  return {
    getSession: vi.fn(() => null),
    getThreadSession: vi.fn(() => null),
    saveSession,
    saveThreadSession,
    clearSession: vi.fn(),
    getEffectiveApprovalPolicy: vi.fn(() => 'on-request'),
    getEffectiveWorkingDir: vi.fn(() => '/tmp'),
    APPROVAL_POLICIES: ['never', 'on-request', 'on-failure', 'untrusted'],
  };
});

describe('/resume command routing', () => {
  const baseContext: CommandContext = {
    channelId: 'C123',
    threadTs: '123.456',
    userId: 'U123',
    text: '',
  };

  let codex: CodexClient;

  beforeEach(() => {
    vi.clearAllMocks();
    codex = {
      resumeThread: vi.fn().mockResolvedValue({
        id: 'thread-xyz',
        workingDirectory: '/project',
        createdAt: new Date().toISOString(),
      }),
    } as unknown as CodexClient;
  });

  it('dispatches /resume to resumeThread and saves session', async () => {
    const result = await handleCommand(
      { ...baseContext, text: '/resume thread-xyz' },
      codex
    );

    expect(result).not.toBeNull();
    expect(codex.resumeThread).toHaveBeenCalledWith('thread-xyz');

    const { saveSession, saveThreadSession } = await import('../../session-manager.js');
    expect(saveSession as unknown as vi.Mock).toHaveBeenCalled();
    expect(saveThreadSession as unknown as vi.Mock).toHaveBeenCalled();

    const channelArgs = (saveSession as unknown as vi.Mock).mock.calls[0][1];
    expect(channelArgs.threadId).toBe('thread-xyz');
    expect(channelArgs.configuredPath).toBe('/project');
  });
});
