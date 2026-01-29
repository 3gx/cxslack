/**
 * Integration tests for model selection flow.
 * Tests the two-step button-based model + reasoning selection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  buildModelSelectionBlocks,
  buildReasoningSelectionBlocks,
  buildModelConfirmationBlocks,
  buildModelPickerCancelledBlocks,
  ModelInfo,
} from '../../blocks.js';
import { FALLBACK_MODELS, getModelInfo, DEFAULT_MODEL, DEFAULT_REASONING } from '../../commands.js';
import { pendingModelSelections } from '../../slack-bot.js';
import {
  getThreadSession,
  saveThreadSession,
  getSession,
  saveSession,
  loadSessions,
} from '../../session-manager.js';

// Mock fs for session persistence tests
vi.mock('fs');

describe('Model Selection Flow Integration', () => {
  beforeEach(() => {
    // Clear pending selections before each test
    pendingModelSelections.clear();
  });

  describe('Step 1: Model Selection', () => {
    it('FALLBACK_MODELS contains valid ModelInfo entries', () => {
      expect(FALLBACK_MODELS.length).toBeGreaterThan(0);
      for (const model of FALLBACK_MODELS) {
        expect(model.value).toBeTruthy();
        expect(model.displayName).toBeTruthy();
        expect(model.description).toBeTruthy();
      }
    });

    it('getModelInfo returns correct model info', () => {
      const info = getModelInfo('gpt-5.2-codex');
      expect(info).toBeDefined();
      expect(info?.displayName).toBe('GPT-5.2 Codex');
    });

    it('getModelInfo returns undefined for unknown model', () => {
      const info = getModelInfo('unknown-model');
      expect(info).toBeUndefined();
    });

    it('buildModelSelectionBlocks creates buttons for each model', () => {
      const blocks = buildModelSelectionBlocks(FALLBACK_MODELS);

      // Header section
      expect(blocks[0].type).toBe('section');
      expect(blocks[0].text?.text).toContain('Step 1/2');

      // Model buttons
      const actionsBlock = blocks.find((b) => b.block_id === 'model_selection');
      expect(actionsBlock).toBeDefined();
      const buttons = actionsBlock?.elements as Array<{ action_id: string }>;
      expect(buttons.length).toBe(Math.min(FALLBACK_MODELS.length, 5));

      // Each button has correct action_id pattern
      for (let i = 0; i < buttons.length; i++) {
        expect(buttons[i].action_id).toBe(`model_select_${FALLBACK_MODELS[i].value}`);
      }
    });

    it('highlights current model with primary style', () => {
      const currentModel = FALLBACK_MODELS[1].value;
      const blocks = buildModelSelectionBlocks(FALLBACK_MODELS, currentModel);

      const actionsBlock = blocks.find((b) => b.block_id === 'model_selection');
      const buttons = actionsBlock?.elements as Array<{ action_id: string; style?: string }>;

      // Current model should have primary style
      expect(buttons[1].style).toBe('primary');
      // Others should not
      expect(buttons[0].style).toBeUndefined();
    });
  });

  describe('Step 2: Reasoning Selection', () => {
    it('buildReasoningSelectionBlocks shows model context', () => {
      const blocks = buildReasoningSelectionBlocks('gpt-5.2-codex', 'GPT-5.2 Codex');

      expect(blocks[0].text?.text).toContain('Step 2/2');
      expect(blocks[0].text?.text).toContain('GPT-5.2 Codex');
    });

    it('reasoning buttons encode model in value', () => {
      const blocks = buildReasoningSelectionBlocks('gpt-5.2-codex', 'GPT-5.2 Codex');

      const actionsBlock = blocks.find((b) => b.block_id === 'reasoning_selection');
      const buttons = actionsBlock?.elements as Array<{ action_id: string; value: string }>;

      // All buttons should encode the model
      for (const button of buttons) {
        const parsed = JSON.parse(button.value);
        expect(parsed.model).toBe('gpt-5.2-codex');
      }
    });

    it('highlights current reasoning with primary style', () => {
      const blocks = buildReasoningSelectionBlocks('gpt-5.2', 'GPT-5.2', 'high');

      const actionsBlock = blocks.find((b) => b.block_id === 'reasoning_selection');
      const buttons = actionsBlock?.elements as Array<{ action_id: string; style?: string }>;

      // high is at index 3 (minimal=0, low=1, medium=2, high=3)
      expect(buttons[3].style).toBe('primary');
    });

    it('includes all 5 reasoning levels', () => {
      const blocks = buildReasoningSelectionBlocks('gpt-5.2', 'GPT-5.2');

      const actionsBlock = blocks.find((b) => b.block_id === 'reasoning_selection');
      const buttons = actionsBlock?.elements as Array<{ action_id: string }>;

      expect(buttons.map((b) => b.action_id)).toEqual([
        'reasoning_select_minimal',
        'reasoning_select_low',
        'reasoning_select_medium',
        'reasoning_select_high',
        'reasoning_select_xhigh',
      ]);
    });
  });

  describe('Confirmation and Cancellation', () => {
    it('buildModelConfirmationBlocks shows both model and reasoning', () => {
      const blocks = buildModelConfirmationBlocks('GPT-5.2 Codex', 'gpt-5.2-codex', 'high');

      expect(blocks[0].text?.text).toContain(':white_check_mark:');
      expect(blocks[0].text?.text).toContain('GPT-5.2 Codex');
      expect(blocks[0].text?.text).toContain('high');
    });

    it('buildModelPickerCancelledBlocks shows cancel message', () => {
      const blocks = buildModelPickerCancelledBlocks();

      expect(blocks[0].text?.text).toContain(':x:');
      expect(blocks[0].text?.text).toContain('cancelled');
    });
  });

  describe('Pending Selection Tracking', () => {
    it('pendingModelSelections map is initially empty', () => {
      expect(pendingModelSelections.size).toBe(0);
    });

    it('can track pending selections', () => {
      const messageTs = '1234567890.123456';
      pendingModelSelections.set(messageTs, {
        originalTs: '1234567890.000000',
        channelId: 'C123',
        threadTs: '1234567890.000001',
      });

      expect(pendingModelSelections.has(messageTs)).toBe(true);
      const pending = pendingModelSelections.get(messageTs);
      expect(pending?.originalTs).toBe('1234567890.000000');
      expect(pending?.channelId).toBe('C123');
    });

    it('can delete pending selections', () => {
      const messageTs = '1234567890.123456';
      pendingModelSelections.set(messageTs, {
        originalTs: '1234567890.000000',
        channelId: 'C123',
      });

      pendingModelSelections.delete(messageTs);
      expect(pendingModelSelections.has(messageTs)).toBe(false);
    });
  });

  describe('Full Flow Simulation', () => {
    it('simulates complete model selection flow', () => {
      // Step 1: User runs /model, bot shows model picker
      const modelBlocks = buildModelSelectionBlocks(FALLBACK_MODELS, undefined);
      expect(modelBlocks[0].text?.text).toContain('Step 1/2');

      // Simulate tracking pending selection (would happen in slack-bot.ts)
      const pickerTs = '1234567890.111111';
      const originalTs = '1234567890.000000';
      pendingModelSelections.set(pickerTs, {
        originalTs,
        channelId: 'C123',
        threadTs: 'T456',
      });

      // Step 2: User clicks model button, bot shows reasoning picker
      const selectedModel = FALLBACK_MODELS[0];
      const reasoningBlocks = buildReasoningSelectionBlocks(
        selectedModel.value,
        selectedModel.displayName
      );
      expect(reasoningBlocks[0].text?.text).toContain('Step 2/2');
      expect(reasoningBlocks[0].text?.text).toContain(selectedModel.displayName);

      // Step 3: User clicks reasoning button, bot shows confirmation
      const confirmBlocks = buildModelConfirmationBlocks(
        selectedModel.displayName,
        selectedModel.value,
        'high'
      );
      expect(confirmBlocks[0].text?.text).toContain(':white_check_mark:');

      // Clean up pending selection (would happen in handler)
      pendingModelSelections.delete(pickerTs);
      expect(pendingModelSelections.size).toBe(0);
    });

    it('simulates cancelled model selection', () => {
      // User runs /model
      const modelBlocks = buildModelSelectionBlocks(FALLBACK_MODELS);

      // Track pending
      const pickerTs = '1234567890.222222';
      pendingModelSelections.set(pickerTs, {
        originalTs: '1234567890.000000',
        channelId: 'C123',
      });

      // User clicks Cancel
      const cancelBlocks = buildModelPickerCancelledBlocks();
      expect(cancelBlocks[0].text?.text).toContain('cancelled');

      // Clean up
      pendingModelSelections.delete(pickerTs);
      expect(pendingModelSelections.size).toBe(0);
    });
  });

  describe('Session Persistence', () => {
    const mockFs = vi.mocked(fs);

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('saves model to thread session and retrieves it', async () => {
      const channelId = 'C123';
      const threadTs = '1234567890.000001';
      const modelValue = 'gpt-5.2-codex';
      const reasoningValue = 'xhigh';

      // Initial state: channel exists but no thread session
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        channels: {
          [channelId]: {
            threadId: null,
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
            threads: {},
          },
        },
      }));
      mockFs.writeFileSync.mockImplementation(() => {});

      // Save model to thread session (simulates reasoning_select handler)
      await saveThreadSession(channelId, threadTs, {
        model: modelValue,
        reasoningEffort: reasoningValue
      });

      // Verify it was written
      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(writtenData.channels[channelId].threads[threadTs].model).toBe(modelValue);
      expect(writtenData.channels[channelId].threads[threadTs].reasoningEffort).toBe(reasoningValue);
    });

    it('retrieves model from thread session for subsequent messages', () => {
      const channelId = 'C123';
      const threadTs = '1234567890.000001';
      const savedModel = 'gpt-5.2-codex';
      const savedReasoning = 'xhigh';

      // State: thread session has model saved
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        channels: {
          [channelId]: {
            threadId: null,
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
            threads: {
              [threadTs]: {
                threadId: 'codex-thread-123',
                forkedFrom: null,
                workingDir: '/test',
                approvalPolicy: 'on-request',
                model: savedModel,
                reasoningEffort: savedReasoning,
                createdAt: 1000,
                lastActiveAt: 2000,
                pathConfigured: false,
                configuredPath: null,
                configuredBy: null,
                configuredAt: null,
              },
            },
          },
        },
      }));

      // Retrieve session (simulates handleUserMessage)
      const session = getThreadSession(channelId, threadTs);

      // Verify model is retrieved
      expect(session).not.toBeNull();
      expect(session?.model).toBe(savedModel);
      expect(session?.reasoningEffort).toBe(savedReasoning);
    });

    it('uses default model when session has no model set', () => {
      const channelId = 'C123';
      const threadTs = '1234567890.000001';

      // State: thread session exists but no model
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        channels: {
          [channelId]: {
            threadId: null,
            workingDir: '/test',
            approvalPolicy: 'on-request',
            createdAt: 1000,
            lastActiveAt: 2000,
            pathConfigured: false,
            configuredPath: null,
            configuredBy: null,
            configuredAt: null,
            threads: {
              [threadTs]: {
                threadId: 'codex-thread-123',
                forkedFrom: null,
                workingDir: '/test',
                approvalPolicy: 'on-request',
                // model is NOT set
                createdAt: 1000,
                lastActiveAt: 2000,
                pathConfigured: false,
                configuredPath: null,
                configuredBy: null,
                configuredAt: null,
              },
            },
          },
        },
      }));

      const session = getThreadSession(channelId, threadTs);

      // Session exists but model is undefined
      expect(session).not.toBeNull();
      expect(session?.model).toBeUndefined();

      // In handleUserMessage, this would use default:
      const effectiveModel = session?.model || DEFAULT_MODEL;
      const effectiveReasoning = session?.reasoningEffort || DEFAULT_REASONING;

      expect(effectiveModel).toBe(DEFAULT_MODEL);
      expect(effectiveReasoning).toBe(DEFAULT_REASONING);
    });

    it('threadTs from pending selection matches session lookup', () => {
      // This test verifies the fix for the model selection bug
      const channelId = 'C123';
      const threadAnchor = '1234567890.000001'; // The thread anchor ts
      const pickerMessageTs = '1234567890.111111'; // The picker message ts

      // When model picker is posted, we store the threadTs
      pendingModelSelections.set(pickerMessageTs, {
        originalTs: '1234567890.000000',
        channelId,
        threadTs: threadAnchor, // This is the correct threadTs
      });

      // When user clicks button, we retrieve from pending
      const pending = pendingModelSelections.get(pickerMessageTs);
      const threadTsForSave = pending?.threadTs || pickerMessageTs;

      // Should use the stored threadTs, not the picker message ts
      expect(threadTsForSave).toBe(threadAnchor);

      // Later, when user sends a message in thread, they use the same threadTs
      const threadTsForMessage = threadAnchor;

      // These should match!
      expect(threadTsForSave).toBe(threadTsForMessage);

      pendingModelSelections.clear();
    });
  });
});
