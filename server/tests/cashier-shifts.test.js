import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { getDb } from '../src/db/index.js';

test('Cashier Shift Management and Drawer Reconciliation', () => {
  const db = getDb();
  const storeId = 'store_ganesh_kirana';
  const cashierId = 'usr_cashier_shift_test';

  // Create temporary cashier user for this test if not exists
  const existing = db.get('SELECT id FROM users WHERE id = ?', [cashierId]);
  if (!existing) {
    db.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active)
       VALUES (?, ?, 'shift_test@ganesh.com', 'hash', 'Test Cashier', '9000000000', 'CASHIER', 1)`,
      [cashierId, storeId]
    );
  }

  const shiftId = `shf_${crypto.randomUUID()}`;
  const openingCash = 1000.0;

  // 1. Open shift
  db.run(
    `INSERT INTO cashier_shifts (id, store_id, cashier_id, opened_at, opening_cash, cash_sales, cash_refunds, cash_drops, cash_additions, status)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 0, 0, 0, 0, 'OPEN')`,
    [shiftId, storeId, cashierId, openingCash]
  );

  let shift = db.get('SELECT * FROM cashier_shifts WHERE id = ?', [shiftId]);
  assert.strictEqual(shift.opening_cash, 1000.0);
  assert.strictEqual(shift.status, 'OPEN');

  // 2. Simulate cash sales (+₹1500)
  db.run('UPDATE cashier_shifts SET cash_sales = cash_sales + 1500 WHERE id = ?', [shiftId]);

  // 3. Simulate cash drop to store safe (-₹800)
  db.run(
    `INSERT INTO shift_cash_movements (id, shift_id, movement_type, amount, reason)
     VALUES (?, ?, 'DROP', 800.0, 'Mid-day transfer to main store safe')`,
    [`smov_${crypto.randomUUID()}`, shiftId]
  );
  db.run('UPDATE cashier_shifts SET cash_drops = cash_drops + 800 WHERE id = ?', [shiftId]);

  // 4. Simulate small cash addition (+₹200 for change)
  db.run(
    `INSERT INTO shift_cash_movements (id, shift_id, movement_type, amount, reason)
     VALUES (?, ?, 'ADDITION', 200.0, 'Small change coins added')`,
    [`smov_${crypto.randomUUID()}`, shiftId]
  );
  db.run('UPDATE cashier_shifts SET cash_additions = cash_additions + 200 WHERE id = ?', [shiftId]);

  // 5. Close shift
  shift = db.get('SELECT * FROM cashier_shifts WHERE id = ?', [shiftId]);
  const expectedCash = shift.opening_cash + shift.cash_sales - shift.cash_refunds - shift.cash_drops + shift.cash_additions;
  // 1000 + 1500 - 0 - 800 + 200 = 1900.0
  assert.strictEqual(expectedCash, 1900.0);

  const actualCountedCash = 1890.0; // ₹10 short
  const diff = actualCountedCash - expectedCash; // -10.0

  db.run(
    `UPDATE cashier_shifts SET
      closed_at = CURRENT_TIMESTAMP,
      expected_cash = ?,
      actual_cash = ?,
      difference = ?,
      notes = '₹10 discrepancy due to round off coins shortage',
      status = 'CLOSED'
    WHERE id = ?`,
    [expectedCash, actualCountedCash, diff, shiftId]
  );

  const closedShift = db.get('SELECT * FROM cashier_shifts WHERE id = ?', [shiftId]);
  assert.strictEqual(closedShift.status, 'CLOSED');
  assert.strictEqual(closedShift.expected_cash, 1900.0);
  assert.strictEqual(closedShift.actual_cash, 1890.0);
  assert.strictEqual(closedShift.difference, -10.0);
});
