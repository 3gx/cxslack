/**
 * Unit tests for CodexClient delta deduplication and token events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { CodexClient } from '../../codex-client.js';
import type { JsonRpcNotification } from '../../json-rpc.js';

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

describe('CodexClient turn:completed deduplication', () => {
  it('emits turn:completed only once for task_complete + turn/completed', () => {
    const client = new CodexClient({ requestTimeout: 10 });
    const handler = vi.fn();
    client.on('turn:completed', handler);

    const taskComplete: JsonRpcNotification = {
      method: 'codex/event/task_complete',
      params: {
        id: 'turn-1',
        conversationId: 'thread-1',
        status: 'completed',
      },
    };

    const turnCompleted: JsonRpcNotification = {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    };

    (client as any).handleNotification(taskComplete);
    (client as any).handleNotification(turnCompleted);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed' });
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

describe('context:turnId Event', () => {
  it('emits when threadId and turnId present', () => {
    const params = { threadId: 't1', turnId: 'turn1' };
    const shouldEmit = !!(params.threadId && params.turnId);
    expect(shouldEmit).toBe(true);
  });

  it('does not emit when turnId missing', () => {
    const params = { threadId: 't1', turnId: '' };
    const shouldEmit = !!(params.threadId && params.turnId);
    expect(shouldEmit).toBe(false);
  });

  it('does not emit when threadId missing', () => {
    const params = { threadId: '', turnId: 'turn1' };
    const shouldEmit = !!(params.threadId && params.turnId);
    expect(shouldEmit).toBe(false);
  });
});

describe('Command exitCode Extraction', () => {
  it('extracts camelCase exitCode', () => {
    const params = { exitCode: 0 };
    const exitCode = params.exitCode ?? (params as { exit_code?: number }).exit_code;
    expect(exitCode).toBe(0);
  });

  it('extracts snake_case exit_code', () => {
    const params = { exit_code: 127 };
    const exitCode = (params as { exitCode?: number }).exitCode ?? params.exit_code;
    expect(exitCode).toBe(127);
  });

  it('handles undefined exit code', () => {
    const params = {} as { exitCode?: number; exit_code?: number };
    const exitCode = params.exitCode ?? params.exit_code;
    expect(exitCode).toBeUndefined();
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

describe('CodexClient web search notifications', () => {
  it('emits websearch start/end with parsed fields', () => {
    const client = new CodexClient({ requestTimeout: 10 });
    const started = vi.fn();
    const completed = vi.fn();

    client.on('websearch:started', started);
    client.on('websearch:completed', completed);

    const begin: JsonRpcNotification = {
      method: 'codex/event/web_search_begin',
      params: {
        conversationId: 'thread-1',
        msg: {
          call_id: 'search-1',
          query: 'test query',
          url: 'https://search.example',
          turn_id: 'turn-1',
        },
      },
    };

    const end: JsonRpcNotification = {
      method: 'codex/event/web_search_end',
      params: {
        conversationId: 'thread-1',
        msg: {
          call_id: 'search-1',
          results: [{ url: 'https://result.example' }],
        },
      },
    };

    (client as any).handleNotification(begin);
    (client as any).handleNotification(end);

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'search-1',
        query: 'test query',
        url: 'https://search.example',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })
    );

    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'search-1',
        url: 'https://result.example',
        resultUrls: ['https://result.example'],
        threadId: 'thread-1',
      })
    );
  });
});

describe('CodexClient file change notifications', () => {
  it('emits filechange:delta with itemId and delta', () => {
    const client = new CodexClient({ requestTimeout: 10 });
    const listener = vi.fn();
    client.on('filechange:delta', listener);

    const notification: JsonRpcNotification = {
      method: 'item/fileChange/outputDelta',
      params: {
        itemId: 'change-1',
        delta: '+++ b/file.ts\n+new line\n',
      },
    };

    (client as any).handleNotification(notification);

    expect(listener).toHaveBeenCalledWith({
      itemId: 'change-1',
      delta: '+++ b/file.ts\n+new line\n',
    });
  });
});

describe('CodexClient Point-in-Time Fork', () => {
  describe('rollbackThread validation', () => {
    it('rejects numTurns < 1', async () => {
      const client = new CodexClient({ requestTimeout: 10 });
      // Mock the process to avoid "not connected" error - just test the validation
      (client as any).process = { stdin: { write: vi.fn() } };
      (client as any).initialized = true;

      await expect(client.rollbackThread('thread-1', 0)).rejects.toThrow('numTurns must be >= 1');
      await expect(client.rollbackThread('thread-1', -1)).rejects.toThrow('numTurns must be >= 1');
    });

    it('accepts numTurns >= 1', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      const rpcSpy = vi.spyOn(client, 'rpc').mockResolvedValue({ thread: { id: 'thread-1' } });

      await client.rollbackThread('thread-1', 1);

      expect(rpcSpy).toHaveBeenCalledWith('thread/rollback', {
        threadId: 'thread-1',
        numTurns: 1,
      });
    });

    it('passes correct RPC params for rollback', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      const rpcSpy = vi.spyOn(client, 'rpc').mockResolvedValue({ thread: { id: 'thread-1' } });

      await client.rollbackThread('thread-xyz', 5);

      expect(rpcSpy).toHaveBeenCalledWith('thread/rollback', {
        threadId: 'thread-xyz',
        numTurns: 5,
      });
    });
  });

  describe('readThread and getThreadTurnCount', () => {
    it('readThread calls thread/read with includeTurns', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      const rpcSpy = vi.spyOn(client, 'rpc').mockResolvedValue({
        thread: {
          id: 'thread-123',
          workingDirectory: '/test',
          createdAt: new Date().toISOString(),
          turns: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
        },
      });

      const result = await client.readThread('thread-123', true);

      expect(rpcSpy).toHaveBeenCalledWith('thread/read', { threadId: 'thread-123', includeTurns: true });
      expect(result.turns).toHaveLength(3);
    });

    it('getThreadTurnCount returns correct count', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'readThread').mockResolvedValue({
        thread: { id: 'thread-123', workingDirectory: '/test', createdAt: new Date().toISOString() },
        turns: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }, { id: 't5' }],
      });

      const count = await client.getThreadTurnCount('thread-123');

      expect(count).toBe(5);
    });

    it('getThreadTurnCount returns 0 for empty turns', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'readThread').mockResolvedValue({
        thread: { id: 'thread-123', workingDirectory: '/test', createdAt: new Date().toISOString() },
        turns: undefined,
      });

      const count = await client.getThreadTurnCount('thread-123');

      expect(count).toBe(0);
    });

    it('findTurnIndex returns correct index for existing turn', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'readThread').mockResolvedValue({
        thread: { id: 'thread-123', workingDirectory: '/test', createdAt: new Date().toISOString() },
        turns: [{ id: 'turn-a' }, { id: 'turn-b' }, { id: 'turn-c' }],
      });

      const index = await client.findTurnIndex('thread-123', 'turn-b');

      expect(index).toBe(1);
    });

    it('findTurnIndex returns -1 for non-existent turn', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'readThread').mockResolvedValue({
        thread: { id: 'thread-123', workingDirectory: '/test', createdAt: new Date().toISOString() },
        turns: [{ id: 'turn-a' }, { id: 'turn-b' }],
      });

      const index = await client.findTurnIndex('thread-123', 'turn-xyz');

      expect(index).toBe(-1);
    });

    it('findTurnIndex returns -1 for undefined turns', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'readThread').mockResolvedValue({
        thread: { id: 'thread-123', workingDirectory: '/test', createdAt: new Date().toISOString() },
        turns: undefined,
      });

      const index = await client.findTurnIndex('thread-123', 'turn-a');

      expect(index).toBe(-1);
    });
  });

  describe('forkThreadAtTurn calculation', () => {
    it('gets turn count from Codex and calculates correct rollback for turn 0 of 3', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      // Mock getThreadTurnCount to return 3 turns (source of truth from Codex)
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(3);
      const forkSpy = vi.spyOn(client, 'forkThread').mockResolvedValue({
        id: 'forked-thread',
        workingDirectory: '/test',
        createdAt: new Date().toISOString(),
      });
      const rollbackSpy = vi.spyOn(client, 'rollbackThread').mockResolvedValue();

      // Fork at turn 0, Codex says 3 turns → keep 1 turn, rollback 2
      await client.forkThreadAtTurn('source-thread', 0);

      expect(forkSpy).toHaveBeenCalledWith('source-thread');
      expect(rollbackSpy).toHaveBeenCalledWith('forked-thread', 2);
    });

    it('gets turn count from Codex and calculates correct rollback for turn 1 of 3', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(3);
      const forkSpy = vi.spyOn(client, 'forkThread').mockResolvedValue({
        id: 'forked-thread',
        workingDirectory: '/test',
        createdAt: new Date().toISOString(),
      });
      const rollbackSpy = vi.spyOn(client, 'rollbackThread').mockResolvedValue();

      // Fork at turn 1, Codex says 3 turns → keep 2 turns, rollback 1
      await client.forkThreadAtTurn('source-thread', 1);

      expect(forkSpy).toHaveBeenCalledWith('source-thread');
      expect(rollbackSpy).toHaveBeenCalledWith('forked-thread', 1);
    });

    it('skips rollback when fork at last turn', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(3);
      const forkSpy = vi.spyOn(client, 'forkThread').mockResolvedValue({
        id: 'forked-thread',
        workingDirectory: '/test',
        createdAt: new Date().toISOString(),
      });
      const rollbackSpy = vi.spyOn(client, 'rollbackThread').mockResolvedValue();

      // Fork at turn 2, Codex says 3 turns → keep 3 turns, rollback 0 (skip)
      await client.forkThreadAtTurn('source-thread', 2);

      expect(forkSpy).toHaveBeenCalledWith('source-thread');
      expect(rollbackSpy).not.toHaveBeenCalled();
    });

    it('handles single-turn thread (fork at turn 0 of 1)', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(1);
      const forkSpy = vi.spyOn(client, 'forkThread').mockResolvedValue({
        id: 'forked-thread',
        workingDirectory: '/test',
        createdAt: new Date().toISOString(),
      });
      const rollbackSpy = vi.spyOn(client, 'rollbackThread').mockResolvedValue();

      // Fork at turn 0, Codex says 1 turn → keep 1 turn, rollback 0 (skip)
      await client.forkThreadAtTurn('source-thread', 0);

      expect(forkSpy).toHaveBeenCalledWith('source-thread');
      expect(rollbackSpy).not.toHaveBeenCalled();
    });

    it('calculates correct rollback for large thread', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(20);
      const forkSpy = vi.spyOn(client, 'forkThread').mockResolvedValue({
        id: 'forked-thread',
        workingDirectory: '/test',
        createdAt: new Date().toISOString(),
      });
      const rollbackSpy = vi.spyOn(client, 'rollbackThread').mockResolvedValue();

      // Fork at turn 5, Codex says 20 turns → keep 6 turns, rollback 14
      await client.forkThreadAtTurn('source-thread', 5);

      expect(forkSpy).toHaveBeenCalledWith('source-thread');
      expect(rollbackSpy).toHaveBeenCalledWith('forked-thread', 14);
    });

    it('returns forked thread info', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      const expectedThread = {
        id: 'forked-thread-123',
        workingDirectory: '/test/path',
        createdAt: '2024-01-01T00:00:00Z',
      };
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(3);
      vi.spyOn(client, 'forkThread').mockResolvedValue(expectedThread);
      vi.spyOn(client, 'rollbackThread').mockResolvedValue();

      const result = await client.forkThreadAtTurn('source-thread', 0);

      expect(result).toEqual(expectedThread);
    });

    it('rejects invalid turnIndex (negative)', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(3);

      await expect(client.forkThreadAtTurn('source-thread', -1))
        .rejects.toThrow('Invalid turnIndex -1: thread has 3 turns (0-2)');
    });

    it('rejects invalid turnIndex (out of bounds)', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      vi.spyOn(client, 'getThreadTurnCount').mockResolvedValue(3);

      await expect(client.forkThreadAtTurn('source-thread', 5))
        .rejects.toThrow('Invalid turnIndex 5: thread has 3 turns (0-2)');
    });
  });

  describe('forkThread RPC', () => {
    it('calls thread/fork with correct params', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      const rpcSpy = vi.spyOn(client, 'rpc').mockResolvedValue({
        thread: { id: 'new-fork', workingDirectory: '/test', createdAt: new Date().toISOString() },
      });

      await client.forkThread('source-thread-abc');

      expect(rpcSpy).toHaveBeenCalledWith('thread/fork', { threadId: 'source-thread-abc' });
    });

    it('returns thread info from RPC response', async () => {
      const client = new CodexClient({ requestTimeout: 100 });
      const expectedThread = {
        id: 'new-fork-xyz',
        workingDirectory: '/working/dir',
        createdAt: '2024-06-15T12:00:00Z',
      };
      vi.spyOn(client, 'rpc').mockResolvedValue({ thread: expectedThread });

      const result = await client.forkThread('source-thread');

      expect(result).toEqual(expectedThread);
    });
  });
});
