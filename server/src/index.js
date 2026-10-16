import express from 'express';
import fs from 'fs';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { errorHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/authRoutes.js';
import productRoutes from './routes/productRoutes.js';
import salesRoutes from './routes/salesRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import supplierRoutes from './routes/supplierRoutes.js';
import purchaseRoutes from './routes/purchaseRoutes.js';
import shiftRoutes from './routes/shiftRoutes.js';
import expenseRoutes from './routes/expenseRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import superAdminRoutes from './routes/superAdminRoutes.js';
import userRoutes from './routes/userRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { seedDatabase, ensureDefaultMongoCredentials } from './db/seed.js';

// Initialize database schema and ensure initial demo dataset exists
try {
  runMigrations();
  const db = getDb();
  if (db && typeof db.get === 'function') {
    const usersCount = db.get('SELECT COUNT(*) as count FROM users')?.count || 0;
    if (usersCount === 0) {
      console.log('[KiranaOS DB] Database is empty. Auto-seeding initial store and users...');
      await seedDatabase();
    } else {
      // Ensure cloud MongoDB credentials cluster is synced with default credentials
      ensureDefaultMongoCredentials().catch(e => console.warn('[KiranaOS Mongo Sync]:', e.message));
    }
  }
} catch (err) {
  console.error('[KiranaOS DB] Database initialization warning:', err.message);
}

const app = express();

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With']
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Root Status API
app.get('/', (req, res) => {
  res.send('KiranaOS Backend Engine is running!');
});

// Health Check API
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    system: 'KiranaOS',
    version: '1.0.0',
    mode: 'offline-first',
    timestamp: new Date().toISOString()
  });
});

// Mount Module Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/users', userRoutes);

// Serve static client bundle if built (single-port offline retail deployment)
const clientDistPath = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Centralized error handling
app.use(errorHandler);

// Start Server if not running in serverless environment (e.g. Vercel)
if (!process.env.VERCEL) {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`  KiranaOS Backend Engine is running!`);
    console.log(`  Local URL:   http://localhost:${config.port}`);
    console.log(`  Health API:  http://localhost:${config.port}/api/health`);
    console.log(`  Mode:        Offline-First Retail POS (SQLite WAL)`);
    console.log(`=======================================================`);
  });
}

export default app;
