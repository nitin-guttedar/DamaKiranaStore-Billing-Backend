import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from server directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isVercel = !!process.env.VERCEL;
const defaultDb = isVercel ? '/tmp/kiranaos.db' : 'data/kiranaos.db';
const rawDbPath = process.env.DB_PATH || defaultDb;
const resolvedDbPath = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(__dirname, '../../', rawDbPath);

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || (isVercel ? 'production' : 'development'),
  dbPath: resolvedDbPath,
  jwt: {
    secret: process.env.JWT_SECRET || 'kiranaos_super_jwt_secret_dev_key_2026_xyz987654321',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
  license: {
    signingSecret: process.env.LICENSE_SIGNING_SECRET || 'kiranaos_license_engine_rsa_or_hmac_secret_2026_very_secure',
    issuer: 'KiranaOS Licensing Authority',
    audience: 'KiranaOS Offline Store Runtime',
  },
  bootstrapKey: process.env.SUPER_ADMIN_BOOTSTRAP_KEY || 'kiranaos_bootstrap_admin_secure_pass_2026',
  defaults: {
    printerMode: process.env.DEFAULT_PRINTER_MODE || '58mm',
    invoicePrefix: process.env.DEFAULT_INVOICE_PREFIX || 'INV',
    currency: process.env.DEFAULT_CURRENCY || 'INR',
  }
};
