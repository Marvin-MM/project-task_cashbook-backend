import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthenticationError } from '../core/errors/AppError';
import { AuthenticatedRequest, JwtPayload } from '../core/types';

export function authenticate(
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction
): void {
    try {
        const token = req.cookies?.accessToken;

        if (!token) {
            throw new AuthenticationError('Access token is required');
        }

        const decoded = jwt.verify(token, config.JWT_ACCESS_SECRET) as JwtPayload;

        req.user = {
            userId: decoded.userId,
            email: decoded.email,
            isSuperAdmin: decoded.isSuperAdmin,
        };

        next();
    } catch (error) {
        if (error instanceof AuthenticationError) {
            next(error);
            return;
        }

        if (error instanceof jwt.TokenExpiredError) {
            next(new AuthenticationError('Access token has expired'));
            return;
        }

        if (error instanceof jwt.JsonWebTokenError) {
            next(new AuthenticationError('Invalid access token'));
            return;
        }

        next(new AuthenticationError('Authentication failed'));
    }
}

export function optionalAuth(
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction
): void {
    try {
        const token = req.cookies?.accessToken;

        if (token) {
            const decoded = jwt.verify(token, config.JWT_ACCESS_SECRET) as JwtPayload;
            req.user = {
                userId: decoded.userId,
                email: decoded.email,
                isSuperAdmin: decoded.isSuperAdmin,
            };
        }
    } catch {
        // Silently continue without auth
    }

    next();
}
