import crypto from 'crypto';
import { getDb } from '../db/index.js';

export function getSuppliers(req, res) {
  const storeId = req.user.storeId;
  const { q } = req.query;
  const db = getDb();

  let query = 'SELECT * FROM suppliers WHERE store_id = ? AND is_active = 1';
  const params = [storeId];

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query += ' AND (name LIKE ? OR contact_person LIKE ? OR phone LIKE ?)';
    params.push(term, term, term);
  }

  query += ' ORDER BY name ASC';
  const suppliers = db.query(query, params);
  res.json({ success: true, count: suppliers.length, suppliers });
}

export function createSupplier(req, res) {
  const storeId = req.user.storeId;
  const { name, contactPerson, phone, email, address, gstin, openingBalance = 0 } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Supplier name is required' });
  }

  const db = getDb();
  const id = `sup_${crypto.randomUUID()}`;
  const balance = parseFloat(openingBalance) || 0;

  db.transaction((tx) => {
    tx.run(
      `INSERT INTO suppliers (id, store_id, name, contact_person, phone, email, address, gstin, outstanding_balance, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, storeId, name.trim(), contactPerson || null, phone || null, email || null, address || null, gstin || null, balance]
    );

    if (balance > 0) {
      tx.run(
        `INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount, running_balance, reference_type, notes, created_by)
         VALUES (?, ?, ?, 'PURCHASE', ?, ?, 'OPENING', 'Opening balance owed to supplier', ?)`,
        [`sled_${crypto.randomUUID()}`, storeId, id, balance, balance, req.user.userId]
      );
    }
  });

  const created = db.get('SELECT * FROM suppliers WHERE id = ?', [id]);
  res.status(201).json({ success: true, supplier: created });
}

export function getSupplierLedger(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const db = getDb();

  const supplier = db.get('SELECT * FROM suppliers WHERE id = ? AND store_id = ?', [id, storeId]);
  if (!supplier) return res.status(404).json({ success: false, error: 'Supplier not found' });

  const ledger = db.query(
    'SELECT * FROM supplier_ledger WHERE supplier_id = ? AND store_id = ? ORDER BY created_at DESC LIMIT 50',
    [id, storeId]
  );

  res.json({ success: true, supplier, ledger });
}

export function recordSupplierPayment(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const { amount, paymentMethod = 'BANK_TRANSFER', referenceId, notes } = req.body;

  const payAmt = parseFloat(amount);
  if (isNaN(payAmt) || payAmt <= 0) {
    return res.status(400).json({ success: false, error: 'Valid payment amount is required.' });
  }

  const db = getDb();

  const result = db.transaction((tx) => {
    const supplier = tx.get('SELECT * FROM suppliers WHERE id = ? AND store_id = ?', [id, storeId]);
    if (!supplier) throw new Error('Supplier not found');

    const newBalance = Math.max(0, (supplier.outstanding_balance || 0) - payAmt);

    tx.run('UPDATE suppliers SET outstanding_balance = ? WHERE id = ?', [newBalance, id]);

    tx.run(
      `INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount, running_balance, reference_type, reference_id, notes, created_by)
       VALUES (?, ?, ?, 'PAYMENT_MADE', ?, ?, 'PAYMENT', ?, ?, ?)`,
      [
        `sled_${crypto.randomUUID()}`,
        storeId,
        id,
        payAmt,
        newBalance,
        referenceId || `PAY-${Date.now().toString().slice(-6)}`,
        notes || `Payment made via ${paymentMethod}`,
        req.user.userId
      ]
    );

    return {
      success: true,
      paidAmount: payAmt,
      previousBalance: supplier.outstanding_balance,
      newBalance
    };
  });

  res.json(result);
}
