import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const app = express();
const port = Number(process.env.PORT) || 4173;
const validCandidates = new Set(['lula', 'flavio']);
const dataFile = path.resolve(rootDir, process.env.VOTEQUEST_DATA_FILE || './data/votes.json');

app.disable('x-powered-by');
app.use(express.json({ limit: '12kb' }));

function emptyStore() {
  return {
    counts: { lula: 0, flavio: 0 },
    pending: [],
    usedPaymentHashes: [],
    decisions: [],
  };
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return {
      counts: {
        lula: Math.max(0, Number(data?.counts?.lula) || 0),
        flavio: Math.max(0, Number(data?.counts?.flavio) || 0),
      },
      pending: Array.isArray(data?.pending) ? data.pending : [],
      usedPaymentHashes: Array.isArray(data?.usedPaymentHashes) ? data.usedPaymentHashes : [],
      decisions: Array.isArray(data?.decisions) ? data.decisions : [],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Não foi possível ler o arquivo de revisão de pagamentos.');
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, dataFile);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getPixCode() {
  const configured = String(process.env.VOTEQUEST_PIX_CODE || '').trim();
  if (configured) return configured;
  // The Pix payload is public by design. Fall back to the checked-in example so the preview works without a local .env.
  try {
    const example = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');
    const line = example.split(/\r?\n/).find((item) => item.startsWith('VOTEQUEST_PIX_CODE='));
    return line ? line.slice('VOTEQUEST_PIX_CODE='.length).trim() : '';
  } catch {
    return '';
  }
}

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
  const pixCode = getPixCode();
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

function authenticateAdmin(req, res, next) {
  const expected = String(process.env.VOTEQUEST_ADMIN_TOKEN || '');
  if (!expected) {
    return res.status(503).json({
      error: 'admin_not_configured',
      message: 'A revisão administrativa ainda não foi configurada no servidor.',
    });
  }
  const supplied = String(req.get('x-admin-token') || '');
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Token administrativo inválido.' });
  }
  return next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/pix/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getPixConfig());
});

app.get('/api/pix/results', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(readStore().counts);
});

app.post('/api/votes/submit', (req, res) => {
  const candidate = String(req.body?.candidate || '').toLowerCase();
  const endToEndId = String(req.body?.endToEndId || '').replace(/\s/g, '').toUpperCase();
  if (!validCandidates.has(candidate)) {
    return res.status(400).json({ error: 'invalid_candidate', message: 'Selecione uma opção válida.' });
  }
  if (endToEndId.length < 16 || endToEndId.length > 100 || !/^[A-Z0-9-]+$/.test(endToEndId)) {
    return res.status(400).json({ error: 'invalid_e2e', message: 'Informe o identificador E2E exibido no comprovante Pix.' });
  }

  const paymentHash = sha256(endToEndId);
  const store = readStore();
  if (store.usedPaymentHashes.includes(paymentHash) || store.pending.some((item) => item.paymentHash === paymentHash)) {
    return res.status(409).json({ error: 'duplicate_payment', message: 'Este identificador Pix já foi enviado para revisão.' });
  }

  const protocol = crypto.randomBytes(16).toString('hex').toUpperCase();
  store.pending.push({
    protocol,
    candidate,
    endToEndId,
    paymentHash,
    createdAt: new Date().toISOString(),
  });
  try {
    writeStore(store);
  } catch {
    return res.status(503).json({ error: 'storage_unavailable', message: 'Não foi possível guardar o pedido para revisão. Tente novamente mais tarde.' });
  }

  return res.status(201).json({ protocol, status: 'pending' });
});

app.get('/api/votes/status/:protocol', (req, res) => {
  const protocol = String(req.params.protocol || '').toUpperCase();
  const store = readStore();
  if (store.pending.some((item) => item.protocol === protocol)) {
    return res.json({ status: 'pending' });
  }
  const decision = store.decisions.find((item) => item.protocol === protocol);
  if (decision) return res.json({ status: decision.status });
  return res.status(404).json({ status: 'not_found', message: 'Protocolo não encontrado.' });
});

app.get('/api/admin/votes', authenticateAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const pending = readStore().pending.map(({ protocol, candidate, endToEndId, createdAt }) => ({
    protocol,
    candidate,
    endToEndId,
    createdAt,
  }));
  return res.json({ pending });
});

app.patch('/api/admin/votes/:protocol', authenticateAdmin, (req, res) => {
  const protocol = String(req.params.protocol || '').toUpperCase();
  const decision = String(req.body?.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'invalid_decision', message: 'Escolha aprovar ou rejeitar.' });
  }

  const store = readStore();
  const pendingIndex = store.pending.findIndex((item) => item.protocol === protocol);
  if (pendingIndex < 0) return res.status(404).json({ error: 'not_found', message: 'Pedido pendente não encontrado.' });

  const [item] = store.pending.splice(pendingIndex, 1);
  if (decision === 'approve') store.counts[item.candidate] += 1;
  store.usedPaymentHashes.push(item.paymentHash);
  store.usedPaymentHashes = store.usedPaymentHashes.slice(-50000);
  store.decisions.push({
    protocol,
    status: decision === 'approve' ? 'approved' : 'rejected',
    decidedAt: new Date().toISOString(),
  });
  store.decisions = store.decisions.slice(-10000);

  try {
    writeStore(store);
  } catch {
    return res.status(503).json({ error: 'storage_unavailable', message: 'Não foi possível salvar a decisão. Tente novamente.' });
  }
  return res.json({ status: decision === 'approve' ? 'approved' : 'rejected', counts: store.counts });
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
