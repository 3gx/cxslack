/**
 * Integration test for thinking/reasoning event handling.
 *
 * KEY FINDING (from SDK live test):
 * - Codex ENCRYPTS thinking content in the `encrypted_content` field
 * - We can only detect WHEN thinking happens, not WHAT is being thought
 * - We receive item/started and item/completed for Reasoning type items
 * - The thinking:started and thinking:complete events are used to show "Thinking..." activity
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

  it('thinking:started posts placeholder message to thread', async () => {
    const context = createContext();
    streaming.startStreaming(context);

    // Emit thinking:started (simulating Reasoning item started)
    codex.emit('thinking:started', { itemId: 'reasoning-item-123' });

    // Wait for async postMessage
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have posted a thinking placeholder
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '123.456',
        text: ':brain: _Thinking..._',
      })
    );

    streaming.stopStreaming(makeConversationKey(context.channelId, context.threadTs));
  });

  it('thinking:started adds thinking entry to activity', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    // Get activity manager
    const activityManager = (streaming as any).activityManager;

    // Emit thinking:started
    codex.emit('thinking:started', { itemId: 'reasoning-item-456' });

    // Check activity entries
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntry = entries.find((e: any) => e.type === 'thinking');

    expect(thinkingEntry).toBeDefined();
    expect(thinkingEntry?.thinkingInProgress).toBe(true);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:complete updates message with duration', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    // Manually set state as if thinking:started was emitted
    const state = (streaming as any).states.get(conversationKey);
    state.thinkingStartTime = Date.now() - 5000; // 5 seconds ago
    state.thinkingItemId = 'reasoning-item-789';
    state.thinkingMessageTs = 'thinking.msg.ts';

    // Emit thinking:complete
    codex.emit('thinking:complete', { itemId: 'reasoning-item-789', durationMs: 5000 });

    // Wait for async update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have updated the thinking message
    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        ts: 'thinking.msg.ts',
        text: expect.stringContaining(':brain: _Thinking complete_'),
      })
    );

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:complete marks activity entry as not in progress', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;

    // Emit thinking:started first
    codex.emit('thinking:started', { itemId: 'reasoning-item-101' });

    // Verify in progress
    let entries = activityManager.getEntries(conversationKey);
    let thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry?.thinkingInProgress).toBe(true);

    // Emit thinking:complete
    codex.emit('thinking:complete', { itemId: 'reasoning-item-101', durationMs: 3000 });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify not in progress and has duration
    entries = activityManager.getEntries(conversationKey);
    thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry?.thinkingInProgress).toBe(false);
    expect(thinkingEntry?.durationMs).toBe(3000);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:delta still works if Codex sends content (future-proofing)', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:delta (rare, but possible if Codex changes behavior)
    codex.emit('thinking:delta', { content: 'This is some reasoning content...' });

    // Should have set thinkingStartTime and accumulated content
    expect(state.thinkingStartTime).toBeGreaterThan(0);
    expect(state.thinkingContent).toBe('This is some reasoning content...');

    streaming.stopStreaming(conversationKey);
  });

  it('encrypted thinking content shows appropriate message', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    // Setup state for complete event (no content accumulated = encrypted)
    const state = (streaming as any).states.get(conversationKey);
    state.thinkingStartTime = Date.now() - 2000;
    state.thinkingItemId = 'reasoning-encrypted';
    state.thinkingMessageTs = 'thinking.msg.ts';
    state.thinkingContent = ''; // No content received (encrypted)

    // Emit thinking:complete
    codex.emit('thinking:complete', { itemId: 'reasoning-encrypted', durationMs: 2000 });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should show "(content encrypted)" message
    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('_(content encrypted)_'),
      })
    );

    streaming.stopStreaming(conversationKey);
  });
});
