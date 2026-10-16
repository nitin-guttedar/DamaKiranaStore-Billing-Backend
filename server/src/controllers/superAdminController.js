import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { AuthService } from '../services/authService.js';
import { LicenseService } from '../services/licenseService.js';

export function getOverview(req, res) {
  const db = getDb();

  const totalStores = db.get('SELECT COUNT(*) as count FROM stores').count;
  const activeStores = db.get("SELECT COUNT(*) as count FROM stores WHERE status = 'ACTIVE'").count;
  const suspendedStores = db.get("SELECT COUNT(*) as count FROM stores WHERE status = 'SUSPENDED'").count;
  const expiredStores = db.get("SELECT COUNT(*) as count FROM stores WHERE status = 'EXPIRED'").count;

  const totalLicenses = db.get('SELECT COUNT(*) as count FROM license_tokens').count;
  const activeLicenses = db.get("SELECT COUNT(*) as count FROM license_tokens WHERE is_revoked = 0 AND date(expires_at) >= date('now')").count;

  // Subscriptions expiring within next 30 days
  const expiringSoon = db.get(
    `SELECT COUNT(*) as count FROM subscriptions
     WHERE status = 'ACTIVE' AND date(expires_at) >= date('now') AND date(expires_at) <= date('now', '+30 days')`
  ).count;

  const recentStores = db.query(
    `SELECT s.*, u.email as owner_email, u.full_name as owner_name, sub.expires_at, p.name as plan_name
     FROM stores s
     LEFT JOIN users u ON u.store_id = s.id AND u.role = 'STORE_OWNER'
     LEFT JOIN subscriptions sub ON sub.store_id = s.id
     LEFT JOIN subscription_plans p ON sub.plan_id = p.id
     GROUP BY s.id
     ORDER BY s.created_at DESC LIMIT 5`
  );

  res.json({
    success: true,
    kpis: {
      totalStores,
      activeStores,
      suspendedStores,
      expiredStores,
      totalLicenses,
      activeLicenses,
      expiringSoon
    },
    recentStores
  });
}

export function getStores(req, res) {
  const { q, status } = req.query;
  const db = getDb();

  let query = `
    SELECT s.*,
           u.id as owner_id, u.email as owner_email, u.full_name as owner_name, u.phone as owner_phone,
           sub.id as subscription_id, sub.status as subscription_status, sub.expires_at,
           p.name as plan_name, p.code as plan_code
    FROM stores s
    LEFT JOIN users u ON u.store_id = s.id AND u.role = 'STORE_OWNER'
    LEFT JOIN (
      SELECT * FROM subscriptions WHERE id IN (
        SELECT id FROM subscriptions GROUP BY store_id HAVING MAX(created_at)
      )
    ) sub ON sub.store_id = s.id
    LEFT JOIN subscription_plans p ON sub.plan_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += ' AND s.status = ?';
    params.push(status);
  }

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query += ' AND (s.name LIKE ? OR s.city LIKE ? OR u.email LIKE ? OR u.full_name LIKE ?)';
    params.push(term, term, term, term);
  }

  query += ' ORDER BY s.created_at DESC';

  const stores = db.query(query, params);
  res.json({ success: true, count: stores.length, stores });
}

export async function createStore(req, res) {
  const {
    storeName,
    ownerName,
    ownerEmail,
    ownerPhone,
    address,
    city,
    state = 'Karnataka',
    pincode,
    gstin,
    planId,
    initialPassword
  } = req.body;

  if (!storeName || !ownerName || !ownerEmail || !planId) {
    return res.status(400).json({
      success: false,
      error: 'Store name, owner name, owner email, and subscription plan are required'
    });
  }

  const db = getDb();

  // Check duplicate email
  const existingUser = db.get('SELECT id FROM users WHERE email = ?', [ownerEmail.toLowerCase().trim()]);
  if (existingUser) {
    return res.status(400).json({ success: false, error: 'A user with this email address already exists.' });
  }

  const plan = db.get('SELECT * FROM subscription_plans WHERE id = ?', [planId]);
  if (!plan) {
    return res.status(400).json({ success: false, error: 'Invalid subscription plan.' });
  }

  const storeId = `str_${crypto.randomUUID()}`;
  const ownerId = `usr_owner_${crypto.randomUUID()}`;
  const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + `-${Date.now().toString().slice(-4)}`;
  const plainPassword = initialPassword || `Kirana@${Math.floor(100000 + Math.random() * 900000)}`;
  const passwordHash = await AuthService.hashPassword(plainPassword);

  const startsAt = new Date().toISOString();
  const expiresAt = LicenseService.calculateExpiryDate(startsAt, plan.duration_days);
  const subscriptionId = `sub_${crypto.randomUUID()}`;

  const result = db.transaction((tx) => {
    // 1. Insert store
    tx.run(
      `INSERT INTO stores (id, name, slug, phone, email, address, city, state, pincode, gstin, status, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)`,
      [
        storeId,
        storeName.trim(),
        slug,
        ownerPhone || null,
        ownerEmail.toLowerCase().trim(),
        address || null,
        city || 'Bengaluru',
        state,
        pincode || null,
        gstin || null
      ]
    );

    // 2. Insert store settings
    tx.run(
      `INSERT INTO store_settings (id, store_id, invoice_prefix, next_invoice_number, receipt_printer_type, enable_gst, upi_name)
       VALUES (?, ?, 'INV', 1, '58mm', ?, ?)`,
      [`set_${storeId}`, storeId, gstin ? 1 : 0, storeName.trim()]
    );

    // 3. Insert store owner
    tx.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, must_change_password, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 'STORE_OWNER', 1, 1)`,
      [ownerId, storeId, ownerEmail.toLowerCase().trim(), passwordHash, ownerName.trim(), ownerPhone || null]
    );

    // 4. Create subscription
    tx.run(
      `INSERT INTO subscriptions (id, store_id, plan_id, status, starts_at, expires_at, created_by_admin_id)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [subscriptionId, storeId, plan.id, startsAt, expiresAt, req.user.userId]
    );

    // 5. Issue cryptographic license token
    const license = LicenseService.issueLicense({
      storeId,
      subscriptionId,
      planCode: plan.code,
      planName: plan.name,
      durationDays: plan.duration_days,
      maxUsers: plan.max_users,
      maxProducts: plan.max_products,
      createdByAdminId: req.user.userId
    });

    // 6. Audit log
    tx.run(
      `INSERT INTO audit_logs (id, store_id, user_id, action, entity_type, entity_id, new_values_json)
       VALUES (?, ?, ?, 'CREATE_STORE', 'STORE', ?, ?)`,
      [
        `aud_${crypto.randomUUID()}`,
        storeId,
        req.user.userId,
        storeId,
        JSON.stringify({ storeName, ownerEmail, plan: plan.name })
      ]
    );

    return {
      storeId,
      ownerId,
      storeName,
      ownerEmail,
      temporaryPassword: plainPassword, // Returned ONCE to super-admin
      licenseToken: license.rawToken, // Returned ONCE to copy
      tokenHint: license.tokenHint,
      expiresAt: license.expiresAt
    };
  });

  res.status(201).json({ success: true, ...result });
}

export function getStoreDetail(req, res) {
  const { id } = req.params;
  const db = getDb();

  const store = db.get('SELECT * FROM stores WHERE id = ?', [id]);
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });

  const owner = db.get('SELECT id, email, full_name, phone, role, is_active, created_at FROM users WHERE store_id = ? AND role = "STORE_OWNER"', [id]);
  const settings = db.get('SELECT * FROM store_settings WHERE store_id = ?', [id]);
  const subscriptions = db.query(
    `SELECT s.*, p.name as plan_name, p.code as plan_code
     FROM subscriptions s
     JOIN subscription_plans p ON s.plan_id = p.id
     WHERE s.store_id = ?
     ORDER BY s.created_at DESC`,
    [id]
  );
  const licenses = db.query('SELECT * FROM license_tokens WHERE store_id = ? ORDER BY issued_at DESC', [id]);
  const events = db.query('SELECT * FROM subscription_events WHERE store_id = ? ORDER BY created_at DESC LIMIT 20', [id]);

  res.json({
    success: true,
    store,
    owner,
    settings,
    subscriptions,
    licenses,
    events
  });
}

export function suspendStore(req, res) {
  const { id } = req.params;
  const { reason } = req.body;
  const db = getDb();

  db.transaction((tx) => {
    tx.run("UPDATE stores SET status = 'SUSPENDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    tx.run("UPDATE subscriptions SET status = 'SUSPENDED', updated_at = CURRENT_TIMESTAMP WHERE store_id = ?", [id]);
    tx.run(
      `INSERT INTO subscription_events (id, store_id, event_type, details_json, created_by)
       VALUES (?, ?, 'STORE_SUSPENDED', ?, ?)`,
      [`se_${crypto.randomUUID()}`, id, JSON.stringify({ reason: reason || 'Suspended by super-admin' }), req.user.userId]
    );
  });

  res.json({ success: true, message: 'Store suspended successfully.' });
}

export function activateStore(req, res) {
  const { id } = req.params;
  const db = getDb();

  db.transaction((tx) => {
    tx.run("UPDATE stores SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    tx.run("UPDATE subscriptions SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE store_id = ?", [id]);
    tx.run(
      `INSERT INTO subscription_events (id, store_id, event_type, details_json, created_by)
       VALUES (?, ?, 'STORE_REACTIVATED', '{}', ?)`,
      [`se_${crypto.randomUUID()}`, id, req.user.userId]
    );
  });

  res.json({ success: true, message: 'Store reactivated successfully.' });
}

export function renewSubscription(req, res) {
  const { id } = req.params; // storeId
  const { planId } = req.body;
  const db = getDb();

  const plan = db.get('SELECT * FROM subscription_plans WHERE id = ?', [planId]);
  if (!plan) return res.status(400).json({ success: false, error: 'Invalid subscription plan.' });

  const startsAt = new Date().toISOString();
  const expiresAt = LicenseService.calculateExpiryDate(startsAt, plan.duration_days);
  const subId = `sub_${crypto.randomUUID()}`;

  const result = db.transaction((tx) => {
    tx.run(
      `INSERT INTO subscriptions (id, store_id, plan_id, status, starts_at, expires_at, created_by_admin_id)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [subId, id, plan.id, startsAt, expiresAt, req.user.userId]
    );

    tx.run("UPDATE stores SET status = 'ACTIVE' WHERE id = ?", [id]);

    const license = LicenseService.issueLicense({
      storeId: id,
      subscriptionId: subId,
      planCode: plan.code,
      planName: plan.name,
      durationDays: plan.duration_days,
      maxUsers: plan.max_users,
      maxProducts: plan.max_products,
      createdByAdminId: req.user.userId
    });

    return {
      subscriptionId: subId,
      planName: plan.name,
      startsAt,
      expiresAt,
      rawToken: license.rawToken,
      tokenHint: license.tokenHint
    };
  });

  res.json({ success: true, ...result });
}

export function revokeLicense(req, res) {
  const { id } = req.params; // licenseId
  const { reason } = req.body;

  try {
    const result = LicenseService.revokeLicense(id, reason || 'Revoked by admin', req.user.userId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

export function getPlans(req, res) {
  const db = getDb();
  const plans = db.query('SELECT * FROM subscription_plans ORDER BY duration_days ASC');
  res.json({ success: true, plans });
}

export function createPlan(req, res) {
  const { name, code, durationDays, priceInr, maxUsers = 5, maxProducts = 5000 } = req.body;
  if (!name || !code || !durationDays || priceInr === undefined) {
    return res.status(400).json({ success: false, error: 'Name, code, duration, and price in INR are required.' });
  }

  const db = getDb();
  const id = `plan_${code.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

  db.run(
    `INSERT INTO subscription_plans (id, name, code, duration_days, price_inr, max_users, max_products, features_json, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1)`,
    [id, name.trim(), code.toUpperCase().trim(), parseInt(durationDays, 10), parseFloat(priceInr), parseInt(maxUsers, 10), parseInt(maxProducts, 10)]
  );

  const created = db.get('SELECT * FROM subscription_plans WHERE id = ?', [id]);
  res.status(201).json({ success: true, plan: created });
}
