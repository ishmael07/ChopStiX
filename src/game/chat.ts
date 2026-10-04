// Chat helpers shared by friend-link games (peer to peer) and server-run games.
// Server-run games are also cleaned in the database (cx_clean in 0003_daily.sql); keep the lists in step.

export const QUICK_PHRASES = ['Good luck!', 'Have fun!', 'Nice move!', 'Oops', 'Good game', 'Thanks!', 'Rematch?'];

const LINKS = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|gg|io|co|xyz|tv|me|ly)\b\S*/gi;
const BAD = /\b(fuck|f\*ck|fuk|shit|sh\*t|bitch|cunt|dick|cock|pussy|asshole|bastard|whore|slut|fag|nigg|retard|kys|kill yourself)\w*/gi;

/** Tidy a message: collapse spaces, mask links and swearing, cap at 140 characters. */
export function cleanChat(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140).replace(LINKS, '[link]').replace(BAD, '***');
}
