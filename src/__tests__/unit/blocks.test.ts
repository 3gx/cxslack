/**
 * Unit tests for Block Kit builders.
 */

import { describe, it, expect } from 'vitest';
import {
  buildStatusBlocks,
  buildHeaderBlock,
  buildCommandApprovalBlocks,
  buildFileChangeApprovalBlocks,
  buildApprovalGrantedBlocks,
  buildApprovalDeniedBlocks,
  buildPolicyStatusBlocks,
  buildPolicySelectionBlocks,
  buildClearBlocks,
  buildTextBlocks,
  buildErrorBlocks,
  buildUnifiedStatusLine,
  buildAbortConfirmationModalView,
  buildActivityBlocks,
  buildModelSelectionBlocks,
} from '../../blocks.js';

describe('Block Kit Builders', () => {
  describe('buildStatusBlocks', () => {
    it('builds processing status with abort button', () => {
      const blocks = buildStatusBlocks({
        status: 'processing',
        conversationKey: 'C123:456.789',
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('Processing');
      expect(blocks[1].type).toBe('actions');
    });

    it('builds processing status without abort button when no key', () => {
      const blocks = buildStatusBlocks({ status: 'processing' });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Processing');
    });

    it('builds aborted status with octagonal_sign emoji', () => {
      const blocks = buildStatusBlocks({ status: 'aborted' });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain(':octagonal_sign:');
      expect(blocks[0].text?.text).toContain('Aborted');
    });

    it('builds complete status without duration', () => {
      const blocks = buildStatusBlocks({ status: 'complete' });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain(':white_check_mark:');
      expect(blocks[0].text?.text).toContain('Complete');
    });

    it('builds complete status with duration', () => {
      const blocks = buildStatusBlocks({ status: 'complete', durationMs: 5500 });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain(':white_check_mark:');
      expect(blocks[0].text?.text).toContain('Complete');
      expect(blocks[0].text?.text).toContain('5.5s');
    });

    it('builds error status with message', () => {
      const blocks = buildStatusBlocks({
        status: 'error',
        errorMessage: 'Something went wrong',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Error');
      expect(blocks[0].text?.text).toContain('Something went wrong');
    });
  });

  describe('buildHeaderBlock', () => {
    it('includes status emoji and policy badge', () => {
      const block = buildHeaderBlock({
        status: 'processing',
        approvalPolicy: 'on-request',
      });

      expect(block.type).toBe('section');
      expect(block.text?.text).toContain('Processing');
      expect(block.text?.text).toContain('on-request');
    });

    it('includes model when provided', () => {
      const block = buildHeaderBlock({
        status: 'complete',
        approvalPolicy: 'never',
        model: 'gpt-4',
      });

      expect(block.text?.text).toContain('gpt-4');
    });

    it('includes duration when complete', () => {
      const block = buildHeaderBlock({
        status: 'complete',
        approvalPolicy: 'on-request',
        durationMs: 5500,
      });

      expect(block.text?.text).toContain('5.5s');
    });

    it('includes error message when error', () => {
      const block = buildHeaderBlock({
        status: 'error',
        approvalPolicy: 'on-request',
        errorMessage: 'Test error',
      });

      expect(block.text?.text).toContain('Test error');
    });
  });

  describe('buildCommandApprovalBlocks', () => {
    it('builds approval request with command preview', () => {
      const blocks = buildCommandApprovalBlocks({
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        parsedCmd: 'rm -rf /tmp/test',
        risk: 'high',
        sandboxed: false,
        requestId: 123,
      });

      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(blocks[0].text?.text).toContain('rm -rf /tmp/test');
      expect(blocks[1].elements?.[0].type).toBe('mrkdwn');
    });

    it('includes approve and deny buttons', () => {
      const blocks = buildCommandApprovalBlocks({
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        parsedCmd: 'ls',
        risk: 'low',
        sandboxed: true,
        requestId: 456,
      });

      const actionsBlock = blocks.find((b) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock?.elements).toHaveLength(2);

      const approveBtn = actionsBlock?.elements?.[0] as { action_id: string };
      const denyBtn = actionsBlock?.elements?.[1] as { action_id: string };

      expect(approveBtn.action_id).toContain('approve');
      expect(denyBtn.action_id).toContain('deny');
    });
  });

  describe('buildFileChangeApprovalBlocks', () => {
    it('builds file change approval request', () => {
      const blocks = buildFileChangeApprovalBlocks({
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        filePath: '/src/index.ts',
        reason: 'Add new feature',
        requestId: 789,
      });

      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks[0].text?.text).toContain('/src/index.ts');
      expect(blocks[0].text?.text).toContain('Add new feature');
    });
  });

  describe('buildApprovalGrantedBlocks', () => {
    it('builds granted message without command', () => {
      const blocks = buildApprovalGrantedBlocks();

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Approved');
    });

    it('builds granted message with command', () => {
      const blocks = buildApprovalGrantedBlocks('npm install');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Approved');
      expect(blocks[0].text?.text).toContain('npm install');
    });
  });

  describe('buildApprovalDeniedBlocks', () => {
    it('builds denied message', () => {
      const blocks = buildApprovalDeniedBlocks('dangerous command');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Denied');
      expect(blocks[0].text?.text).toContain('dangerous command');
    });
  });

  describe('buildPolicyStatusBlocks', () => {
    it('shows current policy when no change', () => {
      const blocks = buildPolicyStatusBlocks({
        currentPolicy: 'on-request',
      });

      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks[0].text?.text).toContain('on-request');
      expect(blocks[0].text?.text).toContain('Model decides');
    });

    it('shows policy change when newPolicy provided', () => {
      const blocks = buildPolicyStatusBlocks({
        currentPolicy: 'on-request',
        newPolicy: 'never',
      });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('on-request');
      expect(blocks[0].text?.text).toContain('never');
    });
  });

  describe('buildPolicySelectionBlocks', () => {
    it('shows selection buttons and current policy', () => {
      const blocks = buildPolicySelectionBlocks('on-request');

      expect(blocks[0].text?.text).toContain('Select Approval Policy');
      expect(blocks[0].text?.text).toContain('on-request');
      expect(blocks[1].type).toBe('actions');
      const actions = blocks[1].elements as Array<{ action_id: string; style?: string }>;
      expect(actions.map((a) => a.action_id)).toContain('policy_select_on-request');
      const current = actions.find((a) => a.action_id === 'policy_select_on-request');
      expect(current?.style).toBe('primary');
    });
  });

  describe('buildModelSelectionBlocks', () => {
    it('renders model and reasoning selectors', () => {
      const blocks = buildModelSelectionBlocks({
        availableModels: ['model-a', 'model-b'],
        currentModel: 'model-b',
        currentReasoning: 'high',
      });

      expect(blocks[0].text?.text).toContain('Select Model & Reasoning');
      expect(blocks[0].text?.text).toContain('model-b');
      expect(blocks[1].type).toBe('actions');
      const elements = blocks[1].elements as Array<{ action_id: string }>;
      expect(elements.map((e) => e.action_id)).toContain('model_select');
      expect(elements.map((e) => e.action_id)).toContain('reasoning_select');
    });

    it('shows warning when model list is empty', () => {
      const blocks = buildModelSelectionBlocks({
        availableModels: [],
      });

      const warning = blocks.find((b) => b.type === 'section' && b.text?.text.includes('Model list unavailable'));
      expect(warning).toBeDefined();
    });
  });

  describe('buildClearBlocks', () => {
    it('builds clear confirmation', () => {
      const blocks = buildClearBlocks();

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('cleared');
    });
  });

  describe('buildTextBlocks', () => {
    it('wraps short text in single block', () => {
      const blocks = buildTextBlocks('Hello, world!');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toBe('Hello, world!');
    });

    it('splits long text into multiple blocks', () => {
      const longText = 'A'.repeat(3500);
      const blocks = buildTextBlocks(longText);

      expect(blocks.length).toBeGreaterThan(1);

      // Verify all text is preserved
      const totalText = blocks.map((b) => b.text?.text || '').join('');
      expect(totalText).toBe(longText);
    });

    it('includes expand: true to prevent Slack collapse', () => {
      const blocks = buildTextBlocks('Test message');

      expect(blocks).toHaveLength(1);
      expect((blocks[0] as unknown as { expand: boolean }).expand).toBe(true);
    });

    it('includes expand: true on all blocks for long text', () => {
      const longText = 'A'.repeat(3500);
      const blocks = buildTextBlocks(longText);

      expect(blocks.length).toBeGreaterThan(1);
      for (const block of blocks) {
        expect((block as unknown as { expand: boolean }).expand).toBe(true);
      }
    });
  });

  describe('buildErrorBlocks', () => {
    it('builds error message block', () => {
      const blocks = buildErrorBlocks('Something went wrong');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Error');
      expect(blocks[0].text?.text).toContain('Something went wrong');
    });
  });

  describe('buildUnifiedStatusLine', () => {
    it('formats status line with all fields', () => {
      const line = buildUnifiedStatusLine({
        approvalPolicy: 'on-request',
        model: 'codex-mini',
        reasoningEffort: 'high',
        sessionId: 'thread-123',
        contextPercent: 42.5,
        compactPercent: 25.1,
        tokensToCompact: 67516,
        inputTokens: 1250,
        outputTokens: 542,
        costUsd: 0.05,
        durationMs: 5200,
      });

      expect(line).toContain('on-request');
      expect(line).toContain('codex-mini [high]');
      expect(line).toContain('thread-123');
      expect(line).toContain('42.5% ctx');
      expect(line).toContain('25.1%');
      expect(line).toContain('67.5k tok to :zap:');
      expect(line).toContain('1.3k/542');
      expect(line).toContain('$0.05');
      expect(line).toContain('5.2s');
      expect(line.startsWith('_')).toBe(true);
      expect(line.trimEnd().endsWith('_')).toBe(true);
    });

    it('omits missing optional fields', () => {
      const line = buildUnifiedStatusLine({
        approvalPolicy: 'never',
      });

      expect(line).toContain('never');
      expect(line).toContain('default');
      expect(line).toContain('n/a');
    });

    it('formats token counts correctly', () => {
      const line = buildUnifiedStatusLine({
        approvalPolicy: 'on-request',
        inputTokens: 0,
        outputTokens: 100,
      });

      expect(line).toContain('0/100');
    });
  });

  describe('buildAbortConfirmationModalView', () => {
    it('builds modal with correct callback_id', () => {
      const modal = buildAbortConfirmationModalView({
        conversationKey: 'C123:456.789',
        channelId: 'C123',
        messageTs: '456.789',
      });

      expect(modal.type).toBe('modal');
      expect(modal.callback_id).toBe('abort_confirmation_modal');
    });

    it('includes private_metadata with params', () => {
      const modal = buildAbortConfirmationModalView({
        conversationKey: 'C123:456.789',
        channelId: 'C123',
        messageTs: '456.789',
      });

      const metadata = JSON.parse(modal.private_metadata);
      expect(metadata.conversationKey).toBe('C123:456.789');
      expect(metadata.channelId).toBe('C123');
      expect(metadata.messageTs).toBe('456.789');
    });

    it('has Abort submit button', () => {
      const modal = buildAbortConfirmationModalView({
        conversationKey: 'test',
        channelId: 'C123',
        messageTs: '456.789',
      });

      expect(modal.submit.text).toBe('Abort');
      expect(modal.close.text).toBe('Cancel');
    });

    it('includes warning message', () => {
      const modal = buildAbortConfirmationModalView({
        conversationKey: 'test',
        channelId: 'C123',
        messageTs: '456.789',
      });

      expect(modal.blocks).toHaveLength(1);
      expect(modal.blocks[0].text?.text).toContain('interrupt');
    });
  });

  describe('buildActivityBlocks', () => {
    const baseParams = {
      approvalPolicy: 'on-request' as const,
      model: 'codex-mini',
      sessionId: 'thread-123',
    };

    it('builds activity blocks with running status and abort button', () => {
      const blocks = buildActivityBlocks({
        activityText: ':gear: Processing...',
        status: 'running',
        conversationKey: 'C123:456.789',
        elapsedMs: 5000,
        ...baseParams,
      });

      // Should have 4 blocks: section, spinner, status, actions
      expect(blocks).toHaveLength(4);
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('Processing');
      expect(blocks[1].type).toBe('context');
      expect(blocks[1].elements?.[0].text).toContain('[');
      expect(blocks[2].type).toBe('context');
      expect(blocks[2].elements?.[0].text).toContain('on-request');
      expect(blocks[2].elements?.[0].text).toContain('codex-mini');
      expect(blocks[1].elements?.[0].text).toContain('5.0s');
      expect(blocks[3].type).toBe('actions');
    });

    it('builds activity blocks with completed status (no abort button)', () => {
      const blocks = buildActivityBlocks({
        activityText: ':white_check_mark: Done',
        status: 'completed',
        conversationKey: 'C123:456.789',
        elapsedMs: 3500,
        ...baseParams,
      });

      // Should have 2 blocks: section, context (status) - NO actions
      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('section');
      expect(blocks[1].type).toBe('context');
      expect(blocks[1].elements?.[0].text).toContain('on-request');
      expect(blocks[1].elements?.[0].text).toContain('3.5s');
    });

    it('builds activity blocks with interrupted status', () => {
      const blocks = buildActivityBlocks({
        activityText: ':octagonal_sign: Stopped',
        status: 'interrupted',
        conversationKey: 'C123:456.789',
        elapsedMs: 2000,
        ...baseParams,
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].text?.text).toContain('Stopped');
      expect(blocks[1].elements?.[0].text).toContain('on-request');
    });

    it('builds activity blocks with failed status', () => {
      const blocks = buildActivityBlocks({
        activityText: ':x: Error occurred',
        status: 'failed',
        conversationKey: 'C123:456.789',
        elapsedMs: 1000,
        ...baseParams,
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0].text?.text).toContain('Error occurred');
      expect(blocks[1].elements?.[0].text).toContain('on-request');
    });

    it('uses default text when activityText is empty', () => {
      const blocks = buildActivityBlocks({
        activityText: '',
        status: 'running',
        conversationKey: 'C123:456.789',
        elapsedMs: 0,
        ...baseParams,
      });

      expect(blocks[0].text?.text).toBe(':gear: Starting...');
    });

    it('formats elapsed time correctly', () => {
      const blocks1 = buildActivityBlocks({
        activityText: 'Test',
        status: 'completed',
        conversationKey: 'test',
        elapsedMs: 1234,
        ...baseParams,
      });
      expect(blocks1[1].elements?.[0].text).toContain('1.2s');

      const blocks2 = buildActivityBlocks({
        activityText: 'Test',
        status: 'completed',
        conversationKey: 'test',
        elapsedMs: 10567,
        ...baseParams,
      });
      expect(blocks2[1].elements?.[0].text).toContain('10.6s');
    });

    it('includes abort button with correct action_id during running', () => {
      const blocks = buildActivityBlocks({
        activityText: 'Test',
        status: 'running',
        conversationKey: 'C123:456.789',
        elapsedMs: 0,
        ...baseParams,
      });

      const actionsBlock = blocks.find((b) => b.type === 'actions');
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock?.block_id).toBe('status_panel_C123:456.789');

      const button = actionsBlock?.elements?.[0] as { action_id: string; text: { text: string }; style: string };
      expect(button.action_id).toBe('abort_C123:456.789');
      expect(button.text.text).toBe('Abort');
      expect(button.style).toBe('danger');
    });

    it('status line appears at bottom (after activity text)', () => {
      const blocks = buildActivityBlocks({
        activityText: ':brain: Thinking...\n:mag: Read file.ts',
        status: 'running',
        conversationKey: 'test',
        elapsedMs: 5000,
        ...baseParams,
      });

      // First block is activity content
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('Thinking');
      expect(blocks[0].text?.text).toContain('Read');

      // Third block is status line (context) after spinner
      expect(blocks[2].type).toBe('context');
      expect(blocks[2].elements?.[0].text).toContain('on-request');
    });

    describe('expand property', () => {
      it('includes expand: true on activity section block', () => {
        const blocks = buildActivityBlocks({
          activityText: ':gear: Test activity',
          status: 'running',
          conversationKey: 'C123:456.789',
          elapsedMs: 1000,
          ...baseParams,
        });

        // First block should be the section with expand: true
        const sectionBlock = blocks[0];
        expect(sectionBlock.type).toBe('section');
        expect((sectionBlock as unknown as { expand: boolean }).expand).toBe(true);
      });

      it('prevents Slack collapse by setting expand: true', () => {
        const blocks = buildActivityBlocks({
          activityText: 'A'.repeat(500), // Long text
          status: 'completed',
          conversationKey: 'C123:456.789',
          elapsedMs: 5000,
          ...baseParams,
        });

        const sectionBlock = blocks[0];
        // expand: true ensures Slack won't collapse this section
        expect((sectionBlock as unknown as { expand: boolean }).expand).toBe(true);
      });
    });
  });
});
