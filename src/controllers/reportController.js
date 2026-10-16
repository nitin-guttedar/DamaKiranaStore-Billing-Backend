import { getDb } from '../db/index.js';
import { LicenseService } from '../services/licenseService.js';

export function getDashboardKpis(req, res) {
  const storeId = req.user.storeId;
  const { period = 'today', startDate, endDate } = req.query;
  const db = getDb();

  // Date range filter
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const yesterdayStr = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
  const sevenDaysStr = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0];
  const thirtyDaysStr = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];

  let dateCondition = "substr(s.created_at, 1, 10) = ?";
  const params = [storeId, todayStr];

  if (period === 'yesterday') {
    dateCondition = "substr(s.created_at, 1, 10) = ?";
    params[1] = yesterdayStr;
  } else if (period === '7days') {
    dateCondition = "substr(s.created_at, 1, 10) >= ?";
    params[1] = sevenDaysStr;
  } else if (period === '30days') {
    dateCondition = "substr(s.created_at, 1, 10) >= ?";
    params[1] = thirtyDaysStr;
  } else if (period === 'custom' && startDate && endDate) {
    dateCondition = "substr(s.created_at, 1, 10) >= ? AND substr(s.created_at, 1, 10) <= ?";
    params[1] = startDate;
    params.push(endDate);
  }

  // 1. Sales & Bills Count
  const salesSummary = db.get(
    `SELECT
       COUNT(s.id) as total_bills,
       COALESCE(SUM(s.total_amount), 0) as total_sales,
       COALESCE(SUM(s.subtotal), 0) as gross_sales,
       COALESCE(SUM(s.discount_amount), 0) as total_discounts,
       COALESCE(SUM(s.tax_amount), 0) as total_tax
     FROM sales s
     WHERE s.store_id = ? AND s.status = 'COMPLETED' AND ${dateCondition}`,
    params
  );

  // 2. Gross Profit Estimate: SUM(si.quantity * (si.selling_price - si.purchase_cost))
  const profitSummary = db.get(
    `SELECT
       COALESCE(SUM(si.quantity * (si.selling_price - si.purchase_cost) - si.discount_amount), 0) as estimated_gross_profit
     FROM sale_items si
     JOIN sales s ON si.sale_id = s.id
     WHERE s.store_id = ? AND s.status = 'COMPLETED' AND ${dateCondition}`,
    params
  );

  // 3. Payment Methods Breakdown
  const paymentRows = db.query(
    `SELECT
       p.payment_method,
       COALESCE(SUM(p.amount), 0) as total_amount,
       COUNT(p.id) as count
     FROM payments p
     JOIN sales s ON p.sale_id = s.id
     WHERE p.store_id = ? AND s.status = 'COMPLETED' AND ${dateCondition}
     GROUP BY p.payment_method`,
    params
  );

  const paymentBreakdown = {
    CASH: 0,
    UPI: 0,
    CARD: 0,
    CREDIT: 0,
    BANK_TRANSFER: 0
  };
  paymentRows.forEach(row => {
    paymentBreakdown[row.payment_method] = row.total_amount;
  });

  // 4. Low-stock Items Count & List
  const lowStockItems = db.query(
    `SELECT id, name, sku, barcode, stock_quantity, reorder_threshold, unit
     FROM products
     WHERE store_id = ? AND is_active = 1 AND stock_quantity <= reorder_threshold
     ORDER BY stock_quantity ASC LIMIT 10`,
    [storeId]
  );
  const lowStockCount = db.get(
    'SELECT COUNT(*) as count FROM products WHERE store_id = ? AND is_active = 1 AND stock_quantity <= reorder_threshold',
    [storeId]
  ).count;

  // 5. Products Nearing Expiry (within next 30 days)
  const expiringItems = db.query(
    `SELECT id, name, sku, barcode, expiry_date, stock_quantity, unit
     FROM products
     WHERE store_id = ? AND is_active = 1 AND expiry_date IS NOT NULL
       AND date(expiry_date) <= date('now', '+30 days')
     ORDER BY expiry_date ASC LIMIT 10`,
    [storeId]
  );

  // 6. Customer Outstanding Balances (Total Udhaar)
  const customerDues = db.get(
    `SELECT
       COUNT(id) as total_credit_customers,
       COALESCE(SUM(outstanding_balance), 0) as total_outstanding_udhaar
     FROM customers
     WHERE store_id = ? AND is_active = 1 AND outstanding_balance > 0`,
    [storeId]
  );

  // 7. Supplier Dues
  const supplierDues = db.get(
    `SELECT
       COUNT(id) as total_suppliers_with_dues,
       COALESCE(SUM(outstanding_balance), 0) as total_supplier_dues
     FROM suppliers
     WHERE store_id = ? AND is_active = 1 AND outstanding_balance > 0`,
    [storeId]
  );

  // 8. Recent Completed Transactions
  const recentTransactions = db.query(
    `SELECT s.id, s.invoice_number, s.total_amount, s.created_at, s.status,
            c.name as customer_name, u.full_name as cashier_name
     FROM sales s
     LEFT JOIN customers c ON s.customer_id = c.id
     LEFT JOIN users u ON s.cashier_id = u.id
     WHERE s.store_id = ?
     ORDER BY s.created_at DESC LIMIT 6`,
    [storeId]
  );

  // 9. Subscription Information
  const subscription = LicenseService.getStoreSubscriptionStatus(storeId);

  res.json({
    success: true,
    filter: { period, startDate, endDate },
    sales: {
      totalBills: salesSummary.total_bills,
      totalSales: salesSummary.total_sales,
      grossSales: salesSummary.gross_sales,
      totalDiscounts: salesSummary.total_discounts,
      totalTax: salesSummary.total_tax,
      estimatedGrossProfit: profitSummary.estimated_gross_profit,
      profitMarginPercent: salesSummary.total_sales > 0
        ? Math.round((profitSummary.estimated_gross_profit / salesSummary.total_sales) * 10000) / 100
        : 0
    },
    payments: paymentBreakdown,
    inventory: {
      lowStockCount,
      lowStockItems,
      expiringItems
    },
    udhaar: {
      customerCount: customerDues.total_credit_customers,
      totalOutstanding: customerDues.total_outstanding_udhaar
    },
    suppliers: {
      supplierCount: supplierDues.total_suppliers_with_dues,
      totalDues: supplierDues.total_supplier_dues
    },
    recentTransactions,
    subscription
  });
}

export function getSalesReport(req, res) {
  const storeId = req.user.storeId;
  const { startDate, endDate, groupBy = 'day' } = req.query;
  const db = getDb();

  let query = `
    SELECT
      date(s.created_at) as sale_date,
      COUNT(s.id) as bill_count,
      COALESCE(SUM(s.subtotal), 0) as subtotal,
      COALESCE(SUM(s.discount_amount), 0) as discounts,
      COALESCE(SUM(s.tax_amount), 0) as taxes,
      COALESCE(SUM(s.total_amount), 0) as net_sales
    FROM sales s
    WHERE s.store_id = ? AND s.status = 'COMPLETED'
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

  query += ' GROUP BY date(s.created_at) ORDER BY sale_date DESC LIMIT 90';

  const rows = db.query(query, params);
  res.json({ success: true, count: rows.length, rows });
}

export function getProductSalesReport(req, res) {
  const storeId = req.user.storeId;
  const { startDate, endDate, limit = 25 } = req.query;
  const db = getDb();

  let query = `
    SELECT
      si.product_id,
      si.product_name,
      si.barcode,
      si.unit,
      COALESCE(SUM(si.quantity), 0) as total_quantity_sold,
      COALESCE(SUM(si.total_amount), 0) as total_revenue,
      COALESCE(SUM(si.quantity * (si.selling_price - si.purchase_cost) - si.discount_amount), 0) as total_profit
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.id
    WHERE s.store_id = ? AND s.status = 'COMPLETED'
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

  query += ` GROUP BY si.product_id ORDER BY total_revenue DESC LIMIT ?`;
  params.push(parseInt(limit, 10));

  const items = db.query(query, params);
  res.json({ success: true, count: items.length, items });
}

export function getGstReport(req, res) {
  const storeId = req.user.storeId;
  const { startDate, endDate } = req.query;
  const db = getDb();

  let query = `
    SELECT
      si.tax_rate,
      COALESCE(SUM(si.quantity * si.selling_price - si.discount_amount), 0) as taxable_value,
      COALESCE(SUM(si.tax_amount), 0) as total_tax,
      COALESCE(SUM(si.tax_amount / 2), 0) as cgst,
      COALESCE(SUM(si.tax_amount / 2), 0) as sgst
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.id
    WHERE s.store_id = ? AND s.status = 'COMPLETED'
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

  query += ' GROUP BY si.tax_rate ORDER BY si.tax_rate ASC';

  const taxSlabs = db.query(query, params);
  const store = db.get('SELECT name, gstin FROM stores WHERE id = ?', [storeId]);

  res.json({ success: true, store, taxSlabs });
}
