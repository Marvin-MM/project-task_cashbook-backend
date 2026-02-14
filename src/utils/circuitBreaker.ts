import { logger } from './logger';

export enum CircuitBreakerState {
    CLOSED = 'CLOSED',
    OPEN = 'OPEN',
    HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenMaxAttempts: number;
    name: string;
}

export class CircuitBreaker {
    private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
    private failureCount = 0;
    private lastFailureTime = 0;
    private halfOpenAttempts = 0;
    private readonly options: CircuitBreakerOptions;

    constructor(options: Partial<CircuitBreakerOptions> & { name: string }) {
        this.options = {
            failureThreshold: 5,
            resetTimeoutMs: 30000,
            halfOpenMaxAttempts: 3,
            ...options,
        };
    }

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === CircuitBreakerState.OPEN) {
            if (Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs) {
                this.state = CircuitBreakerState.HALF_OPEN;
                this.halfOpenAttempts = 0;
                logger.info(`Circuit breaker ${this.options.name} transitioning to HALF_OPEN`);
            } else {
                throw new Error(`Circuit breaker ${this.options.name} is OPEN`);
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    private onSuccess(): void {
        if (this.state === CircuitBreakerState.HALF_OPEN) {
            this.halfOpenAttempts++;
            if (this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
                this.state = CircuitBreakerState.CLOSED;
                this.failureCount = 0;
                logger.info(`Circuit breaker ${this.options.name} transitioning to CLOSED`);
            }
        } else {
            this.failureCount = 0;
        }
    }

    private onFailure(): void {
        this.failureCount++;
        this.lastFailureTime = Date.now();

        if (this.state === CircuitBreakerState.HALF_OPEN) {
            this.state = CircuitBreakerState.OPEN;
            logger.warn(`Circuit breaker ${this.options.name} back to OPEN from HALF_OPEN`);
        } else if (this.failureCount >= this.options.failureThreshold) {
            this.state = CircuitBreakerState.OPEN;
            logger.warn(`Circuit breaker ${this.options.name} tripped to OPEN after ${this.failureCount} failures`);
        }
    }

    getState(): CircuitBreakerState {
        return this.state;
    }
}
