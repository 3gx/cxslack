/**
 * Regression test: activity status line should use per-turn token deltas,
 * not cumulative thread totals (avoids 5M/0% context displays).
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
  it('uses per-turn deltas instead of cumulative totals', async () => {
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
      // Cumulative totals from Codex (before baseline)
      inputTokens: 5_010_000,
      outputTokens: 5_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      baseInputTokens: 5_000_000, // baseline captured at start of turn
      baseOutputTokens: 0,
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

    // Should use delta: (5,010,000 - 5,000,000) + (5,000 - 0) = 15,000
    expect(call.contextTokens).toBe(15_000);
    // Context percent should reflect ~5.8% used, not 0% left
    expect(call.contextPercent).toBeCloseTo(5.8, 1);
    // Token stats passed to status line should also use deltas
    expect(call.inputTokens).toBe(10_000);
    expect(call.outputTokens).toBe(5_000);
  });
});
