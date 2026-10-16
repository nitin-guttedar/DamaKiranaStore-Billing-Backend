import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { getDb } from '../src/db/index.js';
import { requireStoreAccess, requireRole } from '../src/middleware/auth.js';

test('Tenant Isolation and Role Authorization', () => {
  const db = getDb();

  // Mock Request / Response helper
  function mockReqRes(user, targetStoreId) {
    const req = {
      user,
      params: { storeId: targetStoreId }
    };
    let statusCode = 200;
    let jsonResult = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResult = data;
        return this;
      }
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    return { req, res, next, getStatus: () => statusCode, getJson: () => jsonResult, isNextCalled: () => nextCalled };
  }

  // 1. Store Owner trying to access their own store -> ALLOWED
  const storeUser = { userId: 'u1', storeId: 'store_ganesh_kirana', role: 'STORE_OWNER' };
  const allowedCheck = mockReqRes(storeUser, 'store_ganesh_kirana');
  requireStoreAccess(allowedCheck.req, allowedCheck.res, allowedCheck.next);
  assert.strictEqual(allowedCheck.isNextCalled(), true, 'Store owner should access their own store');

  // 2. Store Owner trying to access another store -> BLOCKED (403)
  const crossStoreCheck = mockReqRes(storeUser, 'store_rival_kirana');
  requireStoreAccess(crossStoreCheck.req, crossStoreCheck.res, crossStoreCheck.next);
  assert.strictEqual(crossStoreCheck.isNextCalled(), false, 'Cross-tenant access must be blocked');
  assert.strictEqual(crossStoreCheck.getStatus(), 403);
  assert.ok(crossStoreCheck.getJson().error.includes('Tenant isolation violation'));

  // 3. Super Admin accessing any store -> ALLOWED
  const superAdmin = { userId: 'sa_1', storeId: null, role: 'SUPER_ADMIN' };
  const adminCheck = mockReqRes(superAdmin, 'store_rival_kirana');
  requireStoreAccess(adminCheck.req, adminCheck.res, adminCheck.next);
  assert.strictEqual(adminCheck.isNextCalled(), true, 'Super admin has platform authority across stores');

  // 4. Role Authorization: CASHIER attempting to access STORE_OWNER endpoint -> BLOCKED (403)
  const cashierUser = { userId: 'c1', storeId: 'store_ganesh_kirana', role: 'CASHIER' };
  const cashierCheck = mockReqRes(cashierUser, 'store_ganesh_kirana');
  const ownerOnlyMiddleware = requireRole('STORE_OWNER', 'STORE_MANAGER');
  ownerOnlyMiddleware(cashierCheck.req, cashierCheck.res, cashierCheck.next);
  assert.strictEqual(cashierCheck.isNextCalled(), false, 'Cashier must be blocked from owner/manager endpoints');
  assert.strictEqual(cashierCheck.getStatus(), 403);
});
