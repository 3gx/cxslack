/**
 * Integration test for refresh-fork flow.
 * Ensures the refresh button is added and can restore the fork button.
 */

import { describe, it, expect, vi } from 'vitest';
import { updateSourceMessageWithForkLink, restoreForkHereButton } from '../../slack-bot.js';

describe('Refresh Fork Flow', () => {
  it('adds refresh button and restores fork button when requested', async () => {
    const sourceMessageTs = '555.666';
    const originalMessage = {
      ts: sourceMessageTs,
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
              action_id: 'fork_C_SOURCE_turn_1',
              text: { type: 'plain_text', text: 'Fork here' },
            },
          ],
        },
      ],
    };

    let messages = [originalMessage];

    const client = {
      conversations: {
        history: vi.fn().mockImplementation(() => ({ messages })),
        replies: vi.fn(),
      },
      chat: {
        update: vi.fn().mockImplementation(({ blocks, text }: { blocks: any[]; text: string }) => {
          messages = [{ ...messages[0], blocks, text }];
          return { ok: true };
        }),
      },
    };

    await updateSourceMessageWithForkLink(client, 'C_SOURCE', sourceMessageTs, 'C_FORK', {
      conversationKey: 'C_SOURCE:555.666',
      turnId: 'turn_1',
    });

    const updated = messages[0];
    const refreshButtonPresent = updated.blocks.some(
      (block: any) =>
        block.type === 'actions' &&
        block.elements?.some((el: any) => el.action_id?.startsWith('refresh_fork_'))
    );
    expect(refreshButtonPresent).toBe(true);

    await restoreForkHereButton(client, {
      sourceChannelId: 'C_SOURCE',
      sourceMessageTs,
      conversationKey: 'C_SOURCE:555.666',
      turnId: 'turn_1',
    });

    const restored = messages[0];
    const forkButtonPresent = restored.blocks.some(
      (block: any) =>
        block.type === 'actions' &&
        block.elements?.some((el: any) => el.action_id?.startsWith('fork_'))
    );
    const refreshButtonStillPresent = restored.blocks.some(
      (block: any) =>
        block.type === 'actions' &&
        block.elements?.some((el: any) => el.action_id?.startsWith('refresh_fork_'))
    );

    expect(forkButtonPresent).toBe(true);
    expect(refreshButtonStillPresent).toBe(false);
  });
});
