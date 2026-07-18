import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ProjectsService } from './projects.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class ProjectsController {
    constructor(private service: ProjectsService) {}

    async getProjects(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getProjects(
                req.params.workspaceId as string,
                req.user.userId,
                req.query as any,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Projects retrieved', data });
        } catch (e) { next(e); }
    }

    async getProject(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getProject(
                req.params.projectId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Project retrieved', data });
        } catch (e) { next(e); }
    }

    async createProject(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.createProject(
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Project created', data });
        } catch (e) { next(e); }
    }

    async updateProject(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateProject(
                req.params.projectId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Project updated', data });
        } catch (e) { next(e); }
    }

    async archiveProject(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.archiveProject(
                req.params.projectId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Project archived', data });
        } catch (e) { next(e); }
    }

    async unarchiveProject(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.unarchiveProject(
                req.params.projectId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Project unarchived', data });
        } catch (e) { next(e); }
    }

    async deleteProject(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.deleteProject(
                req.params.projectId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Project deleted' });
        } catch (e) { next(e); }
    }

    async getMembers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.getMembers(
                req.params.projectId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Members retrieved', data });
        } catch (e) { next(e); }
    }

    async addMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.addMember(
                req.params.projectId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.CREATED).json({ success: true, message: 'Member added', data });
        } catch (e) { next(e); }
    }

    async updateMemberRole(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.service.updateMemberRole(
                req.params.projectId as string,
                req.params.memberId as string,
                req.params.workspaceId as string,
                req.user.userId,
                req.body,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Member role updated', data });
        } catch (e) { next(e); }
    }

    async removeMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await this.service.removeMember(
                req.params.projectId as string,
                req.params.memberId as string,
                req.params.workspaceId as string,
                req.user.userId,
            );
            res.status(StatusCodes.OK).json({ success: true, message: 'Member removed' });
        } catch (e) { next(e); }
    }
}
