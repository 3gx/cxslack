/**
 * File handling for Slack file uploads.
 * Downloads files to memory and prepares them for Codex input.
 */

import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

// Constants
const MAX_FILE_SIZE = 25 * 1024 * 1024;           // 25MB per file
const MAX_FILE_COUNT = 20;                         // 20 files per message
const DOWNLOAD_TIMEOUT_MS = 30000;                 // 30 seconds
const MAX_IMAGE_INLINE_BYTES = 3.75 * 1024 * 1024; // ~3.75MB inline image cap
const IMAGE_RESIZE_STEPS = [
  { maxDimension: 2048, quality: 85 },
  { maxDimension: 1024, quality: 80 },
];

export interface ResizeResult {
  buffer: Buffer;
  mimetype: string;
  resized: boolean;
  tooLarge: boolean;
}

/**
 * Slack file object from event payload.
 */
export interface SlackFile {
  id: string;
  name: string | null;
  mimetype?: string;
  filetype?: string;  // Fallback for extension if mimetype missing
  size?: number;
  created?: number;
  url_private_download?: string;
  url_private?: string;  // Fallback if url_private_download is undefined
}

/**
 * Processed file ready for content building.
 */
export interface ProcessedFile {
  index: number;         // 1-based index for user reference ("file 1", "file 2")
  name: string;          // Filename (or fallback: "{id}-unnamed.{ext}")
  mimetype: string;
  size: number;
  buffer: Buffer;        // Raw file content in memory
  base64?: string;       // Base64 encoded (for inline images)
  localPath?: string;    // Local temp path for fallback image viewing
  isImage: boolean;
  isText: boolean;
  error?: string;        // Error message if processing failed
}

/**
 * Result of processing files with any warnings.
 */
export interface ProcessFilesResult {
  files: ProcessedFile[];
  warnings: string[];    // Warnings about skipped files, etc.
}

export interface ProcessSlackFilesOptions {
  downloadFile?: (file: SlackFile, token: string) => Promise<Buffer>;
  writeTempFile?: (buffer: Buffer, filename: string, extension: string) => Promise<string>;
  resizeImageIfNeeded?: (buffer: Buffer, mimetype: string) => Promise<ResizeResult>;
}

/**
 * Check if mimetype is an image type supported by Codex.
 */
export function isImageFile(mimetype: string): boolean {
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimetype);
}

/**
 * Check if mimetype is a text-based file.
 */
export function isTextFile(mimetype: string): boolean {
  if (mimetype.startsWith('text/')) return true;
  const textMimetypes = [
    'application/json',
    'application/javascript',
    'application/typescript',
    'application/xml',
    'application/x-yaml',
    'application/x-sh',
    'application/x-python',
  ];
  return textMimetypes.includes(mimetype);
}

/**
 * Check if file is a binary type that cannot be read.
 */
export function isBinaryFile(mimetype: string): boolean {
  const binaryPrefixes = ['audio/', 'video/'];
  const binaryMimetypes = [
    'application/pdf',
    'application/zip',
    'application/x-tar',
    'application/x-gzip',
    'application/octet-stream',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ];
  return binaryPrefixes.some(p => mimetype.startsWith(p)) || binaryMimetypes.includes(mimetype);
}

/**
 * Get file extension from mimetype or filetype.
 */
function getExtension(mimetype: string, filetype?: string): string {
  if (filetype) return filetype;

  const mimeToExt: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/json': 'json',
    'application/javascript': 'js',
    'application/typescript': 'ts',
    'application/xml': 'xml',
    'application/x-yaml': 'yaml',
  };
  return mimeToExt[mimetype] || 'bin';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getFallbackName(file: SlackFile): string {
  const ext = getExtension(file.mimetype || 'application/octet-stream', file.filetype);
  return `${file.id}-unnamed.${ext}`;
}

/**
 * Download a Slack file using private URL and token.
 */
async function downloadSlackFile(file: SlackFile, token: string): Promise<Buffer> {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    throw new Error('No download URL available');
  }

  return await new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total > MAX_FILE_SIZE) {
          req.destroy(new Error('File too large'));
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('Download timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Write a buffer to a uniquely named temp file.
 */
export async function writeTempFile(buffer: Buffer, filename: string, extension: string): Promise<string> {
  const safeName = sanitizeFilename(filename || 'file');
  const unique = randomUUID();
  const tempName = `cxslack-${Date.now()}-${unique}-${safeName}.${extension}`;
  const tempPath = path.join(os.tmpdir(), tempName);
  await fs.promises.writeFile(tempPath, buffer);
  return tempPath;
}

async function resizeImageIfNeeded(buffer: Buffer, mimetype: string): Promise<ResizeResult> {
  if (buffer.length <= MAX_IMAGE_INLINE_BYTES) {
    return { buffer, mimetype, resized: false, tooLarge: false };
  }

  let smallest: Buffer | null = null;
  for (const step of IMAGE_RESIZE_STEPS) {
    const resized = await sharp(buffer, { failOnError: false })
      .rotate()
      .resize(step.maxDimension, step.maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: step.quality, mozjpeg: true })
      .toBuffer();

    if (!smallest || resized.length < smallest.length) {
      smallest = resized;
    }

    if (resized.length <= MAX_IMAGE_INLINE_BYTES) {
      return {
        buffer: resized,
        mimetype: 'image/jpeg',
        resized: true,
        tooLarge: false,
      };
    }
  }

  if (smallest) {
    return {
      buffer: smallest,
      mimetype: 'image/jpeg',
      resized: true,
      tooLarge: smallest.length > MAX_IMAGE_INLINE_BYTES,
    };
  }

  return { buffer, mimetype, resized: false, tooLarge: true };
}

/**
 * Process Slack files for Codex consumption.
 */
export async function processSlackFiles(
  files: SlackFile[],
  token: string,
  options: ProcessSlackFilesOptions = {}
): Promise<ProcessFilesResult> {
  const warnings: string[] = [];
  const processedFiles: ProcessedFile[] = [];

  let filesToProcess = files;
  if (files.length > MAX_FILE_COUNT) {
    warnings.push(`${files.length - MAX_FILE_COUNT} additional files skipped (max ${MAX_FILE_COUNT})`);
    filesToProcess = files.slice(0, MAX_FILE_COUNT);
  }

  // Sort by created timestamp, using array index as tiebreaker
  const sortedFiles = filesToProcess
    .map((file, originalIndex) => ({ file, originalIndex }))
    .sort((a, b) => {
      const createdA = a.file.created ?? 0;
      const createdB = b.file.created ?? 0;
      if (createdA !== createdB) return createdA - createdB;
      return a.originalIndex - b.originalIndex;
    });

  const download = options.downloadFile ?? downloadSlackFile;
  const writeTemp = options.writeTempFile ?? writeTempFile;
  const resizeImage = options.resizeImageIfNeeded ?? resizeImageIfNeeded;

  for (let i = 0; i < sortedFiles.length; i++) {
    const { file } = sortedFiles[i];
    const index = i + 1;
    const name = file.name || getFallbackName(file);
    const mimetype = file.mimetype || 'application/octet-stream';
    const extension = getExtension(mimetype, file.filetype);
    const isImage = isImageFile(mimetype);
    const isText = isTextFile(mimetype);
    const isBinary = isBinaryFile(mimetype);

    if (isBinary) {
      const typeLabel = mimetype.startsWith('audio/') ? 'audio' :
        mimetype.startsWith('video/') ? 'video' :
        mimetype === 'application/pdf' ? 'PDF' : 'binary';
      warnings.push(`File ${index} (${name}) skipped - ${typeLabel} files not supported`);
      continue;
    }

    if (file.size && file.size > MAX_FILE_SIZE) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      warnings.push(`File ${index} (${name}) too large (${sizeMB}MB, max 25MB)`);
      continue;
    }

    try {
      let buffer = await download(file, token);
      let outputMimetype = mimetype;
      let outputExtension = extension;
      let base64: string | undefined;
      let localPath: string | undefined;

      if (isImage) {
        try {
          const resizeResult = await resizeImage(buffer, mimetype);
          buffer = resizeResult.buffer;
          outputMimetype = resizeResult.mimetype;
          outputExtension = getExtension(outputMimetype);
          if (resizeResult.resized && resizeResult.tooLarge) {
            const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
            warnings.push(`File ${index} (${name}) image still too large for inline data URL after resize (${sizeMB}MB, max 3.75MB)`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          warnings.push(`File ${index} (${name}) image resize failed: ${errorMsg}`);
        }

        localPath = await writeTemp(buffer, name, outputExtension);
        if (buffer.length <= MAX_IMAGE_INLINE_BYTES) {
          base64 = buffer.toString('base64');
        } else if (!warnings.some((warning) => warning.includes(`File ${index} (${name}) image still too large`))) {
          const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
          warnings.push(`File ${index} (${name}) image too large for inline data URL (${sizeMB}MB, max 3.75MB)`);
        }
      }

      processedFiles.push({
        index,
        name,
        mimetype: outputMimetype,
        size: buffer.length,
        buffer,
        base64,
        localPath,
        isImage,
        isText,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg.toLowerCase().includes('timed out')) {
        warnings.push(`File ${index} (${name}) download timed out`);
      } else {
        warnings.push(`File ${index} (${name}) could not be downloaded: ${errorMsg}`);
      }
      processedFiles.push({
        index,
        name,
        mimetype,
        size: 0,
        buffer: Buffer.alloc(0),
        isImage,
        isText,
        error: errorMsg,
      });
    }
  }

  return { files: processedFiles, warnings };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
