import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { config } from '../config/index.js';
import {
  findMongoUserByEmail,
  findMongoUserById,
  updateMongoPassword,
  syncUserToSqlite
} from '../db/mongo.js';

export class AuthService {
  /**
   * Hash a plaintext password
   */
  static async hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  /**
   * Compare a plaintext password with a hash
   */
  static async comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate JWT token for authenticated user
   */
  static generateToken(user) {
    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      storeId: user.store_id || null,
      fullName: user.full_name
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn
    });
  }

  /**
   * Authenticate user with email and password
   * Credentials checked against MongoDB Atlas cluster with local SQLite offline fallback
   */
  static async login(email, password) {
    const db = getDb();
    const normalizedEmail = email.toLowerCase().trim();

    let user = null;
    let fromMongo = false;

    // 1. Primary check: Query MongoDB credentials collection
    try {
      const mongoUser = await findMongoUserByEmail(normalizedEmail);
      if (mongoUser) {
        user = mongoUser;
        fromMongo = true;
      }
    } catch (err) {
      console.warn('[KiranaOS Auth] MongoDB credential lookup warning, falling back to local storage:', err.message);
    }

    // 2. Offline fallback: Query local SQLite storage if not found in MongoDB
    if (!user) {
      user = db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    }

    if (!user) {
      throw new Error('Invalid email or password');
    }

    if (user.is_active !== 1 && user.is_active !== true) {
      throw new Error('Your user account has been deactivated. Please contact support.');
    }

    const isMatch = await this.comparePassword(password, user.password_hash);
    if (!isMatch) {
      throw new Error('Invalid email or password');
    }

    // Mirror credential record to local SQLite so local FKs (sales, shifts) and bill printing succeed
    if (fromMongo) {
      syncUserToSqlite(user);
    }

    // If store-associated, check if store is suspended
    if (user.store_id) {
      const store = db.get('SELECT status, is_active FROM stores WHERE id = ?', [user.store_id]);
      if (store && (store.is_active !== 1 || store.status === 'SUSPENDED')) {
        throw new Error('This store is currently suspended. Access denied.');
      }
    }

    const token = this.generateToken(user);

    // Fetch store info if available from local disk storage
    let store = null;
    if (user.store_id) {
      store = db.get('SELECT * FROM stores WHERE id = ?', [user.store_id]);
    }

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        storeId: user.store_id,
        mustChangePassword: Boolean(user.must_change_password)
      },
      store: store ? {
        id: store.id,
        name: store.name,
        slug: store.slug,
        status: store.status,
        gstin: store.gstin
      } : null
    };
  }

  /**
   * Change password for authenticated user in MongoDB and SQLite
   */
  static async changePassword(userId, currentPassword, newPassword) {
    const db = getDb();
    let user = null;

    // Check MongoDB first
    try {
      user = await findMongoUserById(userId);
    } catch (e) {
      // offline fallback
    }

    if (!user) {
      user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
    }

    if (!user) throw new Error('User not found');

    const isMatch = await this.comparePassword(currentPassword, user.password_hash);
    if (!isMatch) throw new Error('Current password does not match');

    if (!newPassword || newPassword.length < 6) {
      throw new Error('New password must be at least 6 characters long');
    }

    const newHash = await this.hashPassword(newPassword);

    // Update in MongoDB
    try {
      await updateMongoPassword(userId, newHash);
    } catch (e) {
      console.warn('[KiranaOS Auth] Failed to update password in MongoDB:', e.message);
    }

    // Update in local SQLite
    db.run(
      'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newHash, userId]
    );

    return { success: true, message: 'Password updated successfully' };
  }
}

export default AuthService;

