import { Router } from 'express';
import { login, me, changePassword, logout } from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/errorHandler.js';

const router = Router();

router.post('/login', rateLimiter({ max: 15, message: 'Too many login attempts. Please wait a minute.' }), login);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);
router.post('/change-password', authenticate, changePassword);

export default router;
