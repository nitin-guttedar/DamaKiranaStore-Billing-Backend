import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { getDb } from '../db/index.js';

/**
 * Ensures the store, settings, and active subscription exist in SQLite
 * to satisfy FOREIGN KEY constraints (e.g. products.store_id, customers.store_id).
 */
export function ensureStoreInSqlite(storeId, user = null) {
  if (!storeId) return;
  try {
    const db = getDb();
    if (!db || typeof db.get !== 'function') return;

    const store = db.get('SELECT id FROM stores WHERE id = ?', [storeId]);
    if (!store) {
      const storeName = user?.fullName ? `${user.fullName}'s Store` : 'Kirana Retail Store';
      const slug = `store-${storeId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase()}`;
      db.run(
        `INSERT INTO stores (id, name, slug, phone, email, address, city, state, pincode, status, is_active)
         VALUES (?, ?, ?, ?, ?, 'Market Road', 'Bengaluru', 'Karnataka', '560001', 'ACTIVE', 1)
         ON CONFLICT(id) DO NOTHING`,
        [storeId, storeName, slug, user?.phone || null, user?.email || null]
      );

      db.run(
        `INSERT INTO store_settings (id, store_id, invoice_prefix, next_invoice_number, receipt_printer_type, enable_gst, upi_name)
         VALUES (?, ?, 'INV', 1, '58mm', 0, ?)
         ON CONFLICT(id) DO NOTHING`,
        [`set_${storeId}`, storeId, storeName]
      );

      const startsAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      db.run(
        `INSERT INTO subscriptions (id, store_id, plan_id, status, starts_at, expires_at)
         VALUES (?, ?, 'plan_annual', 'ACTIVE', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [`sub_${storeId}`, storeId, startsAt, expiresAt]
      );
    }
  } catch (err) {
    console.warn('[KiranaOS Auth] SQLite ensureStore error:', err.message);
  }
}

export function authenticate(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;

    // Resolve or guarantee store context
    const db = getDb();
    if (db && typeof db.get === 'function') {
      let resolvedStoreId = req.user.storeId;

      // 1. If token did not include storeId, look up user's store in local SQLite
      if (!resolvedStoreId && req.user.userId) {
        const u = db.get('SELECT store_id FROM users WHERE id = ?', [req.user.userId]);
        if (u && u.store_id) {
          resolvedStoreId = u.store_id;
        }
      }

      // 2. If still missing and user is store staff or owner, assign or find a store
      if (!resolvedStoreId) {
        if (req.user.role === 'SUPER_ADMIN') {
          // Default to first active store in SQLite or create default
          const firstStore = db.get("SELECT id FROM stores WHERE status = 'ACTIVE' LIMIT 1") || db.get('SELECT id FROM stores LIMIT 1');
          resolvedStoreId = firstStore ? firstStore.id : 'str_3666f292-fdf0-43b9-b308-ed6ab258f708';
        } else {
          // Store Owner or staff without store_id: auto-create/link dedicated store
          resolvedStoreId = `str_${(req.user.userId || 'owner').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`;
          try {
            db.run('UPDATE users SET store_id = ? WHERE id = ?', [resolvedStoreId, req.user.userId]);
          } catch (e) {}
        }
      }

      req.user.storeId = resolvedStoreId;
      ensureStoreInSqlite(resolvedStoreId, req.user);
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, error: 'Invalid or forged authentication token.' });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Role '${req.user.role}' is not authorized for this action.`
      });
    }

    next();
  };
}

/**
 * Enforce strict tenant isolation: A user may only access resources belonging to their store_id
 */
export function requireStoreAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  // SUPER_ADMIN has platform-wide authority
  if (req.user.role === 'SUPER_ADMIN') {
    return next();
  }

  const targetStoreId = req.params.storeId || req.body?.storeId || req.query?.storeId || req.user.storeId;

  if (targetStoreId && req.user.storeId && targetStoreId !== req.user.storeId) {
    return res.status(403).json({
      success: false,
      error: 'Tenant isolation violation: You cannot access or modify records of another store.'
    });
  }

  next();
}
