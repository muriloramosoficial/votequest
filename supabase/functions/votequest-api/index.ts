import { DEFAULT_PIX_CONFIG } from '../_shared/pix-config.js'

const validCandidates = new Set(['lula', 'flavio'])
const protocolPattern = /^[A-F0-9]{32}$/i

// Reference codes go into the Pix TxID (field 62.05), so they stay short and are restricted to
// characters every banking app renders well. 0/O and 1/I/L are left out because they are the
// usual source of transcription mistakes when the admin reads the code back from a statement.
const referencePattern = /^[23456789A-HJ-NP-Z]{8}$/
const referenceAlphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const maxTxidLength = 25
const defaultVoteWindowSeconds = 3600

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-admin-token',
  'Access-Control-Max-Age': '86400',
}

type Env = Record<string, string | undefined>
type PixField = { tag: string; value: string }

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

function parsePixTlv(payload: string): PixField[] | null {
  const fields: PixField[] = []
  let offset = 0
  while (offset + 4 <= payload.length) {
    const tag = payload.slice(offset, offset + 2)
    const lengthText = payload.slice(offset + 2, offset + 4)
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) return null
    const end = offset + 4 + Number(lengthText)
    if (end > payload.length) return null
    fields.push({ tag, value: payload.slice(offset + 4, end) })
    offset = end
    if (tag === '63') break
  }
  return offset === payload.length ? fields : null
}

function parsePixFields(payload: string): Record<string, string> | null {
  const fields = parsePixTlv(payload)
  if (!fields) return null
  const record: Record<string, string> = {}
  for (const field of fields) record[field.tag] = field.value
  return record
}

function pixCrc16(payload: string): string {
  let crc = 0xffff
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).padStart(4, '0').toUpperCase()
}

function hasValidPixCrc(payload: string): boolean {
  if (!/6304[0-9A-Fa-f]{4}$/.test(payload)) return false
  return pixCrc16(payload.slice(0, -4)) === payload.slice(-4).toUpperCase()
}

function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, '0')}${value}`
}

// Rebuilds the BR Code with a per-vote TxID in the additional data field, then recomputes the
// CRC16. Everything else (key, receiver, city, amount) comes from the validated base payload, so
// the payer always sees the same receiver and the same R$ 10,00 amount.
function buildDynamicPixCode(basePixCode: string, txid: string): string | null {
  if (!referencePattern.test(txid) || txid.length > maxTxidLength) return null
  const fields = parsePixTlv(basePixCode)
  if (!fields) return null

  // 63 (checksum) is always the last field of a BR Code, so the rebuilt payload keeps every
  // other field in its original order and re-appends the additional data before the checksum.
  const kept = fields
    .filter((field) => field.tag !== '62' && field.tag !== '63')
    .map((field) => tlv(field.tag, field.value))

  const prefix = `${kept.join('')}${tlv('62', tlv('05', txid))}6304`
  const payload = `${prefix}${pixCrc16(prefix)}`
  return hasValidPixCrc(payload) ? payload : null
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
    amount: fields?.['54'] || '',
    receiverName: fields?.['59'] || '',
    city: fields?.['60'] || '',
    issue: valid ? '' : 'invalid',
  }
}

// Rejection sampling keeps the distribution uniform even though 256 is not a multiple of the
// alphabet size. Collisions are impossible in practice and the unique index would reject them.
function newReferenceCode(): string {
  const limit = Math.floor(256 / referenceAlphabet.length) * referenceAlphabet.length
  let code = ''
  while (code.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte >= limit) continue
      code += referenceAlphabet[byte % referenceAlphabet.length]
      if (code.length === 8) break
    }
  }
  return code
}

function voteWindowSeconds(env: Env): number {
  const minutes = Number(readEnv(env, 'VOTEQUEST_VOTE_WINDOW_MINUTES'))
  if (!Number.isFinite(minutes) || minutes <= 0) return defaultVoteWindowSeconds
  return Math.min(Math.max(Math.floor(minutes * 60), 300), 86400)
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
    voteWindowSeconds: voteWindowSeconds(env),
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

  // Mints the short reference code and the per-vote Pix payload. The voter never types a bank
  // transaction id; they just scan this QR and pay.
  if (method === 'POST' && route === '/api/votes/intent') {
    const pixConfig = getPixConfig(env)
    if (!pixConfig.ready) {
      return json(503, { error: 'pix_not_configured', message: 'O Pix ainda não está configurado.' })
    }

    const body = await bodyObject(req)
    const candidate = String(body.candidate || '').toLowerCase()
    if (!validCandidates.has(candidate)) {
      return json(400, { error: 'invalid_candidate', message: 'Selecione uma opção válida.' })
    }

    const expiresInSeconds = voteWindowSeconds(env)
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()

    // Retrying only matters if a reference code ever collides, which the unique index prevents.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const referenceCode = newReferenceCode()
      const pixCode = buildDynamicPixCode(pixConfig.pixCode, referenceCode)
      if (!pixCode) {
        return json(500, { error: 'pix_payload_invalid', message: 'Não foi possível gerar o código Pix deste voto.' })
      }

      try {
        const inserted = await rest(
          env,
          'votequest_payments?select=protocol,reference_code,status,expires_at',
          {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              protocol: newProtocol(),
              candidate,
              reference_code: referenceCode,
              payment_hash: await sha256(referenceCode),
              expires_at: expiresAt,
            }),
          },
        )
        const record = Array.isArray(inserted) ? inserted[0] : inserted
        if (!record?.protocol) throw new Error('Supabase did not return the created protocol.')
        return json(201, {
          protocol: record.protocol,
          referenceCode,
          status: record.status,
          pixCode,
          amount: pixConfig.amount,
          receiverName: pixConfig.receiverName,
          city: pixConfig.city,
          expiresAt: record.expires_at,
          expiresInSeconds,
        })
      } catch (error) {
        if (error instanceof SupabaseRequestError && error.status === 409) continue
        if (error instanceof SupabaseRequestError && error.status === 400) {
          return json(400, { error: 'invalid_payment', message: error.message })
        }
        return databaseFailure('create vote intent', error)
      }
    }

    return json(503, { error: 'reference_conflict', message: 'Não foi possível gerar um código único agora. Tente novamente.' })
  }

  // The voter pressed "Já fiz o Pix". Stamping the confirmation time lets the admin compare it
  // against the payment time in the statement.
  if (method === 'POST' && route === '/api/votes/intent/confirm') {
    const body = await bodyObject(req)
    const protocol = String(body.protocol || '').toUpperCase()
    if (!protocolPattern.test(protocol)) {
      return json(400, { error: 'invalid_protocol', message: 'Protocolo inválido.' })
    }
    try {
      const data = await rpc(env, 'votequest_confirm_payment', { p_protocol: protocol })
      if (data?.status === 'not_found') {
        return json(404, { error: 'not_found', message: 'Pedido não encontrado. Abra a votação novamente.' })
      }
      return json(200, { status: data?.status })
    } catch (error) {
      return databaseFailure('confirm payment', error)
    }
  }

  if (method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'votes' && segments[2] === 'status') {
    const protocol = segments[3].toUpperCase()
    if (!protocolPattern.test(protocol)) return json(400, { status: 'invalid_protocol', message: 'Protocolo inválido.' })
    try {
      const rows = await rest(env, `votequest_payments?select=status,reference_code&protocol=eq.${protocol}&limit=1`)
      const record = Array.isArray(rows) ? rows[0] : null
      if (!record) return json(404, { status: 'not_found', message: 'Protocolo não encontrado.' })
      return json(200, { status: record.status, referenceCode: record.reference_code })
    } catch (error) {
      return databaseFailure('check payment status', error)
    }
  }

  if (method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'votes' && segments[2] === 'receipt') {
    // Public by design: anyone holding the receipt link may open it, which is what makes
    // votequest.com.br/<code> work. The row carries no personal data, and the code is a random
    // 8-character string that is not enumerable.
    const code = segments[3].toUpperCase()
    if (!referencePattern.test(code)) return json(404, { error: 'not_found', message: 'Recibo não encontrado.' })
    try {
      await rpc(env, 'votequest_expire_stale')
      const rows = await rest(
        env,
        `votequest_payments?select=reference_code,protocol,candidate,status,created_at,confirmed_at,expires_at,decided_at&reference_code=eq.${code}&limit=1`,
      )
      const record = Array.isArray(rows) ? rows[0] : null
      if (!record) return json(404, { error: 'not_found', message: 'Recibo não encontrado.' })
      return json(200, {
        referenceCode: record.reference_code,
        // Returned so the payer can press "Já fiz o Pix" from this page after closing the dialog.
        // It only unlocks status reads and confirmations, never an admin decision.
        protocol: record.protocol,
        candidate: record.candidate,
        status: record.status,
        requestedAt: record.created_at,
        confirmedAt: record.confirmed_at,
        expiresAt: record.expires_at,
        decidedAt: record.decided_at,
      })
    } catch (error) {
      return databaseFailure('load receipt', error)
    }
  }

  if (method === 'GET' && route === '/api/admin/votes') {
    const auth = authorized(env, req)
    if (!auth.ok) return auth.response
    try {
      // Expire on the database clock first so the queue never shows a stale request.
      await rpc(env, 'votequest_expire_stale')
      const [open, results] = await Promise.all([
        rest(env, 'votequest_payments?select=protocol,candidate,reference_code,status,created_at,confirmed_at,expires_at&status=in.(pending,review)&order=created_at.asc&limit=200'),
        readResults(env),
      ])
      return json(200, {
        pending: (Array.isArray(open) ? open : []).map((item) => ({
          protocol: item.protocol,
          candidate: item.candidate,
          referenceCode: item.reference_code,
          status: item.status,
          requestedAt: item.created_at,
          confirmedAt: item.confirmed_at,
          expiresAt: item.expires_at,
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
      if (data?.status === 'not_found') {
        return json(404, { error: 'not_found', message: 'Pedido pendente não encontrado.' })
      }
      if (data?.status === 'expired') {
        return json(409, { error: 'expired', message: 'Este pedido passou do prazo de conferência e expirou.' })
      }
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

export {
  buildDynamicPixCode,
  corsHeaders,
  getPixConfig,
  handleRequest,
  hasValidPixCrc,
  newReferenceCode,
  normalizeResults,
  parsePixFields,
  parsePixTlv,
  pixCrc16,
  voteWindowSeconds,
}