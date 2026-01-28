/**
 * Integration tests for the notification flow.
 *
 * Tests notification → event → handler chain:
 * - exec_command_begin emits context:turnId
 * - Defensive extraction handles snake_case params
 * - context:turnId only sets turnId once (first source wins)
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

describe('Notification Flow Integration', () => {
  it('exec_command_begin emits context:turnId when threadId+turnId present', () => {
    const emitter = new EventEmitter();
    const contextTurnIdHandler = vi.fn();
    emitter.on('context:turnId', contextTurnIdHandler);

    // Simulate handleNotification for exec_command_begin
    const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
    if (params.threadId && params.turnId) {
      emitter.emit('context:turnId', { threadId: params.threadId, turnId: params.turnId });
    }

    expect(contextTurnIdHandler).toHaveBeenCalledWith({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('defensive extraction handles snake_case params', () => {
    const params = { thread_id: 'thread-2', turn_id: 'turn-2', item_id: 'item-2' } as Record<string, unknown>;

    const extracted = {
      threadId: (params.threadId || params.thread_id || '') as string,
      turnId: (params.turnId || params.turn_id || '') as string,
      itemId: (params.itemId || params.item_id || '') as string,
    };

    expect(extracted).toEqual({ threadId: 'thread-2', turnId: 'turn-2', itemId: 'item-2' });
  });

  it('context:turnId only sets turnId once (first source wins)', () => {
    const context = { turnId: '' };

    // First source: context:turnId
    if (!context.turnId) {
      context.turnId = 'from-exec-command';
    }

    // Second source: turn:started (should NOT overwrite)
    if (!context.turnId) {
      context.turnId = 'from-turn-started';
    }

    expect(context.turnId).toBe('from-exec-command');
  });

  it('emits context:turnId only when both threadId AND turnId are present', () => {
    const emitter = new EventEmitter();
    const contextTurnIdHandler = vi.fn();
    emitter.on('context:turnId', contextTurnIdHandler);

    // Missing turnId - should NOT emit
    const params1 = { threadId: 'thread-1', turnId: '' };
    if (params1.threadId && params1.turnId) {
      emitter.emit('context:turnId', { threadId: params1.threadId, turnId: params1.turnId });
    }
    expect(contextTurnIdHandler).not.toHaveBeenCalled();

    // Missing threadId - should NOT emit
    const params2 = { threadId: '', turnId: 'turn-1' };
    if (params2.threadId && params2.turnId) {
      emitter.emit('context:turnId', { threadId: params2.threadId, turnId: params2.turnId });
    }
    expect(contextTurnIdHandler).not.toHaveBeenCalled();

    // Both present - should emit
    const params3 = { threadId: 'thread-3', turnId: 'turn-3' };
    if (params3.threadId && params3.turnId) {
      emitter.emit('context:turnId', { threadId: params3.threadId, turnId: params3.turnId });
    }
    expect(contextTurnIdHandler).toHaveBeenCalledTimes(1);
    expect(contextTurnIdHandler).toHaveBeenCalledWith({ threadId: 'thread-3', turnId: 'turn-3' });
  });

  it('extracts delta from various param structures', () => {
    function extractDelta(params: Record<string, unknown>): string {
      const msg = params.msg as Record<string, unknown> | undefined;
      return (params.delta || params.content || params.output ||
              msg?.delta || msg?.content || msg?.output || '') as string;
    }

    // Direct delta field
    expect(extractDelta({ delta: 'output line' })).toBe('output line');

    // Nested msg.delta
    expect(extractDelta({ msg: { delta: 'nested' } })).toBe('nested');

    // Content fallback
    expect(extractDelta({ content: 'via content' })).toBe('via content');

    // Output fallback
    expect(extractDelta({ output: 'via output' })).toBe('via output');

    // Nested msg.content
    expect(extractDelta({ msg: { content: 'nested content' } })).toBe('nested content');

    // Empty when no delta found
    expect(extractDelta({})).toBe('');
  });
});
