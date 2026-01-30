import { describe, it, expect, vi } from 'vitest';
import { updateSourceMessageWithForkLink } from '../../slack-bot.js';

function buildMessage(ts: string) {
  return {
    ts,
    text: 'Activity log',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Activity log' },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'fork_C123_turn_1',
            text: { type: 'plain_text', text: 'Fork here' },
          },
          {
            type: 'button',
            action_id: 'other_action',
            text: { type: 'plain_text', text: 'Other' },
          },
        ],
      },
    ],
  };
}

describe('updateSourceMessageWithForkLink', () => {
  it('updates a channel message and preserves non-fork buttons', async () => {
    const message = buildMessage('111.222');
    const client = {
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [message] }),
        replies: vi.fn(),
      },
      chat: {
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    await updateSourceMessageWithForkLink(client, 'C_SOURCE', '111.222', 'C_FORK');

    expect(client.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_SOURCE',
        latest: '111.222',
        inclusive: true,
        limit: 1,
      })
    );
    expect(client.conversations.replies).not.toHaveBeenCalled();

    const updateCall = client.chat.update.mock.calls[0][0];
    expect(updateCall.channel).toBe('C_SOURCE');
    expect(updateCall.ts).toBe('111.222');

    const contextBlock = updateCall.blocks.find(
      (block: any) =>
        block.type === 'context' &&
        block.elements?.[0]?.text?.includes('Forked to <#C_FORK>')
    );
    expect(contextBlock).toBeDefined();

    const actionsBlock = updateCall.blocks.find((block: any) => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements.some((el: any) => el.action_id?.startsWith('fork_'))).toBe(false);
    expect(actionsBlock.elements.some((el: any) => el.action_id === 'other_action')).toBe(true);
  });

  it('uses conversations.replies for thread messages and targets the reply', async () => {
    const parentTs = '222.000';
    const replyTs = '222.111';
    const parentMessage = { ts: parentTs, text: 'Parent', blocks: [] };
    const replyMessage = buildMessage(replyTs);
    const client = {
      conversations: {
        history: vi.fn(),
        replies: vi.fn().mockResolvedValue({ messages: [parentMessage, replyMessage] }),
      },
      chat: {
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    await updateSourceMessageWithForkLink(client, 'C_THREAD', replyTs, 'C_FORK', parentTs);

    expect(client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_THREAD',
        ts: parentTs,
      })
    );
    expect(client.conversations.history).not.toHaveBeenCalled();

    const updateCall = client.chat.update.mock.calls[0][0];
    expect(updateCall.ts).toBe(replyTs);
    const contextBlock = updateCall.blocks.find(
      (block: any) =>
        block.type === 'context' &&
        block.elements?.[0]?.text?.includes('Forked to <#C_FORK>')
    );
    expect(contextBlock).toBeDefined();
  });
});
