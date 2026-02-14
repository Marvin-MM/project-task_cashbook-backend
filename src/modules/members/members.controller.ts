import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { MembersService } from './members.service';
import { AuthenticatedRequest, ApiResponse } from '../../core/types';

const membersService = new MembersService();

export class MembersController {
    async getMembers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const members = await membersService.getWorkspaceMembers(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Members retrieved successfully',
                data: members,
            });
        } catch (error) {
            next(error);
        }
    }

    async inviteMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const member = await membersService.inviteMember(
                req.params.workspaceId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'Member invited successfully',
                data: member,
            });
        } catch (error) {
            next(error);
        }
    }

    async updateRole(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const member = await membersService.updateMemberRole(
                req.params.workspaceId as string,
                req.params.userId as string,
                req.user.userId,
                req.body
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Member role updated successfully',
                data: member,
            });
        } catch (error) {
            next(error);
        }
    }

    async removeMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await membersService.removeMember(
                req.params.workspaceId as string,
                req.params.userId as string,
                req.user.userId
            );
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Member removed successfully',
            });
        } catch (error) {
            next(error);
        }
    }
}
