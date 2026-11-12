import { upstream } from './generated';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_receipt');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('invalid_receipt');
  return bytes;
}
async function key(secret: string) {
  if (!secret || encoder.encode(secret).length < 32) throw new Error('receipt_secret_not_configured');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export interface ReceiptPayload {
  format: 1;
  adapter: '0.1.0';
  upstream_commit: string;
  upstream_version: string;
  final_hash: string;
  original_hash: string;
  material_hashes: string[];
  conditions: { doc_type?: string; reader?: string; stance?: string };
  checks: string[];
}
export async function signReceipt(payload: ReceiptPayload, secret: string): Promise<string> {
  const body = encoder.encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), body);
  return `${encode(body)}.${encode(new Uint8Array(signature))}`;
}
export async function verifyReceipt(final: string, receipt: string, secret: string) {
  const parts = receipt.split('.');
  if (parts.length !== 2 || receipt.length > 16384) throw new Error('invalid_receipt');
  const body = decode(parts[0]);
  const signature = decode(parts[1]);
  if (!await crypto.subtle.verify('HMAC', await key(secret), signature, body)) throw new Error('invalid_receipt');
  const payload = JSON.parse(decoder.decode(body)) as ReceiptPayload;
  if (payload.format !== 1 || payload.adapter !== '0.1.0' || payload.upstream_commit !== upstream.commit || payload.upstream_version !== upstream.version) {
    throw new Error('receipt_version_mismatch');
  }
  return { status: 'completed', matches: await sha256(final) === payload.final_hash, checked: payload,
    note: '本文の一致だけを確認します。意味保持や読みやすさの合格を示しません。' };
}
