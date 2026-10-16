import { AuthService } from '../services/authService.js';
import { getDb } from '../db/index.js';
import { LicenseService } from '../services/licenseService.js';

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const result = await AuthService.login(email, password);

    // If store user, attach subscription info
    let subscription = null;
    if (result.user.storeId) {
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

export function me(req, res) {
  const db = getDb();
  const user = db.get(
    'SELECT id, store_id, email, full_name, phone, role, must_change_password FROM users WHERE id = ?',
    [req.user.userId]
  );

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  let store = null;
  let subscription = null;

  if (user.store_id) {
    store = db.get('SELECT * FROM stores WHERE id = ?', [user.store_id]);
    subscription = LicenseService.getStoreSubscriptionStatus(user.store_id);
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      phone: user.phone,
      role: user.role,
      storeId: user.store_id,
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
