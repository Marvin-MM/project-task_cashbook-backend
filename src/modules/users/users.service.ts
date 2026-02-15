import { injectable } from 'tsyringe';
import { UsersRepository } from './users.repository';
import { NotFoundError } from '../../core/errors/AppError';
import { UpdateProfileDto } from './users.dto';

@injectable()
export class UsersService {
    constructor(private usersRepository: UsersRepository) { }

    async getProfile(userId: string) {
        const user = await this.usersRepository.findById(userId);
        if (!user) {
            throw new NotFoundError('User');
        }
        return user;
    }

    async updateProfile(userId: string, dto: UpdateProfileDto) {
        const user = await this.usersRepository.findById(userId);
        if (!user) {
            throw new NotFoundError('User');
        }

        return this.usersRepository.updateProfile(userId, dto);
    }
}
