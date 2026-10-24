import { createClient } from '@supabase/supabase-js';

const rawUrl = import.meta.env.VITE_SUPABASE_URL;
const rawAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const url = typeof rawUrl === 'string' ? rawUrl.trim().replace(/\/+$/, '') : '';
const anonKey = typeof rawAnonKey === 'string' ? rawAnonKey.trim() : '';

const hasPlaceholder =
  !url ||
  !anonKey ||
  url.includes('YOUR_PROJECT') ||
  anonKey.includes('YOUR_');

const isValidUrl = (() => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
})();

// The UI uses this value to show a helpful setup message instead of failing silently.
export const configurationProblem = hasPlaceholder
  ? 'missing-config'
  : !isValidUrl
    ? 'invalid-url'
    : null;

export const isConfigured = configurationProblem === null;

// Keep staff sessions memory-only so refreshing the browser requires signing in again.
// Access to staff data must still be enforced by database policies and Edge Functions.
export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export const functionUrl = (name) => `${url}/functions/v1/${name}`;
export const anonKeyValue = anonKey;
