/**
 * Unit tests for activity thread posting functions.
 * Uses mocks for Slack client and markdownToPng.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postStartingToThread,
  flushActivityBatchToThread,
  postThinkingToThread,
  postResponseToThread,
  postErrorToThread,
  uploadMarkdownAndPngWithResponse,
  ActivityThreadManager,
  MESSAGE_SIZE_DEFAULT,
} from '../../activity-thread.js';

// Mock markdownToPng
vi.mock('../../markdown-png.js', () => ({
  markdownToPng: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
}));

// Mock withSlackRetry to just call the function
vi.mock('../../slack-retry.js', () => ({
  withSlackRetry: vi.fn((fn) => fn()),
}));

/**
 * Create a mock Slack WebClient.
 */
function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted-ts-123' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({
        files: [
          {
            id: 'F123',
            shares: {
              public: {
                C123: [{ ts: 'file-ts-456' }],
              },
            },
          },
        ],
      }),
      info: vi.fn().mockResolvedValue({
        file: {
          shares: {
            public: {
              C123: [{ ts: 'file-ts-789' }],
            },
          },
        },
      }),
    },
  } as any;
}

describe('postStartingToThread', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  it('posts starting message and returns ts', async () => {
    const ts = await postStartingToThread(mockClient, 'C123', '456.789');

    expect(ts).toBe('posted-ts-123');
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '456.789',
      text: expect.stringContaining('Analyzing'),
    });
  });

  it('returns null on error', async () => {
    mockClient.chat.postMessage.mockRejectedValue(new Error('Network error'));

    const ts = await postStartingToThread(mockClient, 'C123', '456.789');

    expect(ts).toBeNull();
  });
});

describe('flushActivityBatchToThread', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let manager: ActivityThreadManager;

  beforeEach(() => {
    mockClient = createMockClient();
    manager = new ActivityThreadManager();
    vi.clearAllMocks();
  });

  it('posts batched tool entries', async () => {
    const key = 'C123:456.789';
    manager.addEntry(key, {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Read',
      toolInput: 'file.ts',
      toolUseId: 'tool-1',
      durationMs: 1000,
    });

    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789');

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '456.789',
      text: expect.stringContaining('Read'),
    });
  });

  it('does nothing when batch empty', async () => {
    const key = 'C123:empty';
    // Don't add any entries

    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789');

    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    expect(mockClient.chat.update).not.toHaveBeenCalled();
  });

  it('force=true posts even when rate limited', async () => {
    const key = 'C123:456.789';
    manager.addEntry(key, {
      type: 'starting',
      timestamp: Date.now(),
    });

    // First call
    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', true);

    // Reset mock
    mockClient.chat.postMessage.mockClear();

    // Add another entry
    manager.addEntry(key, {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Edit',
      toolUseId: 'tool-2',
      durationMs: 500,
    });

    // Second call with force=true should still work even if rate limited
    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', true);

    // Should have been called (update or post)
    expect(
      mockClient.chat.postMessage.mock.calls.length + mockClient.chat.update.mock.calls.length
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('postThinkingToThread', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  it('posts short thinking inline', async () => {
    const content = 'This is a short thinking process';
    const ts = await postThinkingToThread(mockClient, 'C123', '456.789', content, 1000);

    expect(ts).toBe('posted-ts-123');
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '456.789',
      text: expect.stringContaining('Thinking'),
    });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '456.789',
      text: expect.stringContaining(content),
    });
  });

  it('uploads .md + .png for long thinking', async () => {
    const longContent = 'A'.repeat(4000);
    await postThinkingToThread(mockClient, 'C123', '456.789', longContent, 5000);

    // Should use files.uploadV2 for long content
    expect(mockClient.files.uploadV2).toHaveBeenCalled();
  });
});

describe('postResponseToThread', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  it('posts short response inline', async () => {
    const content = 'Here is the answer';
    const ts = await postResponseToThread(mockClient, 'C123', '456.789', content, 2000);

    expect(ts).toBe('posted-ts-123');
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '456.789',
      text: expect.stringContaining('Response'),
    });
  });

  it('uploads .md + .png for long response', async () => {
    const longContent = 'B'.repeat(4000);
    await postResponseToThread(mockClient, 'C123', '456.789', longContent, 10000);

    expect(mockClient.files.uploadV2).toHaveBeenCalled();
  });
});

describe('postErrorToThread', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  it('posts error message to thread', async () => {
    const ts = await postErrorToThread(mockClient, 'C123', '456.789', 'Something went wrong');

    expect(ts).toBe('posted-ts-123');
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '456.789',
      text: expect.stringContaining('Error'),
    });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '456.789',
      text: expect.stringContaining('Something went wrong'),
    });
  });

  it('returns null on error', async () => {
    mockClient.chat.postMessage.mockRejectedValue(new Error('API error'));

    const ts = await postErrorToThread(mockClient, 'C123', '456.789', 'Test error');

    expect(ts).toBeNull();
  });
});

describe('uploadMarkdownAndPngWithResponse', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  it('posts text only when under limit', async () => {
    const shortContent = 'Short content';
    const result = await uploadMarkdownAndPngWithResponse(
      mockClient,
      'C123',
      shortContent,
      shortContent,
      '456.789'
    );

    expect(result?.ts).toBe('posted-ts-123');
    expect(mockClient.chat.postMessage).toHaveBeenCalled();
    // Should NOT upload files for short content
    expect(mockClient.files.uploadV2).not.toHaveBeenCalled();
  });

  it('uploads .md + .png when over limit', async () => {
    const longContent = 'C'.repeat(5000);
    const result = await uploadMarkdownAndPngWithResponse(
      mockClient,
      'C123',
      longContent,
      longContent,
      '456.789'
    );

    expect(result).not.toBeNull();
    expect(mockClient.files.uploadV2).toHaveBeenCalled();
  });

  it('handles main channel vs thread paths', async () => {
    const longContent = 'D'.repeat(5000);

    // With threadTs (thread context)
    await uploadMarkdownAndPngWithResponse(mockClient, 'C123', longContent, longContent, '456.789');

    expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: '456.789',
      })
    );

    vi.clearAllMocks();

    // Without threadTs (main channel)
    await uploadMarkdownAndPngWithResponse(mockClient, 'C123', longContent, longContent);

    // Should post text first, then upload files as thread reply
    expect(mockClient.chat.postMessage).toHaveBeenCalled();
  });

  it('returns null on complete failure', async () => {
    mockClient.chat.postMessage.mockRejectedValue(new Error('Total failure'));
    mockClient.files.uploadV2.mockRejectedValue(new Error('Total failure'));

    const result = await uploadMarkdownAndPngWithResponse(
      mockClient,
      'C123',
      'content',
      'content',
      '456.789'
    );

    expect(result).toBeNull();
  });
});
