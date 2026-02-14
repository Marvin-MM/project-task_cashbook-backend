import { Router } from 'express';
import { AuthController } from './auth.controller';
import { validate } from '../../middlewares/validate';
import { authenticate } from '../../middlewares/authenticate';
import { authRateLimiter } from '../../middlewares/rateLimiter';
import { registerSchema, loginSchema, changePasswordSchema } from './auth.dto';

const router = Router();
const authController = new AuthController();

// Public routes
router.post(
    '/register',
    authRateLimiter,
    validate(registerSchema),
    authController.register.bind(authController) as any
);

router.post(
    '/login',
    authRateLimiter,
    validate(loginSchema),
    authController.login.bind(authController) as any
);

router.post(
    '/refresh',
    authRateLimiter,
    authController.refresh.bind(authController) as any
);

// Protected routes
router.post(
    '/logout',
    authenticate as any,
    authController.logout.bind(authController) as any
);

router.post(
    '/logout-all',
    authenticate as any,
    authController.logoutAll.bind(authController) as any
);

router.post(
    '/change-password',
    authenticate as any,
    validate(changePasswordSchema),
    authController.changePassword.bind(authController) as any
);

router.get(
    '/login-history',
    authenticate as any,
    authController.getLoginHistory.bind(authController) as any
);

export default router;
