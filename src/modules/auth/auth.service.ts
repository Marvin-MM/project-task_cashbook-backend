import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config';
import { AuthRepository } from './auth.repository';
import {
    AuthenticationError,
    ConflictError,
    AppError,
} from '../../core/errors/AppError';
import { JwtPayload, AuditAction, WorkspaceType } from '../../core/types';
import { RegisterDto, LoginDto, ChangePasswordDto } from './auth.dto';
import { getPrismaClient } from '../../config/database';
import { logger } from '../../utils/logger';

const prisma = getPrismaClient();
const authRepository = new AuthRepository();

const SUSPICIOUS_FAILURE_THRESHOLD = 5;

export class AuthService {
    // ─── Register ──────────────────────────────────────
    async register(dto: RegisterDto, ipAddress?: string, userAgent?: string) {
        const existingUser = await authRepository.findUserByEmail(dto.email);
        if (existingUser) {
            throw new ConflictError('A user with this email already exists');
        }

        const passwordHash = await bcrypt.hash(dto.password, config.BCRYPT_SALT_ROUNDS);

        // Create user + personal workspace in a transaction
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
                data: {
                    email: dto.email,
                    passwordHash,
                    firstName: dto.firstName,
                    lastName: dto.lastName,
                    isSuperAdmin: dto.email === config.SUPER_ADMIN_EMAIL,
                },
            });

            // Auto-create personal workspace
            await tx.workspace.create({
                data: {
                    name: `${dto.firstName}'s Personal`,
                    type: WorkspaceType.PERSONAL,
                    ownerId: user.id,
                },
            });

            // Audit log
            await tx.auditLog.create({
                data: {
                    userId: user.id,
                    action: AuditAction.USER_REGISTERED,
                    resource: 'user',
                    resourceId: user.id,
                    ipAddress,
                    userAgent,
                },
            });

            return user;
        });

        const { passwordHash: _, ...userWithoutPassword } = result;
        return userWithoutPassword;
    }

    // ─── Login ─────────────────────────────────────────
    async login(dto: LoginDto, ipAddress?: string, userAgent?: string) {
        const user = await authRepository.findUserByEmail(dto.email);

        if (!user) {
            throw new AuthenticationError('Invalid email or password');
        }

        if (!user.isActive) {
            throw new AuthenticationError('Account is deactivated');
        }

        // Check for suspicious activity
        const recentFailures = await authRepository.getRecentFailedAttempts(user.id);
        if (recentFailures >= SUSPICIOUS_FAILURE_THRESHOLD) {
            await authRepository.createLoginHistory({
                userId: user.id,
                ipAddress,
                userAgent,
                status: 'SUSPICIOUS',
                reason: `${recentFailures} failed attempts in last 30 minutes`,
            });

            await prisma.auditLog.create({
                data: {
                    userId: user.id,
                    action: AuditAction.SUSPICIOUS_LOGIN,
                    resource: 'auth',
                    details: { recentFailures, ipAddress } as any,
                    ipAddress,
                    userAgent,
                },
            });

            throw new AuthenticationError(
                'Account temporarily locked due to too many failed attempts. Please try again later.'
            );
        }

        const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
        if (!isPasswordValid) {
            await authRepository.createLoginHistory({
                userId: user.id,
                ipAddress,
                userAgent,
                status: 'FAILED',
                reason: 'Invalid password',
            });
            throw new AuthenticationError('Invalid email or password');
        }

        // Generate tokens
        const accessToken = this.generateAccessToken(user);
        const { token: refreshToken, hash: refreshTokenHash } = this.generateRefreshToken();

        // Parse refresh expiry for DB
        const refreshExpiresAt = this.parseExpiryToDate(config.JWT_REFRESH_EXPIRY);

        // Store refresh token
        await authRepository.createRefreshToken({
            userId: user.id,
            tokenHash: refreshTokenHash,
            deviceInfo: userAgent,
            ipAddress,
            expiresAt: refreshExpiresAt,
        });

        // Update last login + create history
        await authRepository.updateUserLastLogin(user.id);
        await authRepository.createLoginHistory({
            userId: user.id,
            ipAddress,
            userAgent,
            status: 'SUCCESS',
        });

        // Audit log
        await prisma.auditLog.create({
            data: {
                userId: user.id,
                action: AuditAction.USER_LOGGED_IN,
                resource: 'auth',
                ipAddress,
                userAgent,
            },
        });

        const { passwordHash: _, ...userWithoutPassword } = user;
        return {
            user: userWithoutPassword,
            accessToken,
            refreshToken,
        };
    }

    // ─── Refresh Token ────────────────────────────────
    async refreshTokens(oldRefreshToken: string, ipAddress?: string, userAgent?: string) {
        const tokenHash = this.hashToken(oldRefreshToken);
        const storedToken = await authRepository.findRefreshTokenByHash(tokenHash);

        if (!storedToken) {
            throw new AuthenticationError('Invalid or expired refresh token');
        }

        if (!storedToken.user.isActive) {
            throw new AuthenticationError('Account is deactivated');
        }

        // Revoke old token (rotation)
        await authRepository.revokeRefreshToken(storedToken.id);

        // Generate new tokens
        const accessToken = this.generateAccessToken(storedToken.user);
        const { token: newRefreshToken, hash: newRefreshTokenHash } = this.generateRefreshToken();

        const refreshExpiresAt = this.parseExpiryToDate(config.JWT_REFRESH_EXPIRY);

        await authRepository.createRefreshToken({
            userId: storedToken.userId,
            tokenHash: newRefreshTokenHash,
            deviceInfo: userAgent,
            ipAddress,
            expiresAt: refreshExpiresAt,
        });

        await prisma.auditLog.create({
            data: {
                userId: storedToken.userId,
                action: AuditAction.TOKEN_REFRESHED,
                resource: 'auth',
                ipAddress,
                userAgent,
            },
        });

        return {
            accessToken,
            refreshToken: newRefreshToken,
        };
    }

    // ─── Logout ────────────────────────────────────────
    async logout(refreshToken: string, userId: string, ipAddress?: string, userAgent?: string) {
        if (refreshToken) {
            const tokenHash = this.hashToken(refreshToken);
            const storedToken = await authRepository.findRefreshTokenByHash(tokenHash);
            if (storedToken) {
                await authRepository.revokeRefreshToken(storedToken.id);
            }
        }

        await prisma.auditLog.create({
            data: {
                userId,
                action: AuditAction.USER_LOGGED_OUT,
                resource: 'auth',
                ipAddress,
                userAgent,
            },
        });
    }

    // ─── Logout All ────────────────────────────────────
    async logoutAll(userId: string, ipAddress?: string, userAgent?: string) {
        await authRepository.revokeAllUserTokens(userId);

        await prisma.auditLog.create({
            data: {
                userId,
                action: AuditAction.ALL_SESSIONS_REVOKED,
                resource: 'auth',
                ipAddress,
                userAgent,
            },
        });
    }

    // ─── Change Password ──────────────────────────────
    async changePassword(userId: string, dto: ChangePasswordDto) {
        const user = await authRepository.findUserById(userId);
        if (!user) {
            throw new AuthenticationError('User not found');
        }

        const isValid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
        if (!isValid) {
            throw new AuthenticationError('Current password is incorrect');
        }

        const newHash = await bcrypt.hash(dto.newPassword, config.BCRYPT_SALT_ROUNDS);
        await authRepository.updateUserPassword(userId, newHash);

        // Revoke all refresh tokens for security
        await authRepository.revokeAllUserTokens(userId);
    }

    // ─── Login History ─────────────────────────────────
    async getLoginHistory(userId: string) {
        return authRepository.getLoginHistory(userId);
    }

    // ─── Token Helpers ─────────────────────────────────
    private generateAccessToken(user: { id: string; email: string; isSuperAdmin: boolean }): string {
        const payload: JwtPayload = {
            userId: user.id,
            email: user.email,
            isSuperAdmin: user.isSuperAdmin,
        };

        return jwt.sign(payload, config.JWT_ACCESS_SECRET, {
            expiresIn: config.JWT_ACCESS_EXPIRY as any,
        });
    }

    private generateRefreshToken(): { token: string; hash: string } {
        const token = crypto.randomBytes(40).toString('hex');
        const hash = this.hashToken(token);
        return { token, hash };
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    private parseExpiryToDate(expiry: string): Date {
        const match = expiry.match(/^(\d+)([smhd])$/);
        if (!match) {
            return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // default 7 days
        }

        const value = parseInt(match[1]);
        const unit = match[2];

        const multipliers: Record<string, number> = {
            s: 1000,
            m: 60 * 1000,
            h: 60 * 60 * 1000,
            d: 24 * 60 * 60 * 1000,
        };

        return new Date(Date.now() + value * multipliers[unit]);
    }
}
