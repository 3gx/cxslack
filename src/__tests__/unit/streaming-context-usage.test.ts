/**
 * Regression test: activity status line should use cumulative totals,
 * matching Codex CLI context usage.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock slack retry to run inline
vi.mock('../../slack-retry.js', () => ({
  withSlackRetry: (fn: () => Promise<unknown> | unknown) => fn(),
}));

// Spy on buildActivityBlocks to inspect the numbers we pass to Slack
const buildActivityBlocks = vi.fn(() => []);

vi.mock('../../blocks.js', async () => {
  const actual = await vi.importActual<typeof import('../../blocks.js')>('../../blocks.js');
  return {
    ...actual,
    buildActivityBlocks,
  };
});

describe('StreamingManager context usage (activity line)', () => {
  it('uses cumulative totals for context usage', async () => {
    const { StreamingManager } = await import('../../streaming.js');

    const slack = {
      chat: {
        update: vi.fn().mockResolvedValue({}),
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-1' }),
      },
    } as any;

    const codex = new EventEmitter() as any;
    const manager = new StreamingManager(slack, codex);

    const key = 'C123:thread';
    const now = Date.now();

    // Manually seed context and state
    (manager as any).contexts.set(key, {
      channelId: 'C123',
      threadTs: 'thread',
      originalTs: 'orig',
      messageTs: 'msg',
      userId: 'U123',
      threadId: 'thread-id',
      turnId: 'turn-id',
      approvalPolicy: 'on-request',
      model: 'gpt-5.2-codex',
      reasoningEffort: 'xhigh',
      startTime: now - 1000,
      updateRateMs: 1000,
    });

    (manager as any).states.set(key, {
      text: '',
      isStreaming: true,
      lastUpdateTime: 0,
      updateTimer: null,
      status: 'completed',
      inputTokens: 132_000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      baseInputTokens: undefined,
      baseOutputTokens: undefined,
      baseCacheCreationInputTokens: 0,
      contextWindow: 258_000,
      maxOutputTokens: undefined,
      costUsd: undefined,
      thinkingContent: '',
      thinkingStartTime: 0,
      thinkingComplete: false,
      activeTools: new Map(),
      activityMessageTs: 'msg',
      spinnerIndex: 0,
      pendingAbort: false,
      pendingAbortTimeout: undefined,
      threadParentTs: 'orig',
      activityBatch: [],
      lastActivityPostTime: 0,
      postedBatchTs: null,
      postedBatchToolUseIds: new Set(),
    });

    await (manager as any).updateActivityMessage(key);

    const call = buildActivityBlocks.mock.calls.at(-1)?.[0];
    expect(call).toBeDefined();

    expect(call.contextTokens).toBe(132_000);
    expect(call.contextPercent).toBeCloseTo(51.2, 1);
  });

  it('uses totalTokens when input/output are missing', async () => {
    const { StreamingManager } = await import('../../streaming.js');

    const slack = {
      chat: {
        update: vi.fn().mockResolvedValue({}),
        postMessage: vi.fn().mockResolvedValue({ ts: 'msg-1' }),
      },
    } as any;

    const codex = new EventEmitter() as any;
    const manager = new StreamingManager(slack, codex);

    const key = 'C456:thread';
    const now = Date.now();

    (manager as any).contexts.set(key, {
      channelId: 'C456',
      threadTs: 'thread',
      originalTs: 'orig',
      messageTs: 'msg',
      userId: 'U456',
      threadId: 'thread-id',
      turnId: 'turn-id',
      approvalPolicy: 'on-request',
      model: 'gpt-5.2-codex',
      reasoningEffort: 'xhigh',
      startTime: now - 1000,
      updateRateMs: 1000,
    });

    (manager as any).states.set(key, {
      text: '',
      isStreaming: true,
      lastUpdateTime: 0,
      updateTimer: null,
      status: 'completed',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      baseInputTokens: undefined,
      baseOutputTokens: undefined,
      baseCacheCreationInputTokens: 0,
      contextWindow: 258_000,
      maxOutputTokens: undefined,
      costUsd: undefined,
      thinkingContent: '',
      thinkingStartTime: 0,
      thinkingComplete: false,
      activeTools: new Map(),
      activityMessageTs: 'msg',
      spinnerIndex: 0,
      pendingAbort: false,
      pendingAbortTimeout: undefined,
      threadParentTs: 'orig',
      activityBatch: [],
      lastActivityPostTime: 0,
      postedBatchTs: null,
      postedBatchToolUseIds: new Set(),
    });

    // Simulate a total-only token update (input/output missing)
    (codex as EventEmitter).emit('tokens:updated', {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 150_000,
      contextWindow: 258_000,
    });

    await (manager as any).updateActivityMessage(key);

    const call = buildActivityBlocks.mock.calls.at(-1)?.[0];
    expect(call).toBeDefined();

    expect(call.contextTokens).toBe(150_000);
    expect(call.contextPercent).toBeCloseTo(58.1, 1);

    buildActivityBlocks.mockClear();

    // Now a full token update arrives with input/output
    (codex as EventEmitter).emit('tokens:updated', {
      inputTokens: 155_000,
      outputTokens: 5_000,
      contextWindow: 258_000,
    });

    await (manager as any).updateActivityMessage(key);

    const followup = buildActivityBlocks.mock.calls.at(-1)?.[0];
    expect(followup).toBeDefined();
    expect(followup.contextTokens).toBe(160_000);
    expect(followup.contextPercent).toBeCloseTo(62.0, 1);
  });
});
