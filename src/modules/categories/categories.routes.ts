import { Router } from 'express';
import { CategoriesController } from './categories.controller';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { requireWorkspaceMember } from '../../middlewares/authorize';
import { createCategorySchema, updateCategorySchema } from './categories.dto';

const router = Router({ mergeParams: true });
const categoriesController = new CategoriesController();

router.use(authenticate as any);

router.get('/:workspaceId', requireWorkspaceMember() as any, categoriesController.getAll.bind(categoriesController) as any);
router.get('/:workspaceId/:categoryId', requireWorkspaceMember() as any, categoriesController.getOne.bind(categoriesController) as any);
router.post('/:workspaceId', requireWorkspaceMember() as any, validate(createCategorySchema), categoriesController.create.bind(categoriesController) as any);
router.patch('/:workspaceId/:categoryId', requireWorkspaceMember() as any, validate(updateCategorySchema), categoriesController.update.bind(categoriesController) as any);
router.delete('/:workspaceId/:categoryId', requireWorkspaceMember() as any, categoriesController.delete.bind(categoriesController) as any);

export default router;
