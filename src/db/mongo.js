import { MongoClient } from 'mongodb';
import { config } from '../config/index.js';
import { getDb } from './index.js';

let cachedClient = null;
let cachedDb = null;
let clientPromise = null;

/**
 * Returns a connected MongoDB client (reusing instance in serverless / hot environments)
 */
export async function getMongoClient() {
  if (cachedClient) {
    return cachedClient;
  }

  if (!clientPromise) {
    const uri = config.mongo.uri;
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 20000,
    });
    clientPromise = client.connect().then((c) => {
      cachedClient = c;
      console.log('[KiranaOS Mongo] Connected to MongoDB Atlas cluster');
      return c;
    }).catch((err) => {
      clientPromise = null;
      console.error('[KiranaOS Mongo] Failed to connect to MongoDB Atlas:', err.message);
      throw err;
    });
  }

  return clientPromise;
}

/**
 * Returns the MongoDB Database instance
 */
export async function getMongoDb() {
  if (cachedDb) return cachedDb;
  const client = await getMongoClient();
  cachedDb = client.db(config.mongo.dbName);
  return cachedDb;
}

/**
 * Returns the users collection with unique email index
 */
export async function getUsersCollection() {
  const db = await getMongoDb();
  const col = db.collection('users');
  try {
    await col.createIndex({ email: 1 }, { unique: true });
  } catch (e) {
    // Index already exists
  }
  return col;
}

/**
 * Ensures store and default settings exist in SQLite before user insertion
 * to satisfy SQLite FOREIGN KEY (store_id) REFERENCES stores(id).
 */
export function syncStoreToSqlite(storeData, subscriptionData) {
  if (!storeData || !storeData.id) return;
  try {
    const db = getDb();
    if (!db || typeof db.run !== 'function') return;

    db.run(
      `INSERT INTO stores (id, name, slug, phone, email, address, city, state, pincode, gstin, status, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         phone = COALESCE(excluded.phone, stores.phone),
         email = COALESCE(excluded.email, stores.email),
         status = 'ACTIVE',
         updated_at = CURRENT_TIMESTAMP`,
      [
        storeData.id,
        storeData.name || 'Kirana Store',
        storeData.slug || `store-${storeData.id}`,
        storeData.phone || null,
        storeData.email || null,
        storeData.address || null,
        storeData.city || 'Bengaluru',
        storeData.state || 'Karnataka',
        storeData.pincode || null,
        storeData.gstin || null
      ]
    );

    db.run(
      `INSERT INTO store_settings (id, store_id, invoice_prefix, next_invoice_number, receipt_printer_type, enable_gst, upi_name)
       VALUES (?, ?, 'INV', 1, '58mm', 0, ?)
       ON CONFLICT(id) DO NOTHING`,
      [`set_${storeData.id}`, storeData.id, storeData.name || 'Kirana Store']
    );

    const planId = subscriptionData?.plan_id || 'plan_annual';
    const startsAt = subscriptionData?.starts_at || new Date().toISOString();
    const expiresAt = subscriptionData?.expires_at || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const subId = subscriptionData?.id || `sub_${storeData.id}`;

    db.run(
      `INSERT INTO subscriptions (id, store_id, plan_id, status, starts_at, expires_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'ACTIVE',
         expires_at = excluded.expires_at`,
      [subId, storeData.id, planId, startsAt, expiresAt]
    );
  } catch (err) {
    console.warn('[KiranaOS Sync] SQLite store sync warning:', err.message);
  }
}

/**
 * Syncs a MongoDB user document into the local SQLite users table.
 * Ensures the referenced store exists first so foreign keys never fail.
 */
export function syncUserToSqlite(userDoc) {
  if (!userDoc || !userDoc.id || !userDoc.email) return;
  try {
    const db = getDb();
    if (!db || typeof db.run !== 'function') return;

    // 1. If user has store_id, ensure store exists in SQLite first
    if (userDoc.store_id) {
      const existingStore = db.get('SELECT id FROM stores WHERE id = ?', [userDoc.store_id]);
      if (!existingStore) {
        const storeData = userDoc.store_data || {
          id: userDoc.store_id,
          name: `${userDoc.full_name || 'Owner'}'s Store`,
          slug: `store-${userDoc.store_id}`,
          phone: userDoc.phone,
          email: userDoc.email
        };
        syncStoreToSqlite(storeData, userDoc.subscription_data);
      }
    }

    // 2. Insert or update user record
    db.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         store_id = excluded.store_id,
         email = excluded.email,
         password_hash = excluded.password_hash,
         full_name = excluded.full_name,
         phone = excluded.phone,
         role = excluded.role,
         is_active = excluded.is_active,
         must_change_password = excluded.must_change_password,
         updated_at = CURRENT_TIMESTAMP`,
      [
        userDoc.id,
        userDoc.store_id || null,
        userDoc.email.toLowerCase().trim(),
        userDoc.password_hash,
        userDoc.full_name || '',
        userDoc.phone || null,
        userDoc.role,
        userDoc.is_active !== undefined ? (userDoc.is_active ? 1 : 0) : 1,
        userDoc.must_change_password ? 1 : 0
      ]
    );
  } catch (err) {
    console.warn('[KiranaOS Sync] SQLite user sync warning:', err.message);
  }
}

/**
 * Find a user document by email (case-insensitive)
 */
export async function findMongoUserByEmail(email) {
  if (!email) return null;
  const col = await getUsersCollection();
  const normalizedEmail = email.toLowerCase().trim();
  return col.findOne({ email: normalizedEmail });
}

/**
 * Find a user document by id
 */
export async function findMongoUserById(id) {
  if (!id) return null;
  const col = await getUsersCollection();
  return col.findOne({ id });
}

/**
 * Create a new user document in MongoDB and sync to SQLite
 */
export async function createMongoUser(userData) {
  const col = await getUsersCollection();
  const normalizedEmail = userData.email.toLowerCase().trim();

  const existing = await col.findOne({ email: normalizedEmail });
  if (existing) {
    throw new Error('A user with this email address already exists in MongoDB.');
  }

  const doc = {
    id: userData.id,
    store_id: userData.store_id || null,
    email: normalizedEmail,
    password_hash: userData.password_hash,
    full_name: userData.full_name,
    phone: userData.phone || null,
    role: userData.role, // SUPER_ADMIN, STORE_OWNER, STORE_MANAGER, CASHIER
    is_active: userData.is_active !== undefined ? (userData.is_active ? 1 : 0) : 1,
    must_change_password: userData.must_change_password ? 1 : 0,
    store_data: userData.store_data || null,
    subscription_data: userData.subscription_data || null,
    created_at: userData.created_at || new Date(),
    updated_at: new Date()
  };

  await col.insertOne(doc);
  syncUserToSqlite(doc);
  return doc;
}

/**
 * Update a user document in MongoDB and sync to SQLite
 */
export async function updateMongoUser(id, updates) {
  const col = await getUsersCollection();
  const updatePayload = {
    ...updates,
    updated_at: new Date()
  };

  if (updatePayload.email) {
    updatePayload.email = updatePayload.email.toLowerCase().trim();
  }

  await col.updateOne({ id }, { $set: updatePayload });
  const updatedUser = await col.findOne({ id });
  if (updatedUser) {
    syncUserToSqlite(updatedUser);
  }
  return updatedUser;
}

/**
 * Update user password hash in MongoDB
 */
export async function updateMongoPassword(id, passwordHash) {
  return updateMongoUser(id, {
    password_hash: passwordHash,
    must_change_password: 0
  });
}

/**
 * List users from MongoDB with optional filter (e.g. by store_id)
 */
export async function listMongoUsers(filter = {}) {
  const col = await getUsersCollection();
  return col.find(filter).project({ password_hash: 0 }).sort({ created_at: -1 }).toArray();
}

/**
 * Permanently delete a user from MongoDB Atlas
 */
export async function deleteMongoUser(id, email = null) {
  const col = await getUsersCollection();
  const conditions = [];
  if (id) conditions.push({ id });
  if (email) conditions.push({ email: email.toLowerCase().trim() });
  if (conditions.length === 0) return { deletedCount: 0 };
  return col.deleteOne({ $or: conditions });
}

/**
 * Seed default credentials into MongoDB if collection is empty or users are missing
 */
export async function seedMongoCredentials(seedUsers = []) {
  try {
    const col = await getUsersCollection();
    for (const u of seedUsers) {
      const existing = await col.findOne({ email: u.email.toLowerCase().trim() });
      if (!existing) {
        await col.insertOne({
          id: u.id,
          store_id: u.store_id || null,
          email: u.email.toLowerCase().trim(),
          password_hash: u.password_hash,
          full_name: u.full_name,
          phone: u.phone || null,
          role: u.role,
          is_active: 1,
          must_change_password: u.must_change_password ? 1 : 0,
          created_at: new Date(),
          updated_at: new Date()
        });
        console.log(`[KiranaOS Mongo] Seeded user credentials into MongoDB: ${u.email} (${u.role})`);
      }
    }
  } catch (err) {
    console.error('[KiranaOS Mongo] Failed to seed credentials into MongoDB:', err.message);
  }
}
