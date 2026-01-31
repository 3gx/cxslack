/**
 * Unit tests for activity thread manager.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ActivityThreadManager,
  ActivityEntry,
  SPINNER_FRAMES,
  getToolEmoji,
  buildActivityLogText,
} from '../../activity-thread.js';

describe('ActivityThreadManager', () => {
  describe('addEntry', () => {
    it('batches activity entries', () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      manager.addEntry(key, { type: 'starting', timestamp: Date.now() });
      manager.addEntry(key, { type: 'tool_start', timestamp: Date.now(), tool: 'Read' });

      const entries = manager.getEntries(key);
      expect(entries).toHaveLength(2);
    });

    it('creates separate batches for different conversations', () => {
      const manager = new ActivityThreadManager();

      manager.addEntry('conv-1', { type: 'starting', timestamp: Date.now() });
      manager.addEntry('conv-2', { type: 'starting', timestamp: Date.now() });

      expect(manager.getEntries('conv-1')).toHaveLength(1);
      expect(manager.getEntries('conv-2')).toHaveLength(1);
    });
  });

  describe('clearEntries', () => {
    it('clears entries for a conversation', () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      manager.addEntry(key, { type: 'starting', timestamp: Date.now() });
      expect(manager.getEntries(key)).toHaveLength(1);

      manager.clearEntries(key);
      expect(manager.getEntries(key)).toHaveLength(0);
    });
  });

  describe('flushBatch', () => {
    it('posts entries to Slack thread', async () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      manager.addEntry(key, { type: 'starting', timestamp: Date.now() });
      manager.addEntry(key, {
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Read',
        durationMs: 1500,
      });

      const mockClient = {
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
          update: vi.fn().mockResolvedValue({}),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({}),
        },
      };

      await manager.flushBatch(key, mockClient as any, 'C123', '456.789');

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          thread_ts: '456.789',
        })
      );
    });

    it('updates existing message on subsequent flush', async () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      manager.addEntry(key, { type: 'starting', timestamp: Date.now() });

      const mockClient = {
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
          update: vi.fn().mockResolvedValue({}),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({}),
        },
      };

      // First flush posts
      await manager.flushBatch(key, mockClient as any, 'C123', '456.789');
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);

      // Add more entries
      manager.addEntry(key, { type: 'tool_start', timestamp: Date.now(), tool: 'Bash' });

      // Second flush updates
      await manager.flushBatch(key, mockClient as any, 'C123', '456.789');
      expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
    });
  });
});

describe('getToolEmoji', () => {
  it('returns correct emoji for known tools', () => {
    expect(getToolEmoji('Read')).toBe(':mag:');
    expect(getToolEmoji('Glob')).toBe(':mag:');
    expect(getToolEmoji('Grep')).toBe(':mag:');
    expect(getToolEmoji('Edit')).toBe(':memo:');
    expect(getToolEmoji('Write')).toBe(':memo:');
    expect(getToolEmoji('Bash')).toBe(':computer:');
    expect(getToolEmoji('Shell')).toBe(':computer:');
    expect(getToolEmoji('WebFetch')).toBe(':globe_with_meridians:');
    expect(getToolEmoji('Task')).toBe(':robot_face:');
  });

  it('returns gear emoji for unknown tools', () => {
    expect(getToolEmoji('UnknownTool')).toBe(':gear:');
    expect(getToolEmoji('CustomTool')).toBe(':gear:');
  });
});

describe('SPINNER_FRAMES', () => {
  it('has 4 frames', () => {
    expect(SPINNER_FRAMES).toHaveLength(4);
  });

  it('contains Unicode spinner characters', () => {
    // Each frame should be a single Unicode character
    for (const frame of SPINNER_FRAMES) {
      expect(frame.length).toBe(1);
    }
  });
});

describe('buildActivityLogText', () => {
  it('limits to maxEntries (rolling window)', () => {
    const entries: ActivityEntry[] = [];
    for (let i = 0; i < 30; i++) {
      entries.push({ type: 'starting', timestamp: Date.now() });
    }

    const text = buildActivityLogText(entries, 20);

    // Should contain "earlier entries" indicator
    expect(text).toContain('earlier entries');
  });

  it('shows all entries when under limit', () => {
    const entries: ActivityEntry[] = [
      { type: 'starting', timestamp: Date.now() },
      { type: 'tool_complete', timestamp: Date.now(), tool: 'Read', durationMs: 1000 },
    ];

    const text = buildActivityLogText(entries);

    expect(text).not.toContain('earlier entries');
  });

  it('skips tool_start when tool_complete exists for same toolUseId', () => {
    const entries: ActivityEntry[] = [
      { type: 'tool_start', timestamp: Date.now(), tool: 'Bash', toolInput: 'npm test', toolUseId: 'tool-1' },
      { type: 'tool_complete', timestamp: Date.now(), tool: 'Bash', toolInput: 'npm test', toolUseId: 'tool-1', durationMs: 500 },
    ];

    const text = buildActivityLogText(entries);

    // Should NOT contain "[in progress]" - the tool_start should be skipped
    expect(text).not.toContain('[in progress]');
    // Should contain the completed entry with duration
    expect(text).toContain('Bash');
    expect(text).toContain('0.5s');
  });

  it('shows tool_start when tool_complete does not exist yet', () => {
    const entries: ActivityEntry[] = [
      { type: 'tool_start', timestamp: Date.now(), tool: 'Bash', toolInput: 'npm test', toolUseId: 'tool-1' },
    ];

    const text = buildActivityLogText(entries);

    // Should contain "[in progress]" since no tool_complete yet
    expect(text).toContain('[in progress]');
    expect(text).toContain('Bash');
    expect(text).toContain('`npm test`');
  });

  it('reduces entries when output exceeds maxChars (rolling window)', () => {
    // Create many entries to generate long text
    const entries: ActivityEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'ReadFileWithVeryLongToolName',
        durationMs: 1000 + i,
      });
    }

    // Set a small maxChars limit
    const text = buildActivityLogText(entries, 50, 200);

    // Should be within char limit
    expect(text.length).toBeLessThanOrEqual(200);
    // Should show "earlier entries" (because we reduced entry count)
    expect(text).toContain('earlier entries');
    // Should NOT contain "truncated" (no mid-text cutting)
    expect(text).not.toContain('truncated');
  });

  it('shows most recent entries when maxChars forces reduction', () => {
    // Create entries with identifiable content
    const entries: ActivityEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      entries.push({
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: `Tool${i}`,
        durationMs: 1000,
      });
    }

    // Very small maxChars forces showing only a few entries
    const text = buildActivityLogText(entries, 10, 150);

    // Should show the MOST RECENT entries (end of array)
    // Last entry is Tool10
    expect(text).toContain('Tool10');
    // Earlier entries should be hidden, not cut mid-text
    expect(text).toContain('earlier entries');
  });

  it('does not truncate when under maxChars', () => {
    const entries: ActivityEntry[] = [
      { type: 'starting', timestamp: Date.now() },
    ];

    const text = buildActivityLogText(entries, 20, 1000);

    expect(text).not.toContain('truncated');
  });

  it('respects both maxEntries and maxChars limits', () => {
    const entries: ActivityEntry[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push({ type: 'starting', timestamp: Date.now() });
    }

    // Limit to 10 entries and 100 chars
    const text = buildActivityLogText(entries, 10, 100);

    // Should show "earlier entries" (from maxEntries limit)
    expect(text).toContain('earlier entries');
    // Should be within char limit
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it('formats thinking entry correctly', () => {
    const entries: ActivityEntry[] = [
      { type: 'thinking', timestamp: Date.now() },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain(':brain:');
    expect(text).toContain('Thinking');
  });

  it('formats tool_start entry with emoji', () => {
    const entries: ActivityEntry[] = [
      { type: 'tool_start', timestamp: Date.now(), tool: 'Read' },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain(':mag:'); // Read tool emoji
    expect(text).toContain('Read');
  });

  it('formats tool_start with string toolInput (command)', () => {
    const entries: ActivityEntry[] = [
      { type: 'tool_start', timestamp: Date.now(), tool: 'Bash', toolInput: 'npm test' },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain(':computer:');
    expect(text).toContain('Bash');
    expect(text).toContain('`npm test`'); // Command should be displayed in backticks
    expect(text).toContain('[in progress]');
  });

  it('formats tool_complete with string toolInput (command)', () => {
    const entries: ActivityEntry[] = [
      { type: 'tool_complete', timestamp: Date.now(), tool: 'Bash', toolInput: 'git status', durationMs: 500 },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain(':computer:');
    expect(text).toContain('Bash');
    expect(text).toContain('`git status`'); // Command should be displayed in backticks
    expect(text).toContain('0.5s');
  });

  it('formats tool_complete entry with duration', () => {
    const entries: ActivityEntry[] = [
      { type: 'tool_complete', timestamp: Date.now(), tool: 'Bash', durationMs: 2500 },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain(':computer:'); // Tool emoji, not checkmark
    expect(text).not.toContain(':white_check_mark:');
    expect(text).toContain('Bash');
    expect(text).toContain('2.5s');
  });

  it('wraps entry text in a link when threadMessageLink is present', () => {
    const entries: ActivityEntry[] = [
      {
        type: 'starting',
        timestamp: Date.now(),
        threadMessageLink: 'https://slack.com/archives/C123/p123456',
      },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain('<https://slack.com/archives/C123/p123456|');
    expect(text).toContain('Analyzing request');
  });

  it('includes thinking content preview when present', () => {
    const entries: ActivityEntry[] = [
      {
        type: 'thinking',
        timestamp: Date.now(),
        thinkingContent: 'Short reasoning preview.',
      },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain('Thinking');
    expect(text).toContain('Short reasoning preview.');
  });

  it('formats generating entry with char count', () => {
    const entries: ActivityEntry[] = [
      { type: 'generating', timestamp: Date.now(), charCount: 500 },
    ];

    const text = buildActivityLogText(entries);

    expect(text).toContain(':memo:'); // Generating uses memo emoji now
    expect(text).toContain('500');
  });
});
