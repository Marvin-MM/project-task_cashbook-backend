import { CircuitBreaker } from '../utils/circuitBreaker';

/**
 * Pre-configured circuit breaker singletons for external services.
 *
 * s3Breaker  — wraps S3 upload/download/delete operations
 * dbBreaker  — wraps heavy DB aggregation queries (reports, summaries)
 */

export const s3Breaker = new CircuitBreaker({
    name: 's3',
    failureThreshold: 3,
    resetTimeoutMs: 60_000,    // 1 minute cooldown
    halfOpenMaxAttempts: 2,
});

export const dbBreaker = new CircuitBreaker({
    name: 'db-aggregation',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,    // 30 second cooldown
    halfOpenMaxAttempts: 3,
});
