/**
 * Retry helper for Slack API calls.
 *
 * Handles rate limiting and transient errors with exponential backoff.
 */

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

/**
 * Execute a Slack API operation with retry logic.
 *
 * Retries on:
 * - Rate limit (429 / 'ratelimited')
 * - Transient errors (timeout, service_unavailable)
 *
 * @param operation - The async operation to execute
 * @param label - Label for logging purposes
 * @returns The result of the operation
 */
export async function withSlackRetry<T>(
  operation: () => Promise<T>,
  label: string
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (e: unknown) {
      lastError = e as Error;
      const err = e as { data?: { error?: string }; code?: number; retryAfter?: number };
      const errorCode = err?.data?.error;

      // Rate limited - wait and retry
      if (errorCode === 'ratelimited' || err?.code === 429) {
        const retryAfter = err?.retryAfter || INITIAL_DELAY_MS * Math.pow(2, attempt);
        console.log(`[Slack] Rate limited on ${label}, retry in ${retryAfter}ms`);
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }

      // Transient errors - retry with backoff
      if (
        errorCode &&
        ['timeout', 'request_timeout', 'service_unavailable'].includes(errorCode)
      ) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
        console.log(`[Slack] Transient error on ${label}, retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Non-retryable error
      throw e;
    }
  }

  throw lastError;
}
