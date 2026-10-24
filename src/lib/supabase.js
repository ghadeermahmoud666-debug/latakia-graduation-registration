import { createClient } from '@supabase/supabase-js';

const url = String(import.meta.env.VITE_SUPABASE_URL || '').trim();
const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

function isValidSupabaseUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

const hasPlaceholder = !url || !anonKey || url.includes('YOUR_PROJECT') || anonKey.includes('YOUR_');
export const configurationProblem = hasPlaceholder
  ? 'missing'
  : (!isValidSupabaseUrl(url) ? 'invalid-url' : null);
export const isConfigured = configurationProblem === null;
export const supabase = isConfigured ? createClient(url, anonKey) : null;
export const functionUrl = (name) => `${url}/functions/v1/${name}`;
export const anonKeyValue = anonKey;
