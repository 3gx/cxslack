/**
 * Integration test for startTurn failure cleanup.
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
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
  } as unknown as WebClient;
}

describe('startTurn failure cleanup', () => {
  it('updates activity message and removes abort button', async () => {
    const slack = createSlackMock();
    const codex = new EventEmitter() as unknown as CodexClient;
    const streaming = new StreamingManager(slack, codex);

    const context: StreamingContext = {
      channelId: 'C123',
      threadTs: '123.456',
      messageTs: '123.456',
      originalTs: '111.222',
      userId: 'U123',
      threadId: 'thread-abc',
      turnId: '',
      approvalPolicy: 'on-request',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      updateRateMs: 1000,
      model: 'codex-mini',
      startTime: Date.now() - 1000,
    };

    streaming.startStreaming(context);
    const conversationKey = makeConversationKey(context.channelId, context.threadTs);

    await streaming.failTurnStart(conversationKey, 'Codex unavailable');

    const updateCall = (slack.chat.update as any).mock.calls.at(-1)?.[0];
    expect(updateCall).toBeDefined();

    const blocks = updateCall.blocks as Array<{ type: string; text?: { text?: string }; elements?: Array<{ action_id?: string }> }>;
    const section = blocks.find((block) => block.type === 'section');
    expect(section?.text?.text).toContain('Codex unavailable');

    const hasAbort = blocks.some(
      (block) =>
        block.type === 'actions' &&
        block.elements?.some((el) => el.action_id?.startsWith('abort_'))
    );
    expect(hasAbort).toBe(false);

    // State should be cleaned up after failure
    expect((streaming as any).states.has(conversationKey)).toBe(false);
  });
});
