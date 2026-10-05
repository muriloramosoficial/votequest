import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_PIX_CONFIG } from '../shared/pix-config.js';

const validCandidates = new Set(['lula', 'flavio']);
const protocolPattern = /^[A-F0-9]{32}$/i;
let cachedClient;

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function hasSupabaseConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabase() {
  if (cachedClient) return cachedClient;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceRoleKey) {
    const error = new Error('Supabase backend is not configured.');
    error.code = 'supabase_not_configured';
    throw error;
  }
  cachedClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return cachedClient;
}

function parsePixFields(payload) {
  const fields = {};
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const tag = payload.slice(offset, offset + 2);
    const lengthText = payload.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null;
    const end = offset + 4 + Number(lengthText);
    if (end > payload.length) return null;
    fields[tag] = payload.slice(offset + 4, end);
    offset = end;
    if (tag === '63') break;
  }
  return offset === payload.length ? fields : null;
}

function hasValidPixCrc(payload) {
  if (!/6304[0-9A-Fa-f]{4}$/.test(payload)) return false;
  let crc = 0xffff;
  for (const byte of Buffer.from(payload.slice(0, -4), 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).padStart(4, '0').toUpperCase() === payload.slice(-4).toUpperCase();
}

function getPixConfig() {
  const pixCode = String(process.env.VOTEQUEST_PIX_CODE || DEFAULT_PIX_CONFIG.pixCode).trim();
  const fields = parsePixFields(pixCode);
  const valid = Boolean(
    fields && fields['01'] === '11' && fields['54'] === '10.00' &&
    fields['59'] === 'OMNIGOVS S COMERCIAIS' && fields['60'] === 'TOLEDO' &&
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

function normalizedResults(data) {
  if (!data || typeof data !== 'object' || typeof data.demoMode !== 'boolean') {
    throw new Error('Supabase returned an invalid results payload.');
  }
  const verified = data.verifiedCounts || {};
  const manual = data.manualCounts || {};
  return {
    demoMode: data.demoMode,
    verifiedCounts: { lula: Number(verified.lula) || 0, flavio: Number(verified.flavio) || 0 },
    manualCounts: { lula: Number(manual.lula) || 0, flavio: Number(manual.flavio) || 0 },
  };
}

async function readResults(client = getSupabase()) {
  const { data, error } = await client.rpc('votequest_public_results');
  if (error) throw error;
  return normalizedResults(data);
}

function bodyObject(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try {
      const body = JSON.parse(req.body);
      return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    } catch {
      return {};
    }
  }
  return {};
}

function header(req, name) {
  const fromExpress = typeof req.get === 'function' ? req.get(name) : undefined;
  const value = fromExpress ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function authorizeAdmin(req, res) {
  const expected = String(process.env.VOTEQUEST_ADMIN_TOKEN || '');
  if (!expected) {
    json(res, 503, {
      error: 'admin_not_configured',
      message: 'A revisão administrativa ainda não foi configurada no servidor.',
    });
    return false;
  }
  const supplied = header(req, 'x-admin-token');
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    json(res, 401, { error: 'unauthorized', message: 'Token administrativo inválido.' });
    return false;
  }
  return true;
}

function reportDatabaseError(operation, error) {
  const code = error?.code ? ` (${error.code})` : '';
  console.error(`[VoteQuest] ${operation}${code}: ${error?.message || 'erro não identificado'}`);
}

function databaseFailure(res, operation, error) {
  reportDatabaseError(operation, error);
  const notConfigured = error?.code === 'supabase_not_configured';
  json(res, 503, {
    error: notConfigured ? 'supabase_not_configured' : 'database_unavailable',
    message: notConfigured
      ? 'Backend Supabase não configurado no ambiente da API do Vercel.'
      : 'Banco Supabase indisponível ou ainda não inicializado. Confira as variáveis e aplique a migration do VoteQuest.',
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function handleHealth(res) {
  const pixConfig = getPixConfig();
  const common = {
    ok: true,
    api: true,
    databaseConfigured: hasSupabaseConfig(),
    adminConfigured: Boolean(process.env.VOTEQUEST_ADMIN_TOKEN),
    pixReady: pixConfig.ready,
  };
  try {
    const results = await readResults();
    return json(res, 200, { ...common, databaseReady: true, demoMode: results.demoMode });
  } catch (error) {
    const notConfigured = error?.code === 'supabase_not_configured';
    if (!notConfigured) reportDatabaseError('health check', error);
    return json(res, 200, {
      ...common,
      databaseReady: false,
      demoMode: null,
      reason: notConfigured ? 'supabase_not_configured' : 'migration_missing_or_database_unavailable',
    });
  }
}

async function handleRequest(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  const requestUrl = req.originalUrl || req.url || '/';
  const pathname = new URL(requestUrl, 'http://votequest.local').pathname.replace(/\/+$/, '') || '/';
  const segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));

  if (method === 'GET' && pathname === '/api/health') return handleHealth(res);
  if (method === 'GET' && pathname === '/api/pix/config') return json(res, 200, getPixConfig());

  if (method === 'GET' && pathname === '/api/pix/results') {
    try {
      return json(res, 200, await readResults());
    } catch (error) {
      return databaseFailure(res, 'public results', error);
    }
  }

  if (method === 'POST' && pathname === '/api/votes/submit') {
    const body = bodyObject(req);
    const candidate = String(body.candidate || '').toLowerCase();
    const endToEndId = String(body.endToEndId || '').replace(/\s/g, '').toUpperCase();
    if (!validCandidates.has(candidate)) {
      return json(res, 400, { error: 'invalid_candidate', message: 'Selecione uma opção válida.' });
    }
    if (endToEndId.length < 16 || endToEndId.length > 100 || !/^[A-Z0-9-]+$/.test(endToEndId)) {
      return json(res, 400, { error: 'invalid_e2e', message: 'Informe o identificador E2E exibido no comprovante Pix.' });
    }

    const protocol = crypto.randomBytes(16).toString('hex').toUpperCase();
    try {
      const client = getSupabase();
      const { data, error } = await client.from('votequest_payments').insert({
        protocol,
        candidate,
        end_to_end_id: endToEndId,
        payment_hash: sha256(endToEndId),
      }).select('protocol, status').single();
      if (error) {
        if (error.code === '23505') {
          return json(res, 409, { error: 'duplicate_payment', message: 'Este identificador Pix já foi enviado para revisão.' });
        }
        throw error;
      }
      return json(res, 201, { protocol: data.protocol, status: data.status });
    } catch (error) {
      return databaseFailure(res, 'submit payment for review', error);
    }
  }

  if (method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'votes' && segments[2] === 'status') {
    const protocol = segments[3].toUpperCase();
    if (!protocolPattern.test(protocol)) {
      return json(res, 400, { status: 'invalid_protocol', message: 'Protocolo inválido.' });
    }
    try {
      const { data, error } = await getSupabase().from('votequest_payments')
        .select('status').eq('protocol', protocol).maybeSingle();
      if (error) throw error;
      if (!data) return json(res, 404, { status: 'not_found', message: 'Protocolo não encontrado.' });
      return json(res, 200, { status: data.status });
    } catch (error) {
      return databaseFailure(res, 'check payment status', error);
    }
  }

  if (pathname === '/api/admin/votes' && method === 'GET') {
    if (!authorizeAdmin(req, res)) return;
    try {
      const client = getSupabase();
      const [pendingResult, adjustmentsResult, results] = await Promise.all([
        client.from('votequest_payments')
          .select('protocol, candidate, end_to_end_id, created_at')
          .eq('status', 'pending').order('created_at', { ascending: true }).limit(200),
        client.from('votequest_manual_adjustments')
          .select('id, candidate, amount, reason, created_at')
          .order('created_at', { ascending: false }).limit(20),
        readResults(client),
      ]);
      if (pendingResult.error) throw pendingResult.error;
      if (adjustmentsResult.error) throw adjustmentsResult.error;
      return json(res, 200, {
        pending: (pendingResult.data || []).map((item) => ({
          protocol: item.protocol,
          candidate: item.candidate,
          endToEndId: item.end_to_end_id,
          createdAt: item.created_at,
        })),
        demoMode: results.demoMode,
        manualCounts: results.manualCounts,
        recentManualAdjustments: (adjustmentsResult.data || []).map((item) => ({
          id: item.id,
          candidate: item.candidate,
          amount: item.amount,
          reason: item.reason,
          createdAt: item.created_at,
        })),
      });
    } catch (error) {
      return databaseFailure(res, 'load admin queue', error);
    }
  }

  if (pathname === '/api/admin/settings' && method === 'PATCH') {
    if (!authorizeAdmin(req, res)) return;
    const body = bodyObject(req);
    if (typeof body.demoMode !== 'boolean') {
      return json(res, 400, { error: 'invalid_demo_mode', message: 'Informe true ou false para o modo demonstrativo.' });
    }
    try {
      const { data, error } = await getSupabase().from('votequest_settings')
        .update({ demo_mode: body.demoMode, updated_at: new Date().toISOString() })
        .eq('id', 1).select('demo_mode').single();
      if (error) throw error;
      return json(res, 200, { demoMode: data.demo_mode });
    } catch (error) {
      return databaseFailure(res, 'update public results mode', error);
    }
  }

  if (pathname === '/api/admin/manual-votes' && method === 'POST') {
    if (!authorizeAdmin(req, res)) return;
    const body = bodyObject(req);
    const candidate = String(body.candidate || '').toLowerCase();
    const amount = Number(body.amount);
    const reason = String(body.reason || '').trim();
    if (!validCandidates.has(candidate)) {
      return json(res, 400, { error: 'invalid_candidate', message: 'Selecione um candidato válido.' });
    }
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
      return json(res, 400, { error: 'invalid_amount', message: 'Informe um número inteiro entre 1 e 1.000.000.' });
    }
    if (reason.length < 3 || reason.length > 160) {
      return json(res, 400, { error: 'invalid_reason', message: 'Informe um motivo de 3 a 160 caracteres para a auditoria.' });
    }
    try {
      const client = getSupabase();
      const { data: adjustment, error } = await client.rpc('votequest_add_manual_votes', {
        p_candidate: candidate,
        p_amount: amount,
        p_reason: reason,
      });
      if (error) throw error;
      const results = await readResults(client);
      return json(res, 201, {
        adjustment,
        manualCounts: results.manualCounts,
        verifiedCounts: results.verifiedCounts,
        demoMode: results.demoMode,
      });
    } catch (error) {
      return databaseFailure(res, 'add manual votes', error);
    }
  }

  if (method === 'PATCH' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'votes') {
    if (!authorizeAdmin(req, res)) return;
    const protocol = segments[3].toUpperCase();
    if (!protocolPattern.test(protocol)) {
      return json(res, 400, { error: 'invalid_protocol', message: 'Protocolo inválido.' });
    }
    const decision = String(bodyObject(req).decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) {
      return json(res, 400, { error: 'invalid_decision', message: 'Escolha aprovar ou rejeitar.' });
    }
    try {
      const { data, error } = await getSupabase().rpc('votequest_decide_payment', {
        p_protocol: protocol,
        p_decision: decision,
      });
      if (error) throw error;
      if (data?.status === 'not_found') {
        return json(res, 404, { error: 'not_found', message: 'Pedido pendente não encontrado.' });
      }
      if (!['approved', 'rejected'].includes(data?.status)) {
        throw new Error('Supabase returned an invalid decision status.');
      }
      return json(res, 200, { status: data.status });
    } catch (error) {
      return databaseFailure(res, 'decide payment', error);
    }
  }

  return json(res, 404, { error: 'not_found', message: 'Rota de API não encontrada.' });
}

export async function handleSupabaseApi(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (error) {
    reportDatabaseError('request handler', error);
    return json(res, 500, { error: 'internal_error', message: 'Erro interno da API VoteQuest.' });
  }
}
