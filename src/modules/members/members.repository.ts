import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';

@injectable()
export class MembersRepository {
    constructor(@inject('PrismaClient') private prisma: PrismaClient) { }

    async findByWorkspaceId(workspaceId: string) {
        return this.prisma.workspaceMember.findMany({
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
        return this.prisma.workspaceMember.findUnique({
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
        return this.prisma.workspaceMember.create({
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

    /**
     * Update the authority axis, the job axis, or both.
     *
     * Both are optional and an omitted key is left alone, so retagging somebody
     * cannot silently reset their role — which is what a single `updateRole`
     * taking two positional arguments would have invited.
     */
    async updateMembership(
        workspaceId: string,
        userId: string,
        changes: { role?: string; staffTag?: string | null },
    ) {
        return this.prisma.workspaceMember.update({
            where: {
                workspaceId_userId: { workspaceId, userId },
            },
            data: {
                ...(changes.role !== undefined ? { role: changes.role as any } : {}),
                ...(changes.staffTag !== undefined ? { staffTag: changes.staffTag as any } : {}),
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
        return this.prisma.workspaceMember.update({
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
        return this.prisma.workspaceMember.delete({
            where: {
                workspaceId_userId: { workspaceId, userId },
            },
        });
    }
}
