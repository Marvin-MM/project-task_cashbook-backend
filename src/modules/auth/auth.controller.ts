import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AuthService } from './auth.service';
import { AuthenticatedRequest, ApiResponse } from '../../core/types';
import { config } from '../../config';

const authService = new AuthService();

export class AuthController {
    async register(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = await authService.register(
                req.body,
                req.ip,
                req.get('user-agent')
            );

            const response: ApiResponse = {
                success: true,
                message: 'Registration successful',
                data: user,
            };

            res.status(StatusCodes.CREATED).json(response);
        } catch (error) {
            next(error);
        }
    }

    async login(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await authService.login(
                req.body,
                req.ip,
                req.get('user-agent')
            );

            // Set cookies
            setAuthCookies(res, result.accessToken, result.refreshToken);

            const response: ApiResponse = {
                success: true,
                message: 'Login successful',
                data: { user: result.user },
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }

    async refresh(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const refreshToken = req.cookies?.refreshToken;
            if (!refreshToken) {
                res.status(StatusCodes.UNAUTHORIZED).json({
                    success: false,
                    message: 'Refresh token is required',
                });
                return;
            }

            const result = await authService.refreshTokens(
                refreshToken,
                req.ip,
                req.get('user-agent')
            );

            setAuthCookies(res, result.accessToken, result.refreshToken);

            const response: ApiResponse = {
                success: true,
                message: 'Tokens refreshed successfully',
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }

    async logout(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const refreshToken = req.cookies?.refreshToken;

            await authService.logout(
                refreshToken,
                req.user.userId,
                req.ip,
                req.get('user-agent')
            );

            clearAuthCookies(res);

            const response: ApiResponse = {
                success: true,
                message: 'Logged out successfully',
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }

    async logoutAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await authService.logoutAll(
                req.user.userId,
                req.ip,
                req.get('user-agent')
            );

            clearAuthCookies(res);

            const response: ApiResponse = {
                success: true,
                message: 'Logged out from all devices',
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }

    async changePassword(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await authService.changePassword(req.user.userId, req.body);

            clearAuthCookies(res);

            const response: ApiResponse = {
                success: true,
                message: 'Password changed successfully. Please log in again.',
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }

    async getLoginHistory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const history = await authService.getLoginHistory(req.user.userId);

            const response: ApiResponse = {
                success: true,
                message: 'Login history retrieved',
                data: history,
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }
}

// ─── Cookie Helpers ────────────────────────────────────
function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    const cookieOptions = {
        httpOnly: true,
        secure: config.COOKIE_SECURE,
        sameSite: config.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none',
        domain: config.COOKIE_DOMAIN,
    };

    res.cookie('accessToken', accessToken, {
        ...cookieOptions,
        maxAge: 15 * 60 * 1000, // 15 minutes
    });

    res.cookie('refreshToken', refreshToken, {
        ...cookieOptions,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/api/v1/auth', // Only sent to auth routes
    });
}

function clearAuthCookies(res: Response): void {
    const cookieOptions = {
        httpOnly: true,
        secure: config.COOKIE_SECURE,
        sameSite: config.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none',
        domain: config.COOKIE_DOMAIN,
    };

    res.clearCookie('accessToken', cookieOptions);
    res.clearCookie('refreshToken', { ...cookieOptions, path: '/api/v1/auth' });
}
