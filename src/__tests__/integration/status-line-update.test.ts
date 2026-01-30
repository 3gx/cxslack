/**
 * Integration test for streaming status line + spinner.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { WebClient } from '@slack/web-api';
import type { CodexClient } from '../../codex-client.js';
import { StreamingManager, makeConversationKey, type StreamingContext } from '../../streaming.js';

function createSlackMock() {
  return {
    chat: {
      update: vi.fn().mockResolvedValue({ ts: '123.456' }),
      postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
    },
  } as unknown as WebClient;
}

describe('Streaming status line', () => {
  it('includes spinner and policy/model/session line', async () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);

    const context: StreamingContext = {
      channelId: 'C123',
      threadTs: '123.456',
      messageTs: '123.456',
      originalTs: '123.456',
      userId: 'U123',
      threadId: 'thread-abc',
      turnId: 'turn-1',
      approvalPolicy: 'on-request',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      updateRateMs: 1000,
      model: 'codex-mini',
      startTime: Date.now() - 3000,
    };

    streaming.startStreaming(context);

    (codex as EventEmitter).emit('tokens:updated', {
      inputTokens: 1000,
      outputTokens: 200,
    });

    const conversationKey = makeConversationKey(context.channelId, context.threadTs);
    await (streaming as unknown as { updateActivityMessage: (k: string) => Promise<void> }).updateActivityMessage(
      conversationKey
    );

    const call = (slack.chat.update as any).mock.calls[0][0];
    const blocks = call.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;

    expect(blocks[1].elements?.[0].text).toContain('['); // spinner line
    expect(blocks[2].elements?.[0].text).toContain('on-request');
    expect(blocks[2].elements?.[0].text).toContain('codex-mini [high]');
    expect(blocks[2].elements?.[0].text).toContain('thread-abc');

    streaming.stopStreaming(conversationKey);
  });

  it('status line does not include activity labels (Generating/Thinking)', async () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);

    const context: StreamingContext = {
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
      startTime: Date.now() - 5000,
    };

    streaming.startStreaming(context);

    // Simulate text content being generated (which would trigger "Generating" activity)
    const state = (streaming as any).states.get(makeConversationKey(context.channelId, context.threadTs));
    if (state) {
      state.text = 'Some generated response text here...';
      state.isStreaming = true;
    }

    (codex as EventEmitter).emit('tokens:updated', {
      inputTokens: 5000,
      outputTokens: 1000,
      contextWindow: 200000,
    });

    const conversationKey = makeConversationKey(context.channelId, context.threadTs);
    await (streaming as unknown as { updateActivityMessage: (k: string) => Promise<void> }).updateActivityMessage(
      conversationKey
    );

    const call = (slack.chat.update as any).mock.calls[0][0];
    const blocks = call.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;

    // Status line is in blocks[2] (after activity content and spinner)
    const statusLineText = blocks[2].elements?.[0].text || '';

    // Status line must NOT include activity labels
    expect(statusLineText).not.toContain('Generating');
    expect(statusLineText).not.toContain('Thinking');
    expect(statusLineText).not.toContain(':memo:');
    expect(statusLineText).not.toContain(':brain:');

    // Status line SHOULD include policy/model/session/stats
    expect(statusLineText).toContain('on-request');
    expect(statusLineText).toContain('codex-mini [high]');
    expect(statusLineText).toContain('workspace-write');
    expect(statusLineText).toContain('thread-abc');

    streaming.stopStreaming(conversationKey);
  });

  it('status line remains clean after turn completion (no stale Generating)', async () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);

    const context: StreamingContext = {
      channelId: 'C123',
      threadTs: '123.789',
      messageTs: '123.789',
      originalTs: '123.789',
      userId: 'U123',
      threadId: 'thread-xyz',
      turnId: 'turn-2',
      approvalPolicy: 'auto-edit',
      reasoningEffort: 'xhigh',
      sandboxMode: 'workspace-write',
      updateRateMs: 1000,
      model: 'gpt-5.2-codex',
      startTime: Date.now() - 10000,
    };

    streaming.startStreaming(context);

    const conversationKey = makeConversationKey(context.channelId, context.threadTs);
    const state = (streaming as any).states.get(conversationKey);
    if (state) {
      state.text = 'Final response content';
      state.isStreaming = false; // Turn completed
      state.status = 'completed';
      state.inputTokens = 10000;
      state.outputTokens = 2000;
      state.activityMessageTs = '123.789'; // Ensure update (not post)
    }

    await (streaming as unknown as { updateActivityMessage: (k: string) => Promise<void> }).updateActivityMessage(
      conversationKey
    );

    const call = (slack.chat.update as any).mock.calls[0][0];
    const blocks = call.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;
    // Find the status line block (context section with policy/model info)
    const statusLineBlock = blocks.find(b => b.elements?.[0]?.text?.includes('auto-edit'));
    const statusLineText = statusLineBlock?.elements?.[0]?.text || '';

    // After completion, status line must NOT show "Generating"
    expect(statusLineText).not.toContain('Generating');
    expect(statusLineText).not.toContain('Thinking');
    expect(statusLineText).not.toContain(':memo:');
    expect(statusLineText).not.toContain(':brain:');

    // Should show expected metadata
    expect(statusLineText).toContain('auto-edit');
    expect(statusLineText).toContain('gpt-5.2-codex [xhigh]');
    expect(statusLineText).toContain('workspace-write');
    expect(statusLineText).toContain('thread-xyz');

    streaming.stopStreaming(conversationKey);
  });
});
