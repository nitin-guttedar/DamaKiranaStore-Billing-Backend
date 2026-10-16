import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { getDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { PosService } from '../src/services/posService.js';

test('Local Storage Sync Engine: Idempotent Checkout and Offline Timestamps', () => {
  runMigrations();
  const db = getDb();

  // 1. Setup mock store, product, and cashier
  const storeId = `store_sync_test_${Date.now()}`;
  const cashierId = `cashier_sync_${Date.now()}`;
  const productId = `prod_sync_${Date.now()}`;

  db.run(
    `INSERT INTO stores (id, name, slug, phone, status) VALUES (?, 'Sync Test Store', ?, '9988776655', 'ACTIVE')`,
    [storeId, `slug-${Date.now()}`]
  );
  db.run(
    `INSERT INTO store_settings (store_id, invoice_prefix, next_invoice_number, enable_gst) VALUES (?, 'SYN', 101, 1)`,
    [storeId]
  );
  const cashierEmail = `sync_cashier_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@test.com`;
  db.run(
    `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active)
     VALUES (?, ?, ?, 'hash', 'Test Cashier', '9988776655', 'CASHIER', 1)`,
    [cashierId, storeId, cashierEmail]
  );
  db.run(
    `INSERT INTO products (id, store_id, name, selling_price, mrp, stock_quantity, tax_rate, is_active)
     VALUES (?, ?, 'Local Storage Parle-G 100g', 10, 10, 100, 0, 1)`,
    [productId, storeId]
  );

  const initialStock = db.get('SELECT stock_quantity FROM products WHERE id = ?', [productId]).stock_quantity;
  assert.strictEqual(initialStock, 100);

  // 2. Perform checkout with clientSaleId (simulating an offline-generated sale queued on laptop)
  const clientSaleId = `offline_sale_${crypto.randomUUID()}`;
  const offlineCreatedAt = '2026-10-14 06:15:00';

  const receipt1 = PosService.checkoutSale({
    storeId,
    cashierId,
    customerId: null,
    items: [{ productId, quantity: 5, sellingPrice: 10, discountAmount: 0 }],
    payments: [{ method: 'CASH', amount: 50 }],
    clientSaleId,
    offlineCreatedAt
  });

  assert.strictEqual(receipt1.success, true);
  assert.strictEqual(receipt1.saleId, clientSaleId);
  assert.strictEqual(receipt1.totalAmount, 50);

  // Stock should be decremented by 5 (100 -> 95)
  const stockAfterSale1 = db.get('SELECT stock_quantity FROM products WHERE id = ?', [productId]).stock_quantity;
  assert.strictEqual(stockAfterSale1, 95);

  // Verify created_at matches the offline timestamp
  const recordedSale = db.get('SELECT * FROM sales WHERE id = ?', [clientSaleId]);
  assert.strictEqual(recordedSale.id, clientSaleId);
  assert.strictEqual(recordedSale.created_at, offlineCreatedAt);

  // 3. Re-submit the exact same clientSaleId (simulating a network retry from IndexedDB outbox)
  const receipt2 = PosService.checkoutSale({
    storeId,
    cashierId,
    customerId: null,
    items: [{ productId, quantity: 5, sellingPrice: 10, discountAmount: 0 }],
    payments: [{ method: 'CASH', amount: 50 }],
    clientSaleId,
    offlineCreatedAt
  });

  // Idempotency: must return existing receipt without error
  assert.strictEqual(receipt2.success, true);
  assert.strictEqual(receipt2.saleId, clientSaleId);
  assert.strictEqual(receipt2.totalAmount, 50);

  // Stock MUST STILL BE 95 (no double decrement!)
  const stockAfterSale2 = db.get('SELECT stock_quantity FROM products WHERE id = ?', [productId]).stock_quantity;
  assert.strictEqual(stockAfterSale2, 95, 'Stock should NOT be decremented twice on duplicate sync');

  // Verify only 1 record exists in sales table for this clientSaleId
  const saleCount = db.get('SELECT COUNT(*) as count FROM sales WHERE id = ?', [clientSaleId]).count;
  assert.strictEqual(saleCount, 1);
});
