import { PosService } from '../services/posService.js';
import { getDb } from '../db/index.js';
import { syncLocalDiskJson } from '../services/diskJsonBackup.js';

export function checkout(req, res) {
  try {
    const storeId = req.user.storeId;
    const cashierId = req.user.userId;
    const {
      items,
      payments,
      customerId,
      discountAmount,
      discountPercent,
      notes,
      clientSaleId,
      offlineCreatedAt
    } = req.body;

    const receipt = PosService.checkoutSale({
      storeId,
      cashierId,
      customerId,
      items,
      payments,
      discountAmount,
      discountPercent,
      notes,
      clientSaleId,
      offlineCreatedAt
    });

    syncLocalDiskJson(storeId);
    res.status(201).json(receipt);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

export function getSales(req, res) {
  const storeId = req.user.storeId;
  const { startDate, endDate, q, status, limit = 50, page = 1 } = req.query;
  const db = getDb();

  let query = `
    SELECT s.*, c.name as customer_name, c.phone as customer_phone, u.full_name as cashier_name
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    LEFT JOIN users u ON s.cashier_id = u.id
    WHERE s.store_id = ?
  `;
  const params = [storeId];

  if (startDate) {
    query += ' AND date(s.created_at) >= date(?)';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND date(s.created_at) <= date(?)';
    params.push(endDate);
  }

  if (status) {
    query += ' AND s.status = ?';
    params.push(status);
  }

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query += ' AND (s.invoice_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)';
    params.push(term, term, term);
  }

  query += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  params.push(parseInt(limit, 10), offset);

  const sales = db.query(query, params);
  res.json({ success: true, count: sales.length, sales });
}

export function getSaleById(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const db = getDb();

  const sale = db.get(
    `SELECT s.*, c.name as customer_name, c.phone as customer_phone, u.full_name as cashier_name
     FROM sales s
     LEFT JOIN customers c ON s.customer_id = c.id
     LEFT JOIN users u ON s.cashier_id = u.id
     WHERE s.id = ? AND s.store_id = ?`,
    [id, storeId]
  );

  if (!sale) {
    return res.status(404).json({ success: false, error: 'Sale not found' });
  }

  const items = db.query('SELECT * FROM sale_items WHERE sale_id = ?', [id]);
  const payments = db.query('SELECT * FROM payments WHERE sale_id = ?', [id]);
  const store = db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
  const settings = db.get('SELECT * FROM store_settings WHERE store_id = ?', [storeId]);

  res.json({
    success: true,
    sale,
    items,
    payments,
    store: {
      name: store.name,
      address: store.address,
      city: store.city,
      state: store.state,
      pincode: store.pincode,
      phone: store.phone,
      gstin: store.gstin,
      upiId: settings?.upi_id,
      upiName: settings?.upi_name,
      terms: settings?.terms_and_conditions,
      printerType: settings?.receipt_printer_type || '58mm'
    }
  });
}

export function processReturn(req, res) {
  try {
    const storeId = req.user.storeId;
    const cashierId = req.user.userId;
    const { id } = req.params;
    const { items, refundMethod, reason } = req.body;

    const result = PosService.processReturn({
      storeId,
      cashierId,
      originalSaleId: id,
      items,
      refundMethod,
      reason
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

export function voidSale(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, error: 'Mandatory reason required to void sale.' });
  }

  const db = getDb();
  const sale = db.get('SELECT * FROM sales WHERE id = ? AND store_id = ?', [id, storeId]);
  if (!sale) {
    return res.status(404).json({ success: false, error: 'Sale not found.' });
  }

  if (sale.status === 'VOIDED') {
    return res.status(400).json({ success: false, error: 'Sale has already been voided.' });
  }

  db.transaction((tx) => {
    // Restock all items
    const items = tx.query('SELECT * FROM sale_items WHERE sale_id = ?', [id]);
    for (const item of items) {
      tx.run(
        'UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ? AND store_id = ?',
        [item.quantity, item.product_id, storeId]
      );

      tx.run(
        `INSERT INTO stock_movements (
          id, store_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, reason, created_by
        ) VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, 'SALE_VOID', ?, ?, ?)`,
        [
          `mov_${Date.now()}_${item.id}`,
          storeId,
          item.product_id,
          item.quantity,
          item.purchase_cost,
          sale.invoice_number,
          `Restocked due to voided invoice: ${reason}`,
          req.user.userId
        ]
      );
    }

    // Mark sale voided
    tx.run(
      'UPDATE sales SET status = ?, void_reason = ? WHERE id = ?',
      ['VOIDED', reason.trim(), id]
    );
  });

  res.json({ success: true, message: `Invoice ${sale.invoice_number} voided and items restocked.` });
}
