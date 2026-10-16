const requestCounts = new Map();

/**
 * Basic in-memory rate limiter for sensitive endpoints like /api/auth/login
 */
export function rateLimiter({ windowMs = 60000, max = 20, message = 'Too many attempts. Please try again later.' }) {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let record = requestCounts.get(ip);
    if (!record) {
      record = [];
      requestCounts.set(ip, record);
    }

    // Filter out old timestamps
    const recent = record.filter(timestamp => timestamp > windowStart);
    recent.push(now);
    requestCounts.set(ip, recent);

    if (recent.length > max) {
      return res.status(429).json({ success: false, error: message });
    }

    next();
  };
}

export function errorHandler(err, req, res, next) {
  console.error('[KiranaOS Error]', err);
  const status = err.status || 500;
  const message = err.message || 'An unexpected internal server error occurred';
  res.status(status).json({
    success: false,
    error: message
  });
}
