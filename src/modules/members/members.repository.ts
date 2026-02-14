import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();

export class MembersRepository {
    async findByWorkspaceId(workspaceId: string) {
        return prisma.workspaceMember.findMany({
            where: { workspaceId },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                        isActive: true,
                    },
                },
            },
            orderBy: { joinedAt: 'asc' },
        });
    }

    async findByWorkspaceAndUser(workspaceId: string, userId: string) {
        return prisma.workspaceMember.findUnique({
            where: {
                workspaceId_userId: { workspaceId, userId },
            },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
        });
    }

    async addMember(workspaceId: string, userId: string, role: string) {
        return prisma.workspaceMember.create({
            data: {
                workspaceId,
                userId,
                role: role as any,
            },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
        });
    }

    async updateRole(workspaceId: string, userId: string, role: string) {
        return prisma.workspaceMember.update({
            where: {
                workspaceId_userId: { workspaceId, userId },
            },
            data: { role: role as any },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
        });
    }

    async removeMember(workspaceId: string, userId: string) {
        return prisma.workspaceMember.delete({
            where: {
                workspaceId_userId: { workspaceId, userId },
            },
        });
    }
}
