import crypto from 'crypto';
import { getDb } from '../server/src/db/index.js';
import { AuthService } from '../server/src/services/authService.js';
import { config } from '../server/src/config/index.js';

async function bootstrap() {
  const db = getDb();
  console.log('--- KiranaOS Super-Admin Bootstrap ---');

  const existingAdmin = db.get("SELECT * FROM users WHERE role = 'SUPER_ADMIN'");
  if (existingAdmin) {
    console.log(`[!] Super-Admin already exists: ${existingAdmin.email} (ID: ${existingAdmin.id})`);
    console.log('To reset the password, run with RESET=true or update via admin CLI.');
    return;
  }

  // Allow setting via CLI argument or environment variable
  const email = process.env.ADMIN_EMAIL || process.argv[2] || 'admin@kiranaos.internal';
  const password = process.env.ADMIN_PASSWORD || process.argv[3] || 'SuperAdmin@Kirana2026';
  const fullName = process.env.ADMIN_NAME || 'Platform Super Administrator';

  const passwordHash = await AuthService.hashPassword(password);
  const adminId = `usr_sa_${crypto.randomUUID()}`;

  db.run(
    `INSERT INTO users (
      id, store_id, email, password_hash, full_name, phone, role, must_change_password, is_active
    ) VALUES (?, NULL, ?, ?, ?, ?, 'SUPER_ADMIN', 0, 1)`,
    [adminId, email.toLowerCase(), passwordHash, fullName, '9999999999']
  );

  // Initialize Default Subscription Plans if not already created
  const plansCount = db.get('SELECT COUNT(*) as count FROM subscription_plans').count;
  if (plansCount === 0) {
    const plans = [
      { id: 'plan_monthly', name: 'Kirana Starter Monthly', code: 'MONTHLY', duration: 30, price: 499, users: 2, products: 2000 },
      { id: 'plan_quarterly', name: 'Kirana Growth Quarterly', code: 'QUARTERLY', duration: 90, price: 1399, users: 3, products: 5000 },
      { id: 'plan_halfyearly', name: 'Kirana Business 6-Months', code: 'HALF_YEARLY', duration: 180, price: 2499, users: 5, products: 10000 },
      { id: 'plan_annual', name: 'Kirana Enterprise Annual', code: 'ANNUAL', duration: 365, price: 4499, users: 10, products: 25000 },
      { id: 'plan_trial', name: '14-Day Free Kirana Trial', code: 'TRIAL', duration: 14, price: 0, users: 2, products: 1000 }
    ];

    for (const p of plans) {
      db.run(
        `INSERT INTO subscription_plans (id, name, code, duration_days, price_inr, max_users, max_products, features_json, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1)`,
        [p.id, p.name, p.code, p.duration, p.price, p.users, p.products]
      );
    }
    console.log('[+] Initialized default subscription plans (Monthly, Quarterly, Half-Yearly, Annual, Trial)');
  }

  // Audit log
  db.run(
    `INSERT INTO audit_logs (id, store_id, user_id, action, entity_type, entity_id, new_values_json)
     VALUES (?, NULL, ?, 'BOOTSTRAP_SUPERADMIN', 'USER', ?, ?)`,
    [`aud_${crypto.randomUUID()}`, adminId, adminId, JSON.stringify({ email, fullName })]
  );

  console.log('========================================================');
  console.log(' Super-Admin successfully created!');
  console.log(` Email:    ${email}`);
  console.log(` Password: ${password}`);
  console.log(` Role:     SUPER_ADMIN`);
  console.log('========================================================');
  console.log(' IMPORTANT: Store these credentials securely or change immediately on login.');
}

bootstrap().then(() => process.exit(0)).catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
