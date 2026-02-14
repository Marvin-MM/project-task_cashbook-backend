import { getPrismaClient } from '../../config/database';
import { Prisma } from '@prisma/client';

const prisma = getPrismaClient();

export class AuthRepository {
    async findUserByEmail(email: string) {
        return prisma.user.findUnique({
            where: { email },
        });
    }

    async findUserById(id: string) {
        return prisma.user.findUnique({
            where: { id },
        });
    }

    async createUser(data: Prisma.UserCreateInput) {
        return prisma.user.create({
            data,
        });
    }

    async updateUserLastLogin(userId: string) {
        return prisma.user.update({
            where: { id: userId },
            data: { lastLoginAt: new Date() },
        });
    }

    async updateUserPassword(userId: string, passwordHash: string) {
        return prisma.user.update({
            where: { id: userId },
            data: { passwordHash },
        });
    }

    // ─── Refresh Tokens ────────────────────────────────
    async createRefreshToken(data: {
        userId: string;
        tokenHash: string;
        deviceInfo?: string;
        ipAddress?: string;
        expiresAt: Date;
    }) {
        return prisma.refreshToken.create({
            data,
        });
    }

    async findRefreshTokenByHash(tokenHash: string) {
        return prisma.refreshToken.findFirst({
            where: {
                tokenHash,
                isRevoked: false,
                expiresAt: { gt: new Date() },
            },
            include: { user: true },
        });
    }

    async revokeRefreshToken(id: string) {
        return prisma.refreshToken.update({
            where: { id },
            data: { isRevoked: true },
        });
    }

    async revokeAllUserTokens(userId: string) {
        return prisma.refreshToken.updateMany({
            where: { userId, isRevoked: false },
            data: { isRevoked: true },
        });
    }

    async deleteExpiredTokens() {
        return prisma.refreshToken.deleteMany({
            where: {
                OR: [
                    { expiresAt: { lt: new Date() } },
                    { isRevoked: true },
                ],
            },
        });
    }

    // ─── Login History ─────────────────────────────────
    async createLoginHistory(data: {
        userId: string;
        ipAddress?: string;
        userAgent?: string;
        status: string;
        reason?: string;
    }) {
        return prisma.loginHistory.create({
            data,
        });
    }

    async getLoginHistory(userId: string, limit = 20) {
        return prisma.loginHistory.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }

    async getRecentFailedAttempts(userId: string, windowMinutes = 30) {
        const since = new Date(Date.now() - windowMinutes * 60 * 1000);
        return prisma.loginHistory.count({
            where: {
                userId,
                status: 'FAILED',
                createdAt: { gte: since },
            },
        });
    }
}
