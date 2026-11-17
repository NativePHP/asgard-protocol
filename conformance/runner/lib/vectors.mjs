// Offline checks of conformance/vectors/vectors.json. Every expected value
// is made again from the vector's inputs and compared byte for byte, except
// gzip bytes, which are inflated and compared with the plaintext.

import fs from 'node:fs';
import {
  aes128gcmDecrypt, aes128gcmEncrypt, aes128gcmHeader, b64u, ecdhAgree, ecdhKeyPair, gunzip, gzip, sessionKeys, sessionSecret, unb64u,
} from './crypto.mjs';
import { canonicalize } from './jcs.mjs';
import { openEvent, openResponse, sealEvent, sealRequest, sealResponse, uploadFrame } from './wire.mjs';

export function checkVectors(file) {
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  const results = [];
  const check = (name, fn) => {
    try {
      const notes = fn() || [];
      results.push({ name, ok: true, notes });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  };
  const eq = (what, got, want) => {
    if (Buffer.isBuffer(got)) got = b64u(got);
    if (got !== want) throw new Error(`${what}: got ${String(got).slice(0, 120)}, expected ${String(want).slice(0, 120)}`);
  };

  const h = v.handshake;
  const session = h.session;
  let keys;
  check('handshake', () => {
    const client = ecdhKeyPair(unb64u(h.client_private));
    const server = ecdhKeyPair(unb64u(h.server_private));
    eq('client_public', client.publicKey, h.client_public);
    eq('server_public', server.publicKey, h.server_public);
    const shared = ecdhAgree(client.ecdh, server.publicKey);
    eq('shared_secret (client side)', shared, h.shared_secret);
    eq('shared_secret (server side)', ecdhAgree(server.ecdh, client.publicKey), h.shared_secret);
    eq('secret info', Buffer.concat([Buffer.from('asgard/1 session\0'), client.publicKey, server.publicKey]), h.secret_info);
    const secret = sessionSecret(shared, client.publicKey, server.publicKey);
    eq('secret', secret, h.secret);
    keys = sessionKeys(secret);
    for (const k of Object.keys(h.keys)) eq(k, keys[k], h.keys[k]);
  });
  if (!keys) return results;

  const requestSigs = {};
  for (const [name, r] of Object.entries(v.requests)) {
    check(`request ${name}`, () => {
      const body = r.frame ? unb64u(r.frame.bytes) : Buffer.from(r.plaintext);
      if (r.frame) {
        eq('frame', uploadFrame(r.frame.header, unb64u(r.frame.file)), r.frame.bytes);
        const n = body.readUInt32BE(0);
        const header = JSON.parse(body.subarray(4, 4 + n).toString());
        eq('frame file size', body.length - 4 - n, header.size);
      }
      const sealed = sealRequest({
        keys, session, method: r.method, authority: r.authority, path: r.path, plaintext: body,
        extra: r.headers, created: r.created, nonce: r.nonce ?? undefined, salt: unb64u(r.salt),
      });
      eq('signature base', sealed.base, r.expected.signature_base);
      for (const [hn, hv] of Object.entries(r.expected.headers)) eq(`header ${hn}`, sealed.headers[hn], hv);
      eq('header count', Object.keys(sealed.headers).length, Object.keys(r.expected.headers).length);
      eq('signature', sealed.signature, r.expected.signature);
      eq('body', sealed.body, r.expected.body);
      eq('decrypted', aes128gcmDecrypt(sealed.body, keys.enc_c, { keyId: session }), b64u(body));
      requestSigs[name] = sealed.signature;
    });
  }

  for (const [name, r] of Object.entries(v.responses)) {
    check(`response ${name}`, () => {
      const notes = [];
      const reqSig = requestSigs[r.answers];
      if (!reqSig) throw new Error(`no request ${r.answers}`);
      const sealed = sealResponse({
        keys, session, status: r.status, plaintext: r.plaintext, requestSignature: reqSig, created: r.created,
        salt: unb64u(r.salt), compress: r.compress, cache: r.cache,
      });
      if (r.compress) {
        const gz = unb64u(r.expected.gzip);
        eq('gzip header', gz.subarray(0, 10), b64u(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])));
        eq('gunzipped', gunzip(gz).toString(), r.plaintext);
        eq('decrypted body', aes128gcmDecrypt(unb64u(r.expected.body), keys.enc_s, { keyId: session }), r.expected.gzip);
        if (!gzip(r.plaintext).equals(gz)) notes.push('this runtime\'s zlib deflates to other bytes than the vector (stock zlib); checked by inflating');
      } else {
        eq('body', sealed.body, r.expected.body);
        eq('signature base', sealed.base, r.expected.signature_base);
        for (const [hn, hv] of Object.entries(r.expected.headers)) eq(`header ${hn}`, sealed.headers[hn], hv);
      }
      const opened = openResponse({
        keys, session, status: r.status, headers: r.expected.headers, body: unb64u(r.expected.body), requestSignature: reqSig, now: r.created,
      });
      eq('opened', opened.plaintext.toString(), r.plaintext);
      return notes;
    });
  }

  const streamSig = requestSigs[v.events.answers];
  for (const [name, e] of Object.entries(v.events)) {
    if (name === 'answers') continue;
    check(`event ${name}`, () => {
      const notes = [];
      if (e.compress) {
        const gz = unb64u(e.expected.gzip);
        eq('gunzipped', gunzip(gz).toString(), e.plaintext);
        if (!gzip(e.plaintext).equals(gz)) notes.push('this runtime\'s zlib deflates to other bytes than the vector (stock zlib); checked by inflating');
      } else {
        const sealed = sealEvent({ keys, session, requestSignature: streamSig, id: e.id, event: e.event, plaintext: e.plaintext, salt: unb64u(e.salt) });
        eq('data', sealed.data, e.expected.data);
        eq('signature base', sealed.base, e.expected.signature_base);
      }
      const opened = openEvent({ keys, session, requestSignature: streamSig, id: e.id, event: e.event, data: e.expected.data });
      eq('opened', opened.plaintext.toString(), e.plaintext);
      return notes;
    });
  }

  check('records', () => {
    const r = v.records;
    const body = aes128gcmEncrypt(Buffer.from(r.plaintext), keys[r.ikm], r.key_id, { salt: unb64u(r.salt), recordSize: r.record_size });
    eq('body', body, r.expected.body);
    const header = aes128gcmHeader(body);
    eq('record count', Math.ceil((body.length - header.start) / r.record_size), r.expected.records);
    eq('decrypted', aes128gcmDecrypt(body, keys[r.ikm], { keyId: r.key_id }).toString(), r.plaintext);
  });

  for (const c of v.canonical ?? []) {
    check(`canonical ${c.name}`, () => {
      c.inputs.forEach((input, i) => eq(`input ${i}`, canonicalize(JSON.parse(input)), c.expected));
    });
  }

  for (const t of v.refuse) {
    check(`refuse ${t.name}`, () => {
      let opened = false;
      try {
        if (t.open === 'body') {
          aes128gcmDecrypt(unb64u(t.body), keys[t.ikm], { keyId: t.key_id });
        } else if (t.open === 'response') {
          const r = v.responses[t.response];
          const headers = { ...r.expected.headers, ...(t.set_header ?? {}) };
          if (t.drop_header) delete headers[t.drop_header];
          openResponse({ keys, session, status: r.status, headers, body: unb64u(r.expected.body), requestSignature: requestSigs[t.request], now: r.created });
        } else if (t.open === 'event') {
          const e = v.events[t.event];
          const data = JSON.parse(e.expected.data);
          if (t.set_enc) data.enc = t.set_enc;
          openEvent({ keys, session, requestSignature: streamSig, id: t.id ?? e.id, event: e.event, data: JSON.stringify(data) });
        } else if (t.open === 'canonical') {
          canonicalize(JSON.parse(t.input));
        } else if (t.open === 'point') {
          ecdhAgree(ecdhKeyPair().ecdh, unb64u(t.point));
        }
        opened = true;
      } catch {
        // refused, as it must be
      }
      if (opened) throw new Error(`accepted something it must refuse: ${t.why}`);
    });
  }

  return results;
}

/**
 * Checks that schema/fragment.schema.json and schema/constants.json say the
 * same thing wherever both say something.
 */
export function checkConstants(schemaDir) {
  const c = JSON.parse(fs.readFileSync(`${schemaDir}/constants.json`, 'utf8'));
  const f = JSON.parse(fs.readFileSync(`${schemaDir}/fragment.schema.json`, 'utf8'));
  const d = f.$defs;
  const problems = [];
  const same = (what, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: fragment.schema.json has ${JSON.stringify(a)}, constants.json has ${JSON.stringify(b)}`);
  };
  same('transitions', d.transition.enum, c.slots.transitions);
  same('call pattern', d.call.properties.call.pattern, c.limits.call.pattern);
  same('args maxItems', d.call.properties.args.maxItems, c.limits.args.max_items);
  same('args nesting', ['argValue4', 'argValue3', 'argValue2', 'argValue1'].filter((k) => d[k]).length, c.limits.args.max_nesting);
  same('targets', d.call.properties.target.enum, c.slots.targets);
  same('type pattern', d.node.properties.type.pattern, c.elements.type_pattern);
  same('slot names', Object.keys(d.node.properties).filter((k) => k.startsWith('on_')), c.slots.names);
  same('press slots', Object.keys(d.node.properties).filter((k) => d.node.properties[k].$ref === '#/$defs/pressSlot'), c.slots.press);
  same('value slots', Object.keys(d.node.properties).filter((k) => d.node.properties[k].$ref === '#/$defs/valueSlot'), c.slots.value);
  same('node members', Object.keys(d.node.properties).sort(), [...c.elements.node_members].sort());
  same('media props', Object.keys(d.props.properties), c.elements.media_props);
  same('media URL max', d.mediaUrl.oneOf[1].maxLength, c.limits.media_url_bytes.max);
  same('navigate max', d.navigate.properties.navigate.maxLength, c.limits.navigate_bytes.max);
  same('reserved prop prefixes', d.props.propertyNames.not.pattern, '^(' + c.elements.reserved_prop_prefixes.join('|') + ')');
  same('webview local', d.node.allOf[1].then.properties.props.properties.local.enum, c.elements.webview.local_allowed);
  same('navigation members', Object.keys(d.navigate.properties), c.slots.kinds.navigate.members);
  same('back members', Object.keys(d.back.properties), c.slots.kinds.back.members);
  same('call members', Object.keys(d.call.properties), c.slots.kinds.call.members);
  return problems;
}
