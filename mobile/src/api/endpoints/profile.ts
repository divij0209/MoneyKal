import { api } from '../client';
import type { ProfileResponse } from '../types';

/** GET /profile/me — backend/routers/profile.py.
 *  Resolves the real persona key for the signed-in user. The web app treats
 *  this as authoritative over anything cached at login, and so does this. */
export function fetchProfile() {
  return api.get<ProfileResponse>('/profile/me');
}
