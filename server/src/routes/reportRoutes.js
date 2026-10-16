import { Router } from 'express';
import {
  getDashboardKpis,
  getSalesReport,
  getProductSalesReport,
  getGstReport
} from '../controllers/reportController.js';
import { authenticate, requireRole, requireStoreAccess } from '../middleware/auth.js';
import { checkSubscription } from '../middleware/subscriptionCheck.js';

const router = Router();

router.use(authenticate, requireRole('STORE_OWNER', 'STORE_MANAGER'), requireStoreAccess, checkSubscription);

router.get('/dashboard', getDashboardKpis);
router.get('/sales', getSalesReport);
router.get('/products', getProductSalesReport);
router.get('/gst', getGstReport);

export default router;
