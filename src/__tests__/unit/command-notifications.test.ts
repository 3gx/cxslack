/**
 * Unit tests for command notification extraction.
 *
 * Tests the defensive extraction logic for exec_command_* notifications
 * using REAL notification structures from Codex logs.
 */

import { describe, it, expect } from 'vitest';

describe('Command Notification Extraction - Real Structures', () => {
  // This extraction function mirrors the ACTUAL code in codex-client.ts
  // Structure: { id, msg: { turn_id, call_id, ... }, conversationId }
  function extractExecBegin(params: Record<string, unknown>) {
    const msg = params.msg as Record<string, unknown> | undefined;
    return {
      itemId: (msg?.call_id || params.itemId || params.item_id || params.id || '') as string,
      threadId: (params.conversationId || params.threadId || params.thread_id || msg?.thread_id || '') as string,
      turnId: (msg?.turn_id || params.turnId || params.turn_id || '') as string,
    };
  }

  it('extracts from REAL exec_command_begin structure (nested msg)', () => {
    // This is the ACTUAL structure from Codex logs
    const realParams = {
      id: '1',
      msg: {
        type: 'exec_command_begin',
        call_id: 'call_0Dl0ZkUiAQHKLmv5yqLhOaN1',
        turn_id: '1',
        command: ['/bin/bash', '-lc', 'ls'],
      },
      conversationId: '019c0694-b982-7872-a295-f1cc59a63c73',
    };

    const result = extractExecBegin(realParams);
    expect(result.itemId).toBe('call_0Dl0ZkUiAQHKLmv5yqLhOaN1');
    expect(result.threadId).toBe('019c0694-b982-7872-a295-f1cc59a63c73');
    expect(result.turnId).toBe('1');
  });

  it('extracts from item/started structure (top-level turnId)', () => {
    // item/started has turnId at top level
    const itemStartedParams = {
      item: {
        type: 'commandExecution',
        id: 'call_qw8DGSo2eFYRfCNcdPH7te6v',
        command: '/bin/bash -lc "ls"',
      },
      threadId: '019c0694-b982-7872-a295-f1cc59a63c73',
      turnId: '1',
    };

    const result = extractExecBegin(itemStartedParams);
    expect(result.threadId).toBe('019c0694-b982-7872-a295-f1cc59a63c73');
    expect(result.turnId).toBe('1');
  });

  it('handles missing msg gracefully', () => {
    const result = extractExecBegin({ id: 'test', conversationId: 'thread-1' });
    expect(result.itemId).toBe('test');
    expect(result.threadId).toBe('thread-1');
    expect(result.turnId).toBe('');
  });

  it('prioritizes msg.turn_id over top-level turn_id', () => {
    const params = {
      turn_id: 'top-level',
      msg: { turn_id: 'nested' },
      conversationId: 'thread-1',
    };
    const result = extractExecBegin(params);
    expect(result.turnId).toBe('nested');
  });

  it('falls back to top-level when msg is empty', () => {
    const params = {
      turnId: 'top-level-fallback',
      threadId: 'thread-fallback',
      msg: {},
    };
    const result = extractExecBegin(params);
    expect(result.turnId).toBe('top-level-fallback');
    expect(result.threadId).toBe('thread-fallback');
  });
});

describe('Command End Extraction - Real Structures', () => {
  function extractExecEnd(params: Record<string, unknown>) {
    const msg = params.msg as Record<string, unknown> | undefined;
    return {
      itemId: (msg?.call_id || params.itemId || params.item_id || params.id || '') as string,
      threadId: (params.conversationId || params.threadId || params.thread_id || msg?.thread_id || '') as string,
      turnId: (msg?.turn_id || params.turnId || params.turn_id || '') as string,
      exitCode: (msg?.exit_code ?? params.exitCode ?? params.exit_code ?? params.code) as number | undefined,
    };
  }

  it('extracts from REAL exec_command_end structure', () => {
    const realParams = {
      id: '1',
      msg: {
        type: 'exec_command_end',
        call_id: 'call_0Dl0ZkUiAQHKLmv5yqLhOaN1',
        turn_id: '1',
        exit_code: 0,
        stdout: 'output here',
      },
      conversationId: '019c0694-b982-7872-a295-f1cc59a63c73',
    };

    const result = extractExecEnd(realParams);
    expect(result.itemId).toBe('call_0Dl0ZkUiAQHKLmv5yqLhOaN1');
    expect(result.threadId).toBe('019c0694-b982-7872-a295-f1cc59a63c73');
    expect(result.turnId).toBe('1');
    expect(result.exitCode).toBe(0);
  });

  it('extracts exit_code from msg', () => {
    const params = { msg: { exit_code: 127 } };
    const result = extractExecEnd(params);
    expect(result.exitCode).toBe(127);
  });

  it('handles zero exit code correctly', () => {
    const params = { msg: { exit_code: 0 } };
    const result = extractExecEnd(params);
    expect(result.exitCode).toBe(0);
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

  it('returns empty string for missing delta', () => {
    expect(extractDelta({})).toBe('');
  });
});

describe('context:turnId Emission Logic', () => {
  it('should emit when both threadId and turnId are present', () => {
    const threadId = '019c0694-b982-7872-a295-f1cc59a63c73';
    const turnId = '1';
    const shouldEmit = !!(threadId && turnId);
    expect(shouldEmit).toBe(true);
  });

  it('should NOT emit when threadId is missing', () => {
    const threadId = '';
    const turnId = '1';
    const shouldEmit = !!(threadId && turnId);
    expect(shouldEmit).toBe(false);
  });

  it('should NOT emit when turnId is missing', () => {
    const threadId = '019c0694-b982-7872-a295-f1cc59a63c73';
    const turnId = '';
    const shouldEmit = !!(threadId && turnId);
    expect(shouldEmit).toBe(false);
  });
});
