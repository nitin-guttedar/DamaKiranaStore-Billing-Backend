import crypto from 'crypto';
import { getDb } from '../db/index.js';

export class PosService {
  /**
   * Process a complete retail sale atomically:
   * 1. Validate items and stock
   * 2. Calculate totals, taxes (inclusive by default for Indian kirana), discounts
   * 3. Allocate payments (supports split payments)
   * 4. Deduct stock and write stock movement audit logs
   * 5. Record customer udhaar ledger entry if credit is used
   * 6. Update cashier shift if open
   */
  static checkoutSale({
    storeId,
    cashierId,
    customerId,
    items, // [{ productId, quantity, sellingPrice, discountAmount, customPrice }]
    payments, // [{ method: 'CASH'|'UPI'|'CARD'|'BANK_TRANSFER'|'CREDIT', amount, referenceId }]
    discountAmount = 0,
    discountPercent = 0,
    notes = '',
    customInvoiceNumber = null,
    clientSaleId = null,
    offlineCreatedAt = null
  }) {
    if (!items || items.length === 0) {
      throw new Error('Cart is empty. Add at least one product to checkout.');
    }

    if (!payments || payments.length === 0) {
      throw new Error('Payment details required.');
    }

    const db = getDb();

    return db.transaction((tx) => {
      // Idempotency check: if clientSaleId is already recorded, return existing sale
      if (clientSaleId) {
        const existing = tx.get('SELECT * FROM sales WHERE id = ? AND store_id = ?', [clientSaleId, storeId]);
        if (existing) {
          const store = tx.get('SELECT * FROM stores WHERE id = ?', [storeId]);
          const cashier = tx.get('SELECT full_name FROM users WHERE id = ?', [existing.cashier_id]);
          const existingItems = tx.query('SELECT * FROM sale_items WHERE sale_id = ?', [existing.id]);
          const existingPayments = tx.query('SELECT * FROM payments WHERE sale_id = ?', [existing.id]);
          return {
            success: true,
            saleId: existing.id,
            invoiceNumber: existing.invoice_number,
            createdAt: existing.created_at,
            store: {
              name: store?.name,
              address: store?.address,
              phone: store?.phone,
              gstin: store?.gstin
            },
            cashier: cashier ? cashier.full_name : 'Cashier',
            totalAmount: existing.total_amount,
            subtotal: existing.subtotal,
            discountAmount: existing.discount_amount,
            taxAmount: existing.tax_amount,
            roundOff: existing.round_off,
            items: existingItems,
            payments: existingPayments
          };
        }
      }

      // 1. Fetch store settings for invoice numbering and tax
      const settings = tx.get('SELECT * FROM store_settings WHERE store_id = ?', [storeId]) || {
        invoice_prefix: 'INV',
        next_invoice_number: 1,
        enable_gst: 1
      };

      // Generate invoice number
      let invoiceNumber = customInvoiceNumber;
      if (!invoiceNumber) {
        const nextNum = settings.next_invoice_number || 1;
        invoiceNumber = `${settings.invoice_prefix || 'INV'}-${String(nextNum).padStart(5, '0')}`;
        // Increment invoice sequence
        tx.run(
          'UPDATE store_settings SET next_invoice_number = next_invoice_number + 1 WHERE store_id = ?',
          [storeId]
        );
      }

      // Check active cashier shift
      const activeShift = tx.get(
        `SELECT id FROM cashier_shifts WHERE store_id = ? AND cashier_id = ? AND status = 'OPEN'`,
        [storeId, cashierId]
      );
      const shiftId = activeShift ? activeShift.id : null;

      // 2. Validate items, calculate line amounts and stock deductions
      let grossSubtotal = 0;
      let totalTax = 0;
      let totalCgst = 0;
      let totalSgst = 0;
      let calculatedItemDiscounts = 0;
      const saleId = clientSaleId || `sale_${crypto.randomUUID()}`;
      const lineItemsToInsert = [];
      const stockUpdates = [];

      for (const item of items) {
        const product = tx.get('SELECT * FROM products WHERE id = ? AND store_id = ?', [
          item.productId,
          storeId
        ]);

        if (!product) {
          throw new Error(`Product not found or invalid: ${item.productId}`);
        }

        const qty = parseFloat(item.quantity);
        if (isNaN(qty) || qty <= 0) {
          throw new Error(`Invalid quantity for product: ${product.name}`);
        }

        const unitPrice = parseFloat(item.sellingPrice ?? product.selling_price);
        const itemDiscount = parseFloat(item.discountAmount || 0);
        calculatedItemDiscounts += itemDiscount;

        const lineGross = Math.round(unitPrice * qty * 100) / 100;
        const lineNet = Math.max(0, lineGross - itemDiscount);
        grossSubtotal += lineNet;

        // Indian Retail: MRP/Selling Price is Tax-Inclusive
        let lineTax = 0;
        const taxRate = settings.enable_gst ? (product.tax_rate || 0) : 0;
        if (taxRate > 0) {
          const taxableValue = Math.round((lineNet / (1 + taxRate / 100)) * 100) / 100;
          lineTax = Math.round((lineNet - taxableValue) * 100) / 100;
          totalTax += lineTax;
          totalCgst += Math.round((lineTax / 2) * 100) / 100;
          totalSgst += Math.round((lineTax / 2) * 100) / 100;
        }

        lineItemsToInsert.push({
          id: `si_${crypto.randomUUID()}`,
          saleId,
          productId: product.id,
          productName: product.name,
          barcode: product.barcode,
          sku: product.sku,
          unit: product.unit,
          quantity: qty,
          purchaseCost: product.purchase_cost || 0,
          sellingPrice: unitPrice,
          mrp: product.mrp,
          discountAmount: itemDiscount,
          taxRate,
          taxAmount: lineTax,
          hsnCode: product.hsn_code,
          totalAmount: lineNet
        });

        // Stock deduction
        stockUpdates.push({
          productId: product.id,
          productName: product.name,
          deductQty: qty,
          unitCost: product.purchase_cost || 0
        });
      }

      // Calculate bill level discount
      const billDiscount = parseFloat(discountAmount || 0);
      const totalAmountBeforeRound = Math.max(0, grossSubtotal - billDiscount);
      const roundedTotal = Math.round(totalAmountBeforeRound);
      const roundOff = Math.round((roundedTotal - totalAmountBeforeRound) * 100) / 100;

      // 3. Verify Payments Total matches Total Amount
      let paidTotal = 0;
      let creditAmount = 0;
      let cashAmount = 0;

      for (const p of payments) {
        const amt = parseFloat(p.amount);
        if (isNaN(amt) || amt <= 0) continue;
        paidTotal += amt;
        if (p.method === 'CREDIT') {
          creditAmount += amt;
        } else if (p.method === 'CASH') {
          cashAmount += amt;
        }
      }

      // Allow minor decimal rounding difference (within ₹1)
      if (Math.abs(paidTotal - roundedTotal) > 1.0) {
        throw new Error(
          `Payment mismatch: Total payable is ₹${roundedTotal.toFixed(2)}, but paid amount is ₹${paidTotal.toFixed(2)}`
        );
      }

      // If credit is used, check customer credit limit
      let customer = null;
      if (creditAmount > 0) {
        if (!customerId) {
          throw new Error('Credit (Udhaar) payment requires selecting a registered customer.');
        }

        customer = tx.get('SELECT * FROM customers WHERE id = ? AND store_id = ?', [customerId, storeId]);
        if (!customer) {
          throw new Error('Selected customer not found.');
        }

        const newBalance = (customer.outstanding_balance || 0) + creditAmount;
        if (customer.credit_limit && newBalance > customer.credit_limit) {
          throw new Error(
            `Customer credit limit exceeded! Current balance: ₹${customer.outstanding_balance.toFixed(2)}, Limit: ₹${customer.credit_limit.toFixed(2)}, Requested: ₹${creditAmount.toFixed(2)}`
          );
        }
      }

      const saleCreatedAt = offlineCreatedAt || new Date().toISOString().replace('T', ' ').slice(0, 19);

      // 4. Insert Sales Record
      tx.run(
        `INSERT INTO sales (
          id, store_id, invoice_number, customer_id, cashier_id, shift_id,
          subtotal, discount_amount, discount_percent, tax_amount, cgst_amount, sgst_amount, igst_amount,
          round_off, total_amount, payment_status, status, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'PAID', 'COMPLETED', ?, ?)`,
        [
          saleId,
          storeId,
          invoiceNumber,
          customerId || null,
          cashierId,
          shiftId,
          grossSubtotal,
          billDiscount + calculatedItemDiscounts,
          discountPercent,
          totalTax,
          totalCgst,
          totalSgst,
          roundOff,
          roundedTotal,
          notes,
          saleCreatedAt
        ]
      );

      // 5. Insert Sale Items & Deduct Stock Exactly Once
      for (const item of lineItemsToInsert) {
        tx.run(
          `INSERT INTO sale_items (
            id, sale_id, product_id, product_name, barcode, sku, unit, quantity,
            purchase_cost, selling_price, mrp, discount_amount, tax_rate, tax_amount, hsn_code, total_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            item.saleId,
            item.productId,
            item.productName,
            item.barcode,
            item.sku,
            item.unit,
            item.quantity,
            item.purchaseCost,
            item.sellingPrice,
            item.mrp,
            item.discountAmount,
            item.taxRate,
            item.taxAmount,
            item.hsnCode,
            item.totalAmount
          ]
        );
      }

      // Deduct stock and log movement
      for (const update of stockUpdates) {
        tx.run(
          'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND store_id = ?',
          [update.deductQty, update.productId, storeId]
        );

        tx.run(
          `INSERT INTO stock_movements (
            id, store_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, reason, created_by
          ) VALUES (?, ?, ?, 'SALE', ?, ?, 'SALE', ?, ?, ?)`,
          [
            `mov_${crypto.randomUUID()}`,
            storeId,
            update.productId,
            -update.deductQty,
            update.unitCost,
            invoiceNumber,
            `Sold in invoice ${invoiceNumber}`,
            cashierId
          ]
        );
      }

      // 6. Record Payments
      for (const p of payments) {
        const amt = parseFloat(p.amount);
        if (isNaN(amt) || amt <= 0) continue;

        tx.run(
          `INSERT INTO payments (
            id, store_id, sale_id, customer_id, payment_method, amount, reference_id, notes, status, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)`,
          [
            `pay_${crypto.randomUUID()}`,
            storeId,
            saleId,
            customerId || null,
            p.method,
            amt,
            p.referenceId || null,
            p.notes || null,
            cashierId
          ]
        );
      }

      // 7. Update Customer Udhaar Ledger if credit was used
      if (creditAmount > 0 && customer) {
        const updatedBal = (customer.outstanding_balance || 0) + creditAmount;
        tx.run(
          'UPDATE customers SET outstanding_balance = ? WHERE id = ? AND store_id = ?',
          [updatedBal, customer.id, storeId]
        );

        tx.run(
          `INSERT INTO customer_ledger (
            id, store_id, customer_id, entry_type, amount, running_balance, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'CREDIT_SALE', ?, ?, 'SALE', ?, 'Kirana udhaar on invoice', ?)`,
          [
            `led_${crypto.randomUUID()}`,
            storeId,
            customer.id,
            creditAmount,
            updatedBal,
            invoiceNumber,
            cashierId
          ]
        );
      }

      // 8. Update Cashier Shift if open and cash was received
      if (shiftId && cashAmount > 0) {
        tx.run(
          'UPDATE cashier_shifts SET cash_sales = cash_sales + ? WHERE id = ?',
          [cashAmount, shiftId]
        );
      }

      // Fetch complete sale details with store details for receipt printing
      const store = tx.get('SELECT * FROM stores WHERE id = ?', [storeId]);
      const cashier = tx.get('SELECT full_name FROM users WHERE id = ?', [cashierId]);

      return {
        success: true,
        saleId,
        invoiceNumber,
        createdAt: new Date().toISOString(),
        store: {
          name: store.name,
          address: store.address,
          city: store.city,
          state: store.state,
          pincode: store.pincode,
          phone: store.phone,
          gstin: store.gstin,
          upiId: settings.upi_id,
          upiName: settings.upi_name,
          terms: settings.terms_and_conditions,
          printerType: settings.receipt_printer_type
        },
        cashier: cashier ? cashier.full_name : 'Cashier',
        customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone, balance: customer.outstanding_balance + creditAmount } : null,
        items: lineItemsToInsert,
        subtotal: grossSubtotal,
        discountAmount: billDiscount + calculatedItemDiscounts,
        taxAmount: totalTax,
        cgstAmount: totalCgst,
        sgstAmount: totalSgst,
        roundOff,
        totalAmount: roundedTotal,
        payments
      };
    });
  }

  /**
   * Process a Return or Refund referencing an original sale
   */
  static processReturn({ storeId, cashierId, originalSaleId, items, refundMethod = 'CASH', reason = '' }) {
    const db = getDb();

    return db.transaction((tx) => {
      const sale = tx.get('SELECT * FROM sales WHERE id = ? AND store_id = ?', [originalSaleId, storeId]);
      if (!sale) throw new Error('Original sale invoice not found.');

      let totalRefund = 0;
      const returnId = `ret_${crypto.randomUUID()}`;
      const returnNumber = `RET-${Date.now().toString().slice(-6)}`;

      // First pass: calculate total refund
      for (const item of items) {
        const saleItem = tx.get('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?', [
          item.saleItemId,
          originalSaleId
        ]);

        if (!saleItem) throw new Error('Original sale item not found.');

        const returnQty = parseFloat(item.quantity);
        if (returnQty <= 0 || returnQty > (saleItem.quantity - saleItem.returned_quantity)) {
          throw new Error(`Invalid return quantity for item: ${saleItem.product_name}`);
        }

        const refundLineTotal = Math.round((saleItem.total_amount / saleItem.quantity) * returnQty * 100) / 100;
        totalRefund += refundLineTotal;
      }

      // Record parent return first
      tx.run(
        `INSERT INTO returns (id, store_id, original_sale_id, return_number, customer_id, refund_amount, refund_method, reason, cashier_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          returnId,
          storeId,
          originalSaleId,
          returnNumber,
          sale.customer_id,
          totalRefund,
          refundMethod,
          reason,
          cashierId
        ]
      );

      // Second pass: restock inventory, audit stock movement, and insert child return_items
      for (const item of items) {
        const saleItem = tx.get('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?', [
          item.saleItemId,
          originalSaleId
        ]);

        const returnQty = parseFloat(item.quantity);
        const refundLineTotal = Math.round((saleItem.total_amount / saleItem.quantity) * returnQty * 100) / 100;

        // Update returned quantity on sale_item
        tx.run(
          'UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?',
          [returnQty, saleItem.id]
        );

        // Restock inventory
        tx.run(
          'UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ? AND store_id = ?',
          [returnQty, saleItem.product_id, storeId]
        );

        // Log stock movement
        tx.run(
          `INSERT INTO stock_movements (
            id, store_id, product_id, movement_type, quantity, unit_cost, reference_type, reference_id, reason, created_by
          ) VALUES (?, ?, ?, 'RETURN', ?, ?, 'RETURN', ?, ?, ?)`,
          [
            `mov_${crypto.randomUUID()}`,
            storeId,
            saleItem.product_id,
            returnQty,
            saleItem.purchase_cost,
            returnNumber,
            `Customer return against invoice ${sale.invoice_number}`,
            cashierId
          ]
        );

        // Insert return_item with valid return_id foreign key
        tx.run(
          `INSERT INTO return_items (id, return_id, sale_item_id, product_id, quantity, refund_unit_price, total_refund)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `ri_${crypto.randomUUID()}`,
            returnId,
            saleItem.id,
            saleItem.product_id,
            returnQty,
            saleItem.selling_price,
            refundLineTotal
          ]
        );
      }

      // Update sale status to PARTIALLY_RETURNED or RETURNED
      tx.run(
        `UPDATE sales SET status = 'PARTIALLY_RETURNED' WHERE id = ?`,
        [originalSaleId]
      );

      return {
        success: true,
        returnId,
        returnNumber,
        refundAmount: totalRefund,
        refundMethod
      };
    });
  }
}

export default PosService;
