import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestCoalescer } from '../src/index';

describe('RequestCoalescer Core Deduplication', () => {
  let coalescer: RequestCoalescer;

  beforeEach(() => {
    coalescer = new RequestCoalescer();
  });

  it('should merge duplicate concurrent requests and run the function only once', async () => {
    let callCount = 0;
    const asyncFn = async () => {
      callCount++;
      return new Promise((resolve) => setTimeout(() => resolve('data'), 50));
    };

    // Trigger multiple concurrent requests
    const results = await Promise.all([
      coalescer.coalesce('key1', asyncFn),
      coalescer.coalesce('key1', asyncFn),
      coalescer.coalesce('key1', asyncFn),
    ]);

    expect(results).toEqual(['data', 'data', 'data']);
    expect(callCount).toBe(1); // Only executed once!
    
    // Stats check
    const stats = coalescer.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.resolves).toBe(1);
    expect(stats.active).toBe(0);
  });

  it('should run again for sequential requests after completion (without TTL)', async () => {
    let callCount = 0;
    const asyncFn = async () => {
      callCount++;
      return 'data';
    };

    await coalescer.coalesce('key1', asyncFn);
    await coalescer.coalesce('key1', asyncFn);

    expect(callCount).toBe(2); // Cleanup happened, so it runs again
  });

  it('should handle errors correctly and clean up the cache', async () => {
    let callCount = 0;
    const errorFn = async () => {
      callCount++;
      throw new Error('Database Error');
    };

    // First run fails
    await expect(coalescer.coalesce('errKey', errorFn)).rejects.toThrow('Database Error');
    
    // Check that we can execute it again (it has been cleaned up from cache)
    await expect(coalescer.coalesce('errKey', errorFn)).rejects.toThrow('Database Error');
    
    expect(callCount).toBe(2);
    expect(coalescer.getStats().rejects).toBe(2);
  });
});

describe('Production Features: Timeout & AbortSignal', () => {
  let coalescer: RequestCoalescer;

  beforeEach(() => {
    coalescer = new RequestCoalescer();
  });

  it('should timeout a request if it exceeds timeout limit', async () => {
    const slowFn = () => new Promise((resolve) => setTimeout(() => resolve('done'), 100));

    await expect(
      coalescer.coalesce('timeoutKey', slowFn, { timeout: 30 })
    ).rejects.toThrow('Request timed out after 30ms');
  });

  it('should keep other callers unaffected if one caller times out', async () => {
    const slowFn = () => new Promise((resolve) => setTimeout(() => resolve('done'), 100));

    const p1 = coalescer.coalesce('mixedKey', slowFn, { timeout: 30 }); // Should timeout
    const p2 = coalescer.coalesce('mixedKey', slowFn, { timeout: 200 }); // Should succeed

    await expect(p1).rejects.toThrow('Request timed out after 30ms');
    const res2 = await p2;
    expect(res2).toBe('done');
  });

  it('should abort request immediately if AbortSignal is aborted', async () => {
    const slowFn = () => new Promise((resolve) => setTimeout(() => resolve('done'), 100));
    const controller = new AbortController();

    const p = coalescer.coalesce('abortKey', slowFn, { signal: controller.signal });
    
    // Abort after 20ms
    setTimeout(() => controller.abort(), 20);

    await expect(p).rejects.toThrow('Operation aborted');
  });
});

describe('Production Features: TTL & Limits', () => {
  let coalescer: RequestCoalescer;

  beforeEach(() => {
    coalescer = new RequestCoalescer();
  });

  it('should keep resolved value in cache for TTL duration', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return 'cached-value';
    };

    // Execute with TTL of 100ms
    const r1 = await coalescer.coalesce('ttlKey', fn, { ttl: 100 });
    expect(r1).toBe('cached-value');

    // Call immediately - should hit cache
    const r2 = await coalescer.coalesce('ttlKey', fn);
    expect(r2).toBe('cached-value');
    expect(callCount).toBe(1); // Still 1

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Call again - should trigger new execution
    const r3 = await coalescer.coalesce('ttlKey', fn);
    expect(r3).toBe('cached-value');
    expect(callCount).toBe(2); // Increased to 2!
  });

  it('should respect maxPending execution limit', async () => {
    coalescer = new RequestCoalescer({ maxPending: 2 });
    
    const slowFn = () => new Promise((resolve) => setTimeout(resolve, 50));

    // Start 2 operations
    coalescer.coalesce('k1', slowFn);
    coalescer.coalesce('k2', slowFn);

    // Try starting a 3rd unique operation - should fail
    await expect(coalescer.coalesce('k3', slowFn)).rejects.toThrow(
      'Max pending requests limit (2) reached'
    );
  });
});

describe('Decorator wrap helper', () => {
  it('should correctly wrap dynamic function and coalesce executions', async () => {
    const coalescer = new RequestCoalescer();
    let apiCall = 0;

    const getUser = async (id: number) => {
      apiCall++;
      return { id, name: `user-${id}` };
    };

    const getCoalescedUser = coalescer.wrap(getUser, (id) => `user:${id}`);

    // Trigger concurrent calls
    const [u1, u2, u3] = await Promise.all([
      getCoalescedUser(1),
      getCoalescedUser(1),
      getCoalescedUser(2),
    ]);

    expect(u1).toEqual({ id: 1, name: 'user-1' });
    expect(u2).toEqual({ id: 1, name: 'user-1' });
    expect(u3).toEqual({ id: 2, name: 'user-2' });

    expect(apiCall).toBe(2); // User 1 called once, User 2 called once. Total = 2!
  });
});
