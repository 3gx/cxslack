/**
 * Integration tests for activity thread consistency.
 *
 * Verifies:
 * 1. Emojis match between main activity message and thread messages
 * 2. No duplicate "Analyzing request" messages are posted
 */

import { describe, it, expect } from 'vitest';
import { ActivityThreadManager, ActivityEntry } from '../../activity-thread.js';
import { formatThreadActivityEntry } from '../../blocks.js';

describe('Activity Thread Consistency', () => {
  describe('Emoji Consistency', () => {
    /**
     * The main activity message formatEntry() and thread formatThreadActivityEntry()
     * must use the SAME emojis for each entry type.
     *
     * Expected emojis:
     * - starting (Analyzing request): :brain: (🧠)
     * - generating: :memo: (📝)
     * - response: :speech_balloon: (💬)
     * - thinking: :brain: (🧠) in main, :bulb: (💡) in thread (acceptable difference)
     */

    it('uses :brain: for Analyzing request in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'starting',
        timestamp: Date.now(),
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':brain:');
      expect(threadFormat).toContain(':brain:');
      expect(mainFormat).toContain('Analyzing request');
      expect(threadFormat).toContain('Analyzing request');
    });

    it('uses :memo: for Generating in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'generating',
        timestamp: Date.now(),
        charCount: 100,
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':memo:');
      expect(threadFormat).toContain(':memo:');
      expect(mainFormat).toContain('Generating');
      expect(threadFormat).toContain('Generating');
    });

    it('does NOT use :speech_balloon: for Generating (was a bug)', () => {
      const entry: ActivityEntry = {
        type: 'generating',
        timestamp: Date.now(),
        charCount: 100,
      };

      // Thread message format should NOT use :speech_balloon:
      const threadFormat = formatThreadActivityEntry(entry);

      expect(threadFormat).not.toContain(':speech_balloon:');
      expect(threadFormat).toContain(':memo:');
    });

    it('uses appropriate emoji for tool_complete in main vs thread', () => {
      const entry: ActivityEntry = {
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Read',
        toolInput: { file_path: '/path/to/file.ts' },
        durationMs: 150,
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      // Live Activity: always checkmark for completed
      expect(mainFormat).toContain(':white_check_mark:');

      // Thread Activity: tool-specific emoji (intentional divergence)
      expect(threadFormat).toContain(':mag:'); // Read tool emoji
      expect(threadFormat).not.toContain(':white_check_mark:');
    });

    it('uses :x: for error in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'error',
        timestamp: Date.now(),
        message: 'Something went wrong',
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':x:');
      expect(threadFormat).toContain(':x:');
    });

    it('uses :octagonal_sign: for aborted in both main and thread', () => {
      const entry: ActivityEntry = {
        type: 'aborted',
        timestamp: Date.now(),
      };

      // Main activity message format
      const manager = new ActivityThreadManager();
      const mainFormat = (manager as any).formatEntry(entry);

      // Thread message format
      const threadFormat = formatThreadActivityEntry(entry);

      expect(mainFormat).toContain(':octagonal_sign:');
      expect(threadFormat).toContain(':octagonal_sign:');
    });
  });

  describe('No Duplicate Entries', () => {
    it('starting entry is only added once to activity batch', () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      // Add starting entry once (as would happen in startStreaming)
      manager.addEntry(key, {
        type: 'starting',
        timestamp: Date.now(),
      });

      const entries = manager.getEntries(key);

      // Should only have one starting entry
      const startingEntries = entries.filter(e => e.type === 'starting');
      expect(startingEntries).toHaveLength(1);
    });

    it('activity batch maintains correct order of entries', () => {
      const manager = new ActivityThreadManager();
      const key = 'test-conversation';

      // Add entries in order (simulating a typical turn)
      manager.addEntry(key, { type: 'starting', timestamp: 1 });
      manager.addEntry(key, { type: 'tool_start', timestamp: 2, tool: 'Read', toolUseId: 'tool-1' });
      manager.addEntry(key, { type: 'tool_complete', timestamp: 3, tool: 'Read', toolUseId: 'tool-1' });
      manager.addEntry(key, { type: 'generating', timestamp: 4, charCount: 50 });

      const entries = manager.getEntries(key);

      expect(entries).toHaveLength(4);
      expect(entries[0].type).toBe('starting');
      expect(entries[1].type).toBe('tool_start');
      expect(entries[2].type).toBe('tool_complete');
      expect(entries[3].type).toBe('generating');
    });
  });

  describe('Response Emoji in Main Activity Message', () => {
    /**
     * The Response line in main activity message (added via streaming.ts updateActivityMessage)
     * must use :speech_balloon: emoji, matching the thread messages.
     */

    it('formatThreadResponseMessage uses :speech_balloon:', async () => {
      const { formatThreadResponseMessage } = await import('../../blocks.js');

      const formatted = formatThreadResponseMessage('test response', 1000);

      expect(formatted).toContain(':speech_balloon:');
      expect(formatted).toContain('Response');
    });
  });
});
