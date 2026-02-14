import { getPrismaClient } from '../../config/database';
import { WorkspaceType, WorkspaceRole } from '../../core/types';

const prisma = getPrismaClient();

export class WorkspacesRepository {
    async findById(id: string) {
        return prisma.workspace.findUnique({
            where: { id },
            include: {
                owner: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
                _count: { select: { members: true, cashbooks: true } },
            },
        });
    }

    async findByOwnerId(ownerId: string) {
        return prisma.workspace.findMany({
            where: { ownerId, isActive: true },
            include: {
                _count: { select: { members: true, cashbooks: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findUserWorkspaces(userId: string) {
        // Get owned workspaces and workspaces where user is a member
        const [owned, memberships] = await Promise.all([
            prisma.workspace.findMany({
                where: { ownerId: userId, isActive: true },
                include: {
                    owner: {
                        select: { id: true, email: true, firstName: true, lastName: true },
                    },
                    _count: { select: { members: true, cashbooks: true } },
                },
            }),
            prisma.workspaceMember.findMany({
                where: { userId },
                include: {
                    workspace: {
                        include: {
                            owner: {
                                select: { id: true, email: true, firstName: true, lastName: true },
                            },
                            _count: { select: { members: true, cashbooks: true } },
                        },
                    },
                },
            }),
        ]);

        const memberWorkspaces = memberships
            .filter((m) => m.workspace.isActive)
            .map((m) => ({
                ...m.workspace,
                memberRole: m.role,
            }));

        return {
            owned: owned.map((w) => ({ ...w, memberRole: 'OWNER' })),
            member: memberWorkspaces,
        };
    }

    async create(data: {
        name: string;
        type: WorkspaceType;
        ownerId: string;
    }) {
        return prisma.workspace.create({
            data,
            include: {
                owner: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
            },
        });
    }

    async update(id: string, data: { name?: string }) {
        return prisma.workspace.update({
            where: { id },
            data,
            include: {
                owner: {
                    select: { id: true, email: true, firstName: true, lastName: true },
                },
                _count: { select: { members: true, cashbooks: true } },
            },
        });
    }

    async softDelete(id: string) {
        return prisma.workspace.update({
            where: { id },
            data: { isActive: false },
        });
    }

    async getPersonalWorkspace(userId: string) {
        return prisma.workspace.findFirst({
            where: {
                ownerId: userId,
                type: WorkspaceType.PERSONAL,
                isActive: true,
            },
        });
    }
}
