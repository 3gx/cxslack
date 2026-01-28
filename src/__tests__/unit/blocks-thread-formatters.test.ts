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
    expect(result).toContain(':white_check_mark:');
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
    expect(result).toContain(':white_check_mark:');
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
    expect(result).toContain(':brain:');
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
    expect(result).toContain(':brain:');
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
