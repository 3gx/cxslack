/**
 * Integration test for thinking/reasoning event handling.
 *
 * KEY FINDING (from SDK live test):
 * - Codex ENCRYPTS thinking content in the `encrypted_content` field
 * - We can only detect WHEN thinking happens, not WHAT is being thought
 * - We receive item/started and item/completed for Reasoning type items
 *
 * DESIGN DECISION:
 * - thinking:started adds activity entry with EARLY timestamp (correct chronological order)
 * - thinking:delta accumulates content and updates char count (fallback adds entry if first)
 * - thinking:complete updates duration on activity entry
 * - postThinkingToThread posts full content on turn completion
 * - This avoids duplicate messages in the thread
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../streaming.js';
import * as ActivityThread from '../../activity-thread.js';

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

  it('thinking:started adds activity entry with early timestamp', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    const beforeTime = Date.now();

    // Emit thinking:started (simulating Reasoning item started)
    codex.emit('thinking:started', { itemId: 'reasoning-item-123' });

    const afterTime = Date.now();

    // Should have set thinkingStartTime
    expect(state.thinkingStartTime).toBeGreaterThan(0);
    expect(state.thinkingItemId).toBe('reasoning-item-123');

    // Should have added activity entry with early timestamp
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry).toBeDefined();
    expect(thinkingEntry?.thinkingInProgress).toBe(true);
    expect(thinkingEntry?.timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(thinkingEntry?.timestamp).toBeLessThanOrEqual(afterTime);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:started before thinking:delta - entry has early timestamp, no duplicates', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    const earlyTime = Date.now();

    // Emit thinking:started first - this adds entry with EARLY timestamp
    codex.emit('thinking:started', { itemId: 'reasoning-123' });
    const entryTimestamp = state.thinkingStartTime;
    expect(entryTimestamp).toBeGreaterThanOrEqual(earlyTime);

    // Simulate some time passing (tools running)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lateTime = Date.now();

    // Then emit thinking:delta - should NOT add duplicate entry
    codex.emit('thinking:delta', { content: 'Some reasoning content...' });

    // Should have accumulated content
    expect(state.thinkingContent).toBe('Some reasoning content...');

    // Should have exactly ONE activity entry (from thinking:started)
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntries = entries.filter((e: any) => e.type === 'thinking');
    expect(thinkingEntries).toHaveLength(1);

    // Entry should have EARLY timestamp (from thinking:started), not late timestamp
    expect(thinkingEntries[0].timestamp).toBe(entryTimestamp);
    expect(thinkingEntries[0].timestamp).toBeLessThan(lateTime);

    // Entry should have updated char count from thinking:delta
    expect(thinkingEntries[0].charCount).toBe(25);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:complete updates activity entry duration', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:started to create entry
    codex.emit('thinking:started', { itemId: 'reasoning-item-789' });

    // Verify entry exists and is in progress
    let entries = activityManager.getEntries(conversationKey);
    let thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry?.thinkingInProgress).toBe(true);

    // Emit thinking:complete
    codex.emit('thinking:complete', { itemId: 'reasoning-item-789', durationMs: 5000 });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have updated the activity entry
    entries = activityManager.getEntries(conversationKey);
    thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry?.thinkingInProgress).toBe(false);
    expect(thinkingEntry?.durationMs).toBe(5000);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:delta adds activity entry as fallback if thinking:started did not fire', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:delta WITHOUT thinking:started first (edge case)
    codex.emit('thinking:delta', { content: 'This is some reasoning content...' });

    // Should have set thinkingStartTime and accumulated content
    expect(state.thinkingStartTime).toBeGreaterThan(0);
    expect(state.thinkingContent).toBe('This is some reasoning content...');

    // Should have added activity entry (fallback behavior)
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    expect(thinkingEntry).toBeDefined();
    expect(thinkingEntry?.thinkingInProgress).toBe(true);
    expect(thinkingEntry?.charCount).toBe(33);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking:delta accumulates content across multiple calls', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;
    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:started first
    codex.emit('thinking:started', { itemId: 'reasoning-multi' });

    // Emit multiple deltas
    codex.emit('thinking:delta', { content: 'First part. ' });
    codex.emit('thinking:delta', { content: 'Second part. ' });
    codex.emit('thinking:delta', { content: 'Third part.' });

    // Should have accumulated all content
    expect(state.thinkingContent).toBe('First part. Second part. Third part.');

    // Should have only ONE activity entry (not four)
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntries = entries.filter((e: any) => e.type === 'thinking');
    expect(thinkingEntries).toHaveLength(1);
    expect(thinkingEntries[0].charCount).toBe(36);

    streaming.stopStreaming(conversationKey);
  });

  it('activity entry timestamp is early even when content arrives late', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const activityManager = (streaming as any).activityManager;

    // Record time before thinking starts
    const beforeThinkingTime = Date.now();

    // Emit thinking:started - entry created with early timestamp
    codex.emit('thinking:started', { itemId: 'reasoning-timing' });

    // Simulate tools running (100ms delay)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Add a tool entry (simulating tool activity during reasoning)
    activityManager.addEntry(conversationKey, {
      type: 'tool',
      timestamp: Date.now(), // This has LATER timestamp
      tool: 'bash',
    });

    const afterToolsTime = Date.now();

    // Now thinking content arrives (late)
    codex.emit('thinking:delta', { content: 'Late arriving content' });

    // Get all entries
    const entries = activityManager.getEntries(conversationKey);
    const thinkingEntry = entries.find((e: any) => e.type === 'thinking');
    const toolEntry = entries.find((e: any) => e.type === 'tool');

    // Thinking entry should have EARLY timestamp (before tools)
    expect(thinkingEntry?.timestamp).toBeLessThan(toolEntry?.timestamp);
    expect(thinkingEntry?.timestamp).toBeGreaterThanOrEqual(beforeThinkingTime);
    expect(thinkingEntry?.timestamp).toBeLessThan(afterToolsTime);

    streaming.stopStreaming(conversationKey);
  });

  it('thinking content is posted on turn:completed even after streaming header was posted', async () => {
    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    const state = (streaming as any).states.get(conversationKey);

    // Emit thinking:started - this sets thinkingPostedDuringStreaming=true after flush
    codex.emit('thinking:started', { itemId: 'reasoning-content-test' });

    // Wait for async mutex flush to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Emit thinking:delta with substantial content (> 100 chars required)
    const thinkingContent = 'This is the actual thinking content that should be posted. '.repeat(5);
    codex.emit('thinking:delta', { content: thinkingContent });

    // Wait for async mutex flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify flag was set during streaming (this is what used to block content posting)
    expect(state.thinkingPostedDuringStreaming).toBe(true);

    // Verify content was accumulated
    expect(state.thinkingContent).toBe(thinkingContent);
    expect(state.thinkingContent.length).toBeGreaterThan(100);

    // Clear mock calls from streaming phase
    (slack.chat.postMessage as any).mockClear();

    // Emit turn:completed - this should post full thinking content
    codex.emit('turn:completed', {
      threadId: context.threadId,
      turnId: context.turnId,
      status: 'completed',
    });

    // Wait for async handlers
    await new Promise((resolve) => setTimeout(resolve, 100));

    // FIX VERIFICATION: postThinkingToThread should have been called
    // It posts thinking content via chat.postMessage with the full content
    const postCalls = (slack.chat.postMessage as any).mock.calls;
    const thinkingPost = postCalls.find((call: any[]) => {
      const text = call[0]?.text || '';
      return text.includes(thinkingContent) || text.includes('Thinking');
    });

    // The fix ensures thinking content is posted even when thinkingPostedDuringStreaming=true
    expect(thinkingPost).toBeDefined();
  });

  it('thinking updates thread message on update-rate cadence', async () => {
    vi.useFakeTimers();
    const thinkingUpdateSpy = vi
      .spyOn(ActivityThread, 'updateThinkingEntryInThread')
      .mockResolvedValue(true);

    const context = createContext();
    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    codex.emit('thinking:started', { itemId: 'reasoning-stream' });
    codex.emit('thinking:delta', { content: 'Streaming thinking content.' });

    // No update until the next update-rate tick
    expect(thinkingUpdateSpy).not.toHaveBeenCalled();

    // Advance timers to trigger updateActivityMessage interval
    await vi.advanceTimersByTimeAsync(context.updateRateMs);
    expect(thinkingUpdateSpy).toHaveBeenCalled();

    streaming.stopStreaming(conversationKey);
    thinkingUpdateSpy.mockRestore();
    vi.useRealTimers();
  });
});
