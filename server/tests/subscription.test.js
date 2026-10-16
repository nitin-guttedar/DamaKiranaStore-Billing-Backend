import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { LicenseService } from '../src/services/licenseService.js';
import { getDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';

test('Subscription Licensing and Offline Cryptographic Verification', () => {
  runMigrations();
  const db = getDb();

  // Create a dedicated test store and subscription to satisfy foreign key integrity
  const testStoreId = `str_test_${Date.now()}`;
  const testSubId = `sub_test_${Date.now()}`;

  db.run(
    `INSERT INTO stores (id, name, slug, status, is_active)
     VALUES (?, 'Licensing Test Kirana', ?, 'ACTIVE', 1)`,
    [testStoreId, `slug-${Date.now()}`]
  );

  const startsAt = new Date().toISOString();
  const expiresAt = LicenseService.calculateExpiryDate(startsAt, 365);

  db.run(
    `INSERT INTO subscriptions (id, store_id, plan_id, status, starts_at, expires_at)
     VALUES (?, ?, 'plan_annual', 'ACTIVE', ?, ?)`,
    [testSubId, testStoreId, startsAt, expiresAt]
  );

  // 1. Issue an annual license
  const license = LicenseService.issueLicense({
    storeId: testStoreId,
    subscriptionId: testSubId,
    planCode: 'ANNUAL',
    planName: 'Kirana Enterprise Annual',
    durationDays: 365,
    maxUsers: 5,
    maxProducts: 5000,
    createdByAdminId: 'test_admin'
  });

  assert.ok(license.rawToken.startsWith('KOS-'), 'License token must have KOS prefix');
  assert.ok(license.tokenHint.startsWith('KOS-LIC-••••-'), 'Token hint must be masked');
  assert.strictEqual(license.payload.planCode, 'ANNUAL');

  // 2. Verify valid license token
  const verifyResult = LicenseService.verifyToken(license.rawToken);
  assert.strictEqual(verifyResult.valid, true, 'Original issued token must verify');
  assert.strictEqual(verifyResult.payload.storeId, testStoreId);

  // 3. Verify forged / tampered token is rejected
  const parts = license.rawToken.split('.');
  const tamperedToken = `${parts[0]}.deadbeef00112233445566778899aabbccddeeff`;
  const tamperedResult = LicenseService.verifyToken(tamperedToken);
  assert.strictEqual(tamperedResult.valid, false, 'Tampered signature must fail verification');
  assert.ok(tamperedResult.reason.includes('Invalid cryptographic signature'));

  // 4. Revocation workflow
  const revokeResult = LicenseService.revokeLicense(license.licenseId, 'Store contract terminated', 'test_admin');
  assert.strictEqual(revokeResult.success, true);

  const postRevokeVerify = LicenseService.verifyToken(license.rawToken);
  assert.strictEqual(postRevokeVerify.valid, false, 'Revoked license token must be rejected');
  assert.strictEqual(postRevokeVerify.revoked, true);

  // 5. Expiration status calculation
  const status = LicenseService.getStoreSubscriptionStatus('store_ganesh_kirana');
  assert.strictEqual(status.hasSubscription, true);
  assert.strictEqual(status.status, 'ACTIVE');
  assert.ok(status.daysRemaining > 300, 'Fresh annual license should have > 300 days');
  assert.strictEqual(status.isReadOnly, false);
});
