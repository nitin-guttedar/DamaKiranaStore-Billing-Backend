import { Router } from 'express';
import { getPurchases, createPurchase } from '../controllers/purchaseController.js';
import { authenticate, requireRole, requireStoreAccess } from '../middleware/auth.js';
import { checkSubscription } from '../middleware/subscriptionCheck.js';

const router = Router();

router.use(authenticate, requireRole('STORE_OWNER', 'STORE_MANAGER'), requireStoreAccess, checkSubscription);

router.get('/', getPurchases);
router.post('/', createPurchase);

export default router;
