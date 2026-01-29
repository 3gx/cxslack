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
});
