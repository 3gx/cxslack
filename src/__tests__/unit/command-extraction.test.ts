import { describe, it, expect } from 'vitest';

// Helper function that mirrors the extraction logic in codex-client.ts
function extractCommandDetails(item: Record<string, unknown>): {
  command?: string;
  commandActions?: Array<{ type: string; command: string }>;
} {
  const command = (item.command || '') as string;
  const commandActions = item.commandActions as Array<{ type: string; command: string }> | undefined;
  return {
    command: command || undefined,
    commandActions: commandActions?.length ? commandActions : undefined,
  };
}

// Helper that mirrors streaming.ts toolInput extraction
function extractToolInput(
  itemType: string,
  command?: string,
  commandActions?: Array<{ type: string; command: string }>
): string | undefined {
  if (itemType !== 'commandExecution' && itemType !== 'CommandExecution') {
    return undefined;
  }
  if (commandActions && commandActions.length > 0) {
    return commandActions[0].command;
  }
  if (command) {
    const match = command.match(/-lc\s+["']?(.+?)["']?$/);
    return match ? match[1] : command;
  }
  return undefined;
}

describe('Command extraction from item object', () => {
  it('extracts command string from commandExecution item', () => {
    const item = {
      type: 'commandExecution',
      id: 'call_xxx',
      command: '/bin/bash -lc ls',
    };
    const result = extractCommandDetails(item);
    expect(result.command).toBe('/bin/bash -lc ls');
  });

  it('extracts commandActions array', () => {
    const item = {
      type: 'commandExecution',
      commandActions: [{ type: 'listFiles', command: 'ls' }],
    };
    const result = extractCommandDetails(item);
    expect(result.commandActions).toHaveLength(1);
    expect(result.commandActions![0].command).toBe('ls');
  });

  it('returns undefined for items without command fields', () => {
    const item = { type: 'mcpToolCall', id: 'call_yyy' };
    const result = extractCommandDetails(item);
    expect(result.command).toBeUndefined();
    expect(result.commandActions).toBeUndefined();
  });

  it('handles empty commandActions array', () => {
    const item = { type: 'commandExecution', command: 'ls', commandActions: [] };
    const result = extractCommandDetails(item);
    expect(result.commandActions).toBeUndefined(); // Empty array → undefined
  });
});

describe('Tool input extraction for display', () => {
  it('prefers commandActions[0].command over raw command', () => {
    const result = extractToolInput(
      'commandExecution',
      '/bin/bash -lc ls',
      [{ type: 'listFiles', command: 'ls' }]
    );
    expect(result).toBe('ls');
  });

  it('parses -lc command when no commandActions', () => {
    const result = extractToolInput('commandExecution', '/bin/bash -lc git status', undefined);
    expect(result).toBe('git status');
  });

  it('handles quoted commands in -lc format', () => {
    const result = extractToolInput('commandExecution', '/bin/bash -lc "echo hello"', undefined);
    expect(result).toBe('echo hello');
  });

  it('returns undefined for non-commandExecution items', () => {
    const result = extractToolInput('mcpToolCall', '/some/path', undefined);
    expect(result).toBeUndefined();
  });
});
