/**
 * Content builder for Codex messages with file attachments.
 */

import { ProcessedFile, formatFileSize } from './file-handler.js';
import { TurnContent } from './codex-client.js';

/**
 * Format the file list header for Codex.
 */
function formatFilesHeader(files: ProcessedFile[]): string {
  const validFiles = files.filter((f) => !f.error);
  if (validFiles.length === 0) return '';

  const lines = ['The user has uploaded the following files:'];
  for (const file of validFiles) {
    const sizeStr = formatFileSize(file.size);
    lines.push(`File ${file.index}: ${file.name} (${file.mimetype}, ${sizeStr})`);
  }
  return lines.join('\n');
}

/**
 * Build Codex-compatible TurnContent blocks.
 *
 * Strategy:
 * - Always start with a text block containing file list + warnings + user message.
 * - Add image blocks:
 *   - Prefer data URL when base64 is available.
 *   - Fallback to local path reference when only localPath exists.
 * - Add text file contents inline as additional text blocks.
 */
export function buildMessageContent(
  userText: string,
  processedFiles: ProcessedFile[],
  warnings: string[] = []
): TurnContent[] {
  const blocks: TurnContent[] = [];

  const textParts: string[] = [];
  const header = formatFilesHeader(processedFiles);
  if (header) {
    textParts.push(header);
  }
  if (warnings.length > 0) {
    textParts.push('');
    textParts.push('Note: ' + warnings.join('. '));
  }
  textParts.push('');
  textParts.push('User message:');
  textParts.push(userText);

  blocks.push({
    type: 'text',
    text: textParts.join('\n'),
  });

  for (const file of processedFiles) {
    if (!file.isImage || file.error) continue;
    if (file.base64) {
      const mediaType = file.mimetype || 'image/png';
      blocks.push({
        type: 'image',
        url: `data:${mediaType};base64,${file.base64}`,
        mediaType,
      });
    } else if (file.localPath) {
      // Fallback: reference local file so model can use view_image tool.
      blocks.push({
        type: 'text',
        text: `Image file ${file.index} is available at ${file.localPath}.`,
      });
    }
  }

  for (const file of processedFiles) {
    if (file.isText && !file.error) {
      try {
        const textContent = file.buffer.toString('utf-8');
        blocks.push({
          type: 'text',
          text: `\n--- Content of File ${file.index}: ${file.name} ---\n${textContent}\n--- End of File ${file.index} ---`,
        });
      } catch {
        // If buffer can't be decoded as UTF-8, skip it.
      }
    }
  }

  return blocks;
}
