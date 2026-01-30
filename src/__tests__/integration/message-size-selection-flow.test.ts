/**
 * Integration tests for message size selection persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { saveThreadCharLimit } from '../../session-manager.js';

vi.mock('fs');

describe('Message Size Selection Flow', () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists message size to both channel and thread sessions', async () => {
    const channelId = 'C_MESSAGE_SIZE';
    const threadTs = '1234567890.000002';

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

    await saveThreadCharLimit(channelId, threadTs, 1200);

    expect(sessionStore.channels[channelId].threadCharLimit).toBe(1200);
    expect(sessionStore.channels[channelId].threads[threadTs].threadCharLimit).toBe(1200);
  });
});
