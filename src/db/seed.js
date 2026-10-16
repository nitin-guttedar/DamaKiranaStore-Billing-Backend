import crypto from 'crypto';
import { getDb } from './index.js';
import { runMigrations } from './migrate.js';
import { AuthService } from '../services/authService.js';
import { LicenseService } from '../services/licenseService.js';
import { seedMongoCredentials } from './mongo.js';

export async function ensureDefaultMongoCredentials() {
  try {
    const adminPass = await AuthService.hashPassword('SuperAdmin@Kirana2026');
    const ownerPass = await AuthService.hashPassword('KiranaOwner@123');
    const cashierPass = await AuthService.hashPassword('Cashier@123');

    await seedMongoCredentials([
      {
        id: 'usr_sa_primary',
        store_id: null,
        email: 'admin@kiranaos.internal',
        password_hash: adminPass,
        full_name: 'KiranaOS Super Admin',
        phone: '9999999999',
        role: 'SUPER_ADMIN',
        must_change_password: 0
      },
      {
        id: 'usr_owner_ramesh',
        store_id: 'store_ganesh_kirana',
        email: 'owner@ganeshkirana.com',
        password_hash: ownerPass,
        full_name: 'Ramesh Patel (Owner)',
        phone: '9845012345',
        role: 'STORE_OWNER',
        must_change_password: 0
      },
      {
        id: 'usr_cashier_suresh',
        store_id: 'store_ganesh_kirana',
        email: 'cashier@ganeshkirana.com',
        password_hash: cashierPass,
        full_name: 'Suresh Kumar (Cashier)',
        phone: '9845098765',
        role: 'CASHIER',
        must_change_password: 0
      }
    ]);
  } catch (err) {
    console.warn('[KiranaOS DB] Could not sync default credentials to MongoDB:', err.message);
  }
}

export async function seedDatabase() {
  runMigrations();
  const db = getDb();
  console.log('[KiranaOS DB] Seeding realistic Indian Kirana demo dataset...');
  await ensureDefaultMongoCredentials();

  // 1. Subscription Plans
  const plans = [
    { id: 'plan_monthly', name: 'Kirana Starter Monthly', code: 'MONTHLY', duration: 30, price: 499, users: 2, products: 2000 },
    { id: 'plan_quarterly', name: 'Kirana Growth Quarterly', code: 'QUARTERLY', duration: 90, price: 1399, users: 3, products: 5000 },
    { id: 'plan_halfyearly', name: 'Kirana Business 6-Months', code: 'HALF_YEARLY', duration: 180, price: 2499, users: 5, products: 10000 },
    { id: 'plan_annual', name: 'Kirana Enterprise Annual', code: 'ANNUAL', duration: 365, price: 4499, users: 10, products: 25000 },
    { id: 'plan_trial', name: '14-Day Free Kirana Trial', code: 'TRIAL', duration: 14, price: 0, users: 2, products: 1000 }
  ];

  for (const p of plans) {
    const existing = db.get('SELECT id FROM subscription_plans WHERE id = ?', [p.id]);
    if (!existing) {
      db.run(
        `INSERT INTO subscription_plans (id, name, code, duration_days, price_inr, max_users, max_products, features_json, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1)`,
        [p.id, p.name, p.code, p.duration, p.price, p.users, p.products]
      );
    }
  }

  // 2. Super Administrator
  const adminEmail = 'admin@kiranaos.internal';
  let admin = db.get('SELECT * FROM users WHERE email = ?', [adminEmail]);
  if (!admin) {
    const adminPass = await AuthService.hashPassword('SuperAdmin@Kirana2026');
    const adminId = 'usr_sa_primary';
    db.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active)
       VALUES (?, NULL, ?, ?, 'KiranaOS Super Admin', '9999999999', 'SUPER_ADMIN', 1)`,
      [adminId, adminEmail, adminPass]
    );
    admin = { id: adminId };
    console.log('[+] Created Super-Admin: admin@kiranaos.internal');
  }

  // 3. Demo Store: Shree Ganesh Kirana & General Store
  const storeId = 'store_ganesh_kirana';
  let store = db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
  if (!store) {
    db.run(
      `INSERT INTO stores (
        id, name, slug, phone, email, address, city, state, pincode, gstin, status, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)`,
      [
        storeId,
        'Shree Ganesh Kirana & General Store',
        'ganesh-kirana-bengaluru',
        '+91 98450 12345',
        'owner@ganeshkirana.com',
        'Shop #4, Market Yard, Gandhi Nagar',
        'Bengaluru',
        'Karnataka',
        '560002',
        '29AAAAA0000A1Z5'
      ]
    );

    // Store settings
    db.run(
      `INSERT INTO store_settings (
        id, store_id, invoice_prefix, next_invoice_number, receipt_printer_type,
        enable_gst, default_tax_rate, upi_id, upi_name, currency_symbol, terms_and_conditions
      ) VALUES (?, ?, 'SGK', 101, '58mm', 1, 5.0, 'ganeshkirana@upi', 'Shree Ganesh Kirana', '₹', 'Thank you! Visit again. Exchange within 3 days with bill.')`,
      [`set_${storeId}`, storeId]
    );

    // 4. Annual Subscription & License Token
    const subId = `sub_${crypto.randomUUID()}`;
    const startsAt = new Date().toISOString();
    const expiresAt = LicenseService.calculateExpiryDate(startsAt, 365);

    db.run(
      `INSERT INTO subscriptions (id, store_id, plan_id, status, starts_at, expires_at, created_by_admin_id)
       VALUES (?, ?, 'plan_annual', 'ACTIVE', ?, ?, ?)`,
      [subId, storeId, startsAt, expiresAt, admin.id]
    );

    LicenseService.issueLicense({
      storeId,
      subscriptionId: subId,
      planCode: 'ANNUAL',
      planName: 'Kirana Enterprise Annual',
      durationDays: 365,
      maxUsers: 10,
      maxProducts: 25000,
      createdByAdminId: admin.id
    });
    console.log('[+] Created Store: Shree Ganesh Kirana with Annual License');
  }

  // 5. Store Users: Owner and Cashier
  const ownerEmail = 'owner@ganeshkirana.com';
  if (!db.get('SELECT id FROM users WHERE email = ?', [ownerEmail])) {
    const ownerPass = await AuthService.hashPassword('KiranaOwner@123');
    db.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active)
       VALUES (?, ?, ?, ?, 'Ramesh Patel (Owner)', '9845012345', 'STORE_OWNER', 1)`,
      ['usr_owner_ramesh', storeId, ownerEmail, ownerPass]
    );
    console.log('[+] Created Store Owner: owner@ganeshkirana.com');
  }

  const cashierEmail = 'cashier@ganeshkirana.com';
  if (!db.get('SELECT id FROM users WHERE email = ?', [cashierEmail])) {
    const cashierPass = await AuthService.hashPassword('Cashier@123');
    db.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active)
       VALUES (?, ?, ?, ?, 'Suresh Kumar (Cashier)', '9845098765', 'CASHIER', 1)`,
      ['usr_cashier_suresh', storeId, cashierEmail, cashierPass]
    );
    console.log('[+] Created Cashier: cashier@ganeshkirana.com');
  }

  // 6. Categories
  const categoryData = [
    { id: 'cat_grains', name: 'Grains, Flours & Pulses', desc: 'Rice, Atta, Dals, Besan' },
    { id: 'cat_spices', name: 'Spices & Seasonings', desc: 'Salt, Haldi, Mirch, Garam Masala' },
    { id: 'cat_oils', name: 'Edible Oils & Ghee', desc: 'Mustard oil, Sunflower oil, Desi ghee' },
    { id: 'cat_dairy', name: 'Dairy & Packaged Bakery', desc: 'Butter, Milk, Bread, Curd' },
    { id: 'cat_snacks', name: 'Snacks, Biscuits & Beverages', desc: 'Tea, Parle-G, Maggi, Namkeen' },
    { id: 'cat_clean', name: 'Household & Cleaning', desc: 'Detergents, Soaps, Dishwash' }
  ];

  for (const c of categoryData) {
    if (!db.get('SELECT id FROM categories WHERE id = ?', [c.id])) {
      db.run(
        `INSERT INTO categories (id, store_id, name, description, is_active) VALUES (?, ?, ?, ?, 1)`,
        [c.id, storeId, c.name, c.desc]
      );
    }
  }

  // 7. Suppliers
  const suppliers = [
    { id: 'sup_balaji', name: 'Balaji Wholesalers & Distributors', contact: 'Manoj Shah', phone: '9448811223', balance: 12500, gstin: '29BBBBB1111B1Z2' },
    { id: 'sup_dairy', name: 'Karnataka Milk Fed (Nandini Agency)', contact: 'Raghavan', phone: '9448855667', balance: 3200, gstin: '29CCCCC2222C1Z3' }
  ];

  for (const s of suppliers) {
    if (!db.get('SELECT id FROM suppliers WHERE id = ?', [s.id])) {
      db.run(
        `INSERT INTO suppliers (id, store_id, name, contact_person, phone, outstanding_balance, gstin, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [s.id, storeId, s.name, s.contact, s.phone, s.balance, s.gstin]
      );
    }
  }

  // 8. Products (Indian Retail Kirana Catalog)
  const products = [
    {
      id: 'prd_parleg',
      cat: 'cat_snacks',
      name: 'Parle-G Gluco Biscuits 100g',
      sku: 'SKU-PARLE-100',
      barcode: '8901063001015',
      brand: 'Parle',
      unit: 'PCS',
      cost: 8.5,
      price: 10.0,
      mrp: 10.0,
      stock: 120,
      minStock: 25,
      hsn: '1905',
      tax: 5.0,
      loose: 0
    },
    {
      id: 'prd_atta',
      cat: 'cat_grains',
      name: 'Aashirvaad Shudh Chakki Atta 5kg',
      sku: 'SKU-AASHIR-5KG',
      barcode: '8901725131012',
      brand: 'Aashirvaad',
      unit: 'PACKET',
      cost: 235.0,
      price: 260.0,
      mrp: 275.0,
      stock: 40,
      minStock: 10,
      hsn: '1101',
      tax: 0.0,
      loose: 0
    },
    {
      id: 'prd_salt',
      cat: 'cat_spices',
      name: 'Tata Salt Vacuum Evaporated 1kg',
      sku: 'SKU-TATA-SALT',
      barcode: '8904004400010',
      brand: 'Tata',
      unit: 'PACKET',
      cost: 23.0,
      price: 27.0,
      mrp: 28.0,
      stock: 85,
      minStock: 20,
      hsn: '2501',
      tax: 0.0,
      loose: 0
    },
    {
      id: 'prd_maggi',
      cat: 'cat_snacks',
      name: 'Maggi 2-Minute Masala Noodles 70g',
      sku: 'SKU-MAGGI-70G',
      barcode: '8901058852332',
      brand: 'Nestle',
      unit: 'PCS',
      cost: 12.0,
      price: 14.0,
      mrp: 14.0,
      stock: 150,
      minStock: 30,
      hsn: '1902',
      tax: 12.0,
      loose: 0
    },
    {
      id: 'prd_oil',
      cat: 'cat_oils',
      name: 'Fortune Sunlite Refined Sunflower Oil 1L Pouch',
      sku: 'SKU-FORTUNE-1L',
      barcode: '8906007281014',
      brand: 'Fortune',
      unit: 'L',
      cost: 136.0,
      price: 148.0,
      mrp: 155.0,
      stock: 35,
      minStock: 8,
      hsn: '1512',
      tax: 5.0,
      loose: 0
    },
    {
      id: 'prd_butter',
      cat: 'cat_dairy',
      name: 'Amul Pasteurised Butter 100g',
      sku: 'SKU-AMUL-100G',
      barcode: '8901262010049',
      brand: 'Amul',
      unit: 'PCS',
      cost: 51.0,
      price: 56.0,
      mrp: 58.0,
      stock: 22,
      minStock: 5,
      hsn: '0405',
      tax: 12.0,
      loose: 0
    },
    {
      id: 'prd_surf',
      cat: 'cat_clean',
      name: 'Surf Excel Easy Wash Detergent Powder 1kg',
      sku: 'SKU-SURF-1KG',
      barcode: '8901030010014',
      brand: 'Hindustan Unilever',
      unit: 'PACKET',
      cost: 118.0,
      price: 132.0,
      mrp: 140.0,
      stock: 18,
      minStock: 6,
      hsn: '3402',
      tax: 18.0,
      loose: 0
    },
    {
      id: 'prd_loose_rice',
      cat: 'cat_grains',
      name: 'Loose Sona Masoori Rice (Premium Old Crop)',
      sku: 'SKU-LOOSE-RICE',
      barcode: '2000001',
      brand: 'Local Mill',
      unit: 'KG',
      cost: 52.0,
      price: 62.0,
      mrp: 65.0,
      stock: 240.5,
      minStock: 50,
      hsn: '1006',
      tax: 0.0,
      loose: 1
    },
    {
      id: 'prd_loose_dal',
      cat: 'cat_grains',
      name: 'Loose Toor Dal (Desi Unpolished)',
      sku: 'SKU-LOOSE-TOOR',
      barcode: '2000002',
      brand: 'Local Mandi',
      unit: 'KG',
      cost: 145.0,
      price: 165.0,
      mrp: 175.0,
      stock: 85.0,
      minStock: 20,
      hsn: '0713',
      tax: 0.0,
      loose: 1
    },
    {
      id: 'prd_loose_sugar',
      cat: 'cat_grains',
      name: 'Loose Refined White Sugar (Cheeni)',
      sku: 'SKU-LOOSE-SUGAR',
      barcode: '2000003',
      brand: 'Co-op Sugar',
      unit: 'KG',
      cost: 39.0,
      price: 44.0,
      mrp: 46.0,
      stock: 190.0,
      minStock: 40,
      hsn: '1701',
      tax: 5.0,
      loose: 1
    },
    {
      id: 'prd_redlabel',
      cat: 'cat_snacks',
      name: 'Brooke Bond Red Label Natural Care Tea 250g',
      sku: 'SKU-RED-250G',
      barcode: '8901030385921',
      brand: 'Brooke Bond',
      unit: 'PACKET',
      cost: 125.0,
      price: 139.0,
      mrp: 145.0,
      stock: 4, // Intentionally low stock to showcase alert!
      minStock: 10,
      hsn: '0902',
      tax: 5.0,
      loose: 0
    }
  ];

  for (const p of products) {
    if (!db.get('SELECT id FROM products WHERE id = ?', [p.id])) {
      db.run(
        `INSERT INTO products (
          id, store_id, category_id, supplier_id, name, sku, barcode, brand, unit,
          purchase_cost, selling_price, mrp, stock_quantity, reorder_threshold,
          hsn_code, tax_rate, is_loose_weight, is_active
        ) VALUES (?, ?, ?, 'sup_balaji', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          p.id,
          storeId,
          p.cat,
          p.name,
          p.sku,
          p.barcode,
          p.brand,
          p.unit,
          p.cost,
          p.price,
          p.mrp,
          p.stock,
          p.minStock,
          p.hsn,
          p.tax,
          p.loose
        ]
      );

      // Record opening stock movement
      db.run(
        `INSERT INTO stock_movements (
          id, store_id, product_id, movement_type, quantity, unit_cost, reference_type, reason, created_by
        ) VALUES (?, ?, ?, 'OPENING', ?, ?, 'INITIAL_SEED', 'Store opening inventory initialization', 'SYSTEM')`,
        [`mov_${crypto.randomUUID()}`, storeId, p.id, p.stock, p.cost]
      );
    }
  }

  // 9. Customers with Udhaar (Credit) Accounts
  const customers = [
    { id: 'cust_rahul', name: 'Rahul Sharma', phone: '9876543210', creditLimit: 5000, balance: 650, address: 'Flat 201, Green Heights' },
    { id: 'cust_ananya', name: 'Ananya Rao', phone: '9812345678', creditLimit: 3000, balance: 0, address: '#12 5th Cross, Gandhi Nagar' },
    { id: 'cust_mahendra', name: 'Mahendra Verma', phone: '9944332211', creditLimit: 4000, balance: 1240, address: '#7 Market Road' }
  ];

  for (const c of customers) {
    if (!db.get('SELECT id FROM customers WHERE id = ?', [c.id])) {
      db.run(
        `INSERT INTO customers (id, store_id, name, phone, credit_limit, outstanding_balance, address, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [c.id, storeId, c.name, c.phone, c.creditLimit, c.balance, c.address]
      );

      // Add historical ledger record if balance > 0
      if (c.balance > 0) {
        db.run(
          `INSERT INTO customer_ledger (id, store_id, customer_id, entry_type, amount, running_balance, reference_type, notes, created_by)
           VALUES (?, ?, ?, 'CREDIT_SALE', ?, ?, 'PREVIOUS_BALANCE', 'Carried forward kirana udhaar', 'usr_owner_ramesh')`,
          [`led_${crypto.randomUUID()}`, storeId, c.id, c.balance, c.balance]
        );
      }
    }
  }

  // 10. Sample Completed Sales Transactions for Instant Dashboard Reporting
  const salesCount = db.get('SELECT COUNT(*) as count FROM sales WHERE store_id = ?', [storeId]).count;
  if (salesCount === 0) {
    const sale1Id = `sale_${crypto.randomUUID()}`;
    const sale2Id = `sale_${crypto.randomUUID()}`;

    // Sale 1: Cash sale
    db.run(
      `INSERT INTO sales (
        id, store_id, invoice_number, customer_id, cashier_id, subtotal, discount_amount,
        tax_amount, cgst_amount, sgst_amount, total_amount, payment_status, status
      ) VALUES (?, ?, 'SGK-100', 'cust_ananya', 'usr_cashier_suresh', 288.0, 10.0, 7.0, 3.5, 3.5, 285.0, 'PAID', 'COMPLETED')`,
      [sale1Id, storeId]
    );

    db.run(
      `INSERT INTO sale_items (id, sale_id, product_id, product_name, barcode, unit, quantity, purchase_cost, selling_price, mrp, total_amount)
       VALUES (?, ?, 'prd_atta', 'Aashirvaad Shudh Chakki Atta 5kg', '8901725131012', 'PACKET', 1, 235.0, 260.0, 275.0, 260.0)`,
      [`si_${crypto.randomUUID()}`, sale1Id]
    );

    db.run(
      `INSERT INTO sale_items (id, sale_id, product_id, product_name, barcode, unit, quantity, purchase_cost, selling_price, mrp, total_amount)
       VALUES (?, ?, 'prd_salt', 'Tata Salt Vacuum Evaporated 1kg', '8904004400010', 'PACKET', 1, 23.0, 27.0, 28.0, 27.0)`,
      [`si_${crypto.randomUUID()}`, sale1Id]
    );

    db.run(
      `INSERT INTO payments (id, store_id, sale_id, customer_id, payment_method, amount, status, created_by)
       VALUES (?, ?, ?, 'cust_ananya', 'CASH', 285.0, 'COMPLETED', 'usr_cashier_suresh')`,
      [`pay_${crypto.randomUUID()}`, storeId, sale1Id]
    );

    // Sale 2: UPI sale
    db.run(
      `INSERT INTO sales (
        id, store_id, invoice_number, cashier_id, subtotal, discount_amount,
        tax_amount, total_amount, payment_status, status
      ) VALUES (?, ?, 'SGK-101', 'usr_cashier_suresh', 204.0, 0.0, 10.2, 204.0, 'PAID', 'COMPLETED')`,
      [sale2Id, storeId]
    );

    db.run(
      `INSERT INTO sale_items (id, sale_id, product_id, product_name, barcode, unit, quantity, purchase_cost, selling_price, mrp, total_amount)
       VALUES (?, ?, 'prd_oil', 'Fortune Sunlite Refined Sunflower Oil 1L Pouch', '8906007281014', 'L', 1, 136.0, 148.0, 155.0, 148.0)`,
      [`si_${crypto.randomUUID()}`, sale2Id]
    );

    db.run(
      `INSERT INTO sale_items (id, sale_id, product_id, product_name, barcode, unit, quantity, purchase_cost, selling_price, mrp, total_amount)
       VALUES (?, ?, 'prd_butter', 'Amul Pasteurised Butter 100g', '8901262010049', 'PCS', 1, 51.0, 56.0, 58.0, 56.0)`,
      [`si_${crypto.randomUUID()}`, sale2Id]
    );

    db.run(
      `INSERT INTO payments (id, store_id, sale_id, payment_method, amount, reference_id, status, created_by)
       VALUES (?, ?, ?, 'UPI', 204.0, 'UPI/2026/8947291', 'COMPLETED', 'usr_cashier_suresh')`,
      [`pay_${crypto.randomUUID()}`, storeId, sale2Id]
    );
  }

  // 11. Store Expenses Sample
  const expenseCount = db.get('SELECT COUNT(*) as count FROM expenses WHERE store_id = ?', [storeId]).count;
  if (expenseCount === 0) {
    db.run(
      `INSERT INTO expenses (id, store_id, category, amount, payment_method, notes, created_by)
       VALUES (?, ?, 'TEA_SNACKS', 150.0, 'CASH', 'Daily morning tea and snacks for store staff', 'usr_owner_ramesh')`,
      [`exp_${crypto.randomUUID()}`, storeId]
    );
    db.run(
      `INSERT INTO expenses (id, store_id, category, amount, payment_method, notes, created_by)
       VALUES (?, ?, 'PACKAGING', 450.0, 'UPI', 'Purchased biodegradable carry bags 500 pcs', 'usr_owner_ramesh')`,
      [`exp_${crypto.randomUUID()}`, storeId]
    );
  }

  console.log('[KiranaOS DB] Seed completed successfully!');
  console.log('===============================================================');
  console.log(' DEMO CREDENTIALS:');
  console.log(' Super-Admin: admin@kiranaos.internal  / SuperAdmin@Kirana2026');
  console.log(' Store Owner: owner@ganeshkirana.com   / KiranaOwner@123');
  console.log(' Cashier:     cashier@ganeshkirana.com / Cashier@123');
  console.log('===============================================================');
}

// Allow direct execution
if (process.argv[1]?.endsWith('seed.js')) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[KiranaOS DB] Seed failed:', err);
      process.exit(1);
    });
}
