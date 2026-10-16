import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_JSON_DIR = path.resolve(__dirname, '../../data/local_json');

/**
 * Persists KiranaOS non-credential data (products, customers, udhaar, inventory)
 * as clean, indented JSON files on the local filesystem.
 */
export function syncLocalDiskJson(storeId = null) {
  try {
    if (!fs.existsSync(LOCAL_JSON_DIR)) {
      fs.mkdirSync(LOCAL_JSON_DIR, { recursive: true });
    }

    const db = getDb();
    if (!db || !db.query) return;

    let productsQuery = 'SELECT * FROM products WHERE is_active = 1';
    let customersQuery = 'SELECT * FROM customers WHERE is_active = 1';
    let params = [];

    if (storeId) {
      productsQuery += ' AND store_id = ?';
      customersQuery += ' AND store_id = ?';
      params = [storeId];
    }

    const products = db.query(productsQuery, params);
    const customers = db.query(customersQuery, params);

    // 1. Write products.json
    fs.writeFileSync(
      path.join(LOCAL_JSON_DIR, 'products.json'),
      JSON.stringify(products, null, 2),
      'utf-8'
    );

    // 2. Write customers_udhaar.json
    fs.writeFileSync(
      path.join(LOCAL_JSON_DIR, 'customers_udhaar.json'),
      JSON.stringify(customers, null, 2),
      'utf-8'
    );

    // 3. Write complete store snapshot
    const snapshot = {
      system: 'KiranaOS Local Disk JSON Database',
      exportedAt: new Date().toISOString(),
      summary: {
        totalProducts: products.length,
        totalCustomers: customers.length,
        totalOutstandingUdhaar: customers.reduce((s, c) => s + (c.outstanding_balance || 0), 0)
      },
      products,
      customers
    };

    fs.writeFileSync(
      path.join(LOCAL_JSON_DIR, 'kirana_store_data.json'),
      JSON.stringify(snapshot, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.warn('[KiranaOS Local Disk JSON Backup] Failed:', err.message);
  }
}
