export * from './types';
import { CoalescerOptions, CoalesceOptions, CoalescerStats } from './types';

/**
 * Internal bookkeeping for a single in-flight (or recently settled) key.
 * We keep the promise itself so concurrent callers can attach to the same
 * underlying work instead of triggering it again.
 */
interface CacheEntry<T> {
  promise: Promise<T>;
  isPending: boolean;
}

/**
 * Deduplicates concurrent async calls that share the same key.
 *
 * The classic use case: several parts of an app request the same resource
 * (e.g. `getUser("42")`) at roughly the same time. Without coalescing,
 * each call fires its own network request. With coalescing, the first
 * call "wins" and everyone else rides on its promise.
 *
 * Supports optional TTL-based result caching, per-call timeouts, abort
 * signals, and a concurrency ceiling via `maxPending`.
 */
export class RequestCoalescer {
  // Keyed by whatever string identifies the request. `any` is intentional
  // here since a single coalescer instance is typically reused across many
  // differently-typed calls (see `coalesce<T>`).
  private cache = new Map<string, CacheEntry<any>>();

  private defaultOptions: CoalescerOptions;

  private stats: CoalescerStats = {
    hits: 0,
    misses: 0,
    resolves: 0,
    rejects: 0,
    active: 0,
  };

  constructor(options: CoalescerOptions = {}) {
    this.defaultOptions = options;
  }

  /** Returns a snapshot of current stats (safe to mutate, won't affect internal state). */
  public getStats(): CoalescerStats {
    return { ...this.stats };
  }

  public resetStats(): void {
    this.stats = { hits: 0, misses: 0, resolves: 0, rejects: 0, active: 0 };
  }

  /** Drops all cached entries. Does not cancel in-flight underlying requests. */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Runs `fn()` for a given key, or reuses the result of an identical
   * call already in flight/cached under that key.
   *
   * Important ordering detail: the promise is stored in the cache
   * *before* we attach `.then()` to it. If we cached it after, a second
   * caller could sneak in between `fn()` resolving and the cache write,
   * causing a duplicate request — a classic coalescing race condition.
   */
  public async coalesce<T>(
    key: string,
    fn: () => Promise<T>,
    options?: CoalesceOptions
  ): Promise<T> {
    const mergedOptions = { ...this.defaultOptions, ...options };

    const cachedEntry = this.cache.get(key);

    if (cachedEntry) {
      this.stats.hits++;
      mergedOptions.onHit?.(key);

      // The cache stores `any`; we know by construction that whoever
      // populated this key with `coalesce<T>` used the same T for the
      // same key, so this assertion is safe in practice.
      return this.wrapWithCallerControl(
        cachedEntry.promise as Promise<T>,
        mergedOptions.timeout,
        mergedOptions.signal
      );
    }

    const maxPending = this.defaultOptions.maxPending ?? Infinity;
    if (this.stats.active >= maxPending) {
      throw new Error(`Max pending requests limit (${maxPending}) reached`);
    }

    this.stats.misses++;
    mergedOptions.onMiss?.(key);

    this.stats.active++;
    const startTime = Date.now();

    const rawPromise = fn();

    // Register the entry immediately — see method docstring for why this
    // has to happen before the request settles.
    const entry: CacheEntry<T> = {
      promise: rawPromise,
      isPending: true,
    };
    this.cache.set(key, entry);

    rawPromise.then(
      (value) => {
        this.stats.active--;
        this.stats.resolves++;
        const duration = Date.now() - startTime;
        mergedOptions.onResolve?.(key, duration);

        entry.isPending = false;

        const ttl = mergedOptions.ttl ?? this.defaultOptions.ttl;
        if (ttl && ttl > 0) {
          // Keep the resolved value cached for `ttl` ms so near-simultaneous
          // duplicate calls right after completion still get coalesced.
          setTimeout(() => {
            // Only evict if this is still the same entry — a newer call
            // for the same key may have already replaced it, and we don't
            // want a stale timer deleting fresh data.
            if (this.cache.get(key) === entry) {
              this.cache.delete(key);
            }
          }, ttl);
        } else {
          this.cache.delete(key);
        }
      },
      (error) => {
        this.stats.active--;
        this.stats.rejects++;
        const duration = Date.now() - startTime;
        mergedOptions.onReject?.(key, error, duration);

        // Failures are never cached (regardless of ttl) so the next
        // attempt gets a genuine retry instead of a cached rejection.
        if (this.cache.get(key) === entry) {
          this.cache.delete(key);
        }
      }
    );

    return this.wrapWithCallerControl(
      rawPromise,
      mergedOptions.timeout,
      mergedOptions.signal
    );
  }

  /**
   * Wraps the shared promise with per-caller timeout/abort handling
   * without affecting the underlying request or other callers attached
   * to the same key. Achieved via `Promise.race` against timer/abort
   * promises that never resolve, only reject.
   */
  private wrapWithCallerControl<T>(
    promise: Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T> {
    const promises: Promise<T>[] = [promise];

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    if (timeoutMs && timeoutMs > 0) {
      promises.push(
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Request timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      );
    }

    if (signal) {
      if (signal.aborted) {
        // Already aborted before we even started racing — bail out early
        // and clean up the timer we just armed, if any.
        if (timeoutId) clearTimeout(timeoutId);
        return Promise.reject(new Error('Operation aborted'));
      }

      promises.push(
        new Promise<never>((_, reject) => {
          abortHandler = () => reject(new Error('Operation aborted'));
          signal.addEventListener('abort', abortHandler);
        })
      );
    }

    // Skip the race entirely when there's nothing to race against —
    // avoids an unnecessary wrapper promise on the common path.
    if (!timeoutId && !signal) {
      return promise;
    }

    return Promise.race(promises).finally(() => {
      // Always clean up, whether we won or lost the race, so timers and
      // listeners don't linger and leak memory.
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    });
  }

  /**
   * Convenience wrapper: turns any async function into a coalescing
   * version of itself, keyed by `keyGenerator`.
   *
   * @example
   * const getUser = (id: string) => fetch(`/api/users/${id}`).then(r => r.json());
   * const coalescedGetUser = coalescer.wrap(getUser, (id) => `user:${id}`);
   * // Concurrent calls with the same id now share one request.
   */
  public wrap<Args extends any[], R>(
    fn: (...args: Args) => Promise<R>,
    keyGenerator: (...args: Args) => string,
    options?: CoalesceOptions
  ): (...args: Args) => Promise<R> {
    return (...args: Args) => {
      const key = keyGenerator(...args);
      // Wrapped so `fn` is invoked lazily, only on an actual cache miss
      // inside `coalesce`.
      return this.coalesce(key, () => fn(...args), options);
    };
  }
}