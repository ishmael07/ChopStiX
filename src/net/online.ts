// Peer-to-peer friend games over WebRTC (PeerJS public broker). No server of our own.
import Peer, { type DataConnection } from 'peerjs';
import type { Move, Rules } from '../game/rules';

export type NetMsg =
  | { t: 'hello'; name: string; rating: number; skin?: number }
  | { t: 'start'; rules: Rules; hostSide: 0 | 1; clock: number; game: number }
  | { t: 'move'; move: Move; ply: number; clockLeft: number }
  | { t: 'resign' }
  | { t: 'rematch' }
  | { t: 'chat'; text: string };

const PREFIX = 'chopstix-v1-';

export const newRoomCode = () =>
  Array.from({ length: 6 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');

export interface Link {
  send: (m: NetMsg) => void;
  close: () => void;
}

export function host(
  code: string,
  on: { open: () => void; msg: (m: NetMsg) => void; close: () => void; error: (e: string) => void; ready: () => void },
): Link {
  const peer = new Peer(PREFIX + code);
  let conn: DataConnection | null = null;
  peer.on('open', () => on.ready());
  peer.on('connection', (c) => {
    if (conn) return c.close(); // room is full
    conn = c;
    c.on('open', on.open);
    c.on('data', (d) => on.msg(d as NetMsg));
    c.on('close', on.close);
  });
  peer.on('error', (e) => on.error(e.type === 'unavailable-id' ? 'That room code is taken.' : String(e.type)));
  return { send: (m) => conn?.send(m), close: () => peer.destroy() };
}

export function join(
  code: string,
  on: { open: () => void; msg: (m: NetMsg) => void; close: () => void; error: (e: string) => void },
): Link {
  const peer = new Peer();
  let conn: DataConnection | null = null;
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', on.open);
    conn.on('data', (d) => on.msg(d as NetMsg));
    conn.on('close', on.close);
  });
  peer.on('error', (e) => on.error(e.type === 'peer-unavailable' ? 'Room not found. Ask your friend for a fresh link.' : String(e.type)));
  return { send: (m) => conn?.send(m), close: () => peer.destroy() };
}
