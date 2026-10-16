import { Router } from 'express';
import { listUsers, createUser, updateUser, deleteUser } from '../controllers/userController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticate, listUsers);
router.post('/', authenticate, requireRole('SUPER_ADMIN', 'STORE_OWNER', 'STORE_MANAGER'), createUser);
router.patch('/:id', authenticate, requireRole('SUPER_ADMIN', 'STORE_OWNER', 'STORE_MANAGER'), updateUser);
router.delete('/:id', authenticate, requireRole('SUPER_ADMIN', 'STORE_OWNER'), deleteUser);

export default router;
