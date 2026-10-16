import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export function authenticate(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required. No token provided.' });
  }
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, error: 'Invalid or forged authentication token.' });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Role '${req.user.role}' is not authorized for this action.`
      });
    }

    next();
  };
}

/**
 * Enforce strict tenant isolation: A user may only access resources belonging to their store_id
 */
export function requireStoreAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  // SUPER_ADMIN has platform-wide authority
  if (req.user.role === 'SUPER_ADMIN') {
    return next();
  }

  const targetStoreId = req.params.storeId || req.body?.storeId || req.query?.storeId || req.user.storeId;

  if (!targetStoreId || targetStoreId !== req.user.storeId) {
    return res.status(403).json({
      success: false,
      error: 'Tenant isolation violation: You cannot access or modify records of another store.'
    });
  }

  next();
}
