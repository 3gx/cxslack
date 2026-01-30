/**
 * Integration tests for file upload content handling.
 */

import { describe, it, expect } from 'vitest';
import { processSlackFiles, SlackFile } from '../../file-handler.js';
import { buildMessageContent } from '../../content-builder.js';
import { TurnContent } from '../../codex-client.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PNG_BUFFER = Buffer.from(PNG_BASE64, 'base64');

describe('File upload content handling', () => {
  it('orders files by created timestamp and preserves 1-based indices', async () => {
    const files: SlackFile[] = [
      { id: 'F3', name: 'third.png', mimetype: 'image/png', size: PNG_BUFFER.length, created: 3000 },
      { id: 'F1', name: 'first.txt', mimetype: 'text/plain', size: 5, created: 1000 },
      { id: 'F2', name: 'second.png', mimetype: 'image/png', size: PNG_BUFFER.length, created: 2000 },
    ];

    const result = await processSlackFiles(files, 'token', {
      downloadFile: async (file) => {
        if ((file.mimetype || '').startsWith('image/')) return PNG_BUFFER;
        return Buffer.from('hello', 'utf-8');
      },
      writeTempFile: async (_buffer, filename, _extension) => `/tmp/${filename}-mock.png`,
    });

    expect(result.files[0].name).toBe('first.txt');
    expect(result.files[1].name).toBe('second.png');
    expect(result.files[2].name).toBe('third.png');
    expect(result.files[0].index).toBe(1);
    expect(result.files[1].index).toBe(2);
    expect(result.files[2].index).toBe(3);
  });

  it('builds data URL image blocks when base64 is available', () => {
    const processed = [{
      index: 1,
      name: 'image.png',
      mimetype: 'image/png',
      size: PNG_BUFFER.length,
      buffer: PNG_BUFFER,
      base64: PNG_BASE64,
      isImage: true,
      isText: false,
    }];

    const content = buildMessageContent('Describe the image', processed) as TurnContent[];
    const imageBlocks = content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
    });
    expect((imageBlocks[0] as { url: string }).url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('falls back to local path hint when base64 is unavailable', () => {
    const processed = [{
      index: 1,
      name: 'big.png',
      mimetype: 'image/png',
      size: 5 * 1024 * 1024,
      buffer: Buffer.alloc(0),
      isImage: true,
      isText: false,
      localPath: '/tmp/cxslack-big.png',
    }];

    const content = buildMessageContent('Use the image', processed) as TurnContent[];
    const imageBlocks = content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(0);
    const textBlocks = content.filter((b) => b.type === 'text') as Array<{ type: 'text'; text: string }>;
    const combined = textBlocks.map((b) => b.text).join('\n');
    expect(combined).toContain('/tmp/cxslack-big.png');
  });
});
