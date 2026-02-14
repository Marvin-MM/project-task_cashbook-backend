import { Router, Request, Response } from 'express';
import { getPrismaClient } from '../config/database';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';

const router = Router();

router.get('/health', async (req: Request, res: Response) => {
    const checks: Record<string, string> = {};

    // Database check
    try {
        await getPrismaClient().$queryRaw`SELECT 1`;
        checks.database = 'healthy';
    } catch {
        checks.database = 'unhealthy';
    }

    // Redis check
    try {
        const redis = getRedisClient();
        await redis.ping();
        checks.redis = 'healthy';
    } catch {
        checks.redis = 'unhealthy';
    }

    const allHealthy = Object.values(checks).every((v) => v === 'healthy');

    res.status(allHealthy ? 200 : 503).json({
        success: allHealthy,
        status: allHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        checks,
    });
});

router.get('/health/live', (req: Request, res: Response) => {
    res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

router.get('/health/ready', async (req: Request, res: Response) => {
    try {
        await getPrismaClient().$queryRaw`SELECT 1`;
        res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: 'not_ready', timestamp: new Date().toISOString() });
    }
});

export default router;
