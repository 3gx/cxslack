/**
 * Unit tests for command handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodexClient } from '../../codex-client.js';
import {
  handlePolicyCommand,
  handleModelCommand,
  type CommandContext,
} from '../../commands.js';

vi.mock('../../session-manager.js', () => ({
  getEffectiveApprovalPolicy: vi.fn(() => 'on-request'),
  getSession: vi.fn(() => ({ model: 'model-a', reasoningEffort: 'high' })),
  getThreadSession: vi.fn(() => null),
  saveSession: vi.fn(),
  saveThreadSession: vi.fn(),
  clearSession: vi.fn(),
  getEffectiveWorkingDir: vi.fn(() => '/tmp'),
  APPROVAL_POLICIES: ['never', 'on-request', 'on-failure', 'untrusted'],
}));

describe('Command Handlers', () => {
  const baseContext: CommandContext = {
    channelId: 'C123',
    threadTs: '123.456',
    userId: 'U123',
    text: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows policy selection prompt when no args', async () => {
    const result = await handlePolicyCommand({ ...baseContext, text: '' }, {} as CodexClient);

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0].text?.text).toContain('Select Approval Policy');
  });

  it('returns error for invalid policy', async () => {
    const result = await handlePolicyCommand({ ...baseContext, text: 'invalid' }, {} as CodexClient);

    expect(result.text).toContain('Invalid policy');
  });

  it('shows model selection prompt (no args)', async () => {
    const codex = {
      listModels: vi.fn().mockResolvedValue(['model-a', 'model-b']),
    } as unknown as CodexClient;

    const result = await handleModelCommand({ ...baseContext, text: '' }, codex);

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0].text?.text).toContain('Select Model');
  });

  it('shows model selection prompt even with args', async () => {
    const codex = {
      listModels: vi.fn().mockResolvedValue(['model-a', 'model-b']),
    } as unknown as CodexClient;

    const result = await handleModelCommand({ ...baseContext, text: 'model-b' }, codex);

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks[0].text?.text).toContain('Select Model');
  });

  it('falls back to bundled models when listModels returns empty', async () => {
    const codex = {
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as CodexClient;

    const result = await handleModelCommand({ ...baseContext, text: '' }, codex);

    expect(JSON.stringify(result.blocks)).toContain('gpt-5.2-codex');
  });
}); 
