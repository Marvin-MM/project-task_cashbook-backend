import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { UsersService } from './users.service';
import { AuthenticatedRequest, ApiResponse } from '../../core/types';

@injectable()
export class UsersController {
    constructor(private usersService: UsersService) { }

    async getProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = await this.usersService.getProfile(req.user.userId);

            const response: ApiResponse = {
                success: true,
                message: 'Profile retrieved successfully',
                data: user,
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }

    async updateProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = await this.usersService.updateProfile(req.user.userId, req.body);

            const response: ApiResponse = {
                success: true,
                message: 'Profile updated successfully',
                data: user,
            };

            res.status(StatusCodes.OK).json(response);
        } catch (error) {
            next(error);
        }
    }
}
