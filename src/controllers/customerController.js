import crypto from 'crypto';
import { getDb } from '../db/index.js';

export function getCustomers(req, res) {
  const storeId = req.user.storeId;
  const { q, hasDues } = req.query;
  const db = getDb();

  let query = 'SELECT * FROM customers WHERE store_id = ? AND is_active = 1';
  const params = [storeId];

  if (hasDues === '1') {
    query += ' AND outstanding_balance > 0';
  }

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query += ' AND (name LIKE ? OR phone LIKE ?)';
    params.push(term, term);
  }

  query += ' ORDER BY name ASC';
  const customers = db.query(query, params);
  res.json({ success: true, count: customers.length, customers });
}

export function getCustomerById(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const db = getDb();

  const customer = db.get('SELECT * FROM customers WHERE id = ? AND store_id = ?', [id, storeId]);
  if (!customer) {
    return res.status(404).json({ success: false, error: 'Customer not found' });
  }

  const ledger = db.query(
    'SELECT * FROM customer_ledger WHERE customer_id = ? AND store_id = ? ORDER BY created_at DESC LIMIT 50',
    [id, storeId]
  );

  const recentSales = db.query(
    'SELECT * FROM sales WHERE customer_id = ? AND store_id = ? ORDER BY created_at DESC LIMIT 10',
    [id, storeId]
  );

  res.json({ success: true, customer, ledger, recentSales });
}

export function createCustomer(req, res) {
  const storeId = req.user.storeId;
  if (!storeId) {
    return res.status(400).json({ success: false, error: 'Store context required' });
  }

  const { name, phone, email, address, creditLimit = 5000, initialBalance = 0 } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Customer name is required' });
  }

  const db = getDb();

  // If customer with same phone already exists in this store, return existing
  if (phone && phone.trim()) {
    const existing = db.get('SELECT * FROM customers WHERE store_id = ? AND phone = ? AND is_active = 1', [storeId, phone.trim()]);
    if (existing) {
      return res.status(200).json({ success: true, customer: existing, message: 'Customer already exists with this phone number' });
    }
  }

  const customerId = `cust_${crypto.randomUUID()}`;
  const parsedLimit = parseFloat(creditLimit) || 5000;
  const parsedBalance = parseFloat(initialBalance) || 0;

  try {
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO customers (id, store_id, name, phone, email, address, credit_limit, outstanding_balance, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          customerId,
          storeId,
          name.trim(),
          phone ? phone.trim() : null,
          email ? email.trim() : null,
          address ? address.trim() : null,
          parsedLimit,
          parsedBalance
        ]
      );

      if (parsedBalance > 0) {
        tx.run(
          `INSERT INTO customer_ledger (id, store_id, customer_id, entry_type, amount, running_balance, reference_type, notes, created_by)
           VALUES (?, ?, ?, 'CREDIT_SALE', ?, ?, 'OPENING_BALANCE', 'Opening Udhaar balance', ?)`,
          [`led_${crypto.randomUUID()}`, storeId, customerId, parsedBalance, parsedBalance, req.user?.userId || null]
        );
      }
    });

    const created = db.get('SELECT * FROM customers WHERE id = ?', [customerId]);
    res.status(201).json({ success: true, customer: created });
  } catch (err) {
    console.error('[KiranaOS Customer] Create customer error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

export function updateCustomer(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const { name, phone, email, address, creditLimit } = req.body;
  const db = getDb();

  const existing = db.get('SELECT * FROM customers WHERE id = ? AND store_id = ?', [id, storeId]);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Customer not found' });
  }

  db.run(
    `UPDATE customers SET
      name = COALESCE(?, name),
      phone = COALESCE(?, phone),
      email = COALESCE(?, email),
      address = COALESCE(?, address),
      credit_limit = COALESCE(?, credit_limit),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND store_id = ?`,
    [
      name !== undefined ? name.trim() : null,
      phone !== undefined ? phone.trim() : null,
      email !== undefined ? email.trim() : null,
      address !== undefined ? address.trim() : null,
      creditLimit !== undefined ? parseFloat(creditLimit) : null,
      id,
      storeId
    ]
  );

  const updated = db.get('SELECT * FROM customers WHERE id = ?', [id]);
  res.json({ success: true, customer: updated });
}

export function recordRepayment(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const { amount, paymentMethod = 'CASH', referenceId, notes } = req.body;

  const repayAmount = parseFloat(amount);
  if (isNaN(repayAmount) || repayAmount <= 0) {
    return res.status(400).json({ success: false, error: 'Valid repayment amount is required.' });
  }

  const db = getDb();

  try {
    const result = db.transaction((tx) => {
      const customer = tx.get('SELECT * FROM customers WHERE id = ? AND store_id = ?', [id, storeId]);
      if (!customer) throw new Error('Customer not found.');

      const newBalance = Math.max(0, (customer.outstanding_balance || 0) - repayAmount);
      const receiptNumber = `REC-${Date.now().toString().slice(-6)}`;

      // Update customer balance
      tx.run('UPDATE customers SET outstanding_balance = ? WHERE id = ?', [newBalance, id]);

      // Insert customer ledger entry
      const ledgerId = `led_${crypto.randomUUID()}`;
      tx.run(
        `INSERT INTO customer_ledger (id, store_id, customer_id, entry_type, amount, running_balance, reference_type, reference_id, notes, created_by)
         VALUES (?, ?, ?, 'PAYMENT_RECEIVED', ?, ?, 'REPAYMENT', ?, ?, ?)`,
        [
          ledgerId,
          storeId,
          id,
          repayAmount,
          newBalance,
          receiptNumber,
          notes || `Udhaar repayment via ${paymentMethod}`,
          req.user?.userId || null
        ]
      );

      // Record payment entry
      tx.run(
        `INSERT INTO payments (id, store_id, customer_id, payment_method, amount, reference_id, notes, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)`,
        [
          `pay_${crypto.randomUUID()}`,
          storeId,
          id,
          paymentMethod,
          repayAmount,
          referenceId || receiptNumber,
          notes || 'Customer udhaar repayment',
          req.user?.userId || null
        ]
      );

      // If shift is active and cash received
      if (paymentMethod === 'CASH') {
        const activeShift = tx.get(
          `SELECT id FROM cashier_shifts WHERE store_id = ? AND cashier_id = ? AND status = 'OPEN'`,
          [storeId, req.user?.userId || '']
        );
        if (activeShift) {
          tx.run(
            'UPDATE cashier_shifts SET cash_sales = cash_sales + ? WHERE id = ?',
            [repayAmount, activeShift.id]
          );
        }
      }

      const store = tx.get('SELECT name, phone FROM stores WHERE id = ?', [storeId]) || { name: 'Kirana Store' };

      // Generate WhatsApp reminder text
      const waText = encodeURIComponent(
        `Dear ${customer.name}, we received payment of ₹${repayAmount.toFixed(2)} at ${store.name}. Your remaining udhaar balance is ₹${newBalance.toFixed(2)}. Thank you!`
      );
      const waLink = customer.phone ? `https://wa.me/91${customer.phone.replace(/[^0-9]/g, '')}?text=${waText}` : null;

      return {
        success: true,
        receiptNumber,
        paidAmount: repayAmount,
        previousBalance: customer.outstanding_balance,
        newBalance,
        customerName: customer.name,
        whatsAppReminderLink: waLink
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[KiranaOS Customer] Repayment error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}
