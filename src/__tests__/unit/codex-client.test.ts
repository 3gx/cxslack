/**
 * Unit tests for CodexClient delta deduplication and token events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// We'll test the notification handling logic in isolation
// by simulating the handleNotification behavior

describe('CodexClient Delta Deduplication', () => {
  // Simulate the deduplication logic
  class DeltaDeduplicator {
    private recentDeltaHashes = new Map<string, number>();
    private readonly DELTA_HASH_TTL_MS = 5000;

    isDuplicate(itemId: string, delta: string): boolean {
      const hash = `${itemId}:${delta.slice(0, 50)}`;
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

  it('deduplicates identical deltas with same itemId', () => {
    const dedup = new DeltaDeduplicator();

    expect(dedup.isDuplicate('item-1', 'Hello world')).toBe(false);
    expect(dedup.isDuplicate('item-1', 'Hello world')).toBe(true);
    expect(dedup.isDuplicate('item-1', 'Hello world')).toBe(true);
  });

  it('handles different itemIds separately', () => {
    const dedup = new DeltaDeduplicator();

    expect(dedup.isDuplicate('item-1', 'Hello')).toBe(false);
    expect(dedup.isDuplicate('item-2', 'Hello')).toBe(false); // Different itemId, not duplicate
    expect(dedup.isDuplicate('item-1', 'Hello')).toBe(true); // Same itemId, duplicate
  });

  it('handles different deltas for same itemId', () => {
    const dedup = new DeltaDeduplicator();

    expect(dedup.isDuplicate('item-1', 'Hello')).toBe(false);
    expect(dedup.isDuplicate('item-1', 'World')).toBe(false); // Different delta
    expect(dedup.isDuplicate('item-1', 'Hello')).toBe(true); // Same delta, duplicate
  });

  it('allows re-emit after TTL expires (5s)', () => {
    vi.useFakeTimers();

    const dedup = new DeltaDeduplicator();

    expect(dedup.isDuplicate('item-1', 'Hello')).toBe(false);
    expect(dedup.isDuplicate('item-1', 'Hello')).toBe(true);

    // Advance time past TTL
    vi.advanceTimersByTime(6000);

    // Should allow the same delta again after TTL
    expect(dedup.isDuplicate('item-1', 'Hello')).toBe(false);

    vi.useRealTimers();
  });

  it('cleans up expired hashes to prevent memory leak', () => {
    vi.useFakeTimers();

    const dedup = new DeltaDeduplicator();

    // Add several hashes
    dedup.isDuplicate('item-1', 'delta1');
    dedup.isDuplicate('item-2', 'delta2');
    dedup.isDuplicate('item-3', 'delta3');

    expect(dedup.hashCount).toBe(3);

    // Advance time past TTL
    vi.advanceTimersByTime(6000);

    // Trigger cleanup by checking a new delta
    dedup.isDuplicate('item-4', 'delta4');

    // Old hashes should be cleaned up
    expect(dedup.hashCount).toBe(1); // Only the new one remains

    vi.useRealTimers();
  });

  it('uses first 50 chars of delta for hash', () => {
    const dedup = new DeltaDeduplicator();

    const longDelta1 = 'A'.repeat(100);
    const longDelta2 = 'A'.repeat(50) + 'B'.repeat(50);

    // These should be considered duplicates because first 50 chars are the same
    expect(dedup.isDuplicate('item-1', longDelta1)).toBe(false);
    expect(dedup.isDuplicate('item-1', longDelta2)).toBe(true);
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
