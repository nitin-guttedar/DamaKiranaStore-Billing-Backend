import { Router } from 'express';
import { getSettings, updateSettings, downloadBackup } from '../controllers/settingsController.js';
import { authenticate, requireRole, requireStoreAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate, requireRole('STORE_OWNER', 'STORE_MANAGER'), requireStoreAccess);

router.get('/', getSettings);
router.patch('/', updateSettings);
router.get('/backup', downloadBackup);

export default router;
