import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, type AccountProfile } from './supabase';

export interface Account {
  session: Session | null;
  profile: AccountProfile | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  update: (patch: Partial<Pick<AccountProfile, 'display_name' | 'skin'>>) => Promise<string | null>;
}

export function useAccount(): Account {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loading, setLoading] = useState(!!supabase);

  const load = useCallback(async (s: Session | null) => {
    if (!supabase || !s) return setProfile(null);
    const { data } = await supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
    setProfile(data as AccountProfile | null);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await load(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      void load(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  return {
    session,
    profile,
    loading,
    refresh: () => load(session),
    signOut: async () => {
      await supabase?.auth.signOut();
      setProfile(null);
    },
    update: async (patch) => {
      if (!supabase || !profile) return 'Not signed in';
      const { error } = await supabase.from('profiles').update(patch).eq('id', profile.id);
      if (error) return error.message;
      setProfile({ ...profile, ...patch });
      return null;
    },
  };
}
