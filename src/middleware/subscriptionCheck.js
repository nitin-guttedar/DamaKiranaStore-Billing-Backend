import { LicenseService } from '../services/licenseService.js';
import { ensureStoreInSqlite } from './auth.js';

/**
 * Middleware to check store subscription validity.
 * Allows read-only access (GET, exports) when expired,
 * but strictly blocks state-mutating requests (POST, PUT, PATCH, DELETE) for billing/inventory.
 */
export function checkSubscription(req, res, next) {
  // SUPER_ADMIN operations bypass store subscription checks
  if (req.user?.role === 'SUPER_ADMIN') {
    return next();
  }

  const storeId = req.user?.storeId;
  if (!storeId) {
    return res.status(403).json({ success: false, error: 'User is not associated with an active store.' });
  }

  // Ensure store, base plans, and active subscription exist in SQLite first
  ensureStoreInSqlite(storeId, req.user);

  const subStatus = LicenseService.getStoreSubscriptionStatus(storeId);
  req.subscription = subStatus;

  // If store is suspended by super-admin, block all operations
  if (subStatus.status === 'SUSPENDED') {
    return res.status(403).json({
      success: false,
      isSuspended: true,
      error: 'Store is suspended. Please contact platform administration.'
    });
  }

  // If subscription is expired, only allow read requests (GET) and data exports
  if (subStatus.isReadOnly) {
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    // Allow logout or export
    const isExempt = req.path.includes('/export') || req.path.includes('/logout');

    if (isMutation && !isExempt) {
      return res.status(403).json({
        success: false,
        isExpired: true,
        error: 'Subscription has expired. New billing and inventory modifications are locked. Your existing records remain available in read-only mode.',
        subscription: subStatus
      });
    }
  }

  next();
}
