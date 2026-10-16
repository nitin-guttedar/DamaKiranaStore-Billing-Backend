import { getDb } from './index.js';
import { runMigrations } from './migrate.js';
import { AuthService } from '../services/authService.js';
import { getUsersCollection } from './mongo.js';

export async function ensureDefaultMongoCredentials() {
  try {
    const col = await getUsersCollection();
    // 1. Remove any legacy mock/dummy users
    const dummyEmails = [
      'admin@kiranaos.internal',
      'owner@ganeshkirana.com',
      'cashier@ganeshkirana.com',
      'shashikantpanchal@gmail.com'
    ];
    await col.deleteMany({ email: { $in: dummyEmails } });

    // 2. Ensure only primary Super Admin exists
    const adminEmail = 'nitinguttedar20@gmail.com';
    const existing = await col.findOne({ email: adminEmail });
    const adminPass = await AuthService.hashPassword('nitin@123');

    if (!existing) {
      await col.insertOne({
        id: 'usr_sa_primary',
        store_id: null,
        email: adminEmail,
        password_hash: adminPass,
        full_name: 'Nitin Guttedar',
        phone: '9999999999',
        role: 'SUPER_ADMIN',
        is_active: 1,
        must_change_password: 0,
        created_at: new Date(),
        updated_at: new Date()
      });
      console.log(`[KiranaOS Mongo] Verified Super-Admin credentials in MongoDB: ${adminEmail}`);
    } else {
      // Ensure password hash is up to date for nitin@123
      const matches = await AuthService.comparePassword('nitin@123', existing.password_hash);
      if (!matches || existing.role !== 'SUPER_ADMIN') {
        await col.updateOne(
          { email: adminEmail },
          {
            $set: {
              password_hash: adminPass,
              role: 'SUPER_ADMIN',
              is_active: 1,
              must_change_password: 0,
              updated_at: new Date()
            }
          }
        );
        console.log(`[KiranaOS Mongo] Updated Super-Admin password hash in MongoDB for: ${adminEmail}`);
      }
    }
  } catch (err) {
    console.warn('[KiranaOS DB] Could not sync default credentials to MongoDB:', err.message);
  }
}

export async function seedDatabase() {
  runMigrations();
  const db = getDb();
  console.log('[KiranaOS DB] Initializing clean database environment...');
  await ensureDefaultMongoCredentials();

  // 1. Subscription Plans (necessary for platform operation and store licensing)
  const plans = [
    { id: 'plan_monthly', name: 'Kirana Starter Monthly', code: 'MONTHLY', duration: 30, price: 499, users: 2, products: 2000 },
    { id: 'plan_quarterly', name: 'Kirana Growth Quarterly', code: 'QUARTERLY', duration: 90, price: 1399, users: 3, products: 5000 },
    { id: 'plan_halfyearly', name: 'Kirana Business 6-Months', code: 'HALF_YEARLY', duration: 180, price: 2499, users: 5, products: 10000 },
    { id: 'plan_annual', name: 'Kirana Enterprise Annual', code: 'ANNUAL', duration: 365, price: 4499, users: 10, products: 25000 },
    { id: 'plan_trial', name: '14-Day Free Kirana Trial', code: 'TRIAL', duration: 14, price: 0, users: 2, products: 1000 }
  ];

  for (const p of plans) {
    const existing = db.get('SELECT id FROM subscription_plans WHERE id = ?', [p.id]);
    if (!existing) {
      db.run(
        `INSERT INTO subscription_plans (id, name, code, duration_days, price_inr, max_users, max_products, features_json, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1)`,
        [p.id, p.name, p.code, p.duration, p.price, p.users, p.products]
      );
    }
  }

  // 2. Super Administrator in local SQLite
  const adminEmail = 'nitinguttedar20@gmail.com';
  let admin = db.get('SELECT * FROM users WHERE email = ?', [adminEmail]);
  const adminPass = await AuthService.hashPassword('nitin@123');
  const adminId = 'usr_sa_primary';

  if (!admin) {
    db.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active, must_change_password)
       VALUES (?, NULL, ?, ?, 'Nitin Guttedar', '9999999999', 'SUPER_ADMIN', 1, 0)`,
      [adminId, adminEmail, adminPass]
    );
    console.log('[+] Created Super-Admin in SQLite:', adminEmail);
  } else {
    db.run(
      `UPDATE users SET password_hash = ?, role = 'SUPER_ADMIN', is_active = 1, must_change_password = 0 WHERE email = ?`,
      [adminPass, adminEmail]
    );
  }

  console.log('[KiranaOS DB] Clean database initialization complete. Only Admin user is present.');
}

// Allow direct execution
if (process.argv[1]?.endsWith('seed.js')) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[KiranaOS DB] Seed failed:', err);
      process.exit(1);
    });
}
