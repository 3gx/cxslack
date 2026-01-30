/**
 * Unit tests for thread message formatting functions in blocks.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  stripMarkdownCodeFence,
  markdownToSlack,
  truncateWithClosedFormatting,
  formatToolName,
  formatToolInputSummary,
  formatThreadActivityBatch,
  formatThreadStartingMessage,
  formatThreadThinkingMessage,
  formatThreadResponseMessage,
  formatThreadErrorMessage,
  formatToolDetails,
  formatToolResultSummary,
  formatOutputPreview,
  normalizeToolName,
  getToolEmoji,
  formatThreadActivityEntry,
} from '../../blocks.js';
import type { ActivityEntry } from '../../activity-thread.js';

describe('stripMarkdownCodeFence', () => {
  it('strips ```markdown wrapper', () => {
    const input = '```markdown\n# Hello\n\nWorld\n```';
    const result = stripMarkdownCodeFence(input);
    expect(result).toBe('# Hello\n\nWorld');
  });

  it('strips ```md wrapper', () => {
    const input = '```md\n# Hello\n```';
    const result = stripMarkdownCodeFence(input);
    expect(result).toBe('# Hello');
  });

  it('preserves ```python code blocks', () => {
    const input = '```python\ndef hello():\n    pass\n```';
    const result = stripMarkdownCodeFence(input);
    expect(result).toBe(input);
  });

  it('preserves ```javascript code blocks', () => {
    const input = '```javascript\nconsole.log("hi");\n```';
    const result = stripMarkdownCodeFence(input);
    expect(result).toBe(input);
  });

  it('handles bare ``` fences (no strip)', () => {
    const input = '```\nplain text\n```';
    const result = stripMarkdownCodeFence(input);
    expect(result).toBe(input);
  });

  it('returns content without code fence unchanged', () => {
    const input = '# Hello\n\nThis is plain markdown.';
    const result = stripMarkdownCodeFence(input);
    expect(result).toBe(input);
  });

  it('handles markdown tag with extra info string', () => {
    const input = '```markdown filename=test.md\n# Content\n```';
    const result = stripMarkdownCodeFence(input);
    expect(result).toBe('# Content');
  });
});

describe('markdownToSlack', () => {
  it('converts **bold** to *bold*', () => {
    const result = markdownToSlack('This is **bold** text');
    expect(result).toBe('This is *bold* text');
  });

  it('converts __bold__ to *bold*', () => {
    const result = markdownToSlack('This is __bold__ text');
    expect(result).toBe('This is *bold* text');
  });

  it('converts *italic* to _italic_', () => {
    const result = markdownToSlack('This is *italic* text');
    expect(result).toBe('This is _italic_ text');
  });

  it('converts [link](url) to <url|link>', () => {
    const result = markdownToSlack('Check [this link](https://example.com)');
    expect(result).toBe('Check <https://example.com|this link>');
  });

  it('converts # headers to bold', () => {
    const result = markdownToSlack('# Header\n\nContent');
    expect(result).toBe('*Header*\n\nContent');
  });

  it('converts ## headers to bold', () => {
    const result = markdownToSlack('## Subheader');
    expect(result).toBe('*Subheader*');
  });

  it('converts ~~strikethrough~~ to ~text~', () => {
    const result = markdownToSlack('This is ~~deleted~~ text');
    expect(result).toBe('This is ~deleted~ text');
  });

  it('preserves code blocks', () => {
    const input = '```javascript\nconst x = 1;\n```';
    const result = markdownToSlack(input);
    expect(result).toBe(input);
  });

  it('preserves inline code', () => {
    const input = 'Use the `code` function';
    const result = markdownToSlack(input);
    expect(result).toBe(input);
  });

  it('converts bold+italic ***text***', () => {
    const result = markdownToSlack('This is ***bold italic*** text');
    expect(result).toBe('This is _*bold italic*_ text');
  });

  it('wraps tables in code blocks', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = markdownToSlack(input);
    expect(result).toContain('```');
    expect(result).toContain('| A | B |');
  });

  it('handles multiple conversions in same text', () => {
    const result = markdownToSlack('**Bold** and *italic* and [link](http://x.com)');
    expect(result).toBe('*Bold* and _italic_ and <http://x.com|link>');
  });
});

describe('truncateWithClosedFormatting', () => {
  it('returns text unchanged if under limit', () => {
    const text = 'Short text';
    const result = truncateWithClosedFormatting(text, 1000);
    expect(result).toBe(text);
  });

  it('truncates long text with suffix', () => {
    const text = 'A'.repeat(3000);
    const result = truncateWithClosedFormatting(text, 100);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('truncated');
  });

  it('closes open code blocks', () => {
    const text = '```javascript\nconst x = ' + 'A'.repeat(3000);
    const result = truncateWithClosedFormatting(text, 500);
    // Count ``` - should be even (2 = one open + one close)
    const backtickMatches = result.match(/```/g) || [];
    expect(backtickMatches.length % 2).toBe(0);
  });

  it('closes open bold formatting', () => {
    const text = '*bold text that is ' + 'A'.repeat(3000);
    const result = truncateWithClosedFormatting(text, 500);
    // Count * outside code blocks - should be even
    const asterisks = result.match(/\*/g) || [];
    expect(asterisks.length % 2).toBe(0);
  });

  it('closes open italic formatting', () => {
    const text = '_italic text that is ' + 'A'.repeat(3000);
    const result = truncateWithClosedFormatting(text, 500);
    const underscores = result.match(/_/g) || [];
    expect(underscores.length % 2).toBe(0);
  });

  it('finds good break points (prefers newlines)', () => {
    const text = 'Line 1\n\nLine 2\n\n' + 'A'.repeat(3000);
    const result = truncateWithClosedFormatting(text, 500);
    // Should not break mid-word
    expect(result).not.toMatch(/A{10}\.\.\.truncated/);
  });
});

describe('formatToolName', () => {
  it('formats Read tool with emoji', () => {
    const result = formatToolName('Read');
    expect(result).toBe(':mag: *Read*');
  });

  it('formats Bash tool with emoji', () => {
    const result = formatToolName('Bash');
    expect(result).toBe(':computer: *Bash*');
  });

  it('formats Edit tool with emoji', () => {
    const result = formatToolName('Edit');
    expect(result).toBe(':memo: *Edit*');
  });

  it('uses default emoji for unknown tools', () => {
    const result = formatToolName('UnknownTool');
    expect(result).toBe(':gear: *UnknownTool*');
  });
});

describe('formatToolInputSummary', () => {
  it('returns empty string for no input', () => {
    const result = formatToolInputSummary('Read', undefined);
    expect(result).toBe('');
  });

  it('formats short input in backticks', () => {
    const result = formatToolInputSummary('Read', 'src/index.ts');
    expect(result).toBe(' `src/index.ts`');
  });

  it('truncates long input to 80 chars', () => {
    const longInput = 'A'.repeat(100);
    const result = formatToolInputSummary('Read', longInput);
    expect(result.length).toBeLessThan(90);
    expect(result).toContain('...');
  });
});

describe('formatThreadActivityBatch', () => {
  it('formats tool_complete entries with duration', () => {
    const entries: ActivityEntry[] = [
      {
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Read',
        toolInput: 'file.ts',
        toolUseId: 'tool-1',
        durationMs: 1500,
      },
    ];

    const result = formatThreadActivityBatch(entries);
    expect(result).toContain('Read');
    expect(result).toContain('file.ts');
    expect(result).toContain('1.5s');
    expect(result).toContain(':mag:'); // Thread uses tool emoji, not checkmark
  });

  it('skips tool_start if tool_complete exists for same id', () => {
    const entries: ActivityEntry[] = [
      {
        type: 'tool_start',
        timestamp: Date.now(),
        tool: 'Read',
        toolUseId: 'tool-1',
      },
      {
        type: 'tool_complete',
        timestamp: Date.now(),
        tool: 'Read',
        toolUseId: 'tool-1',
        durationMs: 500,
      },
    ];

    const result = formatThreadActivityBatch(entries);
    // Should NOT contain "in progress" since tool_complete exists
    expect(result).not.toContain('in progress');
    expect(result).toContain(':mag:'); // Thread uses tool emoji, not checkmark
  });

  it('handles empty array', () => {
    const result = formatThreadActivityBatch([]);
    expect(result).toBe('');
  });

  it('formats starting entry', () => {
    const entries: ActivityEntry[] = [
      { type: 'starting', timestamp: Date.now() },
    ];

    const result = formatThreadActivityBatch(entries);
    expect(result).toContain(':brain:');
    expect(result).toContain('Analyzing');
  });

  it('formats error entry', () => {
    const entries: ActivityEntry[] = [
      { type: 'error', timestamp: Date.now(), message: 'Something failed' },
    ];

    const result = formatThreadActivityBatch(entries);
    expect(result).toContain(':x:');
    expect(result).toContain('Something failed');
  });
});

describe('formatThreadStartingMessage', () => {
  it('returns starting message with brain emoji', () => {
    const result = formatThreadStartingMessage();
    expect(result).toBe(':brain: *Analyzing request...*');
  });
});

describe('formatThreadThinkingMessage', () => {
  it('formats thinking with duration', () => {
    const result = formatThreadThinkingMessage('Thinking content', 5000);
    expect(result).toContain(':bulb:');  // Changed from :brain: to match ccslack
    expect(result).toContain('Thinking');
    expect(result).toContain('5.0s');
  });

  it('includes character count', () => {
    const content = 'A'.repeat(100);
    const result = formatThreadThinkingMessage(content, 1000);
    expect(result).toContain('100 chars');
  });

  it('works without duration', () => {
    const result = formatThreadThinkingMessage('Content');
    expect(result).toContain(':bulb:');  // Changed from :brain: to match ccslack
    expect(result).toContain('Thinking');
    expect(result).not.toContain('undefined');
  });
});

describe('formatThreadResponseMessage', () => {
  it('formats response with duration', () => {
    const result = formatThreadResponseMessage('Response content', 3500);
    expect(result).toContain(':speech_balloon:');
    expect(result).toContain('Response');
    expect(result).toContain('3.5s');
  });

  it('includes character count', () => {
    const content = 'A'.repeat(250);
    const result = formatThreadResponseMessage(content);
    expect(result).toContain('250 chars');
  });
});

describe('formatThreadErrorMessage', () => {
  it('formats error with message', () => {
    const result = formatThreadErrorMessage('Connection failed');
    expect(result).toContain(':x:');
    expect(result).toContain('Error');
    expect(result).toContain('Connection failed');
  });
});

// ============================================================================
// NEW TESTS: Tool-specific formatting (ccslack parity)
// ============================================================================

describe('normalizeToolName', () => {
  it('returns simple name unchanged', () => {
    expect(normalizeToolName('Read')).toBe('Read');
    expect(normalizeToolName('Edit')).toBe('Edit');
  });

  it('extracts name from MCP-style names', () => {
    expect(normalizeToolName('mcp__claude-code__Read')).toBe('Read');
    expect(normalizeToolName('mcp__server__ToolName')).toBe('ToolName');
  });

  it('maps legacy tool names to canonical names', () => {
    expect(normalizeToolName('commandExecution')).toBe('Bash');
    expect(normalizeToolName('CommandExecution')).toBe('Bash');
    expect(normalizeToolName('fileRead')).toBe('Read');
    expect(normalizeToolName('FileRead')).toBe('Read');
    expect(normalizeToolName('fileWrite')).toBe('Write');
    expect(normalizeToolName('shell')).toBe('Bash');
  });
});

describe('getToolEmoji', () => {
  it('returns correct emoji for known tools', () => {
    expect(getToolEmoji('Read')).toBe(':mag:');
    expect(getToolEmoji('Edit')).toBe(':memo:');
    expect(getToolEmoji('Bash')).toBe(':computer:');
    expect(getToolEmoji('Task')).toBe(':robot_face:');
  });

  it('returns correct emoji for legacy tool names', () => {
    expect(getToolEmoji('commandExecution')).toBe(':computer:');
    expect(getToolEmoji('CommandExecution')).toBe(':computer:');
    expect(getToolEmoji('fileRead')).toBe(':mag:');
    expect(getToolEmoji('shell')).toBe(':computer:');
  });

  it('returns default emoji for unknown tools', () => {
    expect(getToolEmoji('UnknownTool')).toBe(':gear:');
  });
});

describe('formatToolInputSummary (tool-specific)', () => {
  it('formats file path for Read/Edit/Write', () => {
    expect(formatToolInputSummary('Read', { file_path: '/src/index.ts' })).toBe(' `/src/index.ts`');
    expect(formatToolInputSummary('Edit', { file_path: '/long/path/to/file.ts' })).toContain('file.ts');
    expect(formatToolInputSummary('Write', { file_path: '/config.json' })).toBe(' `/config.json`');
  });

  it('formats pattern for Grep/Glob', () => {
    expect(formatToolInputSummary('Grep', { pattern: 'function.*test' })).toContain('"function.*test"');
    expect(formatToolInputSummary('Glob', { pattern: '**/*.ts' })).toContain('**/*.ts');
  });

  it('formats command for Bash', () => {
    expect(formatToolInputSummary('Bash', { command: 'npm test' })).toContain('npm test');
  });

  it('formats Task with subagent type and description', () => {
    const result = formatToolInputSummary('Task', { subagent_type: 'Explore', description: 'Find tests' });
    expect(result).toContain(':Explore');
    expect(result).toContain('"Find tests"');
  });

  it('formats TodoWrite with status counts', () => {
    const todos = [
      { content: 'Task 1', status: 'completed', activeForm: 'Doing 1' },
      { content: 'Task 2', status: 'in_progress', activeForm: 'Doing 2' },
      { content: 'Task 3', status: 'pending', activeForm: 'Doing 3' },
    ];
    const result = formatToolInputSummary('TodoWrite', { todos });
    expect(result).toContain('1✓');
    expect(result).toContain('1→');
    expect(result).toContain('1☐');
  });

  it('returns empty for AskUserQuestion', () => {
    expect(formatToolInputSummary('AskUserQuestion', { question: 'What?' })).toBe('');
  });

  it('handles string input (legacy)', () => {
    expect(formatToolInputSummary('Read', '/path/to/file.ts')).toContain('/path/to/file.ts');
  });

  it('truncates long paths', () => {
    const longPath = '/very/long/path/to/some/deeply/nested/directory/structure/file.ts';
    const result = formatToolInputSummary('Read', { file_path: longPath });
    expect(result.length).toBeLessThan(50);
    expect(result).toContain('file.ts');
  });
});

describe('formatToolResultSummary', () => {
  it('formats match count', () => {
    const entry: ActivityEntry = { type: 'tool_complete', timestamp: Date.now(), matchCount: 5 };
    expect(formatToolResultSummary(entry)).toBe(' → 5 matches');
  });

  it('formats single match', () => {
    const entry: ActivityEntry = { type: 'tool_complete', timestamp: Date.now(), matchCount: 1 };
    expect(formatToolResultSummary(entry)).toBe(' → 1 match');
  });

  it('formats line count for Read tool', () => {
    const entry: ActivityEntry = { type: 'tool_complete', timestamp: Date.now(), tool: 'Read', lineCount: 42 };
    expect(formatToolResultSummary(entry)).toBe(' (42 lines)');
  });

  it('does NOT show line count for Bash/commandExecution', () => {
    const entry: ActivityEntry = { type: 'tool_complete', timestamp: Date.now(), tool: 'commandExecution', lineCount: 42 };
    expect(formatToolResultSummary(entry)).toBe('');
  });

  it('formats edit diff', () => {
    const entry: ActivityEntry = { type: 'tool_complete', timestamp: Date.now(), linesAdded: 10, linesRemoved: 5 };
    expect(formatToolResultSummary(entry)).toBe(' (+10/-5)');
  });

  it('returns empty for no metrics', () => {
    const entry: ActivityEntry = { type: 'tool_complete', timestamp: Date.now() };
    expect(formatToolResultSummary(entry)).toBe('');
  });
});

describe('formatToolDetails (bullet points)', () => {
  it('formats Edit with line changes', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Edit',
      toolInput: { file_path: '/src/app.ts', old_string: 'old', new_string: 'new\nline' },
      linesAdded: 2,
      linesRemoved: 1,
      durationMs: 1500,
    };
    const details = formatToolDetails(entry);
    expect(details).toContain('Changed: +2/-1 lines');
    expect(details).toContain('Duration: 1.5s');
  });

  it('formats Write with line count', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Write',
      lineCount: 50,
      durationMs: 200,
    };
    const details = formatToolDetails(entry);
    expect(details).toContain('Wrote: 50 lines');
  });

  it('formats Bash with command and output', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolInput: { command: 'npm test' },
      toolOutputPreview: 'Test passed',
      durationMs: 5000,
    };
    const details = formatToolDetails(entry);
    expect(details.some(d => d.includes('npm test'))).toBe(true);
    expect(details.some(d => d.includes('Output:'))).toBe(true);
    expect(details).toContain('Duration: 5.0s');
  });

  it('formats Grep with path and matches', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Grep',
      toolInput: { pattern: 'test', path: '/src' },
      matchCount: 15,
    };
    const details = formatToolDetails(entry);
    expect(details.some(d => d.includes('Path:'))).toBe(true);
    expect(details.some(d => d.includes('Found: 15 matches'))).toBe(true);
  });

  it('formats Task with subagent type', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Task',
      toolInput: { subagent_type: 'Explore', description: 'Search codebase' },
    };
    const details = formatToolDetails(entry);
    expect(details.some(d => d.includes('Type: Explore'))).toBe(true);
    expect(details.some(d => d.includes('Task: Search codebase'))).toBe(true);
  });

  it('includes error message when tool failed', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Bash',
      toolIsError: true,
      toolErrorMessage: 'Command not found',
    };
    const details = formatToolDetails(entry);
    expect(details.some(d => d.includes('Error:') && d.includes('Command not found'))).toBe(true);
  });

  it('returns only duration for AskUserQuestion', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'AskUserQuestion',
      durationMs: 10000,
    };
    const details = formatToolDetails(entry);
    expect(details).toEqual(['Duration: 10.0s']);
  });
});

describe('formatOutputPreview', () => {
  it('formats Bash output with backticks', () => {
    const result = formatOutputPreview('Bash', 'npm test passed');
    expect(result).toBe('`npm test passed`');
  });

  it('truncates long Bash output', () => {
    const longOutput = 'A'.repeat(200);
    const result = formatOutputPreview('Bash', longOutput);
    expect(result.length).toBeLessThan(160);
    expect(result).toContain('...');
  });

  it('formats Grep matches as list', () => {
    const grepOutput = 'file1.ts:10:match1\nfile2.ts:20:match2\nfile3.ts:30:match3';
    const result = formatOutputPreview('Grep', grepOutput);
    expect(result).toContain('`file1.ts:10:match1`');
    expect(result).toContain('`file2.ts:20:match2`');
  });

  it('handles empty output', () => {
    expect(formatOutputPreview('Bash', '')).toBe('');
    expect(formatOutputPreview('Bash', '   \n  ')).toBe('');
  });

  it('strips control characters', () => {
    const result = formatOutputPreview('Bash', 'clean\x00output');
    expect(result).not.toContain('\x00');
  });
});

describe('formatThreadActivityEntry with metrics', () => {
  it('formats tool_complete with bullet points', () => {
    const entry: ActivityEntry = {
      type: 'tool_complete',
      timestamp: Date.now(),
      tool: 'Edit',
      toolInput: { file_path: '/src/app.ts' },
      linesAdded: 5,
      linesRemoved: 3,
      durationMs: 1000,
    };
    const result = formatThreadActivityEntry(entry);
    expect(result).toContain(':memo:'); // Thread uses tool emoji, not checkmark
    expect(result).toContain('Edit');
    expect(result).toContain('• Changed: +5/-3 lines');
    expect(result).toContain('• Duration: 1.0s');
  });

  it('formats thinking with bulb emoji and in-progress indicator', () => {
    const entry: ActivityEntry = {
      type: 'thinking',
      timestamp: Date.now(),
      charCount: 500,
      thinkingInProgress: true,
    };
    const result = formatThreadActivityEntry(entry);
    expect(result).toContain(':bulb:');
    expect(result).toContain('Thinking...');
    expect(result).toContain('500 chars');
  });

  it('formats generating with memo emoji (matches main activity message)', () => {
    const entry: ActivityEntry = {
      type: 'generating',
      timestamp: Date.now(),
      charCount: 1000,
      durationMs: 2000,
    };
    const result = formatThreadActivityEntry(entry);
    expect(result).toContain(':memo:');
    expect(result).toContain('Generating');
    expect(result).toContain('1000 chars');
  });

  it('formats error with colon after Error', () => {
    const entry: ActivityEntry = {
      type: 'error',
      timestamp: Date.now(),
      message: 'Connection timeout',
    };
    const result = formatThreadActivityEntry(entry);
    expect(result).toContain(':x:');
    expect(result).toContain('*Error:*');
    expect(result).toContain('Connection timeout');
  });
});
