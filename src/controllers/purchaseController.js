import crypto from 'crypto';
import { getDb } from '../db/index.js';

export function getPurchases(req, res) {
  const storeId = req.user.storeId;
  const db = getDb();

  const purchases = db.query(
    `SELECT p.*, s.name as supplier_name
     FROM purchases p
     LEFT JOIN suppliers s ON p.supplier_id = s.id
     WHERE p.store_id = ?
     ORDER BY p.invoice_date DESC LIMIT 100`,
    [storeId]
  );

  res.json({ success: true, count: purchases.length, purchases });
}

export function createPurchase(req, res) {
  const storeId = req.user.storeId;
  const { supplierId, invoiceNumber, invoiceDate, items, paidAmount = 0, notes } = req.body;

  if (!supplierId || !invoiceNumber || !items || items.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Supplier, invoice number, and purchase items are required'
    });
  }

  const db = getDb();

  const result = db.transaction((tx) => {
    const supplier = tx.get('SELECT * FROM suppliers WHERE id = ? AND store_id = ?', [supplierId, storeId]);
    if (!supplier) throw new Error('Supplier not found.');

    let subtotal = 0;
    let totalTax = 0;
    const purchaseId = `pur_${crypto.randomUUID()}`;
    const lineItems = [];

    for (const item of items) {
      const product = tx.get('SELECT * FROM products WHERE id = ? AND store_id = ?', [item.productId, storeId]);
      if (!product) throw new Error(`Product not found: ${item.productId}`);

      const qty = parseFloat(item.quantity);
      const unitCost = parseFloat(item.unitCost);
      const taxRate = parseFloat(item.taxRate || 0);

      const lineCost = Math.round(qty * unitCost * 100) / 100;
      const lineTax = Math.round((lineCost * taxRate / 100) * 100) / 100;
      const lineTotal = lineCost + lineTax;

      subtotal += lineCost;
      totalTax += lineTax;

      lineItems.push({
        id: `pi_${crypto.randomUUID()}`,
        purchaseId,
        productId: product.id,
        quantity: qty,
        unitCost,
        taxRate,
        taxAmount: lineTax,
        totalCost: lineTotal,
        batchNumber: item.batchNumber || null,
        expiryDate: item.expiryDate || null
      });

      // Update product stock and purchase cost atomically
      tx.run(
        `UPDATE products SET
          stock_quantity = stock_quantity + ?,
          purchase_cost = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [qty, unitCost, product.id]
      );

      // Audit stock movement
      tx.run(
        `INSERT INTO stock_movements (
          id, store_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, reason, created_by
        ) VALUES (?, ?, ?, 'PURCHASE', ?, ?, 'PURCHASE_INVOICE', ?, ?, ?)`,
        [
          `mov_${crypto.randomUUID()}`,
          storeId,
          product.id,
          qty,
          unitCost,
          invoiceNumber,
          `Stock received from supplier invoice ${invoiceNumber}`,
          req.user.userId
        ]
      );
    }

    const totalAmount = Math.round((subtotal + totalTax) * 100) / 100;
    const parsedPaid = parseFloat(paidAmount) || 0;
    const paymentStatus = parsedPaid >= totalAmount ? 'PAID' : (parsedPaid > 0 ? 'PARTIAL' : 'UNPAID');
    const unpaidBalance = Math.max(0, totalAmount - parsedPaid);

    // Insert purchase
    tx.run(
      `INSERT INTO purchases (
        id, store_id, supplier_id, invoice_number, invoice_date, subtotal, tax_amount, total_amount, paid_amount, payment_status, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseId,
        storeId,
        supplierId,
        invoiceNumber,
        invoiceDate || new Date().toISOString(),
        subtotal,
        totalTax,
        totalAmount,
        parsedPaid,
        paymentStatus,
        notes || '',
        req.user.userId
      ]
    );

    // Insert purchase items
    for (const li of lineItems) {
      tx.run(
        `INSERT INTO purchase_items (id, purchase_id, product_id, quantity, unit_cost, tax_rate, tax_amount, total_cost, batch_number, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [li.id, li.purchaseId, li.productId, li.quantity, li.unitCost, li.taxRate, li.taxAmount, li.totalCost, li.batchNumber, li.expiryDate]
      );
    }

    // Update supplier balance if any unpaid portion
    if (unpaidBalance > 0) {
      const newBal = (supplier.outstanding_balance || 0) + unpaidBalance;
      tx.run('UPDATE suppliers SET outstanding_balance = ? WHERE id = ?', [newBal, supplierId]);

      tx.run(
        `INSERT INTO supplier_ledger (id, store_id, supplier_id, entry_type, amount, running_balance, reference_type, reference_id, notes, created_by)
         VALUES (?, ?, ?, 'PURCHASE', ?, ?, 'PURCHASE_INVOICE', ?, 'Unpaid supplier purchase invoice', ?)`,
        [`sled_${crypto.randomUUID()}`, storeId, supplierId, unpaidBalance, newBal, invoiceNumber, req.user.userId]
      );
    }

    return {
      success: true,
      purchaseId,
      invoiceNumber,
      totalAmount,
      paidAmount: parsedPaid,
      paymentStatus
    };
  });

  res.status(201).json(result);
}
