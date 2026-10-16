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
 * Syncs a MongoDB user document into the local SQLite users table.
 * This guarantees local disk storage foreign keys (sales, shifts, audit logs)
 * and joins continue to work seamlessly without disrupting offline-first local operation.
 */
export function syncUserToSqlite(userDoc) {
  if (!userDoc || !userDoc.id || !userDoc.email) return;
  try {
    const db = getDb();
    if (!db || typeof db.run !== 'function') return;

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
