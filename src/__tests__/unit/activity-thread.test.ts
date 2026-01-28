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
});
