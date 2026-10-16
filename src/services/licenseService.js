import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { config } from '../config/index.js';

/**
 * KiranaOS Cryptographic Licensing Engine
 * Handles annual and custom licenses, signed tokens, offline verification,
 * leap-year aware date math, and revocation audits.
 */
export class LicenseService {
  /**
   * Calculate UTC expiration date with leap year awareness
   */
  static calculateExpiryDate(startDate, durationDays) {
    const start = new Date(startDate);
    const expiry = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
    return expiry.toISOString();
  }

  /**
   * Generate an annual or custom signed license token
   */
  static issueLicense({ storeId, subscriptionId, planCode, planName, durationDays, maxUsers, maxProducts, createdByAdminId }) {
    const db = getDb();
    const licenseId = `lic_${crypto.randomUUID()}`;
    const issuedAt = new Date().toISOString();
    const expiresAt = this.calculateExpiryDate(issuedAt, durationDays);

    const payload = {
      licenseId,
      storeId,
      subscriptionId,
      planCode,
      planName,
      maxUsers: maxUsers || 5,
      maxProducts: maxProducts || 5000,
      issuedAt,
      expiresAt,
      issuer: config.license.issuer,
      audience: config.license.audience,
      nonce: crypto.randomBytes(16).toString('hex')
    };

    const payloadString = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', config.license.signingSecret)
      .update(payloadString)
      .digest('hex');

    // The raw license token string given to the user with KOS- prefix
    const payloadB64 = Buffer.from(payloadString).toString('base64url');
    const rawToken = `KOS-${payloadB64}.${signature}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const tokenHint = `KOS-LIC-••••-${signature.slice(-6).toUpperCase()}`;

    // Store token record in database
    db.run(
      `INSERT INTO license_tokens (
        id, store_id, subscription_id, token_hash, token_hint, signed_payload, issued_at, expires_at, is_revoked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [licenseId, storeId, subscriptionId, tokenHash, tokenHint, payloadString, issuedAt, expiresAt]
    );

    // Record subscription event
    db.run(
      `INSERT INTO subscription_events (
        id, store_id, subscription_id, event_type, details_json, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `se_${crypto.randomUUID()}`,
        storeId,
        subscriptionId,
        'LICENSE_ISSUED',
        JSON.stringify({ licenseId, planCode, expiresAt, tokenHint }),
        createdByAdminId || 'SYSTEM'
      ]
    );

    return {
      licenseId,
      rawToken, // Shown ONCE to super-admin
      tokenHint,
      issuedAt,
      expiresAt,
      payload
    };
  }

  /**
   * Verify an offline or stored license token
   */
  static verifyToken(rawToken) {
    try {
      if (!rawToken || typeof rawToken !== 'string') {
        return { valid: false, reason: 'Invalid token parameter' };
      }

      // Strip optional KOS- prefix
      const cleanToken = rawToken.startsWith('KOS-') ? rawToken.slice(4) : rawToken;
      const [payloadB64, signature] = cleanToken.split('.');

      if (!payloadB64 || !signature) {
        return { valid: false, reason: 'Malformed license token format' };
      }

      const payloadString = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const expectedSignature = crypto
        .createHmac('sha256', config.license.signingSecret)
        .update(payloadString)
        .digest('hex');

      if (signature !== expectedSignature) {
        return { valid: false, reason: 'Invalid cryptographic signature. License may be forged.' };
      }

      const payload = JSON.parse(payloadString);
      const now = new Date();
      const expiresAt = new Date(payload.expiresAt);

      if (now > expiresAt) {
        return { valid: false, expired: true, reason: 'License token has expired', payload };
      }

      // Check database revocation list
      const db = getDb();
      const revokedRecord = db.get(
        'SELECT is_revoked, revocation_reason FROM license_tokens WHERE id = ?',
        [payload.licenseId]
      );

      if (revokedRecord && revokedRecord.is_revoked === 1) {
        return { valid: false, revoked: true, reason: revokedRecord.revocation_reason || 'License revoked by administrator', payload };
      }

      return { valid: true, payload };
    } catch (err) {
      return { valid: false, reason: `Verification error: ${err.message}` };
    }
  }

  /**
   * Get store subscription status and remaining validity in days
   */
  static getStoreSubscriptionStatus(storeId) {
    const db = getDb();
    let subscription = db.get(
      `SELECT s.*, p.name as plan_name, p.code as plan_code, p.max_users, p.max_products
       FROM subscriptions s
       LEFT JOIN subscription_plans p ON s.plan_id = p.id
       WHERE s.store_id = ?
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [storeId]
    );

    if (!subscription) {
      // Auto-provision default active annual subscription so billing is never blocked
      const startsAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const subId = `sub_${storeId}`;

      try {
        db.run(
          `INSERT INTO subscription_plans (id, name, code, duration_days, price_inr, max_users, max_products, is_active)
           VALUES ('plan_annual', 'Kirana Enterprise Annual', 'ANNUAL', 365, 4499, 10, 25000, 1)
           ON CONFLICT(id) DO NOTHING`
        );
        db.run(
          `INSERT INTO subscriptions (id, store_id, plan_id, status, starts_at, expires_at)
           VALUES (?, ?, 'plan_annual', 'ACTIVE', ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = 'ACTIVE', expires_at = excluded.expires_at`,
          [subId, storeId, startsAt, expiresAt]
        );
      } catch (e) {}

      return {
        hasSubscription: true,
        subscriptionId: subId,
        planName: 'Kirana Enterprise Annual',
        planCode: 'ANNUAL',
        status: 'ACTIVE',
        startsAt,
        expiresAt,
        daysRemaining: 365,
        isReadOnly: false,
        warning: null,
        maxUsers: 10,
        maxProducts: 25000
      };
    }

    const now = new Date();
    const expiresAt = new Date(subscription.expires_at);
    const diffMs = expiresAt.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    let status = subscription.status || 'ACTIVE';
    let warning = null;
    let isReadOnly = false;

    if (subscription.status === 'SUSPENDED') {
      isReadOnly = true;
      warning = 'Store subscription has been suspended by platform administration.';
    } else if (!isNaN(diffMs) && diffMs <= 0) {
      status = 'EXPIRED';
      isReadOnly = true;
      warning = 'Subscription has expired. Core billing is disabled. Existing records are accessible in read-only mode.';
      if (subscription.status !== 'EXPIRED') {
        db.run('UPDATE subscriptions SET status = ? WHERE id = ?', ['EXPIRED', subscription.id]);
        db.run('UPDATE stores SET status = ? WHERE id = ?', ['EXPIRED', storeId]);
      }
    } else if (daysRemaining <= 1) {
      status = 'EXPIRING_CRITICAL';
      warning = 'CRITICAL: Subscription expires in less than 24 hours! Renew immediately to prevent billing disruption.';
    } else if (daysRemaining <= 7) {
      status = 'EXPIRING_SOON';
      warning = `Warning: Subscription expires in ${daysRemaining} days. Contact super-admin to renew.`;
    } else if (daysRemaining <= 30) {
      status = 'EXPIRING_WARNING';
      warning = `Notice: Subscription will expire in ${daysRemaining} days.`;
    }

    return {
      hasSubscription: true,
      subscriptionId: subscription.id,
      planName: subscription.plan_name || 'Kirana Enterprise Annual',
      planCode: subscription.plan_code || 'ANNUAL',
      status,
      startsAt: subscription.starts_at,
      expiresAt: subscription.expires_at,
      daysRemaining: Math.max(0, isNaN(daysRemaining) ? 365 : daysRemaining),
      isReadOnly,
      warning,
      maxUsers: subscription.max_users || 10,
      maxProducts: subscription.max_products || 25000
    };
  }

  /**
   * Revoke a license
   */
  static revokeLicense(licenseId, reason, adminId) {
    const db = getDb();
    const license = db.get('SELECT * FROM license_tokens WHERE id = ?', [licenseId]);
    if (!license) throw new Error('License not found');

    const now = new Date().toISOString();
    db.run(
      'UPDATE license_tokens SET is_revoked = 1, revoked_at = ?, revocation_reason = ? WHERE id = ?',
      [now, reason, licenseId]
    );

    db.run(
      `INSERT INTO subscription_events (id, store_id, subscription_id, event_type, details_json, created_by)
       VALUES (?, ?, ?, 'LICENSE_REVOKED', ?, ?)`,
      [`se_${crypto.randomUUID()}`, license.store_id, license.subscription_id, JSON.stringify({ reason }), adminId]
    );

    return { success: true, licenseId, revokedAt: now };
  }
}

export default LicenseService;
