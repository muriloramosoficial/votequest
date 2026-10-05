import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const app = express();
const port = Number(process.env.PORT) || 4173;

app.disable('x-powered-by');

function parsePixFields(payload) {
  const fields = {};
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const tag = payload.slice(offset, offset + 2);
    const lengthText = payload.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null;
    const length = Number(lengthText);
    const valueStart = offset + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > payload.length) return null;
    fields[tag] = payload.slice(valueStart, valueEnd);
    offset = valueEnd;
    if (tag === '63') break;
  }
  return offset === payload.length ? fields : null;
}

function hasValidPixCrc(payload) {
  if (!/6304[0-9A-Fa-f]{4}$/.test(payload)) return false;
  const crcInput = payload.slice(0, -4);
  let crc = 0xffff;
  for (const byte of Buffer.from(crcInput, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).padStart(4, '0').toUpperCase() === payload.slice(-4).toUpperCase();
}

function getPixConfig() {
  const pixCode = String(process.env.VOTEQUEST_PIX_CODE || '').trim();
  if (!pixCode) return { ready: false, pixCode: '', receiverName: '', city: '', issue: 'missing' };
  const fields = parsePixFields(pixCode);
  const valid = Boolean(
    fields &&
    fields['01'] === '11' &&
    fields['54'] === '10.00' &&
    fields['59'] &&
    fields['60'] &&
    hasValidPixCrc(pixCode),
  );
  return {
    ready: valid,
    pixCode: valid ? pixCode : '',
    receiverName: fields?.['59'] || '',
    city: fields?.['60'] || '',
    issue: valid ? '' : 'invalid',
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/pix/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getPixConfig());
});

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
