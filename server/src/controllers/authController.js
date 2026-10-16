import { AuthService } from '../services/authService.js';
import { getDb } from '../db/index.js';
import { LicenseService } from '../services/licenseService.js';
import { findMongoUserById, syncUserToSqlite, syncStoreToSqlite } from '../db/mongo.js';

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const result = await AuthService.login(email, password);

    // If store user, attach subscription info
    let subscription = result.subscription || null;
    if (result.user.storeId && (!subscription || !subscription.hasSubscription)) {
      subscription = LicenseService.getStoreSubscriptionStatus(result.user.storeId);
    }

    res.json({
      success: true,
      token: result.token,
      user: result.user,
      store: result.store,
      subscription
    });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
}

export async function me(req, res) {
  const db = getDb();
  let user = null;

  // 1. Primary check: Query MongoDB credentials collection
  try {
    const mongoUser = await findMongoUserById(req.user.userId);
    if (mongoUser) {
      user = mongoUser;
      if (mongoUser.store_data) {
        syncStoreToSqlite(mongoUser.store_data, mongoUser.subscription_data);
      }
      syncUserToSqlite(mongoUser);
    }
  } catch (err) {
    console.warn('[KiranaOS me] MongoDB credential lookup warning:', err.message);
  }

  // 2. Offline fallback: Query SQLite
  if (!user) {
    user = db.get(
      'SELECT id, store_id, email, full_name, phone, role, must_change_password FROM users WHERE id = ?',
      [req.user.userId]
    );
  }

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  let store = null;
  let subscription = null;
  const storeId = user.store_id || user.storeId;

  if (storeId) {
    store = db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
    if (!store && user.store_data) {
      store = user.store_data;
    }

    subscription = LicenseService.getStoreSubscriptionStatus(storeId);
    if ((!subscription || !subscription.hasSubscription) && user.subscription_data) {
      subscription = {
        hasSubscription: true,
        subscriptionId: user.subscription_data.id || `sub_${storeId}`,
        planName: user.subscription_data.plan_name || 'Kirana Enterprise Annual',
        planCode: user.subscription_data.plan_code || 'ANNUAL',
        status: 'ACTIVE',
        startsAt: user.subscription_data.starts_at || new Date().toISOString(),
        expiresAt: user.subscription_data.expires_at || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        daysRemaining: 365,
        isReadOnly: false,
        warning: null,
        maxUsers: 10,
        maxProducts: 25000
      };
    }
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name || user.fullName,
      phone: user.phone,
      role: user.role,
      storeId,
      mustChangePassword: Boolean(user.must_change_password)
    },
    store,
    subscription
  });
}

export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current password and new password are required' });
    }

    const result = await AuthService.changePassword(req.user.userId, currentPassword, newPassword);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

export function logout(req, res) {
  // Clear any cookie or client session
  res.json({ success: true, message: 'Logged out successfully' });
}
