/**
 * Unit tests for CodexClient delta deduplication and token events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// We'll test the notification handling logic in isolation
// by simulating the handleNotification behavior

describe('CodexClient Delta Deduplication', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Simulate the deduplication logic (content-only, 100ms TTL)
  class DeltaDeduplicator {
    private recentDeltaHashes = new Map<string, number>();
    private readonly DELTA_HASH_TTL_MS = 100; // 100ms TTL

    isDuplicate(delta: string): boolean {
      const hash = delta.slice(0, 100); // Content-only hash
      const now = Date.now();

      // Clean expired hashes
      for (const [h, ts] of this.recentDeltaHashes) {
        if (now - ts > this.DELTA_HASH_TTL_MS) {
          this.recentDeltaHashes.delete(h);
        }
      }

      // Check if duplicate
      if (this.recentDeltaHashes.has(hash)) {
        return true;
      }
      this.recentDeltaHashes.set(hash, now);
      return false;
    }

    get hashCount(): number {
      return this.recentDeltaHashes.size;
    }
  }

  it('deduplicates identical deltas regardless of itemId', () => {
    const dedup = new DeltaDeduplicator();

    // Same content from different event types (different itemIds) should deduplicate
    expect(dedup.isDuplicate('Hello world')).toBe(false);
    expect(dedup.isDuplicate('Hello world')).toBe(true); // Duplicate within 100ms
    expect(dedup.isDuplicate('Hello world')).toBe(true);
  });

  it('allows different content through', () => {
    const dedup = new DeltaDeduplicator();

    expect(dedup.isDuplicate('Hello')).toBe(false);
    expect(dedup.isDuplicate('World')).toBe(false); // Different content, not duplicate
    expect(dedup.isDuplicate('Hello')).toBe(true); // Same content, duplicate
  });

  it('allows re-emit after TTL expires (100ms)', () => {
    const dedup = new DeltaDeduplicator();

    expect(dedup.isDuplicate('Hello')).toBe(false);
    expect(dedup.isDuplicate('Hello')).toBe(true);

    // Advance time past TTL (100ms)
    vi.advanceTimersByTime(150);

    // Should allow the same delta again after TTL
    expect(dedup.isDuplicate('Hello')).toBe(false);
  });

  it('cleans up expired hashes to prevent memory leak', () => {
    const dedup = new DeltaDeduplicator();

    // Add several hashes
    dedup.isDuplicate('delta1');
    dedup.isDuplicate('delta2');
    dedup.isDuplicate('delta3');

    expect(dedup.hashCount).toBe(3);

    // Advance time past TTL
    vi.advanceTimersByTime(150);

    // Trigger cleanup by checking a new delta
    dedup.isDuplicate('delta4');

    // Old hashes should be cleaned up
    expect(dedup.hashCount).toBe(1); // Only the new one remains
  });

  it('uses first 100 chars of delta for hash', () => {
    const dedup = new DeltaDeduplicator();

    const longDelta1 = 'A'.repeat(200);
    const longDelta2 = 'A'.repeat(100) + 'B'.repeat(100);

    // These should be considered duplicates because first 100 chars are the same
    expect(dedup.isDuplicate(longDelta1)).toBe(false);
    expect(dedup.isDuplicate(longDelta2)).toBe(true);
  });

  it('deduplicates same content from multiple event types', () => {
    // This simulates the real scenario: same content arrives via different Codex event types
    const dedup = new DeltaDeduplicator();

    // Simulate item/agentMessage/delta
    expect(dedup.isDuplicate('Why')).toBe(false);

    // Simulate codex/event/agent_message_content_delta with same content
    expect(dedup.isDuplicate('Why')).toBe(true); // Should be deduplicated!

    // Next word arrives
    expect(dedup.isDuplicate(' was')).toBe(false);
    expect(dedup.isDuplicate(' was')).toBe(true); // Deduplicated
  });
});

describe('CodexClient item:started Event Tool Name Extraction', () => {
  // Test the tool name extraction logic that handles multiple possible field names
  type ItemStartedParams = Record<string, unknown>;

  function extractToolName(p: ItemStartedParams): { itemId: string; itemType: string } {
    const itemId = (p.itemId || p.item_id || p.id || '') as string;
    const itemType = (p.itemType || p.item_type || p.type || p.toolName || p.tool_name || p.name || 'unknown') as string;
    return { itemId, itemType };
  }

  it('extracts itemType from itemType field (camelCase)', () => {
    const params = { itemId: 'item-123', itemType: 'Read' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('item-123');
    expect(result.itemType).toBe('Read');
  });

  it('extracts itemType from item_type field (snake_case)', () => {
    const params = { item_id: 'item-456', item_type: 'Write' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('item-456');
    expect(result.itemType).toBe('Write');
  });

  it('extracts itemType from type field as fallback', () => {
    const params = { id: 'item-789', type: 'Bash' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('item-789');
    expect(result.itemType).toBe('Bash');
  });

  it('extracts itemType from toolName field as fallback', () => {
    const params = { itemId: 'item-abc', toolName: 'Grep' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('item-abc');
    expect(result.itemType).toBe('Grep');
  });

  it('extracts itemType from tool_name field as fallback', () => {
    const params = { itemId: 'item-def', tool_name: 'Glob' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('item-def');
    expect(result.itemType).toBe('Glob');
  });

  it('extracts itemType from name field as fallback', () => {
    const params = { itemId: 'item-ghi', name: 'WebFetch' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('item-ghi');
    expect(result.itemType).toBe('WebFetch');
  });

  it('defaults to "unknown" when no type field present', () => {
    const params = { itemId: 'item-jkl' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('item-jkl');
    expect(result.itemType).toBe('unknown');
  });

  it('defaults to empty string for missing itemId', () => {
    const params = { itemType: 'Read' };
    const result = extractToolName(params);
    expect(result.itemId).toBe('');
    expect(result.itemType).toBe('Read');
  });

  it('prioritizes itemType over other type fields', () => {
    const params = { itemId: 'item-mno', itemType: 'Read', type: 'Write', toolName: 'Bash' };
    const result = extractToolName(params);
    expect(result.itemType).toBe('Read'); // itemType takes priority
  });

  it('handles completely empty params', () => {
    const params = {};
    const result = extractToolName(params);
    expect(result.itemId).toBe('');
    expect(result.itemType).toBe('unknown');
  });
});

describe('CodexClient Token Events', () => {
  it('emits tokens:updated event with normalized field names', () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on('tokens:updated', listener);

    // Simulate handling token notification with snake_case fields
    const params = { input_tokens: 100, output_tokens: 50 };
    emitter.emit('tokens:updated', {
      inputTokens: params.inputTokens ?? params.input_tokens ?? 0,
      outputTokens: params.outputTokens ?? params.output_tokens ?? 0,
    });

    expect(listener).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('handles camelCase field names', () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on('tokens:updated', listener);

    // Simulate handling token notification with camelCase fields
    const params = { inputTokens: 200, outputTokens: 75 };
    emitter.emit('tokens:updated', {
      inputTokens: params.inputTokens ?? params.input_tokens ?? 0,
      outputTokens: params.outputTokens ?? params.output_tokens ?? 0,
    });

    expect(listener).toHaveBeenCalledWith({
      inputTokens: 200,
      outputTokens: 75,
    });
  });

  it('defaults to 0 for missing token counts', () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on('tokens:updated', listener);

    // Simulate handling token notification with missing fields
    const params = {} as { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number };
    emitter.emit('tokens:updated', {
      inputTokens: params.inputTokens ?? params.input_tokens ?? 0,
      outputTokens: params.outputTokens ?? params.output_tokens ?? 0,
    });

    expect(listener).toHaveBeenCalledWith({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
