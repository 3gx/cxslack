/**
 * Unit tests for Slack API retry helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSlackRetry } from '../../slack-retry.js';

describe('withSlackRetry', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('returns result on success', async () => {
    const operation = vi.fn().mockResolvedValue('success');

    const result = await withSlackRetry(operation, 'test.operation');

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on rate limit (429)', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ code: 429, retryAfter: 10 })
      .mockResolvedValue('success');

    const result = await withSlackRetry(operation, 'test.operation');

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on ratelimited error', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: 'ratelimited' } })
      .mockResolvedValue('success');

    const result = await withSlackRetry(operation, 'test.operation');

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on transient timeout error', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: 'timeout' } })
      .mockResolvedValue('success');

    const result = await withSlackRetry(operation, 'test.operation');

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on request_timeout error', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: 'request_timeout' } })
      .mockResolvedValue('success');

    const result = await withSlackRetry(operation, 'test.operation');

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on service_unavailable error', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: 'service_unavailable' } })
      .mockResolvedValue('success');

    const result = await withSlackRetry(operation, 'test.operation');

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('throws on non-retryable errors', async () => {
    const error = new Error('channel_not_found');
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withSlackRetry(operation, 'test.operation')).rejects.toThrow(
      'channel_not_found'
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops after MAX_RETRIES', async () => {
    const error = { data: { error: 'ratelimited' } };
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withSlackRetry(operation, 'test.operation')).rejects.toEqual(error);
    expect(operation).toHaveBeenCalledTimes(3); // MAX_RETRIES = 3
  });
});
