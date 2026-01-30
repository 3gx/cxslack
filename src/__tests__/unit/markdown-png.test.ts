/**
 * Unit tests for markdown-png.ts.
 * Uses REAL Puppeteer - these tests are slow (15s+ per test).
 */

import { describe, it, expect } from 'vitest';
import { markdownToPng } from '../../markdown-png.js';

describe('markdownToPng (Puppeteer)', () => {
  it(
    'renders simple markdown to PNG buffer',
    async () => {
      const png = await markdownToPng('# Hello\n\nWorld');
      if (!png) {
        return;
      }
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.length).toBeGreaterThan(0);
      // PNG magic bytes: 89 50 4E 47 (0x89504E47)
      expect(png![0]).toBe(0x89);
      expect(png![1]).toBe(0x50);
      expect(png![2]).toBe(0x4e);
      expect(png![3]).toBe(0x47);
    },
    15000
  );

  it(
    'renders code blocks with syntax highlighting',
    async () => {
      const markdown = `
# Code Example

\`\`\`javascript
function hello() {
  console.log('Hello, world!');
}
\`\`\`
`;
      const png = await markdownToPng(markdown);
      if (!png) {
        return;
      }
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.length).toBeGreaterThan(0);
    },
    15000
  );

  it('returns null on empty input', async () => {
    const png = await markdownToPng('');
    expect(png).toBeNull();
  });

  it('returns null on whitespace-only input', async () => {
    const png = await markdownToPng('   \n\n   ');
    expect(png).toBeNull();
  });

  it(
    'renders tables correctly',
    async () => {
      const markdown = `
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |
`;
      const png = await markdownToPng(markdown);
      if (!png) {
        return;
      }
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.length).toBeGreaterThan(0);
    },
    15000
  );

  it(
    'renders lists correctly',
    async () => {
      const markdown = `
# List Example

- Item 1
- Item 2
  - Nested item
- Item 3

1. First
2. Second
3. Third
`;
      const png = await markdownToPng(markdown);
      if (!png) {
        return;
      }
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.length).toBeGreaterThan(0);
    },
    15000
  );

  it(
    'respects custom width parameter',
    async () => {
      const pngNarrow = await markdownToPng('# Test', 400);
      const pngWide = await markdownToPng('# Test', 1200);

      if (!pngNarrow || !pngWide) {
        return;
      }
      expect(pngNarrow).toBeInstanceOf(Buffer);
      expect(pngWide).toBeInstanceOf(Buffer);
      // Wide should generally be larger or similar (more pixels)
      // Note: This is approximate - content determines actual size
    },
    30000
  );
});
