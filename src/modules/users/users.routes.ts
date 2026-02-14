import { Router } from 'express';
import { UsersController } from './users.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { updateProfileSchema } from './users.dto';

const router = Router();
const usersController = new UsersController();

router.get('/me', authenticate as any, usersController.getProfile.bind(usersController) as any);
router.patch('/me', authenticate as any, validate(updateProfileSchema), usersController.updateProfile.bind(usersController) as any);

export default router;
