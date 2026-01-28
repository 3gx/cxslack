/**
 * Unit tests for abort state tracker.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { markAborted, isAborted, clearAborted } from '../../abort-tracker.js';

describe('Abort Tracker', () => {
  // Clear state between tests by marking and clearing a known key
  beforeEach(() => {
    // Use unique keys per test to avoid cross-contamination
  });

  it('markAborted sets key as aborted', () => {
    const key = 'test-key-1';
    expect(isAborted(key)).toBe(false);

    markAborted(key);
    expect(isAborted(key)).toBe(true);

    // Cleanup
    clearAborted(key);
  });

  it('isAborted returns true for marked keys', () => {
    const key = 'test-key-2';
    markAborted(key);

    expect(isAborted(key)).toBe(true);

    // Cleanup
    clearAborted(key);
  });

  it('isAborted returns false for unmarked keys', () => {
    const key = 'test-key-never-marked';

    expect(isAborted(key)).toBe(false);
  });

  it('clearAborted removes key', () => {
    const key = 'test-key-3';
    markAborted(key);
    expect(isAborted(key)).toBe(true);

    clearAborted(key);
    expect(isAborted(key)).toBe(false);
  });

  it('isolates different conversation keys', () => {
    const key1 = 'conversation-1';
    const key2 = 'conversation-2';

    markAborted(key1);

    expect(isAborted(key1)).toBe(true);
    expect(isAborted(key2)).toBe(false);

    // Cleanup
    clearAborted(key1);
  });

  it('can mark and clear multiple keys', () => {
    const key1 = 'multi-key-1';
    const key2 = 'multi-key-2';

    markAborted(key1);
    markAborted(key2);

    expect(isAborted(key1)).toBe(true);
    expect(isAborted(key2)).toBe(true);

    clearAborted(key1);

    expect(isAborted(key1)).toBe(false);
    expect(isAborted(key2)).toBe(true);

    // Cleanup
    clearAborted(key2);
  });
});
