import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const requestId = uuidv4();
    const start = Date.now();

    // Attach request ID to request
    (req as any).requestId = requestId;

    // Set response header
    res.setHeader('X-Request-Id', requestId);

    // Log when response finishes
    res.on('finish', () => {
        const duration = Date.now() - start;
        const logData = {
            requestId,
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            userAgent: req.get('user-agent'),
            userId: (req as any).user?.userId,
        };

        if (res.statusCode >= 500) {
            logger.error('Request completed with server error', logData);
        } else if (res.statusCode >= 400) {
            logger.warn('Request completed with client error', logData);
        } else {
            logger.info('Request completed', logData);
        }
    });

    next();
}
