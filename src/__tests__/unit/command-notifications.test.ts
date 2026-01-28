/**
 * Unit tests for command notification extraction.
 *
 * Tests the defensive extraction logic for exec_command_* notifications
 * that handles both camelCase and snake_case parameter formats.
 */

import { describe, it, expect } from 'vitest';

describe('Command Notification Extraction', () => {
  function extractExecBegin(params: Record<string, unknown>) {
    return {
      itemId: (params.itemId || params.item_id || params.id || '') as string,
      threadId: (params.threadId || params.thread_id || '') as string,
      turnId: (params.turnId || params.turn_id || '') as string,
    };
  }

  it('extracts from camelCase params', () => {
    const result = extractExecBegin({ itemId: 'i1', threadId: 't1', turnId: 'turn1' });
    expect(result).toEqual({ itemId: 'i1', threadId: 't1', turnId: 'turn1' });
  });

  it('extracts from snake_case params', () => {
    const result = extractExecBegin({ item_id: 'i2', thread_id: 't2', turn_id: 'turn2' });
    expect(result).toEqual({ itemId: 'i2', threadId: 't2', turnId: 'turn2' });
  });

  it('handles missing fields gracefully', () => {
    const result = extractExecBegin({});
    expect(result).toEqual({ itemId: '', threadId: '', turnId: '' });
  });

  it('prioritizes camelCase over snake_case', () => {
    const result = extractExecBegin({
      itemId: 'camel',
      item_id: 'snake',
      threadId: 'camelThread',
      thread_id: 'snakeThread',
    });
    expect(result.itemId).toBe('camel');
    expect(result.threadId).toBe('camelThread');
  });

  it('handles id as fallback for itemId', () => {
    const result = extractExecBegin({ id: 'fallback-id', threadId: 't1' });
    expect(result.itemId).toBe('fallback-id');
  });
});

describe('Command Output Delta Extraction', () => {
  function extractDelta(params: Record<string, unknown>) {
    const msg = params.msg as Record<string, unknown> | undefined;
    return (params.delta || params.content || params.output ||
            msg?.delta || msg?.content || msg?.output || '') as string;
  }

  it('extracts direct delta field', () => {
    expect(extractDelta({ delta: 'output line' })).toBe('output line');
  });

  it('extracts nested msg.delta', () => {
    expect(extractDelta({ msg: { delta: 'nested' } })).toBe('nested');
  });

  it('extracts content fallback', () => {
    expect(extractDelta({ content: 'via content' })).toBe('via content');
  });

  it('extracts output fallback', () => {
    expect(extractDelta({ output: 'via output' })).toBe('via output');
  });

  it('extracts nested msg.content', () => {
    expect(extractDelta({ msg: { content: 'nested content' } })).toBe('nested content');
  });

  it('returns empty string for missing delta', () => {
    expect(extractDelta({})).toBe('');
  });
});

describe('Command End exitCode Extraction', () => {
  function extractExitCode(params: Record<string, unknown>): number | undefined {
    return (params.exitCode ?? params.exit_code ?? params.code) as number | undefined;
  }

  it('extracts camelCase exitCode', () => {
    expect(extractExitCode({ exitCode: 0 })).toBe(0);
    expect(extractExitCode({ exitCode: 1 })).toBe(1);
    expect(extractExitCode({ exitCode: 127 })).toBe(127);
  });

  it('extracts snake_case exit_code', () => {
    expect(extractExitCode({ exit_code: 0 })).toBe(0);
    expect(extractExitCode({ exit_code: 1 })).toBe(1);
  });

  it('extracts code as fallback', () => {
    expect(extractExitCode({ code: 255 })).toBe(255);
  });

  it('returns undefined when no exit code present', () => {
    expect(extractExitCode({})).toBeUndefined();
  });

  it('handles zero exit code correctly (falsy but valid)', () => {
    // This is important - zero is a valid exit code (success)
    expect(extractExitCode({ exitCode: 0 })).toBe(0);
    expect(extractExitCode({ exit_code: 0 })).toBe(0);
    expect(extractExitCode({ code: 0 })).toBe(0);
  });
});
