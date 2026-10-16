# KiranaOS — REST API Specification & Endpoint Documentation

KiranaOS exposes a secure, high-performance REST API over HTTP/JSON. All requests and responses use UTF-8 JSON.

---

## 1. Authentication & Headers

### Request Headers
| Header | Required | Value | Description |
|---|---|---|---|
| `Content-Type` | Optional (default for mutations) | `application/json` | Request payload format |
| `Authorization` | Yes (except `/api/auth/login`) | `Bearer <JWT_TOKEN>` | Standard Bearer JWT token |

### Standard Error Response Format
All API errors return a standard JSON structure:
```json
{
  "success": false,
  "error": "Descriptive human-readable error message"
}
```

---

## 2. Role-Based Access Control (RBAC) Matrix

| Endpoint Group | `SUPER_ADMIN` | `STORE_OWNER` | `STORE_MANAGER` | `CASHIER` |
|---|:---:|:---:|:---:|:---:|
| `/api/auth/login` | Yes | Yes | Yes | Yes |
| `/api/auth/me` | Yes | Yes | Yes | Yes |
| `/api/auth/change-password` | Yes | Yes | Yes | Yes |
| `/api/products` (Read) | Yes | Yes | Yes | Yes |
| `/api/products` (Create/Update/Delete) | No | Yes | Yes | No |
| `/api/sales/checkout` | No | Yes | Yes | Yes |
| `/api/sales/history` | No | Yes | Yes | Yes (Shift-only) |
| `/api/sales/:id/return` | No | Yes | Yes | No |
| `/api/shifts/*` | No | Yes | Yes | Yes |
| `/api/customers/*` | No | Yes | Yes | Yes |
| `/api/customers/:id/ledger` | No | Yes | Yes | Yes |
| `/api/suppliers/*` | No | Yes | Yes | No |
| `/api/purchases/*` | No | Yes | Yes | No |
| `/api/expenses/*` | No | Yes | Yes | No |
| `/api/reports/sales-summary` | No | Yes | Yes | Yes |
| `/api/reports/profit-margin` | No | Yes | No | No |
| `/api/reports/gst-gstr1` | No | Yes | Yes | No |
| `/api/settings/*` | No | Yes | No | No |
| `/api/super-admin/*` | Yes | No | No | No |

---

## 3. Core API Endpoints

### 3.1 Authentication

#### `POST /api/auth/login`
Authenticates a user and returns a signed JWT.
- **Payload**:
```json
{
  "email": "owner@ganeshkirana.com",
  "password": "KiranaOwner@123"
}
```
- **Response** (200 OK):
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "usr_owner_001",
    "email": "owner@ganeshkirana.com",
    "fullName": "Ramesh Patel",
    "role": "STORE_OWNER",
    "storeId": "str_shree_ganesh",
    "mustChangePassword": false
  },
  "store": {
    "id": "str_shree_ganesh",
    "name": "Shree Ganesh Kirana & General Store",
    "phone": "9845012345",
    "currency": "INR",
    "currencySymbol": "₹"
  },
  "license": {
    "status": "ACTIVE",
    "planCode": "ANNUAL",
    "expiresAt": "2027-10-14T00:00:00.000Z",
    "daysRemaining": 365,
    "isExpired": false,
    "warning": null
  }
}
```

---

### 3.2 Products & Inventory

#### `GET /api/products`
Retrieves products for the authenticated store with barcode indexing and stock levels.
- **Query Parameters**:
  - `query` (optional): Barcode or name search substring
  - `category` (optional): Category filter
  - `lowStock` (optional): `true` to filter items where current stock <= low stock alert threshold

#### `POST /api/products`
Creates a new product with barcode mapping and initial inventory.
- **Payload**:
```json
{
  "name": "Tata Tea Gold 500g",
  "category": "Beverages",
  "barcode": "8901030999999",
  "mrp": 340.00,
  "sellingPrice": 320.00,
  "costPrice": 280.00,
  "taxRate": 5.0,
  "hsnCode": "0902",
  "unit": "PACK",
  "isLooseWeight": false,
  "currentStock": 25,
  "lowStockAlert": 5
}
```

---

### 3.3 POS Billing & Checkout

#### `POST /api/sales/checkout`
Executes an atomic sales transaction: creates the sale, decrements inventory batches, logs stock movements, records split payments, and updates customer udhaar ledger.
- **Payload**:
```json
{
  "customerId": "cust_anil",
  "customerName": "Anil Sharma",
  "customerPhone": "9845112233",
  "paymentMethod": "SPLIT",
  "subtotal": 520.00,
  "discountAmount": 20.00,
  "taxAmount": 23.81,
  "totalAmount": 500.00,
  "roundOff": 0.00,
  "payments": [
    { "method": "CASH", "amount": 200.00 },
    { "method": "UPI", "amount": 200.00, "transactionRef": "UPI/2026/0912" },
    { "method": "CREDIT", "amount": 100.00 }
  ],
  "items": [
    {
      "productId": "prod_aashirvaad_5kg",
      "quantity": 1,
      "unitPrice": 290.00,
      "taxRate": 5.0,
      "taxAmount": 13.81,
      "totalAmount": 290.00
    },
    {
      "productId": "prod_sona_masoori",
      "quantity": 3.5,
      "unitPrice": 60.00,
      "taxRate": 5.0,
      "taxAmount": 10.00,
      "totalAmount": 210.00
    }
  ]
}
```
- **Response** (201 Created):
```json
{
  "success": true,
  "saleId": "sal_9b81f3...",
  "invoiceNumber": "INV-20261014-0012",
  "total": 500.00,
  "balanceUdhaar": 350.00,
  "receipt": { ... }
}
```

---

### 3.4 Cashier Shifts & Drawer Management

#### `POST /api/shifts/start`
Starts a cashier register shift with opening cash float.
- **Payload**:
```json
{
  "openingCash": 2000.00,
  "notes": "Morning Shift Counter 1"
}
```

#### `POST /api/shifts/:id/end`
Closes register shift, reconciles expected cash against counted cash, and computes drawer difference.
- **Payload**:
```json
{
  "countedCash": 14550.00,
  "notes": "Shift reconciled without discrepancy"
}
```
- **Calculation Formula**:
$$\text{Expected Cash} = \text{Opening Float} + \text{Cash Sales} + \text{Cash In} - \text{Cash Out} - \text{Cash Refunds}$$

---

### 3.5 Customer Ledger & Udhaar (Khata)

#### `GET /api/customers/:id/ledger`
Returns complete chronological statement of invoices, credit additions, payments, and running balance.

#### `POST /api/customers/:id/payments`
Records a customer debt repayment and updates outstanding balance.
- **Payload**:
```json
{
  "amount": 500.00,
  "paymentMethod": "UPI",
  "notes": "Payment via PhonePe QR"
}
```

---

### 3.6 Super-Admin Platform Management

#### `POST /api/super-admin/stores`
Provisions a new store, creates owner account, assigns subscription plan, and signs cryptographic offline license token.
- **Payload**:
```json
{
  "storeName": "Balaji Provisions",
  "ownerName": "Suresh Reddy",
  "ownerEmail": "suresh@balajistore.in",
  "ownerPhone": "9845099887",
  "ownerPassword": "InitialPassword@2026",
  "planId": "plan_annual",
  "address": "Jayanagar 4th Block, Bengaluru",
  "gstin": "29AABCU9603R1ZM"
}
```
- **Response** (201 Created):
```json
{
  "success": true,
  "storeId": "str_balaji_reddy",
  "ownerId": "usr_suresh_reddy",
  "licenseToken": "KOS-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": "2027-10-14T00:00:00.000Z",
  "initialCredentials": {
    "email": "suresh@balajistore.in",
    "password": "InitialPassword@2026"
  }
}
```

#### `POST /api/super-admin/stores/:id/renew`
Extends subscription duration, issues updated signed license token, and logs renewal event.
