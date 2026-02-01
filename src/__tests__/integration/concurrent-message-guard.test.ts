/**
 * Integration test for per-session message guard.
 *
 * Ensures concurrent request guard only blocks the active conversation,
 * not other sessions in the same process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../streaming.js';
import { shouldBlockNewMessage } from '../../slack-bot.js';

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
    updateRateMs: 60_000,
    model: 'codex-mini',
    startTime: Date.now() - 1000,
    query: 'test query',
    ...overrides,
  };
}

describe('Concurrent message guard', () => {
  let slack: WebClient;
  let codex: EventEmitter;
  let streaming: StreamingManager;

  beforeEach(() => {
    slack = createSlackMock();
    codex = new EventEmitter();
    streaming = new StreamingManager(slack, codex as unknown as CodexClient);
  });

  afterEach(() => {
    streaming.stopAllStreaming();
  });

  it('blocks only the active session, not other threads', () => {
    const ctxA = createContext({
      threadTs: 'thread-A',
      messageTs: 'activity-A',
      originalTs: 'orig-A',
      threadId: 'thread-A',
      query: 'query A',
    });
    const ctxB = createContext({
      threadTs: 'thread-B',
      messageTs: 'activity-B',
      originalTs: 'orig-B',
      threadId: 'thread-B',
      query: 'query B',
    });

    streaming.startStreaming(ctxA);

    const keyA = makeConversationKey(ctxA.channelId, ctxA.threadTs);
    const keyB = makeConversationKey(ctxB.channelId, ctxB.threadTs);

    expect(shouldBlockNewMessage(streaming, keyA)).toBe(true);
    expect(shouldBlockNewMessage(streaming, keyB)).toBe(false);
  });
});
