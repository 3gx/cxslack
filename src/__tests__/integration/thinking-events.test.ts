/**
 * Integration test for thinking/reasoning event handling.
 *
 * KEY FINDING (from SDK live test):
 * - Codex ENCRYPTS thinking content in the `encrypted_content` field
 * - We can only detect WHEN thinking happens, not WHAT is being thought
 * - We receive item/started and item/completed for Reasoning type items
 *
 * DESIGN DECISION:
 * - thinking:started/complete only track timing - NO thread messages
 * - thinking:delta accumulates content and adds activity entry
 * - postThinkingToThread posts full content on turn completion
 * - This avoids duplicate messages in the thread
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../streaming.js';

function createSlackMock() {
  return {
    chat: {
      update: vi.fn().mockResolvedValue({ ts: '123.456' }),
      postMessage: vi.fn().mockResolvedValue({ ts: 'thinking.msg.ts' }),
    },
  } as unknown as WebClient;
}

function createContext(): StreamingContext {
  return {
    channelId: 'C123',
    threadTs: '123.456',
    messageTs: '123.456',
    originalTs: '123.456',
    userId: 'U123',
    threadId: 'thread-abc',
    turnId: 'turn-1',
    approvalPolicy: 'on-request',
    reasoningEffort: 'high',
    updateRateMs: 1000,
    model: 'codex-mini',
    startTime: Date.now() - 3000,
  };
}

describe('Thinking/Reasoning Events', () => {
  let slack: WebClient;
  let codex: EventEmitter;
  let streaming: StreamingManager;

  beforeEach(() => {
    slack = createSlackMock();
    codex = new EventEmitter();
    streaming = new StreamingManager(slack, codex as unknown as CodexClient);
  });

  it('thinking:started tracks timing but does NOT post thread messages', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:started (simulating Reasoning item started)
    codex.emit('thinking:started', { itemId: 'reasoning-item-123' });

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have set thinkingStartTime
    expect(state.thinkingStartTime).toBeGreaterThan(0);
    expect(state.thinkingItemId).toBe('reasoning-item-123');

    // Should NOT have posted any messages (postThinkingToThread handles that on completion)
    expect(slack.chat.postMessage).not.toHaveBeenCalled();

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:complete updates activity entry duration', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    // Simulate thinking:delta adding an activity entry
    activityManager.addEntry(conversationKey, {
      type: 'thinking',
      timestamp: Date.now(),
      thinkingInProgress: true,
    });
    state.thinkingStartTime = Date.now() - 5000;
    state.thinkingItemId = 'reasoning-item-789';

    // Emit thinking:complete
    codex.emit('thinking:complete', { itemId: 'reasoning-item-789', durationMs: 5000 });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have updated the activity entry
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry?.thinkingInProgress).toBe(false);
    expect(thinkingEntry?.durationMs).toBe(5000);

    // Note: chat.update may be called for the activity panel (timer-based updates)
    // but thinking:complete does NOT post separate thinking messages

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:delta adds activity entry and accumulates content', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:delta
    codex.emit('thinking:delta', { content: 'This is some reasoning content...' });

    // Should have set thinkingStartTime and accumulated content
    expect(state.thinkingStartTime).toBeGreaterThan(0);
    expect(state.thinkingContent).toBe('This is some reasoning content...');

    // Should have added activity entry
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry).toBeDefined();
    expect(thinkingEntry?.thinkingInProgress).toBe(true);
    expect(thinkingEntry?.charCount).toBe(33);

    // Should NOT have posted thread messages
    expect(slack.chat.postMessage).not.toHaveBeenCalled();

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:delta accumulates content across multiple calls', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    // Emit multiple deltas
    codex.emit('thinking:delta', { content: 'First part. ' });
    codex.emit('thinking:delta', { content: 'Second part. ' });
    codex.emit('thinking:delta', { content: 'Third part.' });

    // Should have accumulated all content
    expect(state.thinkingContent).toBe('First part. Second part. Third part.');

    // Should have only ONE activity entry (not three)
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntries = entries.filter((e: any) => e.type === 'thinking');
    expect(thinkingEntries).toHaveLength(1);
    expect(thinkingEntries[0].charCount).toBe(36);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:started before thinking:delta prevents duplicate entries', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:started first (sets thinkingStartTime)
    codex.emit('thinking:started', { itemId: 'reasoning-123' });
    expect(state.thinkingStartTime).toBeGreaterThan(0);

    // Then emit thinking:delta - should NOT add duplicate entry
    // because thinkingStartTime is already set
    codex.emit('thinking:delta', { content: 'Some content' });

    // Should have only accumulated content, not added entry
    expect(state.thinkingContent).toBe('Some content');

    // No activity entry should exist (thinking:started doesn't add one,
    // and thinking:delta sees thinkingStartTime already set)
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntries = entries.filter((e: any) => e.type === 'thinking');
    expect(thinkingEntries).toHaveLength(0);

    streaming.stopStreaming(conversationKey);
  });
});
