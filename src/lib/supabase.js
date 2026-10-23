import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey && !url.includes('YOUR_PROJECT') && !anonKey.includes('YOUR_'));
export const supabase = isConfigured ? createClient(url, anonKey) : null;
export const functionUrl = (name) => `${url}/functions/v1/${name}`;
export const anonKeyValue = anonKey;
