import crypto from 'crypto';
import { getDb } from '../db/index.js';

export function getCurrentShift(req, res) {
  const storeId = req.user.storeId;
  const cashierId = req.user.userId;
  const db = getDb();

  const shift = db.get(
    `SELECT * FROM cashier_shifts
     WHERE store_id = ? AND cashier_id = ? AND status = 'OPEN'`,
    [storeId, cashierId]
  );

  if (!shift) {
    return res.json({ success: true, hasOpenShift: false, shift: null });
  }

  // Get cash movements for this shift
  const movements = db.query(
    'SELECT * FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC',
    [shift.id]
  );

  const expectedCash = (shift.opening_cash || 0) + (shift.cash_sales || 0) - (shift.cash_refunds || 0) - (shift.cash_drops || 0) + (shift.cash_additions || 0);

  res.json({
    success: true,
    hasOpenShift: true,
    shift: {
      ...shift,
      expectedCash: Math.round(expectedCash * 100) / 100
    },
    movements
  });
}

export function openShift(req, res) {
  const storeId = req.user.storeId;
  const cashierId = req.user.userId;
  const { openingCash = 0, notes } = req.body;
  const db = getDb();

  // Check if shift is already open
  const existing = db.get(
    `SELECT id FROM cashier_shifts WHERE store_id = ? AND cashier_id = ? AND status = 'OPEN'`,
    [storeId, cashierId]
  );

  if (existing) {
    return res.status(400).json({ success: false, error: 'A shift is already open for this cashier. Close it first.' });
  }

  const shiftId = `shf_${crypto.randomUUID()}`;
  const parsedCash = parseFloat(openingCash) || 0;

  db.run(
    `INSERT INTO cashier_shifts (
      id, store_id, cashier_id, opened_at, opening_cash, cash_sales, cash_refunds,
      cash_drops, cash_additions, expected_cash, notes, status
    ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 0, 0, 0, 0, ?, ?, 'OPEN')`,
    [shiftId, storeId, cashierId, parsedCash, parsedCash, notes || '']
  );

  const shift = db.get('SELECT * FROM cashier_shifts WHERE id = ?', [shiftId]);
  res.status(201).json({ success: true, shift });
}

export function recordShiftCashMovement(req, res) {
  const storeId = req.user.storeId;
  const cashierId = req.user.userId;
  const { shiftId, type, amount, reason } = req.body; // type: 'DROP' | 'ADDITION'

  if (!shiftId || !['DROP', 'ADDITION'].includes(type) || !amount || !reason || !reason.trim()) {
    return res.status(400).json({ success: false, error: 'Valid shift, type (DROP/ADDITION), amount and reason are required' });
  }

  const db = getDb();
  const shift = db.get('SELECT * FROM cashier_shifts WHERE id = ? AND store_id = ? AND status = "OPEN"', [shiftId, storeId]);
  if (!shift) {
    return res.status(404).json({ success: false, error: 'Active open shift not found' });
  }

  const parsedAmt = parseFloat(amount);
  if (isNaN(parsedAmt) || parsedAmt <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }

  db.transaction((tx) => {
    tx.run(
      `INSERT INTO shift_cash_movements (id, shift_id, movement_type, amount, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [`smov_${crypto.randomUUID()}`, shiftId, type, parsedAmt, reason.trim()]
    );

    if (type === 'DROP') {
      tx.run('UPDATE cashier_shifts SET cash_drops = cash_drops + ? WHERE id = ?', [parsedAmt, shiftId]);
    } else {
      tx.run('UPDATE cashier_shifts SET cash_additions = cash_additions + ? WHERE id = ?', [parsedAmt, shiftId]);
    }
  });

  res.json({ success: true, message: `Cash ${type.toLowerCase()} of ₹${parsedAmt} recorded successfully.` });
}

export function closeShift(req, res) {
  const storeId = req.user.storeId;
  const cashierId = req.user.userId;
  const { shiftId, actualCash, notes } = req.body;

  if (!shiftId || actualCash === undefined) {
    return res.status(400).json({ success: false, error: 'Shift ID and counted actual cash are required' });
  }

  const db = getDb();
  const shift = db.get('SELECT * FROM cashier_shifts WHERE id = ? AND store_id = ?', [shiftId, storeId]);
  if (!shift) {
    return res.status(404).json({ success: false, error: 'Shift not found' });
  }

  const parsedActual = parseFloat(actualCash);
  const expected = (shift.opening_cash || 0) + (shift.cash_sales || 0) - (shift.cash_refunds || 0) - (shift.cash_drops || 0) + (shift.cash_additions || 0);
  const diff = Math.round((parsedActual - expected) * 100) / 100;

  db.run(
    `UPDATE cashier_shifts SET
      closed_at = CURRENT_TIMESTAMP,
      expected_cash = ?,
      actual_cash = ?,
      difference = ?,
      notes = ?,
      status = 'CLOSED'
    WHERE id = ?`,
    [expected, parsedActual, diff, notes || '', shiftId]
  );

  const closed = db.get('SELECT * FROM cashier_shifts WHERE id = ?', [shiftId]);
  res.json({
    success: true,
    shift: closed,
    reconciliation: {
      expectedCash: expected,
      actualCash: parsedActual,
      difference: diff,
      isBalanced: diff === 0
    }
  });
}

export function getShiftHistory(req, res) {
  const storeId = req.user.storeId;
  const db = getDb();

  const shifts = db.query(
    `SELECT cs.*, u.full_name as cashier_name
     FROM cashier_shifts cs
     JOIN users u ON cs.cashier_id = u.id
     WHERE cs.store_id = ?
     ORDER BY cs.opened_at DESC LIMIT 50`,
    [storeId]
  );

  res.json({ success: true, count: shifts.length, shifts });
}
