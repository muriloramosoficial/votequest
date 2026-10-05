import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders as supabaseCorsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { DEFAULT_PIX_CONFIG } from '../_shared/pix-config.js'

const corsHeaders = {
  ...supabaseCorsHeaders,
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': `${supabaseCorsHeaders['Access-Control-Allow-Headers']}, x-admin-token`,
}

const validCandidates = new Set(['lula', 'flavio'])
const protocolPattern = /^[A-F0-9]{32}$/i
const projectUrl = Deno.env.get('SUPABASE_URL') ?? ''

function getServiceRoleKey() {
  const legacyKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    || Deno.env.get('VOTEQUEST_SUPABASE_SERVICE_ROLE_KEY')
  if (legacyKey) return legacyKey

  // Newer Supabase projects may expose secret keys as a JSON map.
  try {
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    return secretKeys.default ?? ''
  } catch {
    return ''
  }
}

const serviceRoleKey = getServiceRoleKey()
const supabase = projectUrl && serviceRoleKey
  ? createClient(projectUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  : null

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function parsePixFields(payload: string) {
  const fields: Record<string, string> = {}
  let offset = 0
  while (offset + 4 <= payload.length) {
    const tag = payload.slice(offset, offset + 2)
    const lengthText = payload.slice(offset + 2, offset + 4)
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null
    const end = offset + 4 + Number(lengthText)
    if (end > payload.length) return null
    fields[tag] = payload.slice(offset + 4, end)
    offset = end
    if (tag === '63') break
  }
  return offset === payload.length ? fields : null
}

function hasValidPixCrc(payload: string) {
  if (!/6304[0-9A-Fa-f]{4}$/.test(payload)) return false
  let crc = 0xffff
  for (const byte of new TextEncoder().encode(payload.slice(0, -4))) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).padStart(4, '0').toUpperCase() === payload.slice(-4).toUpperCase()
}

function getPixConfig() {
  const pixCode = (Deno.env.get('VOTEQUEST_PIX_CODE') || DEFAULT_PIX_CONFIG.pixCode).trim()
  const fields = parsePixFields(pixCode)
  const valid = Boolean(
    fields
      && fields['01'] === '11'
      && fields['54'] === '10.00'
      && fields['59'] === 'OMNIGOVS S COMERCIAIS'
      && fields['60'] === 'TOLEDO'
      && hasValidPixCrc(pixCode),
  )
  return {
    ready: valid,
    pixCode: valid ? pixCode : '',
    receiverName: fields?.['59'] || '',
    city: fields?.['60'] || '',
    issue: valid ? '' : 'invalid',
  }
}

function normalizeResults(data: any) {
  if (!data || typeof data !== 'object' || typeof data.demoMode !== 'boolean') {
    throw new Error('Supabase returned an invalid results payload.')
  }
  const verified = data.verifiedCounts || {}
  const manual = data.manualCounts || {}
  return {
    demoMode: data.demoMode,
    verifiedCounts: { lula: Number(verified.lula) || 0, flavio: Number(verified.flavio) || 0 },
    manualCounts: { lula: Number(manual.lula) || 0, flavio: Number(manual.flavio) || 0 },
  }
}

async function readResults(client = supabase) {
  if (!client) throw Object.assign(new Error('Supabase service credentials are unavailable.'), { code: 'supabase_not_configured' })
  const { data, error } = await client.rpc('votequest_public_results')
  if (error) throw error
  return normalizeResults(data)
}

function logDatabaseError(operation: string, error: any) {
  console.error(`[VoteQuest] ${operation}${error?.code ? ` (${error.code})` : ''}: ${error?.message || 'unknown error'}`)
}

function databaseFailure(operation: string, error: any) {
  logDatabaseError(operation, error)
  const notConfigured = error?.code === 'supabase_not_configured'
  return json(503, {
    error: notConfigured ? 'supabase_not_configured' : 'database_unavailable',
    message: notConfigured
      ? 'A API Supabase ainda não tem acesso ao banco. Confira os secrets da Edge Function.'
      : 'Banco Supabase indisponível ou migration ainda não aplicada. Confira o projeto e inicialize o banco.',
  })
}

function authorized(req: Request): { ok: true; response: null } | { ok: false; response: Response } {
  const expected = Deno.env.get('VOTEQUEST_ADMIN_TOKEN') || ''
  if (!expected) return { ok: false, response: json(503, {
    error: 'admin_not_configured',
    message: 'A revisão administrativa ainda não foi configurada nas secrets do Supabase.',
  }) }

  const supplied = req.headers.get('x-admin-token') || ''
  const expectedBytes = new TextEncoder().encode(expected)
  const suppliedBytes = new TextEncoder().encode(supplied)
  if (expectedBytes.length !== suppliedBytes.length) {
    return { ok: false, response: json(401, { error: 'unauthorized', message: 'Token administrativo inválido.' }) }
  }
  let mismatch = 0
  for (let i = 0; i < expectedBytes.length; i += 1) mismatch |= expectedBytes[i] ^ suppliedBytes[i]
  if (mismatch !== 0) {
    return { ok: false, response: json(401, { error: 'unauthorized', message: 'Token administrativo inválido.' }) }
  }
  return { ok: true, response: null }
}

async function bodyObject(req: Request) {
  try {
    const body = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

function getRoute(url: URL) {
  const requestedRoute = url.searchParams.get('route')
  if (requestedRoute) return requestedRoute.startsWith('/') ? requestedRoute : `/${requestedRoute}`
  const functionMarker = '/functions/v1/votequest-api'
  const markerIndex = url.pathname.indexOf(functionMarker)
  if (markerIndex >= 0) return url.pathname.slice(markerIndex + functionMarker.length) || '/'
  return url.pathname
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function newProtocol() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

async function handleHealth() {
  const pixConfig = getPixConfig()
  const base = {
    ok: true,
    api: true,
    databaseConfigured: Boolean(supabase),
    adminConfigured: Boolean(Deno.env.get('VOTEQUEST_ADMIN_TOKEN')),
    pixReady: pixConfig.ready,
  }
  try {
    const results = await readResults()
    return json(200, { ...base, databaseReady: true, demoMode: results.demoMode })
  } catch (error) {
    const notConfigured = (error as any)?.code === 'supabase_not_configured'
    if (!notConfigured) logDatabaseError('health check', error)
    return json(200, {
      ...base,
      databaseReady: false,
      demoMode: null,
      reason: notConfigured ? 'supabase_not_configured' : 'migration_missing_or_database_unavailable',
    })
  }
}

async function handleRequest(req: Request) {
  const method = req.method.toUpperCase()
  const url = new URL(req.url)
  const route = getRoute(url).replace(/\/+$/, '') || '/'
  const segments = route.split('/').filter(Boolean).map(decodeURIComponent)

  if (method === 'GET' && route === '/api/health') return handleHealth()
  if (method === 'GET' && route === '/api/pix/config') return json(200, getPixConfig())

  if (method === 'GET' && route === '/api/pix/results') {
    try {
      return json(200, await readResults())
    } catch (error) {
      return databaseFailure('public results', error)
    }
  }

  if (method === 'POST' && route === '/api/votes/submit') {
    const body = await bodyObject(req)
    const candidate = String(body.candidate || '').toLowerCase()
    const endToEndId = String(body.endToEndId || '').replace(/\s/g, '').toUpperCase()
    if (!validCandidates.has(candidate)) {
      return json(400, { error: 'invalid_candidate', message: 'Selecione uma opção válida.' })
    }
    if (endToEndId.length < 16 || endToEndId.length > 100 || !/^[A-Z0-9-]+$/.test(endToEndId)) {
      return json(400, { error: 'invalid_e2e', message: 'Informe o identificador E2E exibido no comprovante Pix.' })
    }
    if (!supabase) return databaseFailure('submit payment for review', Object.assign(new Error('Supabase is not configured.'), { code: 'supabase_not_configured' }))

    try {
      const { data, error } = await supabase.from('votequest_payments').insert({
        protocol: newProtocol(),
        candidate,
        end_to_end_id: endToEndId,
        payment_hash: await sha256(endToEndId),
      }).select('protocol, status').single()
      if (error) {
        if (error.code === '23505') {
          return json(409, { error: 'duplicate_payment', message: 'Este identificador Pix já foi enviado para revisão.' })
        }
        throw error
      }
      return json(201, { protocol: data.protocol, status: data.status })
    } catch (error) {
      return databaseFailure('submit payment for review', error)
    }
  }

  if (method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'votes' && segments[2] === 'status') {
    const protocol = segments[3].toUpperCase()
    if (!protocolPattern.test(protocol)) return json(400, { status: 'invalid_protocol', message: 'Protocolo inválido.' })
    try {
      if (!supabase) throw Object.assign(new Error('Supabase is not configured.'), { code: 'supabase_not_configured' })
      const { data, error } = await supabase.from('votequest_payments').select('status').eq('protocol', protocol).maybeSingle()
      if (error) throw error
      if (!data) return json(404, { status: 'not_found', message: 'Protocolo não encontrado.' })
      return json(200, { status: data.status })
    } catch (error) {
      return databaseFailure('check payment status', error)
    }
  }

  if (route === '/api/admin/votes' && method === 'GET') {
    const auth = authorized(req)
    if (!auth.ok) return auth.response
    try {
      if (!supabase) throw Object.assign(new Error('Supabase is not configured.'), { code: 'supabase_not_configured' })
      const [pendingResult, adjustmentsResult, results] = await Promise.all([
        supabase.from('votequest_payments')
          .select('protocol, candidate, end_to_end_id, created_at')
          .eq('status', 'pending').order('created_at', { ascending: true }).limit(200),
        supabase.from('votequest_manual_adjustments')
          .select('id, candidate, amount, reason, created_at')
          .order('created_at', { ascending: false }).limit(20),
        readResults(supabase),
      ])
      if (pendingResult.error) throw pendingResult.error
      if (adjustmentsResult.error) throw adjustmentsResult.error
      return json(200, {
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
      })
    } catch (error) {
      return databaseFailure('load admin queue', error)
    }
  }

  if (route === '/api/admin/settings' && method === 'PATCH') {
    const auth = authorized(req)
    if (!auth.ok) return auth.response
    const body = await bodyObject(req)
    if (typeof body.demoMode !== 'boolean') {
      return json(400, { error: 'invalid_demo_mode', message: 'Informe true ou false para o modo demonstrativo.' })
    }
    try {
      if (!supabase) throw Object.assign(new Error('Supabase is not configured.'), { code: 'supabase_not_configured' })
      const { data, error } = await supabase.from('votequest_settings')
        .update({ demo_mode: body.demoMode, updated_at: new Date().toISOString() })
        .eq('id', 1).select('demo_mode').single()
      if (error) throw error
      return json(200, { demoMode: data.demo_mode })
    } catch (error) {
      return databaseFailure('update public results mode', error)
    }
  }

  if (route === '/api/admin/manual-votes' && method === 'POST') {
    const auth = authorized(req)
    if (!auth.ok) return auth.response
    const body = await bodyObject(req)
    const candidate = String(body.candidate || '').toLowerCase()
    const amount = Number(body.amount)
    const reason = String(body.reason || '').trim()
    if (!validCandidates.has(candidate)) return json(400, { error: 'invalid_candidate', message: 'Selecione um candidato válido.' })
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
      return json(400, { error: 'invalid_amount', message: 'Informe um número inteiro entre 1 e 1.000.000.' })
    }
    if (reason.length < 3 || reason.length > 160) {
      return json(400, { error: 'invalid_reason', message: 'Informe um motivo de 3 a 160 caracteres para a auditoria.' })
    }
    try {
      if (!supabase) throw Object.assign(new Error('Supabase is not configured.'), { code: 'supabase_not_configured' })
      const { data: adjustment, error } = await supabase.rpc('votequest_add_manual_votes', {
        p_candidate: candidate,
        p_amount: amount,
        p_reason: reason,
      })
      if (error) throw error
      const results = await readResults(supabase)
      return json(201, {
        adjustment,
        manualCounts: results.manualCounts,
        verifiedCounts: results.verifiedCounts,
        demoMode: results.demoMode,
      })
    } catch (error) {
      return databaseFailure('add manual votes', error)
    }
  }

  if (method === 'PATCH' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'votes') {
    const auth = authorized(req)
    if (!auth.ok) return auth.response
    const protocol = segments[3].toUpperCase()
    if (!protocolPattern.test(protocol)) return json(400, { error: 'invalid_protocol', message: 'Protocolo inválido.' })
    const body = await bodyObject(req)
    const decision = String(body.decision || '').toLowerCase()
    if (!['approve', 'reject'].includes(decision)) {
      return json(400, { error: 'invalid_decision', message: 'Escolha aprovar ou rejeitar.' })
    }
    try {
      if (!supabase) throw Object.assign(new Error('Supabase is not configured.'), { code: 'supabase_not_configured' })
      const { data, error } = await supabase.rpc('votequest_decide_payment', {
        p_protocol: protocol,
        p_decision: decision,
      })
      if (error) throw error
      if (data?.status === 'not_found') return json(404, { error: 'not_found', message: 'Pedido pendente não encontrado.' })
      if (!['approved', 'rejected'].includes(data?.status)) throw new Error('Supabase returned an invalid decision status.')
      return json(200, { status: data.status })
    } catch (error) {
      return databaseFailure('decide payment', error)
    }
  }

  return json(404, { error: 'not_found', message: 'Rota de API não encontrada.' })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  try {
    return await handleRequest(req)
  } catch (error) {
    logDatabaseError('request handler', error)
    return json(500, { error: 'internal_error', message: 'Erro interno da API VoteQuest.' })
  }
})
