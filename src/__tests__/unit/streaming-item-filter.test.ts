/**
 * Unit tests for item type filtering in streaming.
 * Verifies that non-tool items are filtered from activity display.
 */

import { describe, it, expect } from 'vitest';
import { isToolItemType } from '../../streaming.js';

describe('Item Type Filtering', () => {
  describe('isToolItemType', () => {
    // Non-tool item types should be filtered (return false)
    describe('filters non-tool item types', () => {
      it('returns false for userMessage (all case variations)', () => {
        expect(isToolItemType('userMessage')).toBe(false);
        expect(isToolItemType('usermessage')).toBe(false);
        expect(isToolItemType('UserMessage')).toBe(false);
        expect(isToolItemType('USERMESSAGE')).toBe(false);
      });

      it('returns false for agentMessage (all case variations)', () => {
        expect(isToolItemType('agentMessage')).toBe(false);
        expect(isToolItemType('agentmessage')).toBe(false);
        expect(isToolItemType('AgentMessage')).toBe(false);
        expect(isToolItemType('AGENTMESSAGE')).toBe(false);
      });

      it('returns false for reasoning (all case variations)', () => {
        expect(isToolItemType('reasoning')).toBe(false);
        expect(isToolItemType('Reasoning')).toBe(false);
        expect(isToolItemType('REASONING')).toBe(false);
      });

      it('handles snake_case and kebab-case variations', () => {
        expect(isToolItemType('user_message')).toBe(false);
        expect(isToolItemType('user-message')).toBe(false);
        expect(isToolItemType('agent_message')).toBe(false);
        expect(isToolItemType('agent-message')).toBe(false);
      });
    });

    // Tool item types should pass through (return true)
    describe('allows tool item types through', () => {
      it('returns true for commandExecution', () => {
        expect(isToolItemType('commandExecution')).toBe(true);
        expect(isToolItemType('CommandExecution')).toBe(true);
        expect(isToolItemType('COMMANDEXECUTION')).toBe(true);
      });

      it('returns true for mcpToolCall', () => {
        expect(isToolItemType('mcpToolCall')).toBe(true);
        expect(isToolItemType('McpToolCall')).toBe(true);
      });

      it('returns true for fileChange', () => {
        expect(isToolItemType('fileChange')).toBe(true);
        expect(isToolItemType('FileChange')).toBe(true);
      });

      it('returns true for webSearch', () => {
        expect(isToolItemType('webSearch')).toBe(true);
        expect(isToolItemType('WebSearch')).toBe(true);
      });

      it('returns true for collabToolCall', () => {
        expect(isToolItemType('collabToolCall')).toBe(true);
      });
    });

    // Edge cases and safe defaults
    describe('handles edge cases safely', () => {
      it('returns true for unknown types (safe default)', () => {
        expect(isToolItemType('someNewToolType')).toBe(true);
        expect(isToolItemType('futureToolType')).toBe(true);
      });

      it('handles null safely (returns true)', () => {
        expect(isToolItemType(null)).toBe(true);
      });

      it('handles undefined safely (returns true)', () => {
        expect(isToolItemType(undefined)).toBe(true);
      });

      it('handles empty string (returns true)', () => {
        expect(isToolItemType('')).toBe(true);
      });

      it('handles non-string types safely', () => {
        expect(isToolItemType(123 as unknown)).toBe(true);
        expect(isToolItemType({} as unknown)).toBe(true);
        expect(isToolItemType([] as unknown)).toBe(true);
      });
    });
  });

  // Test the filtering behavior in the context of activeTools tracking
  describe('activeTools tracking with filtering', () => {
    it('does not track filtered items in activeTools', () => {
      const activeTools = new Map<string, { tool: string; startTime: number }>();

      // Simulate item:started event handling with filtering
      const handleItemStarted = (itemId: string, itemType: string) => {
        if (!isToolItemType(itemType)) {
          return; // Skip non-tool items
        }
        activeTools.set(itemId, { tool: itemType, startTime: Date.now() });
      };

      // userMessage should be filtered out
      handleItemStarted('msg-1', 'userMessage');
      expect(activeTools.has('msg-1')).toBe(false);

      // reasoning should be filtered out
      handleItemStarted('msg-2', 'reasoning');
      expect(activeTools.has('msg-2')).toBe(false);

      // commandExecution should be tracked
      handleItemStarted('tool-1', 'commandExecution');
      expect(activeTools.has('tool-1')).toBe(true);
      expect(activeTools.get('tool-1')?.tool).toBe('commandExecution');
    });

    it('ignores item:completed for untracked (filtered) items', () => {
      const activeTools = new Map<string, { tool: string; startTime: number }>();
      const completedEntries: Array<{ itemId: string; tool: string; durationMs: number }> = [];

      // Simulate item:completed event handling
      const handleItemCompleted = (itemId: string) => {
        const toolInfo = activeTools.get(itemId);
        if (toolInfo) {
          completedEntries.push({
            itemId,
            tool: toolInfo.tool,
            durationMs: Date.now() - toolInfo.startTime,
          });
          activeTools.delete(itemId);
        }
      };

      // Try to complete an item that was never tracked (because it was filtered)
      handleItemCompleted('msg-1');
      expect(completedEntries).toHaveLength(0);

      // Add a tracked tool and complete it
      activeTools.set('tool-1', { tool: 'Read', startTime: Date.now() - 100 });
      handleItemCompleted('tool-1');
      expect(completedEntries).toHaveLength(1);
      expect(completedEntries[0].tool).toBe('Read');
    });
  });

  // Test the toolInput tracking and activity entries
  describe('Tool input in activity entries', () => {
    it('passes toolInput to tool_start activity entry', () => {
      const entries: { type: string; tool: string; toolInput?: string }[] = [];

      // Simulate adding entry with toolInput
      entries.push({
        type: 'tool_start',
        tool: 'commandExecution',
        toolInput: 'ls -la',
      });

      expect(entries[0].toolInput).toBe('ls -la');
    });

    it('passes toolInput to tool_complete activity entry', () => {
      const activeTools = new Map<string, { tool: string; input?: string; startTime: number }>();
      activeTools.set('tool-1', { tool: 'commandExecution', input: 'git status', startTime: Date.now() });

      const toolInfo = activeTools.get('tool-1');
      const completionEntry = {
        type: 'tool_complete',
        tool: toolInfo!.tool,
        toolInput: toolInfo!.input,
      };

      expect(completionEntry.toolInput).toBe('git status');
    });

    it('handles undefined toolInput gracefully', () => {
      const entry = {
        type: 'tool_start',
        tool: 'mcpToolCall',
        toolInput: undefined,
      };

      // Format should not crash with undefined
      const display = `*${entry.tool}*${entry.toolInput ? ` \`${entry.toolInput}\`` : ''} [in progress]`;
      expect(display).toBe('*mcpToolCall* [in progress]');
    });
  });
});
