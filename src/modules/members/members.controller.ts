import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { MembersService } from './members.service';
import { AuthenticatedRequest, ApiResponse } from '../../core/types';

@injectable()
export class MembersController {
    constructor(private membersService: MembersService) { }

    async getMembers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const members = await this.membersService.getWorkspaceMembers(req.params.workspaceId as string);
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
            const result = await this.membersService.inviteMember(
                req.params.workspaceId as string,
                req.user.userId,
                req.body
            );

            const isAdded = result.status === 'added';

            res.status(isAdded ? StatusCodes.CREATED : StatusCodes.OK).json({
                success: true,
                message: isAdded
                    ? 'Member added successfully. An email notification has been sent.'
                    : 'Invitation sent. The user will be added once they sign up.',
                data: isAdded ? result.member : result.invite,
            });
        } catch (error) {
            next(error);
        }
    }

    async updateRole(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const member = await this.membersService.updateMemberRole(
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
            await this.membersService.removeMember(
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
