import { describe, it, expect, vi } from 'vitest';
import { updateSourceMessageWithForkLink, restoreForkHereButton } from '../../slack-bot.js';

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

    await updateSourceMessageWithForkLink(client, 'C_SOURCE', '111.222', 'C_FORK', {
      conversationKey: 'C_SOURCE:111.222',
      turnId: 'turn_1',
    });

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
    expect(actionsBlock.elements.some((el: any) => el.action_id?.startsWith('refresh_fork_'))).toBe(true);
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

    await updateSourceMessageWithForkLink(client, 'C_THREAD', replyTs, 'C_FORK', {
      threadTs: parentTs,
      conversationKey: 'C_THREAD:222.000',
      turnId: 'turn_thread_1',
    });

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

  it('restores fork button and removes refresh/context blocks', async () => {
    const sourceMessageTs = '333.444';
    const messageWithRefresh = {
      ts: sourceMessageTs,
      text: 'Activity log',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Activity log' },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: ':twisted_rightwards_arrows: Forked to <#C_FORK>' }],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: 'refresh_fork_C_SOURCE',
              text: { type: 'plain_text', text: '🔄 Refresh fork' },
            },
          ],
        },
      ],
    };

    const client = {
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [messageWithRefresh] }),
        replies: vi.fn(),
      },
      chat: {
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    await restoreForkHereButton(client, {
      sourceChannelId: 'C_SOURCE',
      sourceMessageTs,
      conversationKey: 'C_SOURCE:333.444',
      turnId: 'turn_restore_1',
    });

    const updateCall = client.chat.update.mock.calls[0][0];
    const hasForkContext = updateCall.blocks.some(
      (block: any) =>
        block.type === 'context' &&
        block.elements?.[0]?.text?.includes('Forked to')
    );
    expect(hasForkContext).toBe(false);

    const actionsBlock = updateCall.blocks.find((block: any) => block.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements.some((el: any) => el.action_id?.startsWith('refresh_fork_'))).toBe(false);
    expect(actionsBlock.elements.some((el: any) => el.action_id?.startsWith('fork_'))).toBe(true);
  });
});
