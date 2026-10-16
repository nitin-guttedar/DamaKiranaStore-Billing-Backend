import { getDb } from './index.js';

export function runMigrations() {
  const db = getDb();
  console.log('[KiranaOS DB] Running schema migrations...');

  db.exec(`
    -- 1. App Configuration & Settings
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Stores Table (Multi-tenant boundary)
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      gstin TEXT,
      status TEXT DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED, EXPIRED, TRIAL
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. Store Specific Settings
    CREATE TABLE IF NOT EXISTS store_settings (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL UNIQUE,
      invoice_prefix TEXT DEFAULT 'INV',
      next_invoice_number INTEGER DEFAULT 1,
      receipt_printer_type TEXT DEFAULT '58mm', -- 58mm, 80mm, A4
      enable_gst INTEGER DEFAULT 1,
      default_tax_rate REAL DEFAULT 5.0,
      upi_id TEXT DEFAULT '',
      upi_name TEXT DEFAULT '',
      currency_symbol TEXT DEFAULT '₹',
      terms_and_conditions TEXT DEFAULT 'Goods once sold cannot be returned without receipt within 3 days.',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    );

    -- 4. Subscription Plans
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE, -- MONTHLY, QUARTERLY, HALF_YEARLY, ANNUAL, CUSTOM, TRIAL
      duration_days INTEGER NOT NULL,
      price_inr REAL NOT NULL,
      max_users INTEGER DEFAULT 5,
      max_products INTEGER DEFAULT 5000,
      features_json TEXT DEFAULT '{}',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 5. Subscriptions
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE', -- TRIAL, ACTIVE, EXPIRING_SOON, EXPIRED, SUSPENDED
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_by_admin_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
    );

    -- 6. Cryptographic License Tokens
    CREATE TABLE IF NOT EXISTS license_tokens (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_hint TEXT NOT NULL,
      signed_payload TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      is_revoked INTEGER DEFAULT 0,
      revoked_at TEXT,
      revocation_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    );

    -- 7. Subscription Audit Events
    CREATE TABLE IF NOT EXISTS subscription_events (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      subscription_id TEXT,
      event_type TEXT NOT NULL, -- CREATED, RENEWED, SUSPENDED, REACTIVATED, REVOKED, EXPIRED
      details_json TEXT DEFAULT '{}',
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    );

    -- 8. Users Table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      store_id TEXT, -- NULL for SUPER_ADMIN
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL, -- SUPER_ADMIN, STORE_OWNER, STORE_MANAGER, CASHIER
      must_change_password INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    );

    -- 9. Product Categories
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      UNIQUE(store_id, name)
    );

    -- 10. Suppliers Table
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      gstin TEXT,
      outstanding_balance REAL DEFAULT 0.0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    );

    -- 11. Products Table
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      category_id TEXT,
      supplier_id TEXT,
      name TEXT NOT NULL,
      sku TEXT,
      barcode TEXT,
      brand TEXT,
      unit TEXT DEFAULT 'PCS', -- PCS, KG, G, L, ML, PACKET, BOX
      purchase_cost REAL DEFAULT 0.0,
      selling_price REAL NOT NULL,
      mrp REAL NOT NULL,
      stock_quantity REAL DEFAULT 0.0,
      reorder_threshold REAL DEFAULT 10.0,
      hsn_code TEXT DEFAULT '2106',
      tax_rate REAL DEFAULT 5.0,
      is_loose_weight INTEGER DEFAULT 0, -- 1 for items sold by fractional kg/g/l
      batch_number TEXT,
      expiry_date TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
      UNIQUE(store_id, barcode)
    );

    -- 12. Multiple Barcodes Support
    CREATE TABLE IF NOT EXISTS product_barcodes (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      barcode TEXT NOT NULL UNIQUE,
      is_primary INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    -- 13. Inventory Batches
    CREATE TABLE IF NOT EXISTS inventory_batches (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      batch_number TEXT NOT NULL,
      expiry_date TEXT,
      quantity REAL NOT NULL,
      purchase_cost REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    -- 14. Stock Movements (Audit Trail for inventory)
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      movement_type TEXT NOT NULL, -- OPENING, SALE, PURCHASE, RETURN, ADJUSTMENT
      quantity REAL NOT NULL, -- Positive for in, negative for out
      unit_cost REAL DEFAULT 0.0,
      reference_type TEXT, -- SALE, PURCHASE, RETURN, MANUAL
      reference_id TEXT,
      reason TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    -- 15. Customers Table & Udhaar
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      credit_limit REAL DEFAULT 5000.0,
      outstanding_balance REAL DEFAULT 0.0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    );

    -- 16. Cashier Shifts & Drawer Reconciliation
    CREATE TABLE IF NOT EXISTS cashier_shifts (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      cashier_id TEXT NOT NULL,
      opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      opening_cash REAL DEFAULT 0.0,
      cash_sales REAL DEFAULT 0.0,
      cash_refunds REAL DEFAULT 0.0,
      cash_drops REAL DEFAULT 0.0,
      cash_additions REAL DEFAULT 0.0,
      expected_cash REAL DEFAULT 0.0,
      actual_cash REAL,
      difference REAL,
      notes TEXT,
      status TEXT DEFAULT 'OPEN', -- OPEN, CLOSED
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (cashier_id) REFERENCES users(id)
    );

    -- 17. Shift Cash Movements
    CREATE TABLE IF NOT EXISTS shift_cash_movements (
      id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL,
      movement_type TEXT NOT NULL, -- DROP, ADDITION
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id) ON DELETE CASCADE
    );

    -- 18. Sales Table
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      customer_id TEXT,
      cashier_id TEXT NOT NULL,
      shift_id TEXT,
      subtotal REAL NOT NULL,
      discount_amount REAL DEFAULT 0.0,
      discount_percent REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      cgst_amount REAL DEFAULT 0.0,
      sgst_amount REAL DEFAULT 0.0,
      igst_amount REAL DEFAULT 0.0,
      round_off REAL DEFAULT 0.0,
      total_amount REAL NOT NULL,
      payment_status TEXT DEFAULT 'PAID', -- PAID, PARTIAL, UNPAID
      status TEXT DEFAULT 'COMPLETED', -- COMPLETED, RETURNED, PARTIALLY_RETURNED, VOIDED
      notes TEXT,
      void_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
      FOREIGN KEY (cashier_id) REFERENCES users(id),
      FOREIGN KEY (shift_id) REFERENCES cashier_shifts(id) ON DELETE SET NULL,
      UNIQUE(store_id, invoice_number)
    );

    -- 19. Sale Line Items
    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      barcode TEXT,
      sku TEXT,
      unit TEXT DEFAULT 'PCS',
      quantity REAL NOT NULL,
      purchase_cost REAL DEFAULT 0.0,
      selling_price REAL NOT NULL,
      mrp REAL NOT NULL,
      discount_amount REAL DEFAULT 0.0,
      tax_rate REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      hsn_code TEXT,
      total_amount REAL NOT NULL,
      returned_quantity REAL DEFAULT 0.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- 20. Payments Table (Supports split payments)
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      sale_id TEXT,
      customer_id TEXT,
      payment_method TEXT NOT NULL, -- CASH, UPI, CARD, BANK_TRANSFER, CREDIT
      amount REAL NOT NULL,
      reference_id TEXT,
      notes TEXT,
      status TEXT DEFAULT 'COMPLETED',
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );

    -- 21. Customer Udhaar Ledger
    CREATE TABLE IF NOT EXISTS customer_ledger (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      entry_type TEXT NOT NULL, -- CREDIT_SALE, PAYMENT_RECEIVED, RETURN_REFUND, ADJUSTMENT
      amount REAL NOT NULL,
      running_balance REAL NOT NULL,
      reference_type TEXT, -- SALE, PAYMENT, RETURN
      reference_id TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    -- 22. Supplier Purchasing
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      invoice_date TEXT DEFAULT CURRENT_TIMESTAMP,
      subtotal REAL NOT NULL,
      tax_amount REAL DEFAULT 0.0,
      total_amount REAL NOT NULL,
      paid_amount REAL DEFAULT 0.0,
      payment_status TEXT DEFAULT 'PAID', -- PAID, PARTIAL, UNPAID
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    -- 23. Purchase Line Items
    CREATE TABLE IF NOT EXISTS purchase_items (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL,
      tax_rate REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      total_cost REAL NOT NULL,
      batch_number TEXT,
      expiry_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- 24. Supplier Ledger
    CREATE TABLE IF NOT EXISTS supplier_ledger (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      entry_type TEXT NOT NULL, -- PURCHASE, PAYMENT_MADE, RETURN, ADJUSTMENT
      amount REAL NOT NULL,
      running_balance REAL NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    -- 25. Returns and Exchanges
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      original_sale_id TEXT NOT NULL,
      return_number TEXT NOT NULL,
      customer_id TEXT,
      refund_amount REAL NOT NULL,
      refund_method TEXT NOT NULL, -- CASH, UPI, CREDIT_NOTE, STORE_CREDIT
      reason TEXT,
      cashier_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (original_sale_id) REFERENCES sales(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
      FOREIGN KEY (cashier_id) REFERENCES users(id)
    );

    -- 26. Return Items
    CREATE TABLE IF NOT EXISTS return_items (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL,
      sale_item_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      refund_unit_price REAL NOT NULL,
      total_refund REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (return_id) REFERENCES returns(id) ON DELETE CASCADE,
      FOREIGN KEY (sale_item_id) REFERENCES sale_items(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- 27. Store Expenses
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      category TEXT NOT NULL, -- RENT, ELECTRICITY, SALARY, TEA_SNACKS, MAINTENANCE, PACKAGING, MISC
      amount REAL NOT NULL,
      expense_date TEXT DEFAULT CURRENT_TIMESTAMP,
      payment_method TEXT DEFAULT 'CASH',
      notes TEXT,
      receipt_path TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- 28. Audit Logs
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      store_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      old_values_json TEXT,
      new_values_json TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Performance Indexes
    CREATE INDEX IF NOT EXISTS idx_products_store_barcode ON products(store_id, barcode);
    CREATE INDEX IF NOT EXISTS idx_products_store_sku ON products(store_id, sku);
    CREATE INDEX IF NOT EXISTS idx_sales_store_invoice ON sales(store_id, invoice_number);
    CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
    CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer ON customer_ledger(customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at);
  `);

  console.log('[KiranaOS DB] Migrations executed successfully.');
}

// Allow direct execution
if (process.argv[1]?.endsWith('migrate.js')) {
  try {
    runMigrations();
    process.exit(0);
  } catch (err) {
    console.error('[KiranaOS DB] Migration failed:', err);
    process.exit(1);
  }
}
