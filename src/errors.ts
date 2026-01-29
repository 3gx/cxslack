/**
 * Error handling for the Slack bot.
 * Principle: Bot must NEVER crash on invalid input. Always report error gracefully.
 */

/**
 * Error codes for categorizing different error types.
 */
export enum ErrorCode {
  // Slack errors
  SLACK_RATE_LIMITED = 'SLACK_RATE_LIMITED',
  SLACK_CHANNEL_NOT_FOUND = 'SLACK_CHANNEL_NOT_FOUND',
  SLACK_MESSAGE_TOO_LONG = 'SLACK_MESSAGE_TOO_LONG',
  SLACK_API_ERROR = 'SLACK_API_ERROR',

  // Codex errors
  CODEX_ERROR = 'CODEX_ERROR',
  CODEX_TIMEOUT = 'CODEX_TIMEOUT',
  CODEX_PROCESS_DIED = 'CODEX_PROCESS_DIED',
  CODEX_AUTH_ERROR = 'CODEX_AUTH_ERROR',

  // JSON-RPC errors
  JSONRPC_ERROR = 'JSONRPC_ERROR',
  JSONRPC_PARSE_ERROR = 'JSONRPC_PARSE_ERROR',

  // Session errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_FILE_MISSING = 'SESSION_FILE_MISSING',
  SESSION_FILE_CORRUPTED = 'SESSION_FILE_CORRUPTED',

  // File system errors
  WORKING_DIR_NOT_FOUND = 'WORKING_DIR_NOT_FOUND',
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  FILE_WRITE_ERROR = 'FILE_WRITE_ERROR',
  FILE_DOWNLOAD_ERROR = 'FILE_DOWNLOAD_ERROR',

  // Input errors
  INVALID_INPUT = 'INVALID_INPUT',
  EMPTY_MESSAGE = 'EMPTY_MESSAGE',

  // Approval errors
  APPROVAL_TIMEOUT = 'APPROVAL_TIMEOUT',
  APPROVAL_DECLINED = 'APPROVAL_DECLINED',
}

/**
 * Custom error class for Slack bot errors.
 * Includes error code and whether the error is recoverable.
 */
export class SlackBotError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean = false
  ) {
    super(message);
    this.name = 'SlackBotError';
  }
}

/**
 * Convert any error to a user-friendly message.
 * Never exposes internal details or stack traces.
 */
export function toUserMessage(error: unknown): string {
  if (error instanceof SlackBotError) {
    switch (error.code) {
      case ErrorCode.SESSION_NOT_FOUND:
      case ErrorCode.SESSION_FILE_MISSING:
        return 'Session not found. Starting a new session.';

      case ErrorCode.SESSION_FILE_CORRUPTED:
        return 'Session data was corrupted. Starting a new session.';

      case ErrorCode.WORKING_DIR_NOT_FOUND:
        return `Directory not found. Use \`@codex cwd /valid/path\` to set a valid working directory.`;

      case ErrorCode.CODEX_ERROR:
        return `Codex encountered an error: ${error.message}`;

      case ErrorCode.CODEX_TIMEOUT:
        return 'Request timed out. Please try again.';

      case ErrorCode.CODEX_PROCESS_DIED:
        return 'Codex process died unexpectedly. Restarting...';

      case ErrorCode.CODEX_AUTH_ERROR:
        return 'Codex authentication failed. Please run `codex auth login` to authenticate.';

      case ErrorCode.JSONRPC_ERROR:
        return `Communication error: ${error.message}`;

      case ErrorCode.SLACK_RATE_LIMITED:
        return 'Rate limited. Retrying...';

      case ErrorCode.SLACK_MESSAGE_TOO_LONG:
        return 'Response was too long and has been split into multiple messages.';

      case ErrorCode.SLACK_API_ERROR:
        return 'Failed to communicate with Slack. Please try again.';

      case ErrorCode.FILE_READ_ERROR:
        return `Could not read file: ${error.message}`;

      case ErrorCode.FILE_WRITE_ERROR:
        return `Could not write file: ${error.message}`;

      case ErrorCode.FILE_DOWNLOAD_ERROR:
        return `Could not download file: ${error.message}`;

      case ErrorCode.EMPTY_MESSAGE:
        return 'Please provide a message. Example: `@codex help me with this code`';

      case ErrorCode.INVALID_INPUT:
        return `Invalid input: ${error.message}`;

      case ErrorCode.APPROVAL_TIMEOUT:
        return 'Approval request timed out.';

      case ErrorCode.APPROVAL_DECLINED:
        return 'Action was declined.';

      default:
        return error.message || 'An unexpected error occurred. Please try again.';
    }
  }

  // Handle Slack API errors
  if (isSlackError(error)) {
    if (error.data?.error === 'ratelimited') {
      return 'Rate limited. Retrying...';
    }
    if (error.data?.error === 'channel_not_found') {
      return 'Channel not found.';
    }
    return `Slack error: ${error.data?.error || 'Unknown error'}`;
  }

  // Handle generic errors - show the actual message
  if (error instanceof Error) {
    return error.message || 'An unexpected error occurred. Please try again.';
  }

  return 'An unexpected error occurred. Please try again.';
}

/**
 * Check if an error is recoverable (can be retried).
 */
export function isRecoverable(error: unknown): boolean {
  if (error instanceof SlackBotError) {
    return error.recoverable;
  }

  // Slack rate limits are recoverable
  if (isSlackError(error) && error.data?.error === 'ratelimited') {
    return true;
  }

  // Network errors are often recoverable
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
      return true;
    }
  }

  return false;
}

/**
 * Type guard for Slack API errors.
 */
interface SlackApiError {
  data?: {
    error?: string;
    response_metadata?: {
      retry_after?: number;
    };
  };
}

function isSlackError(error: unknown): error is SlackApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'data' in error &&
    typeof (error as SlackApiError).data === 'object'
  );
}

/**
 * Get retry delay from Slack rate limit error.
 */
export function getRetryAfter(error: unknown): number | null {
  if (isSlackError(error)) {
    return error.data?.response_metadata?.retry_after ?? null;
  }
  return null;
}

/**
 * Create specific error instances for common scenarios.
 */
export const Errors = {
  sessionNotFound: (sessionId: string) =>
    new SlackBotError(
      `Session ${sessionId} not found`,
      ErrorCode.SESSION_NOT_FOUND,
      false
    ),

  sessionFileMissing: (sessionId: string) =>
    new SlackBotError(
      `Session file for ${sessionId} is missing`,
      ErrorCode.SESSION_FILE_MISSING,
      false
    ),

  sessionFileCorrupted: () =>
    new SlackBotError(
      'Session file is corrupted',
      ErrorCode.SESSION_FILE_CORRUPTED,
      false
    ),

  workingDirNotFound: (path: string) =>
    new SlackBotError(
      `Directory ${path} not found`,
      ErrorCode.WORKING_DIR_NOT_FOUND,
      false
    ),

  codexError: (message: string) =>
    new SlackBotError(
      message,
      ErrorCode.CODEX_ERROR,
      false
    ),

  codexTimeout: () =>
    new SlackBotError(
      'Request timed out',
      ErrorCode.CODEX_TIMEOUT,
      true
    ),

  codexProcessDied: (code?: number) =>
    new SlackBotError(
      `Codex process died with code ${code ?? 'unknown'}`,
      ErrorCode.CODEX_PROCESS_DIED,
      true
    ),

  codexAuthError: (message?: string) =>
    new SlackBotError(
      message || 'Authentication failed',
      ErrorCode.CODEX_AUTH_ERROR,
      false
    ),

  jsonRpcError: (message: string) =>
    new SlackBotError(
      message,
      ErrorCode.JSONRPC_ERROR,
      false
    ),

  slackRateLimited: (retryAfter?: number) =>
    new SlackBotError(
      `Rate limited${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      ErrorCode.SLACK_RATE_LIMITED,
      true
    ),

  slackApiError: (message: string) =>
    new SlackBotError(
      message,
      ErrorCode.SLACK_API_ERROR,
      true
    ),

  emptyMessage: () =>
    new SlackBotError(
      'Empty message',
      ErrorCode.EMPTY_MESSAGE,
      false
    ),

  invalidInput: (message: string) =>
    new SlackBotError(
      message,
      ErrorCode.INVALID_INPUT,
      false
    ),

  fileReadError: (path: string, cause?: string) =>
    new SlackBotError(
      cause ? `${path}: ${cause}` : path,
      ErrorCode.FILE_READ_ERROR,
      false
    ),

  fileWriteError: (path: string, cause?: string) =>
    new SlackBotError(
      cause ? `${path}: ${cause}` : path,
      ErrorCode.FILE_WRITE_ERROR,
      false
    ),

  fileDownloadError: (filename: string, cause?: string) =>
    new SlackBotError(
      `Failed to download ${filename}${cause ? `: ${cause}` : ''}`,
      ErrorCode.FILE_DOWNLOAD_ERROR,
      true // Recoverable - can retry
    ),

  approvalTimeout: () =>
    new SlackBotError(
      'Approval request timed out',
      ErrorCode.APPROVAL_TIMEOUT,
      false
    ),

  approvalDeclined: () =>
    new SlackBotError(
      'Action was declined',
      ErrorCode.APPROVAL_DECLINED,
      false
    ),
};
