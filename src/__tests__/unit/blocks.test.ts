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
  buildClearBlocks,
  buildTextBlocks,
  buildErrorBlocks,
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

    it('builds aborted status', () => {
      const blocks = buildStatusBlocks({ status: 'aborted' });

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Aborted');
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
  });

  describe('buildErrorBlocks', () => {
    it('builds error message block', () => {
      const blocks = buildErrorBlocks('Something went wrong');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].text?.text).toContain('Error');
      expect(blocks[0].text?.text).toContain('Something went wrong');
    });
  });
});
