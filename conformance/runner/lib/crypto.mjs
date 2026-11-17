// The primitives Asgard builds on (protocol.md §6.1, §7.2, §7.3, §7.4):
// base64url, P-256 ECDH, HKDF-SHA256, the aes128gcm content coding of
// RFC 8188, Content-Digest of RFC 9530, and Asgard's fixed gzip member.
// Node built-ins only.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const RECORD_SIZE = 4096;
export const GZIP_MIN = 1024;
export const INFLATE_CAP = 8 * 1024 * 1024;

// base64url without padding (RFC 4648 §5)

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function unb64u(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  return Buffer.from(text, 'base64url');
}

export function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

// HKDF-SHA256 (RFC 5869)

export function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt ?? Buffer.alloc(0), info, length));
}

// P-256 key agreement (§6.1)

export function ecdhKeyPair(privateKey) {
  const ecdh = crypto.createECDH('prime256v1');
  if (privateKey) ecdh.setPrivateKey(Buffer.from(privateKey));
  else ecdh.generateKeys();
  return { ecdh, privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(null, 'uncompressed') };
}

export function ecdhAgree(ecdh, peerPublic) {
  if (peerPublic.length !== 65 || peerPublic[0] !== 0x04) throw new Error('not an uncompressed P-256 point');
  return ecdh.computeSecret(peerPublic);
}

export const SESSION_INFO = 'asgard/1 session';

export function sessionSecret(shared, clientPublic, serverPublic) {
  const info = Buffer.concat([Buffer.from(SESSION_INFO + '\0', 'latin1'), clientPublic, serverPublic]);
  return hkdf(shared, Buffer.alloc(0), info, 32);
}

export const KEY_LABELS = {
  sig_c: ['asgard/1 sig client', 32],
  sig_s: ['asgard/1 sig server', 32],
  enc_c: ['asgard/1 enc client', 16],
  enc_s: ['asgard/1 enc server', 16],
};

export function sessionKeys(secret) {
  const keys = {};
  for (const [name, [info, length]] of Object.entries(KEY_LABELS)) {
    keys[name] = hkdf(secret, Buffer.alloc(0), Buffer.from(info, 'latin1'), length);
  }
  return keys;
}

// aes128gcm (RFC 8188)

function contentKeys(ikm, salt) {
  return {
    cek: hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
    nonce: hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12),
  };
}

function recordNonce(base, seq) {
  const nonce = Buffer.from(base);
  const tail = nonce.readBigUInt64BE(4) ^ BigInt(seq);
  nonce.writeBigUInt64BE(tail, 4);
  return nonce;
}

export function aes128gcmEncrypt(plaintext, ikm, keyId, { salt, recordSize = RECORD_SIZE } = {}) {
  salt = salt ? Buffer.from(salt) : crypto.randomBytes(16);
  if (salt.length !== 16) throw new Error('the salt must be 16 bytes');
  const id = Buffer.from(keyId, 'utf8');
  if (id.length > 255) throw new Error('the key id is longer than 255 bytes');
  const { cek, nonce } = contentKeys(ikm, salt);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header[20] = id.length;

  const data = Buffer.from(plaintext);
  const chunk = recordSize - 17;
  const parts = [header, id];
  const count = Math.max(1, Math.ceil(data.length / chunk));
  for (let seq = 0; seq < count; seq++) {
    const piece = data.subarray(seq * chunk, (seq + 1) * chunk);
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, recordNonce(nonce, seq));
    const sealed = cipher.update(Buffer.concat([piece, Buffer.from([seq === count - 1 ? 2 : 1])]));
    parts.push(sealed, cipher.final(), cipher.getAuthTag());
  }
  return Buffer.concat(parts);
}

export function aes128gcmHeader(body) {
  if (body.length < 21) throw new Error('the body is shorter than an aes128gcm header');
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20];
  if (body.length < 21 + idLength) throw new Error('the body is shorter than its header');
  return {
    salt: body.subarray(0, 16),
    recordSize,
    keyId: body.subarray(21, 21 + idLength).toString('utf8'),
    start: 21 + idLength,
  };
}

export function aes128gcmDecrypt(body, ikm, { keyId } = {}) {
  body = Buffer.from(body);
  const header = aes128gcmHeader(body);
  if (header.recordSize < 18) throw new Error('the record size is below 18');
  if (keyId !== undefined && header.keyId !== keyId) throw new Error('the body was encrypted for another key id');
  const records = body.subarray(header.start);
  if (records.length === 0) throw new Error('the body has no records');
  const { cek, nonce } = contentKeys(ikm, header.salt);
  const out = [];
  const count = Math.ceil(records.length / header.recordSize);
  for (let seq = 0; seq < count; seq++) {
    const rec = records.subarray(seq * header.recordSize, (seq + 1) * header.recordSize);
    if (rec.length < 17) throw new Error('a record is too short');
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, recordNonce(nonce, seq));
    decipher.setAuthTag(rec.subarray(rec.length - 16));
    let plain = Buffer.concat([decipher.update(rec.subarray(0, rec.length - 16)), decipher.final()]);
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end--;
    if (end === 0) throw new Error('a record has no delimiter');
    const delimiter = plain[end - 1];
    if (delimiter !== (seq === count - 1 ? 2 : 1)) throw new Error('a record has the wrong delimiter, so the body is truncated or corrupt');
    out.push(plain.subarray(0, end - 1));
  }
  return Buffer.concat(out);
}

// Content-Digest (RFC 9530)

export function contentDigest(body) {
  return 'sha-256=:' + crypto.createHash('sha256').update(body).digest('base64') + ':';
}

export function sha256hex(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

export function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// gzip with a fixed header: no name, mtime 0, OS 255, level 6 (§7.4)

export function gzip(data) {
  const deflated = zlib.deflateRawSync(Buffer.from(data), { level: 6 });
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(zlib.crc32(Buffer.from(data)) >>> 0, 0);
  trailer.writeUInt32LE(Buffer.from(data).length >>> 0, 4);
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]), deflated, trailer]);
}

export function gunzip(data, cap = INFLATE_CAP) {
  return zlib.gunzipSync(Buffer.from(data), { maxOutputLength: cap });
}

export function randomNonce() {
  return b64u(crypto.randomBytes(16));
}
