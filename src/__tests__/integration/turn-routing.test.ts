/**
 * Integration test for turn routing.
 *
 * Verifies that turn:completed routes by turnId (not just threadId),
 * so the correct activity message gets updated when multiple Slack threads
 * share the same Codex thread.
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
    threadId: 'thread-shared',
    turnId: '',
    approvalPolicy: 'on-request',
    reasoningEffort: 'high',
    updateRateMs: 60_000, // large to avoid periodic updates in test
    model: 'codex-mini',
    startTime: Date.now() - 1000,
    query: 'test query',
    ...overrides,
  };
}

describe('Turn routing by turnId', () => {
  let slack: WebClient;
  let codex: EventEmitter;
  let streaming: StreamingManager;

  beforeEach(() => {
    slack = createSlackMock();
    codex = new EventEmitter();
    streaming = new StreamingManager(slack, codex as unknown as CodexClient);
  });

  it('updates the correct activity message for turn:completed when threadId is shared', async () => {
    const ctxA = createContext({
      threadTs: 'thread-A',
      messageTs: 'activity-A',
      originalTs: 'orig-A',
      threadId: 'thread-shared',
      query: 'query A',
    });
    const ctxB = createContext({
      threadTs: 'thread-B',
      messageTs: 'activity-B',
      originalTs: 'orig-B',
      threadId: 'thread-shared',
      query: 'query B',
    });

    streaming.startStreaming(ctxA);
    const keyA = makeConversationKey(ctxA.channelId, ctxA.threadTs);
    streaming.registerTurnId(keyA, 'turn-A');

    streaming.startStreaming(ctxB);
    const keyB = makeConversationKey(ctxB.channelId, ctxB.threadTs);
    streaming.registerTurnId(keyB, 'turn-B');

    // Allow initial async activity updates to settle before clearing
    await new Promise((resolve) => setImmediate(resolve));

    // Clear initial update calls from startStreaming
    (slack.chat.update as any).mockClear();

    codex.emit('turn:completed', { threadId: 'thread-shared', turnId: 'turn-A', status: 'completed' });

    // Wait for async handler to finish
    await new Promise((resolve) => setImmediate(resolve));

    const updateCalls = (slack.chat.update as any).mock.calls;
    const updatedTs = updateCalls.map((call: any[]) => call[0]?.ts);

    expect(updatedTs).toContain('activity-A');
    expect(updatedTs).not.toContain('activity-B');
  });
});
