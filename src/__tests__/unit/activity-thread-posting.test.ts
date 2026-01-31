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
  ActivityEntry,
} from '../../activity-thread.js';
import { formatThreadActivityEntry } from '../../blocks.js';

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
      getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: 'https://slack.com/archives/C123/p123456' }),
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

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '456.789',
        text: expect.stringContaining('Read'),
      })
    );
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
    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', { force: true });

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
    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', { force: true });

    // Should have been called (update or post)
    expect(
      mockClient.chat.postMessage.mock.calls.length + mockClient.chat.update.mock.calls.length
    ).toBeGreaterThanOrEqual(1);
  });

  it('updates tool_start message in-place when tool_complete arrives', async () => {
    const key = 'C123:inplace';
    const toolUseId = 'tool-update-test';

    // Mock postMessage to return consistent ts
    mockClient.chat.postMessage.mockResolvedValue({ ts: 'tool-msg-ts-123' });

    // Add tool_start entry
    manager.addEntry(key, {
      type: 'tool_start',
      timestamp: Date.now(),
      tool: 'Grep',
      toolInput: 'search pattern',
      toolUseId,
    });

    // Flush to post tool_start (should post new message)
    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', { force: true });

    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('[in progress]'),
      })
    );

    // Reset mocks
    mockClient.chat.postMessage.mockClear();
    mockClient.chat.update.mockClear();

    // Add tool_complete entry for same toolUseId
    manager.addEntry(key, {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Grep',
      toolInput: 'search pattern',
      toolUseId,
      durationMs: 1500,
      matchCount: 42,
    });

    // Flush again - should UPDATE existing message, not post new
    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', { force: true });

    // Should NOT have posted new message
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();

    // Should have UPDATED the existing message
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: 'tool-msg-ts-123', // Same ts as the original tool_start message
        text: expect.stringContaining('Grep'), // Tool name in completion
      })
    );
    // Should NOT have "[in progress]" in the updated text
    const updateCall = mockClient.chat.update.mock.calls[0][0];
    expect(updateCall.text).not.toContain('[in progress]');
  });

  it('posts new message for tool_complete if tool_start was not tracked', async () => {
    const key = 'C123:nostart';
    const toolUseId = 'tool-no-start';

    // Add tool_complete without prior tool_start (edge case)
    manager.addEntry(key, {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Read',
      toolInput: 'file.txt',
      toolUseId,
      durationMs: 500,
    });

    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', { force: true });

    // Should post new message since there's no existing ts to update
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('skips tool_start if tool_complete exists in entries (race condition fix)', async () => {
    const key = 'C123:race';
    const toolUseId = 'tool-race-test';

    // Simulate race condition: both tool_start and tool_complete added before flush
    manager.addEntry(key, {
      type: 'tool_start',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: 'npm test',
      toolUseId,
    });

    manager.addEntry(key, {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: 'npm test',
      toolUseId,
      durationMs: 1000,
      toolOutputPreview: 'All tests passed',
    });

    // Flush both at once (simulating race condition where both are pending)
    await flushActivityBatchToThread(manager, key, mockClient, 'C123', '456.789', { force: true });

    // Should post only ONE message (the tool_complete), not both
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

    // The posted message should be the completed one, not in-progress
    const postCall = mockClient.chat.postMessage.mock.calls[0][0];
    expect(postCall.text).not.toContain('[in progress]');
    expect(postCall.text).toContain('Bash');
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

// ============================================================================
// Live Activity formatEntry Tests
// ============================================================================

describe('Live Activity formatEntry', () => {
  it('shows arrow with output preview for completed Bash', () => {
    const manager = new ActivityThreadManager();
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'npm run build 2>&1' },
      toolOutputPreview: '> cxslack@1.0.0 build > tsc',
      durationMs: 1400,
    };

    const result = (manager as any).formatEntry(entry);

    expect(result).toContain(':computer:'); // Tool emoji, not checkmark
    expect(result).not.toContain(':white_check_mark:');
    expect(result).toContain(':computer: Bash');
    expect(result).toContain('`npm run build 2>&1`');
    expect(result).toContain('→');
    // Output is escaped for mrkdwn safety (< and > are escaped)
    expect(result).toContain('\\> cxslack@1.0.0 build \\> tsc');
    expect(result).toContain('[1.4s]');
  });

  it('truncates output preview to 50 chars', () => {
    const manager = new ActivityThreadManager();
    const longOutput = 'a'.repeat(100);
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'ls' },
      toolOutputPreview: longOutput,
      durationMs: 500,
    };

    const result = (manager as any).formatEntry(entry);

    expect(result).toContain('→');
    expect(result).toContain('a'.repeat(50));
    expect(result).toContain('...');
    expect(result).not.toContain('a'.repeat(51));
  });

  it('shows warning flag for errors', () => {
    const manager = new ActivityThreadManager();
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'invalid-command' },
      toolIsError: true,
      toolErrorMessage: 'Command not found',
      durationMs: 100,
    };

    const result = (manager as any).formatEntry(entry);

    expect(result).toContain(':warning:');
    expect(result).not.toContain('→'); // No output preview for errors
  });

  it('uses clean input summary not raw JSON', () => {
    const manager = new ActivityThreadManager();
    const entry: ActivityEntry = {
      type: 'tool_start',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'npm test', timeout: 60000, description: 'run tests' },
    };

    const result = (manager as any).formatEntry(entry);

    expect(result).toContain('`npm test`');
    expect(result).not.toContain('timeout');
    expect(result).not.toContain('60000');
    expect(result).not.toContain('{');
  });

  it('escapes mrkdwn special chars in output preview', () => {
    const manager = new ActivityThreadManager();
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'echo test' },
      toolOutputPreview: 'error: `unexpected` *token* in <file>',
      durationMs: 100,
    };

    const result = (manager as any).formatEntry(entry);

    // Special chars should be escaped
    expect(result).toContain('\\`unexpected\\`');
    expect(result).toContain('\\*token\\*');
    expect(result).toContain('\\<file\\>');
    // Should still have the arrow
    expect(result).toContain('→');
  });
});

// ============================================================================
// Thread Activity formatThreadActivityEntry Tests
// ============================================================================

describe('Thread Activity formatThreadActivityEntry', () => {
  it('uses tool emoji for completed', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Edit',
      toolInput: { file_path: 'src/blocks.ts' },
      linesAdded: 85,
      linesRemoved: 54,
      durationMs: 0,
    };

    const result = formatThreadActivityEntry(entry);

    expect(result).toContain(':memo:'); // Edit emoji
    expect(result).not.toContain(':white_check_mark:');
    expect(result).toContain('• Changed: +85/-54 lines');
  });

  it('does not have arrow in header', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'npm test' },
      toolOutputPreview: 'All tests passed',
      durationMs: 5000,
    };

    const result = formatThreadActivityEntry(entry);
    const lines = result.split('\n');

    // Header line should NOT have arrow
    expect(lines[0]).not.toContain('→');
    // Output should be in bullet detail
    expect(result).toContain('• Output:');
  });

  it('formats Read with line count', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Read',
      toolInput: { file_path: 'src/activity-thread.ts' },
      lineCount: 338,
      toolOutputPreview: '1→/** 2→ * Unit tests',
      durationMs: 0,
    };

    const result = formatThreadActivityEntry(entry);

    expect(result).toContain(':mag:'); // Read emoji
    expect(result).toContain('`src/activity-thread.ts`');
    expect(result).toContain('• Read: 338 lines');
    expect(result).toContain('• Output:');
  });

  it('adds attachment suffix for truncated thinking with link', () => {
    const entry: ActivityEntry = {
      type: 'thinking',
      timestamp: Date.now(),
      thinkingInProgress: false,
      thinkingContent: '...tail...',
      thinkingTruncated: true,
      thinkingAttachmentLink: 'https://example.com/file',
      charCount: 4000,
    };

    const result = formatThreadActivityEntry(entry);
    expect(result).toContain('_Full response <https://example.com/file|attached>._');
  });

  it('adds generic attachment suffix for truncated thinking without link', () => {
    const entry: ActivityEntry = {
      type: 'thinking',
      timestamp: Date.now(),
      thinkingInProgress: false,
      thinkingContent: '...tail...',
      thinkingTruncated: true,
      charCount: 4000,
    };

    const result = formatThreadActivityEntry(entry);
    expect(result).toContain('_Full content attached._');
  });
});

// ============================================================================
// Integration: Live vs Thread Format Consistency
// ============================================================================

describe('Live vs Thread Activity Format Consistency', () => {
  it('live activity and thread activity have consistent but different formats', () => {
    const manager = new ActivityThreadManager();
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'npm run build' },
      toolOutputPreview: '> cxslack@1.0.0 build > tsc',
      durationMs: 1400,
    };

    const liveFormat = (manager as any).formatEntry(entry);
    const threadFormat = formatThreadActivityEntry(entry);

    // Live: compact with arrow and duration in header
    expect(liveFormat).toMatch(/→.*\[1\.4s\]/);
    expect(liveFormat.split('\n').length).toBe(1); // Single line

    // Thread: detailed with bullets
    expect(threadFormat).toContain('• Command:');
    expect(threadFormat).toContain('• Output:');
    expect(threadFormat).toContain('• Duration:');
    expect(threadFormat.split('\n').length).toBeGreaterThan(1); // Multi-line
  });
});
