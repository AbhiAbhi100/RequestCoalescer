/**
 * Options that configure the default behavior of a RequestCoalescer instance.
 * These are set once via the constructor and act as the baseline for every
 * call to `coalesce()`, unless overridden per-call by CoalesceOptions.
 */
export interface CoalescerOptions {
  /** Abort an in-flight request if it doesn't settle within this many ms. */
  timeout?: number;

  /**
   * How long (ms) a resolved result stays cached after completion.
   * Useful for absorbing bursts of duplicate calls right after a request
   * finishes. If omitted, successful results are evicted immediately.
   */
  ttl?: number;

  /**
   * Upper bound on concurrently active (in-flight) requests. Once reached,
   * new keys are rejected with an error instead of being queued.
   * Defaults to unlimited.
   */
  maxPending?: number;

  /** Fired when a call reuses an already in-flight or cached promise. */
  onHit?: (key: string) => void;

  /** Fired when a call triggers an actual new invocation of `fn`. */
  onMiss?: (key: string) => void;

  /** Fired when the underlying request resolves successfully. */
  onResolve?: (key: string, durationMs: number) => void;

  /** Fired when the underlying request rejects. */
  onReject?: (key: string, error: any, durationMs: number) => void;
}

/**
 * Per-call overrides for `coalesce()`. Anything left unset here falls back
 * to the instance-level CoalescerOptions.
 */
export interface CoalesceOptions {
  /** Overrides the instance-level timeout for this call only. */
  timeout?: number;

  /** Overrides the instance-level ttl for this call only. */
  ttl?: number;

  /**
   * Lets the caller cancel their wait independently of the underlying
   * request — the shared promise keeps running for other callers even if
   * this signal aborts.
   */
  signal?: AbortSignal;
}

/** Running counters exposed via `RequestCoalescer.getStats()`. */
export interface CoalescerStats {
  /** Number of calls that were served by an existing promise/cache entry. */
  hits: number;

  /** Number of calls that resulted in a fresh call to `fn`. */
  misses: number;

  /** Number of underlying requests that resolved successfully. */
  resolves: number;

  /** Number of underlying requests that rejected. */
  rejects: number;

  /** Number of requests currently in flight. */
  active: number;
}