/**
 * Abort state tracker for conversation turns.
 *
 * Tracks which conversations have been aborted to ensure proper
 * status transitions even if the abort signal arrives after
 * some events have already been processed.
 */

// Set of conversation keys that have been marked as aborted
const abortedQueries = new Set<string>();

/**
 * Mark a conversation as aborted.
 */
export function markAborted(key: string): void {
  abortedQueries.add(key);
}

/**
 * Check if a conversation has been aborted.
 */
export function isAborted(key: string): boolean {
  return abortedQueries.has(key);
}

/**
 * Clear the abort state for a conversation.
 * Should be called after the turn completes.
 */
export function clearAborted(key: string): void {
  abortedQueries.delete(key);
}
