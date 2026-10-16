import { Router } from 'express';
import { checkout, getSales, getSaleById, processReturn, voidSale } from '../controllers/posController.js';
import { authenticate, requireRole, requireStoreAccess } from '../middleware/auth.js';
import { checkSubscription } from '../middleware/subscriptionCheck.js';

const router = Router();

router.use(authenticate, requireStoreAccess, checkSubscription);

router.post('/checkout', checkout);
router.get('/', getSales);
router.get('/:id', getSaleById);
router.post('/:id/returns', processReturn);
router.post('/:id/void', requireRole('STORE_OWNER', 'STORE_MANAGER'), voidSale);

export default router;
