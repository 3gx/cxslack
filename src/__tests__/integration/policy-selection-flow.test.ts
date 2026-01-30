/**
 * Integration tests for policy selection persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { saveApprovalPolicy } from '../../session-manager.js';

vi.mock('fs');

describe('Policy Selection Flow', () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists policy to both channel and thread sessions', async () => {
    const channelId = 'C_POLICY';
    const threadTs = '1234567890.000001';

    let sessionStore = {
      channels: {
        [channelId]: {
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
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => JSON.stringify(sessionStore));
    mockFs.writeFileSync.mockImplementation((_, data) => {
      sessionStore = JSON.parse(data as string);
    });

    await saveApprovalPolicy(channelId, threadTs, 'never');

    expect(sessionStore.channels[channelId].approvalPolicy).toBe('never');
    expect(sessionStore.channels[channelId].threads[threadTs].approvalPolicy).toBe('never');
  });
});
