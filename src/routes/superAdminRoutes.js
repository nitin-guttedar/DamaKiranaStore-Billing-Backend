import { Router } from 'express';
import {
  getOverview,
  getStores,
  createStore,
  getStoreDetail,
  suspendStore,
  activateStore,
  renewSubscription,
  revokeLicense,
  getPlans,
  createPlan
} from '../controllers/superAdminController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

// Strict RBAC: All endpoints in this router strictly require SUPER_ADMIN role
router.use(authenticate, requireRole('SUPER_ADMIN'));

router.get('/overview', getOverview);
router.get('/stores', getStores);
router.post('/stores', createStore);
router.get('/stores/:id', getStoreDetail);
router.post('/stores/:id/suspend', suspendStore);
router.post('/stores/:id/activate', activateStore);
router.post('/stores/:id/renew', renewSubscription);
router.post('/licenses/:id/revoke', revokeLicense);
router.get('/plans', getPlans);
router.post('/plans', createPlan);

export default router;
