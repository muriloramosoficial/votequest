import { DEFAULT_PIX_CONFIG } from '../_shared/pix-config.js'

const validCandidates = new Set(['lula', 'flavio'])
const protocolPattern = /^[A-F0-9]{32}$/i

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-admin-token',
  'Access-Control-Max-Age': '86400',
}

type Env = Record<string, string | undefined>

function readEnv(env: Env, name: string): string {
  const fromContext = env[name]
  if (fromContext) return fromContext
  if (typeof Deno !== 'undefined') return Deno.env.get(name) ?? ''
  return ''
}

function getServiceRoleKey(env: Env): string {
  const direct = readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY') || readEnv(env, 'VOTEQUEST_SUPABASE_SERVICE_ROLE_KEY')
  if (direct) return direct

  // Newer Supabase projects expose rotated secret keys as a JSON map.
  try {
    const secretKeys = JSON.parse(readEnv(env, 'SUPABASE_SECRET_KEYS') || '{}')
    return typeof secretKeys?.default === 'string' ? secretKeys.default : ''
  } catch {
    return ''
  }
}

function getProjectUrl(env: Env): string {
  return readEnv(env, 'SUPABASE_URL').replace(/\/+$/, '')
}

class SupabaseRequestError extends Error {
  status: number
  code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'SupabaseRequestError'
    this.status = status
    this.code = code
  }
}

function json(status: number, payload: unknown): Response {
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

function serviceHeaders(env: Env): Record<string, string> {
  const key = getServiceRoleKey(env)
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

async function rest(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const base = getProjectUrl(env)
  if (!base || !getServiceRoleKey(env)) {
    throw Object.assign(new Error('Supabase service credentials are unavailable.'), {
      code: 'supabase_not_configured',
    })
  }

  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { ...serviceHeaders(env), ...((init.headers as Record<string, string>) || {}) },
  })

  const raw = await response.text()
  let parsed: any = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }

  if (!response.ok) {
    throw new SupabaseRequestError(
      parsed?.message || parsed?.hint || raw || response.statusText || 'Supabase request failed.',
      response.status,
      parsed?.code,
    )
  }
  return parsed
}

async function rpc(env: Env, fn: string, payload: unknown = {}): Promise<any> {
  return rest(env, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(payload) })
}

function logDatabaseError(operation: string, error: any) {
  console.error(`[VoteQuest] ${operation}${error?.code ? ` (${error.code})` : ''}: ${error?.message || 'unknown error'}`)
}

function databaseFailure(operation: string, error: any): Response {
  logDatabaseError(operation, error)
  const notConfigured = error?.code === 'supabase_not_configured'
  return json(notConfigured ? 503 : 500, {
    error: notConfigured ? 'supabase_not_configured' : 'database_unavailable',
    message: notConfigured
      ? 'A API Supabase ainda não tem acesso ao banco. Confira os secrets da Edge Function.'
      : 'Banco Supabase indisponível ou migration ainda não aplicada. Confira o projeto e inicialize o banco.',
  })
}

function parsePixFields(payload: string): Record<string, string> | null {
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

function hasValidPixCrc(payload: string): boolean {
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

function getPixConfig(env: Env) {
  const pixCode = (readEnv(env, 'VOTEQUEST_PIX_CODE') || DEFAULT_PIX_CONFIG.pixCode).trim()
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
  const verified = data?.verifiedCounts || {}
  return {
    verifiedCounts: {
      lula: Number(verified.lula) || 0,
      flavio: Number(verified.flavio) || 0,
    },
  }
}

async function readResults(env: Env) {
  const data = await rpc(env, 'votequest_public_results')
  return normalizeResults(data)
}

function authorized(env: Env, req: Request): { ok: true; response: null } | { ok: false; response: Response } {
  const expected = readEnv(env, 'VOTEQUEST_ADMIN_TOKEN')
  if (!expected) {
    return {
      ok: false,
      response: json(503, {
        error: 'admin_not_configured',
        message: 'A revisão administrativa ainda não foi configurada nas secrets do Supabase.',
      }),
    }
  }

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

async function bodyObject(req: Request): Promise<Record<string, any>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

function getRoute(url: URL): string {
  const requestedRoute = url.searchParams.get('route')
  if (requestedRoute) return requestedRoute.startsWith('/') ? requestedRoute : `/${requestedRoute}`
  const functionMarker = '/functions/v1/votequest-api'
  const markerIndex = url.pathname.indexOf(functionMarker)
  if (markerIndex >= 0) return url.pathname.slice(markerIndex + functionMarker.length) || '/'
  return url.pathname
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function newProtocol(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

async function handleHealth(env: Env): Promise<Response> {
  const pixConfig = getPixConfig(env)
  const base = {
    ok: true,
    api: true,
    adminConfigured: Boolean(readEnv(env, 'VOTEQUEST_ADMIN_TOKEN')),
    pixReady: pixConfig.ready,
  }
  try {
    await readResults(env)
    return json(200, { ...base, databaseReady: true })
  } catch (error) {
    const notConfigured = error?.code === 'supabase_not_configured'
    if (!notConfigured) logDatabaseError('health check', error)
    return json(200, {
      ...base,
      databaseReady: false,
      reason: notConfigured ? 'supabase_not_configured' : 'migration_missing_or_database_unavailable',
    })
  }
}

async function handleRequest(req: Request, env: Env): Promise<Response> {
  const method = req.method.toUpperCase()
  const url = new URL(req.url)
  const route = getRoute(url).replace(/\/+$/, '') || '/'
  const segments = route.split('/').filter(Boolean).map(decodeURIComponent)

  if (method === 'GET' && route === '/api/health') return handleHealth(env)
  if (method === 'GET' && route === '/api/pix/config') return json(200, getPixConfig(env))

  if (method === 'GET' && route === '/api/pix/results') {
    try {
      return json(200, await readResults(env))
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

    try {
      const inserted = await rest(
        env,
        'votequest_payments?select=protocol,status',
        {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            protocol: newProtocol(),
            candidate,
            end_to_end_id: endToEndId,
            payment_hash: await sha256(endToEndId),
          }),
        },
      )
      const record = Array.isArray(inserted) ? inserted[0] : inserted
      if (!record?.protocol) throw new Error('Supabase did not return the created protocol.')
      return json(201, { protocol: record.protocol, status: record.status })
    } catch (error) {
      if (error instanceof SupabaseRequestError && error.status === 409) {
        return json(409, { error: 'duplicate_payment', message: 'Este identificador Pix já foi enviado para revisão.' })
      }
      if (error instanceof SupabaseRequestError && error.status === 400) {
        return json(400, { error: 'invalid_payment', message: error.message })
      }
      return databaseFailure('submit payment for review', error)
    }
  }

  if (method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'votes' && segments[2] === 'status') {
    const protocol = segments[3].toUpperCase()
    if (!protocolPattern.test(protocol)) return json(400, { status: 'invalid_protocol', message: 'Protocolo inválido.' })
    try {
      const rows = await rest(env, `votequest_payments?select=status&protocol=eq.${protocol}&limit=1`)
      const record = Array.isArray(rows) ? rows[0] : null
      if (!record) return json(404, { status: 'not_found', message: 'Protocolo não encontrado.' })
      return json(200, { status: record.status })
    } catch (error) {
      return databaseFailure('check payment status', error)
    }
  }

  if (method === 'GET' && route === '/api/admin/votes') {
    const auth = authorized(env, req)
    if (!auth.ok) return auth.response
    try {
      const [pending, results] = await Promise.all([
        rest(env, 'votequest_payments?select=protocol,candidate,end_to_end_id,created_at&status=eq.pending&order=created_at.asc&limit=200'),
        readResults(env),
      ])
      return json(200, {
        pending: (Array.isArray(pending) ? pending : []).map((item) => ({
          protocol: item.protocol,
          candidate: item.candidate,
          endToEndId: item.end_to_end_id,
          createdAt: item.created_at,
        })),
        verifiedCounts: results.verifiedCounts,
      })
    } catch (error) {
      return databaseFailure('load admin queue', error)
    }
  }

  if (method === 'PATCH' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'votes') {
    const auth = authorized(env, req)
    if (!auth.ok) return auth.response
    const protocol = segments[3].toUpperCase()
    if (!protocolPattern.test(protocol)) return json(400, { error: 'invalid_protocol', message: 'Protocolo inválido.' })
    const body = await bodyObject(req)
    const decision = String(body.decision || '').toLowerCase()
    if (!['approve', 'reject'].includes(decision)) {
      return json(400, { error: 'invalid_decision', message: 'Escolha aprovar ou rejeitar.' })
    }

    try {
      const data = await rpc(env, 'votequest_decide_payment', { p_protocol: protocol, p_decision: decision })
      if (data?.status === 'not_found') return json(404, { error: 'not_found', message: 'Pedido pendente não encontrado.' })
      if (!['approved', 'rejected'].includes(data?.status)) {
        throw new Error('Supabase returned an invalid decision status.')
      }
      return json(200, { status: data.status })
    } catch (error) {
      return databaseFailure('decide payment', error)
    }
  }

  return json(404, { error: 'not_found', message: 'Rota de API não encontrada.' })
}

if (typeof Deno !== 'undefined') {
  const runtimeEnv: Env = {}
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
    try {
      return await handleRequest(req, runtimeEnv)
    } catch (error) {
      logDatabaseError('request handler', error)
      return json(500, { error: 'internal_error', message: 'Erro interno da API VoteQuest.' })
    }
  })
}

export { corsHeaders, getPixConfig, handleRequest, parsePixFields, hasValidPixCrc, normalizeResults }