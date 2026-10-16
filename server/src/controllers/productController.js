import crypto from 'crypto';
import { getDb } from '../db/index.js';

export function getProducts(req, res) {
  const storeId = req.user.storeId;
  const { q, categoryId, lowStock, activeOnly = '1', page = 1, limit = 100 } = req.query;
  const db = getDb();

  let query = `
    SELECT p.*, c.name as category_name, s.name as supplier_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN suppliers s ON p.supplier_id = s.id
    WHERE p.store_id = ?
  `;
  const params = [storeId];

  if (activeOnly === '1') {
    query += ' AND p.is_active = 1';
  }

  if (categoryId) {
    query += ' AND p.category_id = ?';
    params.push(categoryId);
  }

  if (lowStock === '1') {
    query += ' AND p.stock_quantity <= p.reorder_threshold';
  }

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query += ' AND (p.name LIKE ? OR p.barcode LIKE ? OR p.sku LIKE ? OR p.brand LIKE ?)';
    params.push(term, term, term, term);
  }

  query += ' ORDER BY p.name ASC';

  const products = db.query(query, params);
  res.json({ success: true, count: products.length, products });
}

export function getProductByBarcode(req, res) {
  const storeId = req.user.storeId;
  const { barcode } = req.params;
  const db = getDb();

  const product = db.get(
    `SELECT p.*, c.name as category_name
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     WHERE p.store_id = ? AND (p.barcode = ? OR p.sku = ?) AND p.is_active = 1`,
    [storeId, barcode, barcode]
  );

  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found for scanned barcode' });
  }

  res.json({ success: true, product });
}

export function createProduct(req, res) {
  const storeId = req.user.storeId;
  const {
    name,
    sku,
    barcode,
    categoryId,
    supplierId,
    brand,
    unit = 'PCS',
    purchaseCost = 0,
    sellingPrice,
    mrp,
    stockQuantity = 0,
    reorderThreshold = 10,
    hsnCode = '2106',
    taxRate = 5,
    isLooseWeight = 0,
    expiryDate = null
  } = req.body;

  if (!name || sellingPrice === undefined || mrp === undefined) {
    return res.status(400).json({ success: false, error: 'Name, selling price, and MRP are required' });
  }

  const db = getDb();

  // Validate duplicate barcode in store
  if (barcode && barcode.trim()) {
    const duplicate = db.get(
      'SELECT id, name FROM products WHERE store_id = ? AND barcode = ?',
      [storeId, barcode.trim()]
    );
    if (duplicate) {
      return res.status(400).json({
        success: false,
        error: `Barcode '${barcode}' is already assigned to '${duplicate.name}'`
      });
    }
  }

  const productId = `prd_${crypto.randomUUID()}`;
  const parsedCost = parseFloat(purchaseCost) || 0;
  const parsedPrice = parseFloat(sellingPrice);
  const parsedMrp = parseFloat(mrp);
  const parsedStock = parseFloat(stockQuantity) || 0;

  db.transaction((tx) => {
    tx.run(
      `INSERT INTO products (
        id, store_id, category_id, supplier_id, name, sku, barcode, brand, unit,
        purchase_cost, selling_price, mrp, stock_quantity, reorder_threshold,
        hsn_code, tax_rate, is_loose_weight, expiry_date, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        productId,
        storeId,
        categoryId || null,
        supplierId || null,
        name.trim(),
        sku ? sku.trim() : null,
        barcode ? barcode.trim() : null,
        brand ? brand.trim() : null,
        unit,
        parsedCost,
        parsedPrice,
        parsedMrp,
        parsedStock,
        parseFloat(reorderThreshold) || 10,
        hsnCode,
        parseFloat(taxRate) || 0,
        isLooseWeight ? 1 : 0,
        expiryDate || null
      ]
    );

    // If opening stock > 0, log movement
    if (parsedStock > 0) {
      tx.run(
        `INSERT INTO stock_movements (
          id, store_id, product_id, movement_type, quantity, unit_cost, reference_type, reason, created_by
        ) VALUES (?, ?, ?, 'OPENING', ?, ?, 'INITIAL_ENTRY', 'Initial opening stock entry', ?)`,
        [`mov_${crypto.randomUUID()}`, storeId, productId, parsedStock, parsedCost, req.user.userId]
      );
    }
  });

  const created = db.get('SELECT * FROM products WHERE id = ?', [productId]);
  res.status(201).json({ success: true, product: created });
}

export function updateProduct(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const db = getDb();

  const product = db.get('SELECT * FROM products WHERE id = ? AND store_id = ?', [id, storeId]);
  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }

  const {
    name,
    sku,
    barcode,
    categoryId,
    supplierId,
    brand,
    unit,
    purchaseCost,
    sellingPrice,
    mrp,
    reorderThreshold,
    hsnCode,
    taxRate,
    isLooseWeight,
    isActive,
    expiryDate
  } = req.body;

  // Validate duplicate barcode if changed
  if (barcode && barcode.trim() !== product.barcode) {
    const duplicate = db.get(
      'SELECT id, name FROM products WHERE store_id = ? AND barcode = ? AND id != ?',
      [storeId, barcode.trim(), id]
    );
    if (duplicate) {
      return res.status(400).json({
        success: false,
        error: `Barcode '${barcode}' is already in use by '${duplicate.name}'`
      });
    }
  }

  db.run(
    `UPDATE products SET
      name = COALESCE(?, name),
      sku = COALESCE(?, sku),
      barcode = COALESCE(?, barcode),
      category_id = COALESCE(?, category_id),
      supplier_id = COALESCE(?, supplier_id),
      brand = COALESCE(?, brand),
      unit = COALESCE(?, unit),
      purchase_cost = COALESCE(?, purchase_cost),
      selling_price = COALESCE(?, selling_price),
      mrp = COALESCE(?, mrp),
      reorder_threshold = COALESCE(?, reorder_threshold),
      hsn_code = COALESCE(?, hsn_code),
      tax_rate = COALESCE(?, tax_rate),
      is_loose_weight = COALESCE(?, is_loose_weight),
      is_active = COALESCE(?, is_active),
      expiry_date = COALESCE(?, expiry_date),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND store_id = ?`,
    [
      name !== undefined ? name.trim() : null,
      sku !== undefined ? (sku ? sku.trim() : null) : null,
      barcode !== undefined ? (barcode ? barcode.trim() : null) : null,
      categoryId !== undefined ? (categoryId || null) : null,
      supplierId !== undefined ? (supplierId || null) : null,
      brand !== undefined ? (brand ? brand.trim() : null) : null,
      unit !== undefined ? unit : null,
      purchaseCost !== undefined ? parseFloat(purchaseCost) : null,
      sellingPrice !== undefined ? parseFloat(sellingPrice) : null,
      mrp !== undefined ? parseFloat(mrp) : null,
      reorderThreshold !== undefined ? parseFloat(reorderThreshold) : null,
      hsnCode !== undefined ? hsnCode : null,
      taxRate !== undefined ? parseFloat(taxRate) : null,
      isLooseWeight !== undefined ? (isLooseWeight ? 1 : 0) : null,
      isActive !== undefined ? (isActive ? 1 : 0) : null,
      expiryDate !== undefined ? (expiryDate || null) : null,
      id,
      storeId
    ]
  );

  const updated = db.get('SELECT * FROM products WHERE id = ?', [id]);
  res.json({ success: true, product: updated });
}

export function adjustStock(req, res) {
  const storeId = req.user.storeId;
  const { productId, adjustmentQuantity, reason } = req.body;

  if (!productId || adjustmentQuantity === undefined || !reason || !reason.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Product ID, adjustment quantity, and mandatory reason are required'
    });
  }

  const db = getDb();
  const product = db.get('SELECT * FROM products WHERE id = ? AND store_id = ?', [productId, storeId]);
  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }

  const qty = parseFloat(adjustmentQuantity);
  if (isNaN(qty) || qty === 0) {
    return res.status(400).json({ success: false, error: 'Adjustment quantity cannot be zero' });
  }

  db.transaction((tx) => {
    tx.run(
      'UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [qty, productId]
    );

    tx.run(
      `INSERT INTO stock_movements (
        id, store_id, product_id, movement_type, quantity, unit_cost, reference_type, reason, created_by
      ) VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, 'MANUAL_ADJUSTMENT', ?, ?)`,
      [
        `mov_${crypto.randomUUID()}`,
        storeId,
        productId,
        qty,
        product.purchase_cost || 0,
        reason.trim(),
        req.user.userId
      ]
    );
  });

  const updated = db.get('SELECT * FROM products WHERE id = ?', [productId]);
  res.json({
    success: true,
    message: `Stock adjusted by ${qty > 0 ? '+' : ''}${qty} ${product.unit}`,
    stockQuantity: updated.stock_quantity
  });
}

export function exportCsv(req, res) {
  const storeId = req.user.storeId;
  const db = getDb();
  const products = db.query(
    `SELECT p.name, p.barcode, p.sku, p.brand, p.unit, p.purchase_cost, p.selling_price, p.mrp,
            p.stock_quantity, p.reorder_threshold, p.hsn_code, p.tax_rate, p.is_loose_weight,
            c.name as category
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     WHERE p.store_id = ?
     ORDER BY p.name ASC`,
    [storeId]
  );

  const header = 'Name,Barcode,SKU,Brand,Category,Unit,CostPrice,SellingPrice,MRP,Stock,ReorderThreshold,HSN,TaxRate,IsLooseWeight\n';
  const rows = products.map(p => [
    `"${(p.name || '').replace(/"/g, '""')}"`,
    `"${p.barcode || ''}"`,
    `"${p.sku || ''}"`,
    `"${p.brand || ''}"`,
    `"${p.category || ''}"`,
    p.unit || 'PCS',
    p.purchase_cost || 0,
    p.selling_price || 0,
    p.mrp || 0,
    p.stock_quantity || 0,
    p.reorder_threshold || 10,
    p.hsn_code || '',
    p.tax_rate || 0,
    p.is_loose_weight ? 1 : 0
  ].join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=kirana_products_${Date.now()}.csv`);
  res.send(header + rows);
}

export function getCategories(req, res) {
  const storeId = req.user.storeId;
  const db = getDb();
  const categories = db.query(
    'SELECT * FROM categories WHERE store_id = ? AND is_active = 1 ORDER BY name ASC',
    [storeId]
  );
  res.json({ success: true, categories });
}

export function createCategory(req, res) {
  const storeId = req.user.storeId;
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Category name is required' });
  }

  const db = getDb();
  const id = `cat_${crypto.randomUUID()}`;
  try {
    db.run(
      'INSERT INTO categories (id, store_id, name, description, is_active) VALUES (?, ?, ?, ?, 1)',
      [id, storeId, name.trim(), description || '']
    );
    const created = db.get('SELECT * FROM categories WHERE id = ?', [id]);
    res.status(201).json({ success: true, category: created });
  } catch (err) {
    res.status(400).json({ success: false, error: 'Category with this name already exists' });
  }
}
