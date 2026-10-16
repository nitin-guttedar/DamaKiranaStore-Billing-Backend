import test from 'node:test';
import assert from 'node:assert';
import { AuthService } from '../src/services/authService.js';
import { getDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';

test('Auth Service: Password Hashing and Login Verification', async () => {
  runMigrations();
  const db = getDb();

  // Test password hashing
  const plain = 'TestPassword@123';
  const hash = await AuthService.hashPassword(plain);
  assert.ok(hash !== plain, 'Password must be hashed');
  assert.ok(await AuthService.comparePassword(plain, hash), 'Plaintext must match hash');
  assert.strictEqual(await AuthService.comparePassword('WrongPassword', hash), false, 'Wrong password must fail');

  // Test successful login for seeded super-admin
  const adminLogin = await AuthService.login('admin@kiranaos.internal', 'SuperAdmin@Kirana2026');
  assert.ok(adminLogin.token, 'Should return JWT token');
  assert.strictEqual(adminLogin.user.role, 'SUPER_ADMIN');
  assert.strictEqual(adminLogin.user.storeId, null);

  // Test successful login for seeded store owner
  const ownerLogin = await AuthService.login('owner@ganeshkirana.com', 'KiranaOwner@123');
  assert.ok(ownerLogin.token);
  assert.strictEqual(ownerLogin.user.role, 'STORE_OWNER');
  assert.strictEqual(ownerLogin.user.storeId, 'store_ganesh_kirana');
  assert.strictEqual(ownerLogin.store.name, 'Shree Ganesh Kirana & General Store');

  // Test invalid password failure
  await assert.rejects(
    async () => {
      await AuthService.login('owner@ganeshkirana.com', 'InvalidPass999');
    },
    { message: 'Invalid email or password' }
  );

  // Test non-existent user
  await assert.rejects(
    async () => {
      await AuthService.login('ghost@doesnotexist.com', 'AnyPass');
    },
    { message: 'Invalid email or password' }
  );
});
