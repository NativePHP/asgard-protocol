// Raw HTTP with node:http and node:https. The runner needs bytes exactly as
// sent, any method name (QUERY), and no content decoding (§7.4 says a
// client must not let its HTTP library decode the body).

import http from 'node:http';
import https from 'node:https';

let insecure = false;
export function setInsecure(value) {
  insecure = value;
}

function lib(url) {
  return url.protocol === 'https:' ? https : http;
}

export function request({ url, method, headers = {}, body, timeoutMs = 30000 }) {
  url = new URL(url);
  return new Promise((resolve, reject) => {
    const req = lib(url).request(url, {
      method,
      headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
      rejectUnauthorized: !insecure,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Open an SSE stream. Resolves once the response head arrives with
 * {status, headers, events, comments, body, close, closed}. When the
 * status is not 200 the body is read whole, as for request().
 */
export function openStream({ url, method, headers = {}, body }) {
  url = new URL(url);
  return new Promise((resolve, reject) => {
    const req = lib(url).request(url, {
      method,
      headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
      rejectUnauthorized: !insecure,
    }, (res) => {
      const isStream = res.statusCode === 200 && /^text\/event-stream/i.test(res.headers['content-type'] ?? '');
      if (!isStream) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), events: [], comments: [], close() {}, closed: Promise.resolve() }));
        return;
      }
      const events = [];
      const comments = [];
      let buffer = '';
      let current = { data: [] };
      let closedResolve;
      const closed = new Promise((r) => { closedResolve = r; });
      const dispatch = () => {
        if (current.data.length || current.event || current.id !== undefined) {
          events.push({ id: current.id, event: current.event ?? 'message', data: current.data.join('\n'), at: Date.now() });
        }
        current = { data: [] };
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
          if (line === '') dispatch();
          else if (line.startsWith(':')) comments.push({ text: line.slice(1).trim(), at: Date.now() });
          else {
            const i = line.indexOf(':');
            const field = i < 0 ? line : line.slice(0, i);
            let value = i < 0 ? '' : line.slice(i + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'data') current.data.push(value);
            else if (field === 'event') current.event = value;
            else if (field === 'id') current.id = value;
            else if (field === 'retry') current.retry = value;
          }
        }
      });
      res.on('end', () => closedResolve('ended'));
      res.on('error', () => closedResolve('error'));
      resolve({
        status: res.statusCode, headers: res.headers, events, comments, body: null,
        close() { req.destroy(); closedResolve('closed'); },
        closed,
      });
    });
    req.on('error', (e) => {
      if (e.code === 'ECONNRESET' || e.message === 'socket hang up') return;
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}
