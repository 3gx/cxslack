/**
 * Unit tests for ApprovalHandler reminders and expiry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { CodexClient, CommandApprovalRequest } from '../../codex-client.js';
import { ApprovalHandler, TOOL_APPROVAL_EXPIRY_MS, TOOL_APPROVAL_REMINDER_INTERVAL_MS } from '../../approval-handler.js';

vi.mock('../../dm-notifications.js', () => ({
  sendDmNotification: vi.fn().mockResolvedValue(undefined),
}));

type SlackMock = {
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

describe('ApprovalHandler reminders', () => {
  let slack: SlackMock;
  let codex: { respondToApproval: ReturnType<typeof vi.fn> };
  let handler: ApprovalHandler;

  beforeEach(() => {
    vi.useFakeTimers();
    slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    codex = {
      respondToApproval: vi.fn().mockResolvedValue(undefined),
    };
    handler = new ApprovalHandler(slack as unknown as WebClient, codex as unknown as CodexClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts reminders at the configured interval', async () => {
    const request: CommandApprovalRequest = {
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        parsedCmd: 'ls -la',
        risk: 'low',
        sandboxed: true,
      },
    };

    await handler.handleApprovalRequest(request, 'C123', '456.789', 'U123');

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1); // initial approval message

    await vi.advanceTimersByTimeAsync(TOOL_APPROVAL_REMINDER_INTERVAL_MS);

    // One reminder should be posted
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    const reminderText = slack.chat.postMessage.mock.calls[1][0].text as string;
    expect(reminderText).toContain('Reminder');
    expect(reminderText).toContain('ls -la');
  });

  it('expires approvals after the configured timeout', async () => {
    const request: CommandApprovalRequest = {
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        parsedCmd: 'pwd',
        risk: 'low',
        sandboxed: true,
      },
    };

    await handler.handleApprovalRequest(request, 'C123', '456.789');

    await vi.advanceTimersByTimeAsync(TOOL_APPROVAL_EXPIRY_MS + TOOL_APPROVAL_REMINDER_INTERVAL_MS);

    expect(codex.respondToApproval).toHaveBeenCalledWith(1, 'decline');
    expect(slack.chat.update).toHaveBeenCalled();
    const updateText = slack.chat.update.mock.calls.at(-1)?.[0].text as string;
    expect(updateText).toContain('Expired');
    expect(handler.pendingCount).toBe(0);
  });

  it('clears reminders after approval decision', async () => {
    const request: CommandApprovalRequest = {
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        parsedCmd: 'whoami',
        risk: 'low',
        sandboxed: true,
      },
    };

    await handler.handleApprovalRequest(request, 'C123', '456.789');
    await handler.handleApprovalDecision(1, 'accept');

    await vi.advanceTimersByTimeAsync(TOOL_APPROVAL_REMINDER_INTERVAL_MS);

    // No reminder should be posted after decision
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});
