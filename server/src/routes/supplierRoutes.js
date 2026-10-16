import { Router } from 'express';
import {
  getSuppliers,
  createSupplier,
  getSupplierLedger,
  recordSupplierPayment
} from '../controllers/supplierController.js';
import { authenticate, requireRole, requireStoreAccess } from '../middleware/auth.js';
import { checkSubscription } from '../middleware/subscriptionCheck.js';

const router = Router();

router.use(authenticate, requireStoreAccess, checkSubscription);

router.get('/', getSuppliers);
router.post('/', requireRole('STORE_OWNER', 'STORE_MANAGER'), createSupplier);
router.get('/:id/ledger', getSupplierLedger);
router.post('/:id/payments', requireRole('STORE_OWNER', 'STORE_MANAGER'), recordSupplierPayment);

export default router;
