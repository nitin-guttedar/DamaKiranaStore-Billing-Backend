import crypto from 'crypto';
import { getDb } from '../db/index.js';

export function getExpenses(req, res) {
  const storeId = req.user.storeId;
  const { startDate, endDate, category } = req.query;
  const db = getDb();

  let query = `
    SELECT e.*, u.full_name as created_by_name
    FROM expenses e
    LEFT JOIN users u ON e.created_by = u.id
    WHERE e.store_id = ?
  `;
  const params = [storeId];

  if (startDate) {
    query += ' AND date(e.expense_date) >= date(?)';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND date(e.expense_date) <= date(?)';
    params.push(endDate);
  }

  if (category) {
    query += ' AND e.category = ?';
    params.push(category);
  }

  query += ' ORDER BY e.expense_date DESC LIMIT 100';

  const expenses = db.query(query, params);
  const totalAmount = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

  res.json({ success: true, count: expenses.length, totalAmount, expenses });
}

export function createExpense(req, res) {
  const storeId = req.user.storeId;
  const { category, amount, expenseDate, paymentMethod = 'CASH', notes } = req.body;

  const parsedAmt = parseFloat(amount);
  if (!category || isNaN(parsedAmt) || parsedAmt <= 0) {
    return res.status(400).json({ success: false, error: 'Category and valid expense amount are required' });
  }

  const db = getDb();
  const id = `exp_${crypto.randomUUID()}`;

  db.run(
    `INSERT INTO expenses (id, store_id, category, amount, expense_date, payment_method, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      storeId,
      category,
      parsedAmt,
      expenseDate || new Date().toISOString(),
      paymentMethod,
      notes || '',
      req.user.userId
    ]
  );

  const created = db.get('SELECT * FROM expenses WHERE id = ?', [id]);
  res.status(201).json({ success: true, expense: created });
}

export function deleteExpense(req, res) {
  const storeId = req.user.storeId;
  const { id } = req.params;
  const db = getDb();

  const expense = db.get('SELECT * FROM expenses WHERE id = ? AND store_id = ?', [id, storeId]);
  if (!expense) {
    return res.status(404).json({ success: false, error: 'Expense record not found' });
  }

  db.run('DELETE FROM expenses WHERE id = ? AND store_id = ?', [id, storeId]);
  res.json({ success: true, message: 'Expense deleted successfully' });
}
