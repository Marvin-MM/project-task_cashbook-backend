import Redis from 'ioredis';
import { config } from './index';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3000;

export function createRedisClient(): Redis {
    const client = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
        retryStrategy(times: number) {
            if (times > MAX_RETRIES) {
                logger.error('Redis max retries reached, giving up');
                return null;
            }
            const delay = Math.min(times * RETRY_DELAY_MS, 30000);
            logger.warn(`Redis retrying connection in ${delay}ms (attempt ${times}/${MAX_RETRIES})`);
            return delay;
        },
        reconnectOnError(err: Error) {
            const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
            return targetErrors.some((e) => err.message.includes(e));
        },
        tls: config.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    });

    client.on('connect', () => {
        logger.info('✅ Redis connected successfully');
    });

    client.on('error', (err: Error) => {
        logger.error('Redis error', { error: err.message });
    });

    client.on('close', () => {
        logger.warn('Redis connection closed');
    });

    return client;
}

export function getRedisClient(): Redis {
    if (!redisClient) {
        redisClient = createRedisClient();
    }
    return redisClient;
}

export async function disconnectRedis(): Promise<void> {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
        logger.info('Redis disconnected');
    }
}
