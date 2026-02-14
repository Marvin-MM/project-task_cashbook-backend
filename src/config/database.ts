import { PrismaClient } from '@prisma/client';
import { config } from './index';
import { logger } from '../utils/logger';

let prisma: PrismaClient;

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

function createPrismaClient(): PrismaClient {
    const client = new PrismaClient({
        datasources: {
            db: {
                url: config.DATABASE_URL,
            },
        },
        log: config.NODE_ENV === 'development'
            ? [
                { emit: 'event', level: 'query' },
                { emit: 'event', level: 'error' },
                { emit: 'event', level: 'warn' },
            ]
            : [{ emit: 'event', level: 'error' }],
    });

    if (config.NODE_ENV === 'development') {
        (client as any).$on('query', (e: any) => {
            logger.debug('Prisma Query', {
                query: e.query,
                params: e.params,
                duration: `${e.duration}ms`,
            });
        });
    }

    (client as any).$on('error', (e: any) => {
        logger.error('Prisma Error', { message: e.message });
    });

    return client;
}

async function connectWithRetry(client: PrismaClient, retries = MAX_RETRIES): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await client.$connect();
            logger.info('✅ Database connected successfully');
            return;
        } catch (error) {
            logger.error(`Database connection attempt ${attempt}/${retries} failed`, {
                error: error instanceof Error ? error.message : String(error),
            });
            if (attempt === retries) {
                throw new Error('Failed to connect to database after maximum retries');
            }
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        }
    }
}

export function getPrismaClient(): PrismaClient {
    if (!prisma) {
        prisma = createPrismaClient();
    }
    return prisma;
}

export async function initializeDatabase(): Promise<PrismaClient> {
    const client = getPrismaClient();
    await connectWithRetry(client);
    return client;
}

export async function disconnectDatabase(): Promise<void> {
    if (prisma) {
        await prisma.$disconnect();
        logger.info('Database disconnected');
    }
}

export { prisma };
