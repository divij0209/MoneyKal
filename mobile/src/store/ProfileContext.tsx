import React, { createContext, useContext, useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { profileApi } from '../api';
import type { PersonaKey, ProfileResponse } from '../api/types';
import { useAuth } from './AuthContext';

/**
 * The signed-in user's profile, and the persona derived from it.
 *
 * Persona resolution copies twin-app/js/app.js exactly:
 *
 *     applyPersonaNav(currentProfile.key === 'startup' ? 'startup' : 'individual')
 *
 * That "anything not startup is individual" rule is not a simplification — an
 * individual's key is often `custom_<username>` rather than the literal
 * "individual", so testing for equality with 'individual' would misroute real
 * users. GET /profile/me is treated as authoritative over the `profile_key`
 * cached at login, for the same reason the web comment gives: a stale key
 * matches no row in the database.
 */

interface ProfileContextValue {
  profile: ProfileResponse | null;
  persona: PersonaKey;
  currency: string;
  isLoading: boolean;
  error: unknown;
  refetch: UseQueryResult<ProfileResponse>['refetch'];
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export const profileQueryKey = ['profile', 'me'] as const;

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();

  const query = useQuery({
    queryKey: profileQueryKey,
    queryFn: profileApi.fetchProfile,
    // Only meaningful once onboarding has produced a profile. Asking earlier
    // returns a 404 the app would have to special-case.
    enabled: status === 'ready',
    staleTime: 60_000,
  });

  const value = useMemo<ProfileContextValue>(() => {
    const profile = query.data ?? null;
    return {
      profile,
      persona: profile?.key === 'startup' ? 'startup' : 'individual',
      currency: profile?.currency || '₹',
      isLoading: query.isLoading,
      error: query.error,
      refetch: query.refetch,
    };
  }, [query.data, query.isLoading, query.error, query.refetch]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used inside <ProfileProvider>');
  return ctx;
}
