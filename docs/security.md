# KiranaOS — Production Security Checklist

This document details the security architecture, threat model mitigations, and deployment checklist for KiranaOS.

---

## 1. Authentication & Session Security
- **Password Hashing**: Plaintext passwords are never stored. Passwords are salted and hashed using `bcrypt` (10 rounds).
- **JWT Signing**: Access tokens are signed using HMAC-SHA256 with a high-entropy secret (`JWT_SECRET`) configured outside source code in `.env`.
- **Brute Force Protection**: In-memory rate limiting applied to `/api/auth/login` to prevent brute-force attacks.
- **Credential Masking**: Super-admin displays initial store owner passwords and raw license secrets **only once** upon provisioning. Subsequent views show masked identifiers (e.g. `KOS-LIC-••••-8F92`).

---

## 2. Authorization & Tenant Isolation
- **Server-Side Enforcement**: All protected endpoints enforce role checks (`SUPER_ADMIN`, `STORE_OWNER`, `STORE_MANAGER`, `CASHIER`) and verify tenant boundaries. Hiding buttons in the React UI is never treated as authorization.
- **Tenant Isolation**: Every database query scopes records by `store_id`. A user from Store A attempting to access records of Store B receives a `403 Forbidden` (`Tenant isolation violation`).
- **Role Isolation**: Cashiers cannot access profit margin reports, super-admin platform routes, or license management APIs.

---

## 3. Database & SQL Injection Mitigation
- **Parameterized Queries**: 100% of SQLite database queries use prepared parameterized statements (`stmt.run(...)`, `stmt.get(...)`, `stmt.all(...)`). Direct string concatenation into SQL statements is prohibited.
- **Foreign Key Enforcement**: `PRAGMA foreign_keys = ON;` is executed on every database connection to guarantee relational integrity.
- **Atomic Transactions**: Multi-record financial mutations (sales + line items + payment allocation + stock movement + customer udhaar ledger) execute inside atomic SQLite transactions (`BEGIN IMMEDIATE ... COMMIT/ROLLBACK`). If any step fails, the entire transaction is rolled back cleanly.

---

## 4. Cryptographic Licensing Engine
- **HMAC-SHA256 Signing**: Annual license tokens contain store ID, subscription ID, plan code, UTC issued-at, UTC expires-at, limits, and a cryptographic nonce signed with `LICENSE_SIGNING_SECRET`.
- **Offline Verification**: The local server verifies the token signature and expiration date locally without requiring internet connectivity.
- **Revocation List**: Revoked tokens are tracked in `license_tokens` with audit timestamps and reason, immediately rejecting revoked deployments.
- **Read-Only Mode**: When a store's subscription expires, mutating requests (POST, PUT, PATCH, DELETE) are blocked by middleware with an HTTP 403 error. Existing business records remain accessible in read-only mode, and data exports are permitted. Business data is never deleted merely due to subscription expiration.

---

## 5. Deployment Checklist
- [ ] Change `JWT_SECRET` in `server/.env` to a unique 64-character random string.
- [ ] Change `LICENSE_SIGNING_SECRET` to a unique private key held securely.
- [ ] Set `NODE_ENV=production`.
- [ ] Ensure SQLite database file (`server/data/kiranaos.db`) has restrictive OS file permissions (readable only by the local service account).
- [ ] Set up daily automated backups using `node scripts/backup.js`.
