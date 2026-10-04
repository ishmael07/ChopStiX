import { describe, expect, it } from 'vitest';
import { loginEmail } from '../src/account/supabase';

describe('username logins', () => {
  it('maps a username to its internal address, ignoring case and spaces', () => {
    expect(loginEmail(' New_Kid ')).toBe('new_kid@players.chopstix.app');
  });
  it('lets older email accounts log in with their email', () => {
    expect(loginEmail('me@example.com')).toBe('me@example.com');
  });
});
