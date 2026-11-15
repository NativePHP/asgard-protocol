// Loads golden cases from conformance/cases and runs them against a live
// server as an Asgard client would. The file format is in
// conformance/README.md under "Writing a case".

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { b64u, ecdhAgree, ecdhKeyPair, randomNonce, sessionKeys, sessionSecret, unb64u } from './crypto.mjs';
import { checkFragment, checkSlot } from './fragment.mjs';
import { openStream, request } from './http.mjs';
import { match, substitute } from './match.mjs';
import { openEvent, openResponse, sealRequest, uploadFrame } from './wire.mjs';

import constants from '../../../schema/constants.json' with { type: 'json' };

// The unsigned early rejections of §7.3, as status -> list of error codes.
const EARLY = {};
for (const { status, body } of constants.early_rejections.value) (EARLY[status] ??= []).push(body.error);

export function loadCases(dir) {
  const cases = [];
  if (!fs.existsSync(dir)) return cases;
  for (const name of fs.readdirSync(dir).sort()) {
    const caseDir = path.join(dir, name);
    if (!fs.statSync(caseDir).isDirectory()) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
    const files = fs.readdirSync(caseDir);
    const steps = [];
    if (files.includes('request.json')) {
      steps.push({ name: 'request', request: readJson(caseDir, 'request.json'), response: readJson(caseDir, 'response.json') });
    }
    for (const f of files.filter((x) => /^\d+\.request\.json$/.test(x)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
      const n = f.split('.')[0];
      steps.push({ name: `step ${n}`, request: readJson(caseDir, f), response: readJson(caseDir, `${n}.response.json`) });
    }
    if (steps.length === 0) throw new Error(`case ${name} has no request.json`);
    cases.push({ name, dir: caseDir, ...meta, steps });
  }
  return cases;
}

function readJson(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

function lower(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
}

function withUnique(value, vars) {
  if (typeof value === 'string') {
    const m = /^\{\{unique:([A-Za-z0-9_]+)\}\}$/.exec(value);
    if (m) {
      vars[m[1]] ??= 'u' + crypto.randomBytes(6).toString('hex');
      return vars[m[1]];
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => withUnique(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withUnique(v, vars)]));
  return value;
}

export class Runner {
  constructor({ base, key, transport = 'auto' }) {
    this.base = base.replace(/\/+$/, '');
    this.key = key;
    this.transport = transport;
  }

  endpointUrl(endpoint) {
    return `${this.base}/${endpoint}`;
  }

  async handshake({ elements } = {}) {
    const pair = ecdhKeyPair();
    const body = { key: this.key, protocol: 1, accepts: ['tree/json'], client_public: b64u(pair.publicKey) };
    if (elements) body.elements = elements;
    const res = await request({ url: this.endpointUrl('session'), method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    if (res.status !== 200) throw new Error(`handshake failed: ${res.status} ${res.body.toString().slice(0, 200)}`);
    return this.adopt(pair, JSON.parse(res.body.toString()), elements);
  }

  adopt(pair, answer, elements) {
    const serverPublic = unb64u(answer.server_public);
    const shared = ecdhAgree(pair.ecdh, serverPublic);
    const secret = sessionSecret(shared, pair.publicKey, serverPublic);
    return { id: answer.session, keys: sessionKeys(secret), elements: elements ?? [] };
  }

  /** Probe the transport as §8 says: the first safe request goes as QUERY. */
  async probe() {
    if (this.transport !== 'auto') return this.transport;
    const session = await this.handshake();
    const sent = await this.send({
      session, endpoint: 'routes', method: 'QUERY', override: false, plaintext: JSON.stringify({ protocol: 1 }), nonce: null,
    });
    const answer = this.read(sent, session);
    // A valid answer is a sealed one, or an early rejection other than 405
    // whose body is the one §7.3 gives for its status.
    const early = [EARLY[answer.status]].flat();
    const valid = answer.sealed ? !answer.error : (answer.status !== 405 && early.includes(answer.body?.error));
    this.transport = valid ? 'query' : 'post';
    return this.transport;
  }

  async send({ session, endpoint, method, override, plaintext, nonce, tamper = {}, createdOffset = 0, headers = {}, signed = {}, stream = false }) {
    const url = new URL(this.endpointUrl(endpoint));
    const extra = { ...signed };
    if (override) extra['x-asgard-method'] = 'QUERY';
    const sessionId = tamper.session === 'none' ? '' : tamper.session === 'unknown' ? 'conformance-unknown-' + crypto.randomBytes(8).toString('hex') : session.id;
    const sealed = sealRequest({
      keys: session.keys, session: sessionId || 'none', method, authority: url.host, path: url.pathname, plaintext,
      extra, created: Math.floor(Date.now() / 1000) + createdOffset, nonce: nonce ?? undefined, tamper,
    });
    const wire = { ...sealed.headers, accept: stream ? 'text/event-stream' : 'application/json', ...lower(headers) };
    if (tamper.session === 'none') delete wire['asgard-session-id'];
    if (tamper.session === 'unknown') wire['asgard-session-id'] = sessionId;
    for (const [k, v] of Object.entries(tamper.addHeaders ?? {})) wire[k] = v;
    const args = { url, method, headers: wire, body: sealed.body };
    const res = stream ? await openStream(args) : await request(args);
    return { res, signature: sealed.signature, plaintext, method, url: url.href, headers: wire };
  }

  /** Open an answer: sealed answers are verified and decrypted, plain ones parsed. */
  read(sent, session) {
    const { res } = sent;
    const headers = lower(res.headers);
    const out = { status: res.status, headers, sealed: false, body: undefined, problems: [] };
    if (headers['signature-input'] || headers['signature']) {
      out.sealed = true;
      try {
        const opened = openResponse({ keys: session.keys, session: session.id, status: res.status, headers, body: res.body, requestSignature: sent.signature });
        out.coding = opened.coding;
        out.raw = opened.plaintext;
        out.body = JSON.parse(opened.plaintext.toString());
      } catch (e) {
        out.error = `sealed answer failed to open: ${e.message}`;
      }
      return out;
    }
    try {
      out.body = res.body.length ? JSON.parse(res.body.toString()) : undefined;
    } catch {
      out.body = res.body.toString().slice(0, 300);
      out.notJson = true;
    }
    return out;
  }

  async runCase(c) {
    const vars = { key: this.key };
    const failures = [];
    const transcript = [];
    let session = null;
    let lastNonce = null;
    const needSession = async () => {
      session ??= await this.handshake(c.session ?? {});
      return session;
    };

    for (const step of c.steps) {
      const req = substitute(withUnique(step.request, vars), vars);
      const expect = substitute(step.response, {});
      const errs = [];
      try {
        if (req.endpoint === 'session') {
          await this.sessionStep(req, expect, vars, errs, transcript, (s) => { session = s; });
        } else {
          const s = req.session === 'fresh' ? (session = await this.handshake(c.session ?? {})) : await needSession();
          lastNonce = await this.sealedStep(req, expect, s, vars, errs, transcript, lastNonce);
        }
      } catch (e) {
        errs.push(`error: ${e.message}`);
      }
      for (const e of errs) failures.push(`${step.name}: ${e}`);
    }
    return { name: c.name, ok: failures.length === 0, failures, transcript };
  }

  async sessionStep(req, expect, vars, errs, transcript, setSession) {
    const pair = ecdhKeyPair();
    vars.client_public = b64u(pair.publicKey);
    const body = req.raw ?? JSON.stringify(substitute(req.body, vars));
    const res = await request({
      url: this.endpointUrl('session'), method: req.method ?? 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...lower(req.headers) }, body,
    });
    const headers = lower(res.headers);
    let parsed;
    try {
      parsed = res.body.length ? JSON.parse(res.body.toString()) : undefined;
    } catch {
      parsed = res.body.toString().slice(0, 300);
    }
    transcript.push({ request: { endpoint: 'session', method: req.method ?? 'POST', body: tryJson(body) }, response: { status: res.status, body: parsed } });
    if (headers['signature-input'] || headers['signature']) errs.push('a handshake answer is never signed (§6.1)');
    this.compare(expect, { status: res.status, headers, sealed: false, body: parsed }, vars, errs);
    if (req.use && res.status === 200 && parsed?.session) setSession(this.adopt(pair, parsed, req.body?.elements));
  }

  async sealedStep(req, expect, session, vars, errs, transcript, lastNonce) {
    const endpoint = req.endpoint;
    const form = req.method ? { method: req.method, override: req.override ?? (req.method === 'POST') } : this.transport === 'query' ? { method: 'QUERY', override: false } : { method: 'POST', override: true };

    let plaintext;
    if (req.upload) {
      const file = uploadFile(req.upload);
      const header = { ...req.upload.header };
      if (!('size' in header)) header.size = file.length;
      vars.upload_sha256 = crypto.createHash('sha256').update(file).digest('hex');
      vars.upload_size = file.length;
      let frame = uploadFrame(header, file);
      if (req.upload.header_length !== undefined) frame.writeUInt32BE(req.upload.header_length, 0);
      if (req.upload.truncate) frame = frame.subarray(0, req.upload.truncate);
      plaintext = frame;
    } else {
      plaintext = req.raw !== undefined ? req.raw : JSON.stringify(req.body);
    }

    const unsafe = endpoint === 'call' || endpoint === 'upload' || (endpoint === 'render' && req.body && 'action' in req.body);
    const seal = req.seal ?? {};
    let nonce = null;
    if (seal.nonce === 'reuse') nonce = lastNonce;
    else if (seal.nonce === true || (seal.nonce === undefined && unsafe)) nonce = randomNonce();

    const tamper = { ...(seal.tamper ?? {}) };
    if (tamper.drop_component) {
      const drop = tamper.drop_component;
      tamper.cover = (list) => list.filter((n) => n !== drop);
      delete tamper.drop_component;
    }
    if (tamper.flip_signature) tamper.flipSignature = true;
    if (tamper.flip_body) tamper.flipBody = true;
    if (tamper.body_key_id) tamper.bodyKeyId = tamper.body_key_id;
    if (tamper.add_headers) tamper.addHeaders = tamper.add_headers;
    if (tamper.content_encoding !== undefined) tamper.contentEncoding = tamper.content_encoding;
    if ('protocol_header' in tamper) tamper.protocolHeader = tamper.protocol_header;
    if (seal.session) tamper.session = seal.session;

    const signed = {};
    if (req.authorization) signed.authorization = req.authorization;

    if (endpoint === 'stream' && expect.status === 200) {
      await this.streamStep(req, expect, session, vars, errs, transcript, { form, plaintext, nonce, tamper, signed, seal });
      return nonce ?? lastNonce;
    }

    const sent = await this.send({
      session, endpoint, method: form.method, override: form.override, plaintext, nonce, tamper,
      createdOffset: seal.created_offset ?? 0, headers: req.headers ?? {}, signed, stream: endpoint === 'stream',
    });
    const answer = this.read(sent, session);
    transcript.push({ request: { endpoint, method: form.method, body: req.upload ? { upload: req.upload.header } : tryJson(plaintext) }, response: { status: answer.status, sealed: answer.sealed, coding: answer.coding, body: answer.body } });
    this.compare(expect, answer, vars, errs);
    this.invariants(endpoint, answer, session, errs);
    return nonce ?? lastNonce;
  }

  async streamStep(req, expect, session, vars, errs, transcript, { form, plaintext, nonce, tamper, signed, seal }) {
    const sent = await this.send({
      session, endpoint: 'stream', method: form.method, override: form.override, plaintext, nonce, tamper,
      createdOffset: seal.created_offset ?? 0, headers: req.headers ?? {}, signed, stream: true,
    });
    const { res } = sent;
    if (res.status !== 200 || res.body) {
      const answer = this.read({ ...sent, res: { ...res, body: res.body ?? Buffer.alloc(0) } }, session);
      transcript.push({ request: { endpoint: 'stream', body: tryJson(plaintext) }, response: { status: answer.status, body: answer.body } });
      this.compare(expect, answer, vars, errs);
      return;
    }
    const headers = lower(res.headers);
    if (!/^text\/event-stream/i.test(headers['content-type'] ?? '')) errs.push(`stream answered ${headers['content-type']}, not text/event-stream`);

    const listen = req.listen_ms ?? 2500;
    const started = Date.now();
    const during = [];
    if (req.during) {
      await sleep(req.during_after_ms ?? 800);
      for (const d of req.during) {
        const dreq = substitute(withUnique(d.request, vars), vars);
        const derrs = [];
        await this.sealedStep(dreq, substitute(d.response, {}), session, vars, derrs, during, null);
        for (const e of derrs) errs.push(`during ${dreq.endpoint}: ${e}`);
      }
    }
    await sleep(Math.max(0, listen - (Date.now() - started)));
    res.close();

    const events = [];
    for (const ev of res.events) {
      try {
        const opened = openEvent({ keys: session.keys, session: session.id, requestSignature: sent.signature, id: ev.id ?? '', event: ev.event, data: ev.data });
        events.push({ event: ev.event, id: ev.id, enc: opened.enc, data: JSON.parse(opened.plaintext.toString()) });
      } catch (e) {
        errs.push(`event ${ev.event} id ${ev.id} failed its checks: ${e.message}`);
      }
    }
    transcript.push(...during);
    transcript.push({ request: { endpoint: 'stream', body: tryJson(plaintext) }, response: { status: 200, events, pings: res.comments.filter((c) => c.text === 'ping').length } });

    for (const e of events) {
      if (e.event === 'signal' && e.enc !== 'identity') errs.push('a signal MUST NOT be compressed (§8.1)');
      if (e.enc === 'gzip' && JSON.stringify(e.data).length < 1024) errs.push(`event ${e.event} is gzipped below 1024 bytes (§7.4)`);
      if (e.data?.fragment !== undefined) for (const p of checkFragment(e.data.fragment, session.elements)) errs.push(`event fragment: ${p}`);
    }

    const pending = [...events];
    for (const [i, want] of (expect.events ?? []).entries()) {
      const idx = pending.findIndex((got) => match(want, { event: got.event, data: got.data }, '$', { ...vars }, []).length === 0);
      if (idx < 0) {
        const detail = pending.length ? match(want, { event: pending[0].event, data: pending[0].data }, '$', { ...vars }, [])[0] : 'no events left';
        errs.push(`expected event ${i} not seen (${detail}); saw ${JSON.stringify(events.map((e) => ({ event: e.event, data: e.data }))).slice(0, 600)}`);
        continue;
      }
      match(want, { event: pending[idx].event, data: pending[idx].data }, '$', vars, []);
      pending.splice(idx, 1);
    }
    if (expect.exact && pending.length) errs.push(`unexpected events: ${JSON.stringify(pending.map((e) => ({ event: e.event, data: e.data }))).slice(0, 600)}`);
    if (expect.ping && !res.comments.some((c) => c.text === 'ping')) errs.push(`no ": ping" comment in ${listen} ms (§8.1 says every 5 seconds)`);
  }

  compare(expect, answer, vars, errs) {
    if (answer.error) {
      errs.push(answer.error);
      return;
    }
    const statuses = Array.isArray(expect.status) ? expect.status : [expect.status];
    if (!statuses.includes(answer.status)) {
      errs.push(`status ${answer.status}, expected ${statuses.join(' or ')}; body ${JSON.stringify(answer.body)?.slice(0, 300)}`);
      return;
    }
    if (expect.sealed === true && !answer.sealed) errs.push(`expected a sealed answer, got a plain one: ${JSON.stringify(answer.body)?.slice(0, 200)}`);
    if (expect.sealed === false && answer.sealed) errs.push('expected a plain, unsigned answer, got a sealed one');
    if (answer.notJson) errs.push(`the answer is not JSON: ${answer.body}`);
    for (const [k, want] of Object.entries(expect.headers ?? {})) {
      for (const e of match(want, answer.headers[k.toLowerCase()], `header ${k}`, vars, [])) errs.push(e);
    }
    if ('body' in expect || expect.body_by_status) {
      const want = expect.body_by_status?.[answer.status] ?? expect.body;
      for (const e of match(want, answer.body, '$', vars, [])) errs.push(e);
    }
  }

  /**
   * Transfer rules every sealed answer must follow, whatever the case
   * expects: compression (§7.4), fragment validity (§9.3) and Asgard-Cache
   * (§8.3). The shape of a body is left to each case.
   */
  invariants(endpoint, answer, session, errs) {
    if (!answer.sealed || answer.error) return;
    const body = answer.body;
    if (answer.coding === 'gzip') {
      if (answer.status !== 200) errs.push('an error answer is gzipped; errors MUST NOT be compressed (§7.4)');
      if (endpoint === 'call' || endpoint === 'upload') errs.push(`a ${endpoint} answer is gzipped; it MUST NOT be (§7.4)`);
      if (answer.raw && answer.raw.length < 1024) errs.push('the answer is gzipped below 1024 bytes (§7.4)');
      if (body?.delta && Object.keys(body.delta).length) errs.push('the answer is gzipped with a non-empty delta (§5.4, §7.4)');
    }
    if (answer.status === 200 && body && typeof body === 'object' && ['render', 'call', 'upload'].includes(endpoint)) {
      for (const [region, part] of Object.entries(body.fragments ?? {})) {
        if (part?.cached === true) continue;
        if (part && 'fragment' in part) for (const p of checkFragment(part.fragment, session.elements)) errs.push(`fragments.${region}: ${p}`);
        for (const p of checkChrome(part?.chrome)) errs.push(`fragments.${region}.chrome: ${p}`);
      }
      if (answer.headers['asgard-cache'] === 'invalidate' && Object.values(body.fragments ?? {}).some((p) => p?.cached === true)) {
        errs.push('Asgard-Cache: invalidate on an answer with a cached part (§8.3)');
      }
    }
  }
}

function checkChrome(chrome) {
  if (chrome === undefined) return [];
  if (!chrome || typeof chrome !== 'object' || Array.isArray(chrome)) return ['chrome is not an object'];
  const problems = [];
  for (const a of chrome.nav_bar?.actions ?? []) if (a.on_press) problems.push(...checkSlot(a.on_press, 'on_press'));
  return problems;
}

function uploadFile(u) {
  if (u.file_base64 !== undefined) return Buffer.from(u.file_base64, 'base64');
  if (u.file_repeat) return Buffer.alloc(u.file_repeat.length, u.file_repeat.byte ?? 'a');
  return Buffer.from(u.file ?? '');
}

function tryJson(x) {
  try {
    return JSON.parse(Buffer.isBuffer(x) ? x.toString() : x);
  } catch {
    return Buffer.isBuffer(x) ? `<${x.length} bytes>` : x;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
