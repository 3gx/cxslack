/**
 * Integration test for concurrent routing by itemId/threadId.
 *
 * Verifies that deltas and command output are routed to the correct session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../streaming.js';

function createSlackMock() {
  return {
    chat: {
      update: vi.fn().mockResolvedValue({ ts: 'updated.ts' }),
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted.ts' }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
  } as unknown as WebClient;
}

function createContext(overrides: Partial<StreamingContext>): StreamingContext {
  return {
    channelId: 'C123',
    threadTs: 'thread-ts',
    messageTs: 'activity-ts',
    originalTs: 'orig-ts',
    userId: 'U123',
    threadId: 'thread-abc',
    turnId: '',
    approvalPolicy: 'on-request',
    reasoningEffort: 'high',
    sandboxMode: 'workspace-write',
    updateRateMs: 60_000,
    model: 'codex-mini',
    startTime: Date.now() - 1000,
    query: 'test query',
    ...overrides,
  };
}

describe('Concurrent routing by itemId', () => {
  let slack: WebClient;
  let codex: EventEmitter;
  let streaming: StreamingManager;

  beforeEach(() => {
    slack = createSlackMock();
    codex = new EventEmitter();
    streaming = new StreamingManager(slack, codex as unknown as CodexClient);
  });

  it('routes item:delta and command:output to the correct session', async () => {
    const ctxA = createContext({ threadTs: 'thread-A', messageTs: 'activity-A', originalTs: 'orig-A', threadId: 'thread-A-id' });
    const ctxB = createContext({ threadTs: 'thread-B', messageTs: 'activity-B', originalTs: 'orig-B', threadId: 'thread-B-id' });

    streaming.startStreaming(ctxA);
    streaming.startStreaming(ctxB);

    const keyA = makeConversationKey(ctxA.channelId, ctxA.threadTs);
    const keyB = makeConversationKey(ctxB.channelId, ctxB.threadTs);

    streaming.registerTurnId(keyA, 'turn-A');
    streaming.registerTurnId(keyB, 'turn-B');

    // Seed tool items for each session
    codex.emit('item:started', {
      itemId: 'item-A',
      itemType: 'commandExecution',
      commandActions: [{ type: 'run', command: 'echo A' }],
      threadId: 'thread-A-id',
      turnId: 'turn-A',
    });
    codex.emit('item:started', {
      itemId: 'item-B',
      itemType: 'commandExecution',
      commandActions: [{ type: 'run', command: 'echo B' }],
      threadId: 'thread-B-id',
      turnId: 'turn-B',
    });

    // Stream response deltas
    codex.emit('item:delta', { itemId: 'item-A', delta: 'A', threadId: 'thread-A-id', turnId: 'turn-A' });
    codex.emit('item:delta', { itemId: 'item-B', delta: 'B', threadId: 'thread-B-id', turnId: 'turn-B' });

    const stateA = (streaming as any).states.get(keyA);
    const stateB = (streaming as any).states.get(keyB);

    expect(stateA.text).toBe('A');
    expect(stateB.text).toBe('B');

    // Stream command output
    codex.emit('command:output', { itemId: 'item-A', delta: 'out-A', threadId: 'thread-A-id', turnId: 'turn-A' });
    codex.emit('command:output', { itemId: 'item-B', delta: 'out-B', threadId: 'thread-B-id', turnId: 'turn-B' });

    const toolA = stateA.activeTools.get('item-A');
    const toolB = stateB.activeTools.get('item-B');

    expect(toolA?.outputBuffer).toContain('out-A');
    expect(toolB?.outputBuffer).toContain('out-B');
  });
});
