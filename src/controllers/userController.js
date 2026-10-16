import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { AuthService } from '../services/authService.js';
import {
  findMongoUserByEmail,
  findMongoUserById,
  createMongoUser,
  updateMongoUser,
  listMongoUsers,
  syncUserToSqlite
} from '../db/mongo.js';

export async function listUsers(req, res) {
  try {
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN';
    const storeId = isSuperAdmin ? (req.query.storeId || null) : req.user.storeId;

    let users = [];
    try {
      // Query MongoDB credentials
      const filter = storeId ? { store_id: storeId } : (isSuperAdmin ? {} : { store_id: req.user.storeId });
      users = await listMongoUsers(filter);
    } catch (e) {
      console.warn('[KiranaOS Users] Mongo query fallback to SQLite:', e.message);
    }

    // Fallback to SQLite if MongoDB had 0 results or offline
    if (!users || users.length === 0) {
      const db = getDb();
      if (storeId) {
        users = db.query(
          'SELECT id, store_id, email, full_name, phone, role, is_active, must_change_password, created_at FROM users WHERE store_id = ? ORDER BY created_at DESC',
          [storeId]
        );
      } else if (isSuperAdmin) {
        users = db.query(
          'SELECT id, store_id, email, full_name, phone, role, is_active, must_change_password, created_at FROM users ORDER BY created_at DESC'
        );
      }
    }

    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function createUser(req, res) {
  try {
    const { email, password, fullName, phone, role } = req.body;
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN';
    const targetStoreId = isSuperAdmin ? (req.body.storeId || null) : req.user.storeId;

    if (!email || !password || !fullName || !role) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, full name, and role are required'
      });
    }

    // Role authorization check
    const validRoles = ['SUPER_ADMIN', 'STORE_OWNER', 'STORE_MANAGER', 'CASHIER'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid user role specified.' });
    }

    if (!isSuperAdmin) {
      if (role === 'SUPER_ADMIN' || (req.user.role === 'STORE_MANAGER' && role !== 'CASHIER')) {
        return res.status(403).json({ success: false, error: 'You are not authorized to create a user with this role.' });
      }
      if (!targetStoreId) {
        return res.status(400).json({ success: false, error: 'Store context required for store staff users.' });
      }
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Check duplicate in MongoDB
    try {
      const mongoUser = await findMongoUserByEmail(normalizedEmail);
      if (mongoUser) {
        return res.status(400).json({ success: false, error: 'A user with this email address already exists in MongoDB.' });
      }
    } catch (e) {
      console.warn('[KiranaOS Users] Mongo check warning:', e.message);
    }

    // 2. Check duplicate in SQLite
    const db = getDb();
    const existing = db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'A user with this email address already exists.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
    }

    const passwordHash = await AuthService.hashPassword(password);
    const userId = `usr_${role.toLowerCase().slice(0, 7)}_${crypto.randomUUID()}`;

    // 3. Save login credentials to MongoDB Atlas
    const userDoc = {
      id: userId,
      store_id: targetStoreId,
      email: normalizedEmail,
      password_hash: passwordHash,
      full_name: fullName.trim(),
      phone: phone || null,
      role,
      is_active: 1,
      must_change_password: 0
    };

    try {
      await createMongoUser(userDoc);
      console.log(`[KiranaOS Mongo] User credentials created in MongoDB: ${normalizedEmail} (${role})`);
    } catch (err) {
      console.error('[KiranaOS Mongo] Error creating user credentials in MongoDB:', err.message);
    }

    // 4. Mirror to local SQLite for disk storage integrity
    db.run(
      `INSERT INTO users (id, store_id, email, password_hash, full_name, phone, role, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         store_id = excluded.store_id,
         email = excluded.email,
         password_hash = excluded.password_hash,
         full_name = excluded.full_name,
         phone = excluded.phone,
         role = excluded.role,
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, targetStoreId, normalizedEmail, passwordHash, fullName.trim(), phone || null, role]
    );

    res.status(201).json({
      success: true,
      message: 'User credentials created and saved successfully in MongoDB database.',
      user: {
        id: userId,
        storeId: targetStoreId,
        email: normalizedEmail,
        fullName: fullName.trim(),
        phone: phone || null,
        role,
        isActive: true
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { fullName, phone, role, isActive, newPassword } = req.body;
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN';

    const db = getDb();
    const existing = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (!isSuperAdmin && existing.store_id !== req.user.storeId) {
      return res.status(403).json({ success: false, error: 'Access denied: User does not belong to your store.' });
    }

    const updates = {};
    if (fullName) updates.full_name = fullName.trim();
    if (phone !== undefined) updates.phone = phone || null;
    if (role && (isSuperAdmin || req.user.role === 'STORE_OWNER')) updates.role = role;
    if (isActive !== undefined) updates.is_active = isActive ? 1 : 0;
    if (newPassword && newPassword.length >= 6) {
      updates.password_hash = await AuthService.hashPassword(newPassword);
    }

    // Update in MongoDB
    try {
      await updateMongoUser(id, updates);
    } catch (e) {
      console.warn('[KiranaOS Mongo] Update warning:', e.message);
    }

    // Update in SQLite
    const sets = [];
    const vals = [];
    if (updates.full_name) { sets.push('full_name = ?'); vals.push(updates.full_name); }
    if (updates.phone !== undefined) { sets.push('phone = ?'); vals.push(updates.phone); }
    if (updates.role) { sets.push('role = ?'); vals.push(updates.role); }
    if (updates.is_active !== undefined) { sets.push('is_active = ?'); vals.push(updates.is_active); }
    if (updates.password_hash) { sets.push('password_hash = ?'); vals.push(updates.password_hash); }

    if (sets.length > 0) {
      sets.push('updated_at = CURRENT_TIMESTAMP');
      vals.push(id);
      db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
    }

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN';

    if (id === req.user.userId) {
      return res.status(400).json({ success: false, error: 'You cannot deactivate your own account.' });
    }

    const db = getDb();
    const existing = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (!isSuperAdmin && existing.store_id !== req.user.storeId) {
      return res.status(403).json({ success: false, error: 'Access denied: User does not belong to your store.' });
    }

    // Deactivate in MongoDB
    try {
      await updateMongoUser(id, { is_active: 0 });
    } catch (e) {
      console.warn('[KiranaOS Mongo] Deactivate warning:', e.message);
    }

    // Deactivate in SQLite
    db.run('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);

    res.json({ success: true, message: 'User account deactivated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
