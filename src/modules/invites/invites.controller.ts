import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { InvitesService } from './invites.service';
import { AuthenticatedRequest, ApiResponse } from '../../core/types';

@injectable()
export class InvitesController {
    constructor(private invitesService: InvitesService) { }

    async getPendingInvites(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const invites = await this.invitesService.getPendingInvites(req.user.email);

            const response: ApiResponse = {
                success: true,
                message: invites.length > 0
                    ? `You have ${invites.length} pending invitation(s)`
                    : 'No pending invitations',
                data: invites,
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }
}
