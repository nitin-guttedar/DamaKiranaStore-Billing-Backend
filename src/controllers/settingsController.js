import fs from 'fs';
import path from 'path';
import { getDb } from '../db/index.js';
import { config } from '../config/index.js';

export function getSettings(req, res) {
  const storeId = req.user.storeId;
  const db = getDb();

  const store = db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
  const settings = db.get('SELECT * FROM store_settings WHERE store_id = ?', [storeId]);

  res.json({
    success: true,
    store,
    settings: settings || {
      invoice_prefix: 'INV',
      next_invoice_number: 1,
      receipt_printer_type: '58mm',
      enable_gst: 1,
      default_tax_rate: 5.0,
      upi_id: '',
      upi_name: '',
      currency_symbol: '₹',
      terms_and_conditions: ''
    }
  });
}

export function updateSettings(req, res) {
  const storeId = req.user.storeId;
  const {
    storeName,
    phone,
    email,
    address,
    city,
    state,
    pincode,
    gstin,
    invoicePrefix,
    receiptPrinterType,
    enableGst,
    defaultTaxRate,
    upiId,
    upiName,
    termsAndConditions
  } = req.body;

  const db = getDb();

  db.transaction((tx) => {
    tx.run(
      `UPDATE stores SET
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        city = COALESCE(?, city),
        state = COALESCE(?, state),
        pincode = COALESCE(?, pincode),
        gstin = COALESCE(?, gstin),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        storeName !== undefined ? storeName.trim() : null,
        phone !== undefined ? phone.trim() : null,
        email !== undefined ? email.trim() : null,
        address !== undefined ? address.trim() : null,
        city !== undefined ? city.trim() : null,
        state !== undefined ? state.trim() : null,
        pincode !== undefined ? pincode.trim() : null,
        gstin !== undefined ? gstin.trim() : null,
        storeId
      ]
    );

    tx.run(
      `UPDATE store_settings SET
        invoice_prefix = COALESCE(?, invoice_prefix),
        receipt_printer_type = COALESCE(?, receipt_printer_type),
        enable_gst = COALESCE(?, enable_gst),
        default_tax_rate = COALESCE(?, default_tax_rate),
        upi_id = COALESCE(?, upi_id),
        upi_name = COALESCE(?, upi_name),
        terms_and_conditions = COALESCE(?, terms_and_conditions),
        updated_at = CURRENT_TIMESTAMP
      WHERE store_id = ?`,
      [
        invoicePrefix !== undefined ? invoicePrefix.trim() : null,
        receiptPrinterType !== undefined ? receiptPrinterType : null,
        enableGst !== undefined ? (enableGst ? 1 : 0) : null,
        defaultTaxRate !== undefined ? parseFloat(defaultTaxRate) : null,
        upiId !== undefined ? upiId.trim() : null,
        upiName !== undefined ? upiName.trim() : null,
        termsAndConditions !== undefined ? termsAndConditions.trim() : null,
        storeId
      ]
    );
  });

  const updatedStore = db.get('SELECT * FROM stores WHERE id = ?', [storeId]);
  const updatedSettings = db.get('SELECT * FROM store_settings WHERE store_id = ?', [storeId]);

  res.json({ success: true, store: updatedStore, settings: updatedSettings });
}

export function downloadBackup(req, res) {
  const db = getDb();

  // Force SQLite WAL checkpoint to ensure all uncommitted WAL pages are flushed to disk
  try {
    db.exec('PRAGMA wal_checkpoint(FULL);');
  } catch (e) {
    console.warn('Checkpoint warning:', e.message);
  }

  const dbFile = config.dbPath;
  if (!fs.existsSync(dbFile)) {
    return res.status(404).json({ success: false, error: 'Database file not found' });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `kiranaos_backup_${timestamp}.db`;

  res.setHeader('Content-Type', 'application/x-sqlite3');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

  const stream = fs.createReadStream(dbFile);
  stream.pipe(res);
}
