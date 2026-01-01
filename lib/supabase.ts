import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Lazy initialization to avoid build-time errors when env vars aren't available
let _supabaseAdmin: SupabaseClient | null = null;
let _supabase: SupabaseClient | null = null;

export const getSupabaseAdmin = (): SupabaseClient => {
  if (!_supabaseAdmin) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables');
    }
    
    _supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _supabaseAdmin;
};

export const getSupabase = (): SupabaseClient => {
  if (!_supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Missing Supabase environment variables');
    }
    
    _supabase = createClient(supabaseUrl, supabaseAnonKey);
  }
  return _supabase;
};

// Legacy exports for backward compatibility (lazy getters)
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    return (getSupabaseAdmin() as any)[prop];
  }
});

export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    return (getSupabase() as any)[prop];
  }
});
