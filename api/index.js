let appPromise;

export default async function handler(req, res) {
  try {
    if (!appPromise) {
      appPromise = import('../server/src/index.js').then(m => m.default || m);
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    console.error('[Vercel Serverless] Error initializing application:', err);
    res.status(500).json({
      error: 'FUNCTION_INVOCATION_FAILED',
      message: err.message,
      nodeVersion: process.version,
      hint: !process.version.startsWith('v22') && !process.version.startsWith('v23') && !process.version.startsWith('v24')
        ? `Node.js 22.x is required for native SQLite (node:sqlite). Current version is ${process.version}. Please set Node.js Version to 22.x in Vercel Project Settings > General.`
        : undefined
    });
  }
}