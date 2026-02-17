import { CircuitBreaker } from '../utils/circuitBreaker';

/**
 * Pre-configured circuit breaker singletons for external services.
 *
 * minioBreaker — wraps MinIO upload/download/delete operations
 * dbBreaker    — wraps heavy DB aggregation queries (reports, summaries)
 */

export const minioBreaker = new CircuitBreaker({
    name: 'minio',
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
