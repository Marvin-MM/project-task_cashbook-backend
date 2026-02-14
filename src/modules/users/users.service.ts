import { UsersRepository } from './users.repository';
import { NotFoundError } from '../../core/errors/AppError';
import { UpdateProfileDto } from './users.dto';

const usersRepository = new UsersRepository();

export class UsersService {
    async getProfile(userId: string) {
        const user = await usersRepository.findById(userId);
        if (!user) {
            throw new NotFoundError('User');
        }
        return user;
    }

    async updateProfile(userId: string, dto: UpdateProfileDto) {
        const user = await usersRepository.findById(userId);
        if (!user) {
            throw new NotFoundError('User');
        }

        return usersRepository.updateProfile(userId, dto);
    }
}
