# DamaKiranaStore-Billing-Backend

Enterprise-grade, minimal, high-speed retail billing and POS backend platform engineered for Indian kirana stores, grocery shops, and retail chains. Built with **Node.js, Express, and an authoritative local SQLite database (WAL mode)**, ensuring offline-first resilience, rapid checkout execution, and cryptographically verified licensing.

---

## Architecture Overview

```
DamaKiranaStore-Billing-Backend/
├── server/
│   ├── src/
│   │   ├── config/             # Environment, database paths, and secret configuration
│   │   ├── controllers/        # Express route handlers (auth, pos, products, shifts, etc.)
│   │   ├── db/                 # SQLite connection (WAL mode pragmas), migrations, and seeds
│   │   ├── middleware/         # JWT auth, tenant isolation, error handling, subscription check
│   │   ├── routes/             # RESTful API route definitions
│   │   ├── services/           # Business logic (posService, authService, licenseService)
│   │   └── index.js            # Express application bootstrap & server entry point
│   ├── tests/                  # Integration & unit test suites (Node.js test runner)
│   ├── data/                   # SQLite database storage & point-in-time backups
│   ├── package.json            # Server dependencies & scripts
│   └── package-lock.json
├── scripts/
│   ├── backup.js               # Safe SQLite WAL checkpoint & point-in-time backup tool
│   ├── restore.js              # Database integrity check & safe recovery tool
│   └── bootstrap-superadmin.js # Platform super-admin seed & subscription plan provisioner
├── docs/
│   ├── api.md                  # Comprehensive REST API endpoint reference
│   ├── backup-restore.md       # Disaster recovery & database operations runbook
│   ├── hardware.md             # Thermal printer & USB barcode scanner integration guide
│   └── security.md             # Cryptographic licensing, HMAC tokens, and auth architecture
├── .env.example                # Example environment variables template
├── .gitignore
├── package.json                # Root proxy scripts
└── README.md
```

---

## Core Capabilities

1. **Authoritative SQLite Engine (WAL Mode)**:
   - Synchronous = NORMAL, busy_timeout = 5000ms, Foreign Keys = ON.
   - High concurrency with zero corruption even under unexpected power outages.
2. **Atomic Financial Transactions**:
   - Single atomic transaction for sales checkout: records sale header, line items, decrements inventory stock exactly once, splits cash/UPI/credit payments, and updates customer credit ledger.
3. **Multi-Tenant Store Isolation**:
   - Automated tenant scoping middleware enforcing `store_id` isolation across all business queries.
4. **Cashier Shifts & Cash Drawer Reconciliation**:
   - Shift opening float, cash sales tracking, mid-day safe drops, change additions with mandatory audit reasons, and closing difference calculation.
5. **Cryptographic Subscription Licensing**:
   - HMAC-SHA256 offline-verifiable license tokens with grace period enforcement and read-only mode protection.
6. **Indian Tax & GST Engine**:
   - Tax-inclusive pricing support, multi-slab GST breakdown (0%, 5%, 12%, 18%), CGST/SGST splits, and GSTR-1 ready reporting.

---

## Getting Started

### 1. Prerequisites
- **Node.js** v20.0.0 or higher
- **npm** v10.0.0 or higher

### 2. Environment Setup
Copy the example environment file and configure variables:
```bash
cp .env.example server/.env
```

### 3. Install Dependencies
```bash
cd server
npm install
```

### 4. Database Setup & Migrations
```bash
npm run db:migrate
npm run db:seed
npm run bootstrap:admin
```

### 5. Start the Server
```bash
npm run dev
# Server will start on http://localhost:5000
```

### 6. Run Test Suite
```bash
npm test
```

---

## Operations & Documentation

- [REST API Reference](docs/api.md)
- [Backup & Disaster Recovery Guide](docs/backup-restore.md)
- [POS Hardware Configuration Guide](docs/hardware.md)
- [Security & Licensing Guide](docs/security.md)

---

## License
ISC
