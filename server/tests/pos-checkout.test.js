import test from 'node:test';
import assert from 'node:assert';
import { PosService } from '../src/services/posService.js';
import { getDb } from '../src/db/index.js';
import { seedDatabase } from '../src/db/seed.js';

test('POS Checkout: Atomic Sale, Stock Deduction, Split Payments, and Udhaar Ledger', async () => {
  await seedDatabase();
  const db = getDb();
  const storeId = 'store_ganesh_kirana';
  const cashierId = 'usr_cashier_suresh';
  const customerId = 'cust_ananya';

  // Check initial stock of Parle-G
  const initialProduct = db.get('SELECT stock_quantity, selling_price FROM products WHERE id = ?', ['prd_parleg']);
  const initialStock = initialProduct.stock_quantity;
  const unitPrice = initialProduct.selling_price; // 10.0

  // 1. Process Sale with 3 units of Parle-G (₹30.00) split between CASH (₹20) and UPI (₹10)
  const qtyToBuy = 3;
  const expectedTotal = unitPrice * qtyToBuy; // 30.0

  const receipt = PosService.checkoutSale({
    storeId,
    cashierId,
    customerId,
    items: [
      { productId: 'prd_parleg', quantity: qtyToBuy, sellingPrice: unitPrice }
    ],
    payments: [
      { method: 'CASH', amount: 20.0 },
      { method: 'UPI', amount: 10.0, referenceId: 'UPI-TEST-1234' }
    ]
  });

  assert.strictEqual(receipt.success, true);
  assert.ok(receipt.invoiceNumber.startsWith('SGK-'));
  assert.strictEqual(receipt.totalAmount, 30.0);
  assert.strictEqual(receipt.items.length, 1);

  // 2. Verify stock deducted EXACTLY ONCE
  const updatedProduct = db.get('SELECT stock_quantity FROM products WHERE id = ?', ['prd_parleg']);
  assert.strictEqual(
    updatedProduct.stock_quantity,
    initialStock - qtyToBuy,
    `Stock must decrease by ${qtyToBuy}`
  );

  // 3. Verify stock movement recorded
  const movement = db.get(
    'SELECT * FROM stock_movements WHERE product_id = ? AND reference_id = ?',
    ['prd_parleg', receipt.invoiceNumber]
  );
  assert.ok(movement, 'Stock movement audit row must exist');
  assert.strictEqual(movement.movement_type, 'SALE');
  assert.strictEqual(movement.quantity, -qtyToBuy);

  // 4. Verify Payments recorded in payments table
  const payments = db.query('SELECT * FROM payments WHERE sale_id = ?', [receipt.saleId]);
  assert.strictEqual(payments.length, 2, 'Split payments must record 2 payment entries');
  const cashPay = payments.find(p => p.payment_method === 'CASH');
  const upiPay = payments.find(p => p.payment_method === 'UPI');
  assert.strictEqual(cashPay.amount, 20.0);
  assert.strictEqual(upiPay.amount, 10.0);

  // 5. Customer Udhaar (Credit) sale test
  const initialCustomer = db.get('SELECT outstanding_balance, credit_limit FROM customers WHERE id = ?', ['cust_rahul']);
  const initialBal = initialCustomer.outstanding_balance;

  const creditSale = PosService.checkoutSale({
    storeId,
    cashierId,
    customerId: 'cust_rahul',
    items: [
      { productId: 'prd_salt', quantity: 2, sellingPrice: 27.0 } // 54.0
    ],
    payments: [
      { method: 'CREDIT', amount: 54.0 }
    ]
  });

  assert.strictEqual(creditSale.success, true);

  // Verify customer balance increased
  const updatedCustomer = db.get('SELECT outstanding_balance FROM customers WHERE id = ?', ['cust_rahul']);
  assert.strictEqual(
    updatedCustomer.outstanding_balance,
    initialBal + 54.0,
    'Customer balance must increase by credit sale amount'
  );

  // Verify ledger entry created
  const ledger = db.get(
    'SELECT * FROM customer_ledger WHERE customer_id = ? AND reference_id = ?',
    ['cust_rahul', creditSale.invoiceNumber]
  );
  assert.ok(ledger, 'Customer ledger record must be written');
  assert.strictEqual(ledger.entry_type, 'CREDIT_SALE');
  assert.strictEqual(ledger.amount, 54.0);

  // 6. Test Sales Return & Restocking
  const returnResult = PosService.processReturn({
    storeId,
    cashierId,
    originalSaleId: receipt.saleId,
    items: [
      { saleItemId: receipt.items[0].id, quantity: 1 }
    ],
    refundMethod: 'CASH',
    reason: 'Customer bought extra'
  });

  assert.strictEqual(returnResult.success, true);
  assert.strictEqual(returnResult.refundAmount, 10.0);

  // Verify stock restocked by 1
  const restockedProduct = db.get('SELECT stock_quantity FROM products WHERE id = ?', ['prd_parleg']);
  assert.strictEqual(restockedProduct.stock_quantity, updatedProduct.stock_quantity + 1);
});
