import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../core/errors/AppError';
import { logger } from '../utils/logger';
import { config } from '../config';
import { ApiResponse } from '../core/types';

export function errorHandler(
    err: Error,
    _req: Request,
    res: Response,
    _next: NextFunction
): void {
    if (err instanceof AppError) {
        const response: ApiResponse = {
            success: false,
            message: err.message,
            ...(err.constructor.name === 'ValidationError' && {
                errors: (err as any).errors,
            }),
        };

        logger.warn('Operational error', {
            code: err.code,
            statusCode: err.statusCode,
            message: err.message,
        });

        res.status(err.statusCode).json(response);
        return;
    }

    // Unexpected errors
    logger.error('Unexpected error', {
        error: err.message,
        stack: err.stack,
    });

    const response: ApiResponse = {
        success: false,
        message: config.NODE_ENV === 'production'
            ? 'An unexpected error occurred'
            : err.message,
    };

    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json(response);
}
