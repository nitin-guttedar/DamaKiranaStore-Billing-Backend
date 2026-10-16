import { Router } from 'express';
import {
  getCurrentShift,
  openShift,
  recordShiftCashMovement,
  closeShift,
  getShiftHistory
} from '../controllers/shiftController.js';
import { authenticate, requireStoreAccess } from '../middleware/auth.js';
import { checkSubscription } from '../middleware/subscriptionCheck.js';

const router = Router();

router.use(authenticate, requireStoreAccess, checkSubscription);

router.get('/current', getCurrentShift);
router.post('/open', openShift);
router.post('/movement', recordShiftCashMovement);
router.post('/close', closeShift);
router.get('/history', getShiftHistory);

export default router;
