/**
 * Unit tests for per-conversation turn locking.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../codex-client.js';
import { StreamingManager } from '../../streaming.js';

function createSlackMock(): WebClient {
  return {
    chat: {
      update: vi.fn().mockResolvedValue({ ts: '1' }),
      postMessage: vi.fn().mockResolvedValue({ ts: '1' }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
  } as unknown as WebClient;
}

function createContext(overrides: Partial<{
  channelId: string;
  threadTs?: string;
  messageTs: string;
  originalTs: string;
  threadId: string;
}> = {}) {
  return {
    channelId: overrides.channelId ?? 'C1',
    threadTs: overrides.threadTs ?? 'T1',
    messageTs: overrides.messageTs ?? 'm1',
    originalTs: overrides.originalTs ?? 'o1',
    threadId: overrides.threadId ?? 'thread-1',
    turnId: '',
    approvalPolicy: 'never',
    updateRateMs: 1000,
    startTime: Date.now(),
  };
}

describe('StreamingManager turn lock', () => {
  it('blocks concurrent starts in the same conversation', () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);

    const key = 'C1:T1';
    expect(streaming.acquireTurnLock(key)).toBe(true);
    expect(streaming.acquireTurnLock(key)).toBe(false);

    streaming.releaseTurnLock(key);
    expect(streaming.acquireTurnLock(key)).toBe(true);
  });

  it('allows independent sessions to lock in parallel', () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);

    expect(streaming.acquireTurnLock('C1:T1')).toBe(true);
    expect(streaming.acquireTurnLock('C1:T2')).toBe(true);
  });

  it('clears pending lock when streaming stops', () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);

    const key = 'C1:T1';
    expect(streaming.acquireTurnLock(key)).toBe(true);

    streaming.startStreaming(createContext());
    expect(streaming.isTurnLocked(key)).toBe(true);

    streaming.stopStreaming(key);
    expect(streaming.acquireTurnLock(key)).toBe(true);
  });
});
