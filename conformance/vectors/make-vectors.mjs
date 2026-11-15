// Builds vectors.json from fixed inputs. Run it only when the protocol
// changes what a vector holds, never to make a failing implementation pass:
//
//   node conformance/vectors/make-vectors.mjs > conformance/vectors/vectors.json
//
// The handshake inputs are the ones in the interop file that nativephp/asgard
// and nativephp/midgard already share, so every derived key is unchanged.
//
// gzip bytes come from stock zlib through `php -r`, because Node bundles a
// fork of zlib whose level 6 output differs (see README.md, "gzip bytes").
// Every other byte is made here.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  aes128gcmEncrypt, b64u, contentDigest, ecdhAgree, ecdhKeyPair, hmac, sessionKeys, sessionSecret, unb64u,
} from '../runner/lib/crypto.mjs';
import * as sf from '../runner/lib/sf.mjs';
import {
  eventBase, LABEL, responseComponents, sealEvent, sealRequest, sealResponse, signatureBase, uploadFrame,
} from '../runner/lib/wire.mjs';

const salt = (label) => crypto.createHash('sha256').update('asgard conformance salt ' + label).digest().subarray(0, 16);

function stockGzip(text) {
  const deflated = Buffer.from(execFileSync('php', ['-r', 'echo base64_encode(gzdeflate($argv[1], 6));', '--', text]).toString(), 'base64');
  const data = Buffer.from(text);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(zlib.crc32(data) >>> 0, 0);
  trailer.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]), deflated, trailer]);
}

const handshake = {
  client_private: 'p9xBpAzh2PyBRDIRxC0SLtOxf9NI1apGyN-wKk7ykpY',
  server_private: '-27gSNO1GDgIXq9bBCD8L2iDMWN9RlgK_wW4hF_fn8U',
  session: 'aW50ZXJvcC1zZXNzaW9uLTAx',
};
const client = ecdhKeyPair(unb64u(handshake.client_private));
const server = ecdhKeyPair(unb64u(handshake.server_private));
const shared = ecdhAgree(client.ecdh, server.publicKey);
const secret = sessionSecret(shared, client.publicKey, server.publicKey);
const keys = sessionKeys(secret);
const session = handshake.session;
const authority = 'heimdall-server.test';

function requestVector({ method, path, headers = {}, plaintext, created, nonce, saltLabel, body }) {
  const s = salt(saltLabel);
  const sealed = sealRequest({ keys, session, method, authority, path, plaintext: body ?? plaintext, extra: headers, created, nonce, salt: s });
  return {
    vector: {
      method, authority, path, headers,
      ...(body ? {} : { plaintext }),
      created, nonce: nonce ?? null, salt: b64u(s),
      expected: {
        headers: sealed.headers,
        signature_base: sealed.base,
        signature: b64u(sealed.signature),
        body: b64u(sealed.body),
      },
    },
    signature: sealed.signature,
  };
}

function responseVector({ status, plaintext, created, saltLabel, requestSignature, compress = false, cache, answers }) {
  const s = salt(saltLabel);
  const gz = compress ? stockGzip(plaintext) : null;
  // A gzip body holds stock zlib's bytes, so it is sealed by hand rather
  // than through sealResponse, which would use Node's zlib.
  const sealed = gz
    ? sealGzipBody({ status, body: aes128gcmEncrypt(gz, keys.enc_s, session, { salt: s }), requestSignature, created, cache })
    : sealResponse({ keys, session, status, plaintext, requestSignature, created, salt: s, cache });
  return {
    answers, status, plaintext, created, salt: b64u(s), compress,
    ...(cache ? { cache } : {}),
    expected: {
      ...(gz ? { gzip: b64u(gz) } : {}),
      headers: sealed.headers,
      signature_base: sealed.base,
      body: b64u(sealed.body),
    },
  };
}

function sealGzipBody({ status, body, requestSignature, created, cache }) {
  const headers = {
    'content-type': 'application/json',
    'content-encoding': 'aes128gcm',
    'asgard-content-coding': 'gzip',
    'content-digest': contentDigest(body),
    'asgard-protocol': '1',
  };
  if (cache) headers['asgard-cache'] = cache;
  const params = { created: sf.integer(created), keyid: sf.string(session), alg: sf.string('hmac-sha256'), tag: sf.string('asgard/1') };
  const { input, base } = signatureBase(responseComponents(headers), params, (n) => {
    if (n === '@status') return String(status);
    if (n === 'signature') return sf.serializeBareItem(sf.bytes(requestSignature));
    return headers[n];
  });
  const sig = hmac(keys.sig_s, Buffer.from(base, 'latin1'));
  return { headers: { ...headers, 'signature-input': `${LABEL}=${input}`, 'signature': `${LABEL}=${sf.serializeBareItem(sf.bytes(sig))}` }, body, base };
}

function eventVector({ id, event, plaintext, saltLabel, requestSignature, compress = false }) {
  const s = salt(saltLabel);
  let data;
  let base;
  let gz = null;
  if (compress) {
    gz = stockGzip(plaintext);
    const body = b64u(aes128gcmEncrypt(gz, keys.enc_s, session, { salt: s }));
    base = eventBase(requestSignature, id, event, 'gzip', body);
    data = JSON.stringify({ body, enc: 'gzip', sig: b64u(hmac(keys.sig_s, Buffer.from(base, 'latin1'))) });
  } else {
    ({ data, base } = sealEvent({ keys, session, requestSignature, id, event, plaintext, salt: s }));
  }
  return { id, event, plaintext, salt: b64u(s), compress, expected: { ...(gz ? { gzip: b64u(gz) } : {}), signature_base: base, data } };
}

// Plaintexts in Draft 4 shapes. None carries a top-level `platform`.

const rows = Array.from({ length: 40 }, (_, i) => ({ type: 'text', key: `row-${i + 1}`, props: { text: `Row ${i + 1} of the interop list` } }));

const actionRequest = requestVector({
  method: 'POST', path: '/_asgard/render',
  headers: { 'x-asgard-method': 'QUERY', authorization: 'Bearer interop-token' },
  plaintext: JSON.stringify({ protocol: 1, component: 'app.native.screens.home', regions: ['stats'], state: { name: 'Simon' }, action: { call: 'shuffle', args: [3] } }),
  created: 1767225600, nonce: 'aW50ZXJvcC1ub25jZS0wMQ', saltLabel: 'request',
});

const renderRequest = requestVector({
  method: 'QUERY', path: '/_asgard/render',
  plaintext: JSON.stringify({ protocol: 1, component: 'app.native.screens.home', regions: ['greeting', 'stats'], state: { name: 'Simon' } }),
  created: 1767225610, saltLabel: 'query_request',
});

const callRequest = requestVector({
  method: 'POST', path: '/_asgard/call', headers: { 'x-asgard-method': 'QUERY' },
  plaintext: JSON.stringify({ protocol: 1, component: 'app.native.screens.home', method: 'roll', args: [], state: { roll: 0 }, read_only: [] }),
  created: 1767225620, nonce: 'aW50ZXJvcC1ub25jZS0wMg', saltLabel: 'call_request',
});

const uploadHeader = JSON.stringify({ protocol: 1, component: 'app.native.screens.home', method: 'savePhoto', args: ['A caption'], state: { caption: '' }, filename: 'note.txt', mime: 'text/plain', size: 13 });
const uploadFile = Buffer.from('hello asgard\n');
const frame = uploadFrame(uploadHeader, uploadFile);
const uploadRequest = requestVector({
  method: 'POST', path: '/_asgard/upload', headers: { 'x-asgard-method': 'QUERY' },
  body: frame, created: 1767225630, nonce: 'aW50ZXJvcC1ub25jZS0wMw', saltLabel: 'upload_request',
});

const streamRequest = requestVector({
  method: 'POST', path: '/_asgard/stream', headers: { 'x-asgard-method': 'QUERY' },
  plaintext: JSON.stringify({ protocol: 1, subscriptions: [{ id: '3f9a0c1d2e4b5a6c', component: 'app.native.screens.home', regions: ['greeting', 'stats'], state: { name: 'Simon' }, versions: { greeting: 'q3V0bG9yZW1pcHN1' } }] }),
  created: 1767225640, saltLabel: 'stream_request',
});

const fragmentPart = (text) => ({ version: 'q3V0bG9yZW1pcHN1', made_at: 1767225600123, fragment: { type: 'text', props: { text } } });

const out = {
  description: 'Asgard protocol 1 conformance vectors, Draft 4. Binary values are base64url without padding unless a field says otherwise. Generated once from fixed inputs by make-vectors.mjs. Every implementation must reproduce every expected value, apart from gzip bytes, which are only checked by inflating them (see README.md). Do not regenerate to make a failing implementation pass.',
  source: 'Handshake inputs and derived keys are those of tests/Fixtures/asgard-interop.json in nativephp/asgard and nativephp/midgard. Message plaintexts are rewritten for Draft 4: regions lists, fragments maps, delta, made_at, subscriptions, and no platform member.',
  sections: {
    handshake: '§6.1, §7.2', requests: '§7.3, §7.4', responses: '§7.3, §7.4, §8.3', events: '§8.1, §8.2', upload: '§10.6', records: '§7.4', refuse: '§6.3, §7.3, §7.4, §8.1',
  },
  handshake: {
    ...handshake,
    client_public: b64u(client.publicKey),
    server_public: b64u(server.publicKey),
    shared_secret: b64u(shared),
    secret_info: b64u(Buffer.concat([Buffer.from('asgard/1 session\0'), client.publicKey, server.publicKey])),
    secret: b64u(secret),
    keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, b64u(v)])),
  },
  requests: {
    action: actionRequest.vector,
    render_query: renderRequest.vector,
    call: callRequest.vector,
    upload: { ...uploadRequest.vector, frame: { header: uploadHeader, file: b64u(uploadFile), bytes: b64u(frame) } },
    stream: streamRequest.vector,
  },
  responses: {
    action: responseVector({
      answers: 'action', status: 200, created: 1767225601, saltLabel: 'response', requestSignature: actionRequest.signature,
      plaintext: JSON.stringify({ protocol: 1, delta: {}, fragments: { stats: fragmentPart('Shuffled 3') } }),
    }),
    render_gzip: responseVector({
      answers: 'render_query', status: 200, created: 1767225611, saltLabel: 'gzip_response', requestSignature: renderRequest.signature, compress: true,
      plaintext: JSON.stringify({ protocol: 1, delta: {}, fragments: { greeting: fragmentPart('Hello Simon'), stats: { version: 'bG9yZW1pcHN1cTNW', made_at: 1767225600123, fragment: rows } } }),
    }),
    render_invalidate: responseVector({
      answers: 'render_query', status: 200, created: 1767225612, saltLabel: 'cache_response', requestSignature: renderRequest.signature, cache: 'invalidate',
      plaintext: JSON.stringify({ protocol: 1, delta: {}, fragments: { greeting: fragmentPart('Hello Simon'), stats: fragmentPart('42 sales') } }),
    }),
    unknown_component: responseVector({
      answers: 'render_query', status: 404, created: 1767225613, saltLabel: 'error_response', requestSignature: renderRequest.signature,
      plaintext: JSON.stringify({ error: 'unknown_component' }),
    }),
    call: responseVector({
      answers: 'call', status: 200, created: 1767225621, saltLabel: 'call_response', requestSignature: callRequest.signature,
      plaintext: JSON.stringify({ protocol: 1, delta: { roll: 4 } }),
    }),
    upload: responseVector({
      answers: 'upload', status: 200, created: 1767225631, saltLabel: 'upload_response', requestSignature: uploadRequest.signature,
      plaintext: JSON.stringify({ protocol: 1, delta: { caption: 'A caption' } }),
    }),
  },
  events: {
    answers: 'stream',
    signal: eventVector({
      id: '7', event: 'signal', saltLabel: 'signal_event', requestSignature: streamRequest.signature,
      plaintext: JSON.stringify({ protocol: 1, subscription: '3f9a0c1d2e4b5a6c', region: 'stats', version: 'bG9yZW1pcHN1cTNW' }),
    }),
    fragment: eventVector({
      id: '8', event: 'fragment', saltLabel: 'stream_event', requestSignature: streamRequest.signature,
      plaintext: JSON.stringify({ protocol: 1, subscription: '3f9a0c1d2e4b5a6c', region: 'stats', version: 'bG9yZW1pcHN1cTNW', made_at: 1767225641000, fragment: { type: 'text', props: { text: 'Pushed' } } }),
    }),
    fragment_gzip: eventVector({
      id: '9', event: 'fragment', saltLabel: 'gzip_stream_event', requestSignature: streamRequest.signature, compress: true,
      plaintext: JSON.stringify({ protocol: 1, subscription: '3f9a0c1d2e4b5a6c', region: 'stats', version: 'cTNWMGJHOXlaVzFw', made_at: 1767225642000, fragment: rows }),
    }),
    patch: eventVector({
      id: '10', event: 'patch', saltLabel: 'patch_event', requestSignature: streamRequest.signature,
      plaintext: JSON.stringify({ protocol: 1, subscription: '3f9a0c1d2e4b5a6c', region: 'stats', from: 'cTNWMGJHOXlaVzFw', version: 'MGJHOXlaVzFwcTNW', patch: { op: 'prepend', target: 'items', nodes: [{ type: 'text', key: '1043', props: { text: 'New item' } }], keep: 1000 } }),
    }),
  },
};

// A body of three records under enc_s (§7.4): 4079 + 4079 + the rest.
const longText = JSON.stringify({ protocol: 1, delta: {}, fragments: { stats: { version: 'q3V0bG9yZW1pcHN1', made_at: 1767225600123, fragment: Array.from({ length: 200 }, (_, i) => ({ type: 'text', key: i, props: { text: `Record test row ${i}` } })) } } });
const longBody = aes128gcmEncrypt(Buffer.from(longText), keys.enc_s, session, { salt: salt('records') });
out.records = {
  ikm: 'enc_s', key_id: session, record_size: 4096, salt: b64u(salt('records')), plaintext: longText,
  expected: { records: Math.ceil(Buffer.byteLength(longText) / 4079), body: b64u(longBody) },
};

// Things a receiver MUST refuse.
const twoRecords = aes128gcmEncrypt(Buffer.alloc(5000, 0x61), keys.enc_s, session, { salt: salt('refuse-truncated') });
const truncated = twoRecords.subarray(0, 21 + session.length + 4096);
const otherKeyId = aes128gcmEncrypt(Buffer.from('{"protocol":1,"delta":{}}'), keys.enc_s, 'another-session', { salt: salt('refuse-keyid') });
out.refuse = [
  {
    name: 'truncated_body', why: 'The last record carries 0x01, so records are missing (§7.4).',
    open: 'body', ikm: 'enc_s', key_id: session, body: b64u(truncated),
  },
  {
    name: 'other_key_id', why: 'The aes128gcm keyid is not the session id (§7.4).',
    open: 'body', ikm: 'enc_s', key_id: session, body: b64u(otherKeyId),
  },
  {
    name: 'response_for_other_request', why: 'A response signed against the action request, opened as the answer to render_query, fails (§7.3).',
    open: 'response', response: 'action', request: 'render_query',
  },
  {
    name: 'response_stripped_cache', why: 'Asgard-Cache removed from a response that signed it (§7.3).',
    open: 'response', response: 'render_invalidate', request: 'render_query', drop_header: 'asgard-cache',
  },
  {
    name: 'response_wrong_coding', why: 'Asgard-Content-Coding flipped from identity to gzip (§7.4).',
    open: 'response', response: 'action', request: 'action', set_header: { 'asgard-content-coding': 'gzip' },
  },
  {
    name: 'event_renumbered', why: 'An event whose id was changed from 7 to 8 fails its sig (§8.1).',
    open: 'event', event: 'signal', id: '8',
  },
  {
    name: 'event_enc_flipped', why: 'An event whose enc was flipped fails its sig (§8.1).',
    open: 'event', event: 'fragment_gzip', set_enc: 'identity',
  },
  {
    name: 'point_not_on_curve', why: 'A client_public that is not on P-256 is refused with 422 (§6.1).',
    open: 'point', point: b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1), Buffer.alloc(32, 2)])),
  },
];

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
