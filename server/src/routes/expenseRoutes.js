import { Router } from 'express';
import { getExpenses, createExpense, deleteExpense } from '../controllers/expenseController.js';
import { authenticate, requireRole, requireStoreAccess } from '../middleware/auth.js';
import { checkSubscription } from '../middleware/subscriptionCheck.js';

const router = Router();

router.use(authenticate, requireStoreAccess, checkSubscription);

router.get('/', getExpenses);
router.post('/', requireRole('STORE_OWNER', 'STORE_MANAGER'), createExpense);
router.delete('/:id', requireRole('STORE_OWNER'), deleteExpense);

export default router;
