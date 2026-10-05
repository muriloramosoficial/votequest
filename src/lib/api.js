import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../shared/supabase-public.js';

const functionUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/votequest-api`;

export function apiFetch(path, options = {}) {
  const route = path.startsWith('/api/') ? path : `/api/${path.replace(/^\/+/, '')}`;
  const url = new URL(functionUrl);
  url.searchParams.set('route', route);

  const headers = new Headers(options.headers || {});
  headers.set('apikey', SUPABASE_ANON_KEY);
  headers.set('Authorization', `Bearer ${SUPABASE_ANON_KEY}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  return fetch(url, { ...options, headers });
}
