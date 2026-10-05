import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleSupabaseApi } from './supabase-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const app = express();
const port = Number(process.env.PORT) || 4173;

app.disable('x-powered-by');
app.use(express.json({ limit: '12kb' }));
app.use('/api', handleSupabaseApi);

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(rootDir, 'dist');
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const vite = await createViteServer({
    configFile: path.join(rootDir, 'vite.config.js'),
    root: rootDir,
    server: {
      middlewareMode: true,
      allowedHosts: true,
    },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.listen(port, '0.0.0.0', () => {
  console.log(`VoteQuest disponível em http://0.0.0.0:${port}`);
});
