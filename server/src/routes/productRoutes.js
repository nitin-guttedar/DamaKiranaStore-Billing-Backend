import { Router } from 'express';
import {
  getProducts,
  getProductByBarcode,
  createProduct,
  updateProduct,
  adjustStock,
  exportCsv,
  getCategories,
  createCategory
} from '../controllers/productController.js';
import { authenticate, requireRole, requireStoreAccess } from '../middleware/auth.js';
import { checkSubscription } from '../middleware/subscriptionCheck.js';

const router = Router();

router.use(authenticate, requireStoreAccess, checkSubscription);

router.get('/', getProducts);
router.get('/export/csv', exportCsv);
router.get('/categories', getCategories);
router.post('/categories', requireRole('STORE_OWNER', 'STORE_MANAGER'), createCategory);
router.get('/barcode/:barcode', getProductByBarcode);
router.post('/', requireRole('STORE_OWNER', 'STORE_MANAGER'), createProduct);
router.patch('/:id', requireRole('STORE_OWNER', 'STORE_MANAGER'), updateProduct);
router.post('/adjust-stock', requireRole('STORE_OWNER', 'STORE_MANAGER'), adjustStock);

export default router;
