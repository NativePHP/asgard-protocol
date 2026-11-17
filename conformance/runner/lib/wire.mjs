// Sealing and opening Asgard messages (protocol.md §7.3, §7.4, §8.1, §10.6).
// Pure functions: the caller supplies keys, clock, salt and nonce, so the
// same code generates the byte-exact vectors and drives a live server.

import * as sf from './sf.mjs';
import {
  aes128gcmDecrypt, aes128gcmEncrypt, b64, b64u, contentDigest, gunzip, gzip, GZIP_MIN, hmac, unb64u,
} from './crypto.mjs';

import constants from '../../../schema/constants.json' with { type: 'json' };

export const LABEL = constants.signature.label;
export const TAG = constants.signature.tag;
export const ALG = constants.signature.alg;
export const PROTOCOL_HEADER = String(constants.protocol.value);
export const MAX_LIFETIME = constants.timing.request_lifetime_max_seconds.value;
export const MAX_SKEW = constants.timing.clock_skew_future_seconds.value;

export const REQUEST_COMPONENTS = constants.signature.request.components;
export const OPTIONAL_REQUEST_COMPONENTS = constants.signature.request.optional_components;
// The last response component, "signature";req;key="asgard", is added with its parameters below.
export const RESPONSE_COMPONENTS = constants.signature.response.components.slice(0, -1);

export function requestComponents(headers) {
  const list = [...REQUEST_COMPONENTS];
  for (const name of OPTIONAL_REQUEST_COMPONENTS) if (name in headers) list.push(name);
  return list;
}

export function responseComponents(headers) {
  const list = RESPONSE_COMPONENTS.map((n) => sf.string(n));
  for (const name of constants.signature.response.optional_components) if (name in headers) list.push(sf.string(name));
  list.push(sf.string('signature', { req: sf.boolean(true), key: sf.string(LABEL) }));
  return list;
}

// RFC 9421 §2.5. `value(name, params)` gives each component's value.
export function signatureBase(items, params, value) {
  const input = sf.serializeItem(sf.inner(items, params));
  let base = '';
  for (const item of items) {
    const v = value(item.value, item.params);
    if (v === undefined || v === null) throw new Error(`the message has no ${item.value} to cover`);
    base += sf.serializeItem(item) + ': ' + String(v).trim() + '\n';
  }
  return { input, base: base + '"@signature-params": ' + input };
}

function lower(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Seal a request (§7.3, §7.4). `extra` holds x-asgard-method and
 * authorization when the request has them. `tamper` lets a case break one
 * thing on purpose.
 */
export function sealRequest({
  keys, session, method, authority, path, plaintext, extra = {}, created, nonce, salt, tamper = {},
}) {
  created ??= Math.floor(Date.now() / 1000);
  const keyId = tamper.bodyKeyId ?? session;
  let body = aes128gcmEncrypt(Buffer.from(plaintext), tamper.encKey ?? keys.enc_c, keyId, { salt });

  const headers = {
    'content-type': 'application/json',
    'content-encoding': tamper.contentEncoding ?? 'aes128gcm',
    'content-digest': contentDigest(body),
    'asgard-protocol': PROTOCOL_HEADER,
    'asgard-session-id': session,
  };
  // A case can send another Asgard-Protocol value, or none (null). With none
  // the header is also left out of the covered components, since RFC 9421
  // cannot cover a header the message does not have.
  if ('protocolHeader' in tamper) {
    if (tamper.protocolHeader === null) delete headers['asgard-protocol'];
    else headers['asgard-protocol'] = String(tamper.protocolHeader);
  }
  for (const name of OPTIONAL_REQUEST_COMPONENTS) {
    const value = lower(extra)[name];
    if (value !== undefined) headers[name] = value;
  }

  let covered = requestComponents(headers).filter((n) => n.startsWith('@') || n in headers);
  if (tamper.cover) covered = tamper.cover(covered);

  const params = {
    created: sf.integer(created),
    expires: sf.integer(created + (tamper.lifetime ?? MAX_LIFETIME)),
    keyid: sf.string(tamper.keyid ?? session),
    alg: sf.string(tamper.alg ?? ALG),
    tag: sf.string(tamper.tag ?? TAG),
  };
  if (nonce !== undefined && nonce !== null) params.nonce = sf.string(nonce);
  for (const [k, v] of Object.entries(tamper.params ?? {})) params[k] = typeof v === 'number' ? sf.integer(v) : sf.string(v);

  const derived = { '@method': method.toUpperCase(), '@authority': authority.toLowerCase(), '@path': path };
  const { input, base } = signatureBase(covered.map((n) => sf.string(n)), params, (n) => derived[n] ?? headers[n]);
  let signature = hmac(tamper.sigKey ?? keys.sig_c, Buffer.from(base, 'latin1'));
  if (tamper.flipSignature) {
    signature = Buffer.from(signature);
    signature[0] ^= 0x01;
  }

  if (tamper.flipBody) {
    body = Buffer.from(body);
    body[body.length - 1] ^= 0x01;
  }
  if (tamper.stripHeader) delete headers[tamper.stripHeader];

  return {
    headers: {
      ...headers,
      'signature-input': `${LABEL}=${input}`,
      'signature': `${LABEL}=${sf.serializeBareItem(sf.bytes(signature))}`,
    },
    body,
    signature,
    base,
  };
}

/** Seal a response (§7.3, §7.4). Used to make vectors and by a future fake server. */
export function sealResponse({ keys, session, status, plaintext, requestSignature, created, salt, compress = false, cache }) {
  created ??= Math.floor(Date.now() / 1000);
  const data = Buffer.from(plaintext);
  const gz = compress && data.length >= GZIP_MIN;
  const body = aes128gcmEncrypt(gz ? gzip(data) : data, keys.enc_s, session, { salt });
  const headers = {
    'content-type': 'application/json',
    'content-encoding': 'aes128gcm',
    'asgard-content-coding': gz ? 'gzip' : 'identity',
    'content-digest': contentDigest(body),
    'asgard-protocol': PROTOCOL_HEADER,
  };
  if (cache !== undefined) headers['asgard-cache'] = cache;
  const params = {
    created: sf.integer(created),
    keyid: sf.string(session),
    alg: sf.string(ALG),
    tag: sf.string(TAG),
  };
  const { input, base } = signatureBase(responseComponents(headers), params, responseValue(status, headers, requestSignature));
  const signature = hmac(keys.sig_s, Buffer.from(base, 'latin1'));
  return {
    headers: { ...headers, 'signature-input': `${LABEL}=${input}`, 'signature': `${LABEL}=${sf.serializeBareItem(sf.bytes(signature))}` },
    body,
    base,
    gzipped: gz ? gzip(data) : null,
  };
}

function responseValue(status, headers, requestSignature) {
  return (name) => {
    if (name === '@status') return String(status);
    if (name === 'signature') return sf.serializeBareItem(sf.bytes(requestSignature));
    return headers[name];
  };
}

/**
 * Check a sealed response against the request it answers and return its
 * plaintext (§7.3, §7.4, §7.6). Throws with a reason on any failure.
 */
export function openResponse({ keys, session, status, headers, body, requestSignature, now }) {
  headers = lower(headers);
  now ??= Math.floor(Date.now() / 1000);
  if (headers['content-digest'] !== contentDigest(body)) throw new Error('Content-Digest does not match the body');
  if (!headers['signature-input'] || !headers['signature']) throw new Error('the response is not signed');
  const input = sf.parseDictionary(headers['signature-input'])[LABEL];
  const sig = sf.parseDictionary(headers['signature'])[LABEL];
  if (!input || input.type !== 'inner' || !sig || sig.type !== 'bytes') throw new Error('the response has no asgard signature');

  const expected = sf.serializeItem(sf.inner(responseComponents(headers), {}));
  const got = sf.serializeItem(sf.inner(input.value, {}));
  if (expected !== got) throw new Error(`the response covers ${got}, expected ${expected}`);

  const names = Object.keys(input.params).sort().join(',');
  if (names !== 'alg,created,keyid,tag') throw new Error(`the response signature parameters are ${names}`);
  if (input.params.alg.value !== ALG || input.params.tag.value !== TAG) throw new Error('not an asgard/1 hmac-sha256 signature');
  if (input.params.keyid.value !== session) throw new Error('the response keyid is not this session');
  const created = input.params.created.value;
  if (created > now + MAX_SKEW || created < now - MAX_LIFETIME) throw new Error('the response signature is stale or from the future');

  const { base } = signatureBase(input.value, input.params, responseValue(status, headers, requestSignature));
  const mac = hmac(keys.sig_s, Buffer.from(base, 'latin1'));
  if (!mac.equals(sig.value)) throw new Error('the response signature does not verify');

  if ((headers['content-encoding'] ?? '').trim().toLowerCase() !== 'aes128gcm') throw new Error(`Content-Encoding is ${headers['content-encoding']}`);
  const coding = headers['asgard-content-coding'];
  if (coding !== 'gzip' && coding !== 'identity') throw new Error(`Asgard-Content-Coding is ${coding}`);
  const plain = aes128gcmDecrypt(body, keys.enc_s, { keyId: session });
  return { plaintext: coding === 'gzip' ? gunzip(plain) : plain, coding, cache: headers['asgard-cache'] };
}

// Stream events (§8.1)

export function eventBase(requestSignature, id, event, enc, body) {
  return `asgard/1 event\n${b64(requestSignature)}\n${id}\n${event}\n${enc}\n${body}`;
}

export function sealEvent({ keys, session, requestSignature, id, event, plaintext, salt, compress = false }) {
  const data = Buffer.from(plaintext);
  const gz = compress && data.length >= GZIP_MIN;
  const enc = gz ? 'gzip' : 'identity';
  const body = b64u(aes128gcmEncrypt(gz ? gzip(data) : data, keys.enc_s, session, { salt }));
  const base = eventBase(requestSignature, id, event, enc, body);
  const sig = b64u(hmac(keys.sig_s, Buffer.from(base, 'latin1')));
  return { data: JSON.stringify({ body, enc, sig }), base };
}

export function openEvent({ keys, session, requestSignature, id, event, data }) {
  const json = JSON.parse(data);
  if (typeof json !== 'object' || json === null) throw new Error('event data is not an object');
  for (const k of ['body', 'enc', 'sig']) if (!(k in json)) throw new Error(`event data has no ${k}`);
  if (json.enc !== 'gzip' && json.enc !== 'identity') throw new Error(`event enc is ${json.enc}`);
  const base = eventBase(requestSignature, id ?? '', event, json.enc, json.body);
  if (!hmac(keys.sig_s, Buffer.from(base, 'latin1')).equals(unb64u(json.sig))) throw new Error('the event signature does not verify');
  const plain = aes128gcmDecrypt(unb64u(json.body), keys.enc_s, { keyId: session });
  return { plaintext: json.enc === 'gzip' ? gunzip(plain) : plain, enc: json.enc };
}

// Upload frames (§10.6)

export function uploadFrame(header, file) {
  const head = Buffer.from(typeof header === 'string' ? header : JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, Buffer.from(file)]);
}
