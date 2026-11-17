// A small subset of RFC 8941 Structured Field Values: enough to write and
// read the Signature-Input and Signature dictionaries of RFC 9421.
//
// Items are {type, value, params}. Types: string, token, integer, boolean,
// bytes (value is a Buffer), inner (value is a list of items).

export const string = (value, params = {}) => ({ type: 'string', value, params });
export const integer = (value, params = {}) => ({ type: 'integer', value, params });
export const boolean = (value, params = {}) => ({ type: 'boolean', value, params });
export const bytes = (value, params = {}) => ({ type: 'bytes', value, params });
export const inner = (value, params = {}) => ({ type: 'inner', value, params });

export function serializeBareItem(item) {
  switch (item.type) {
    case 'string':
      if (/[\x00-\x1f\x7f-￿]/.test(item.value)) throw new Error('sf: string has a character outside printable ASCII');
      return '"' + item.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    case 'token':
      return item.value;
    case 'integer':
      if (!Number.isInteger(item.value)) throw new Error('sf: not an integer');
      return String(item.value);
    case 'boolean':
      return item.value ? '?1' : '?0';
    case 'bytes':
      return ':' + Buffer.from(item.value).toString('base64') + ':';
    default:
      throw new Error(`sf: cannot serialize a bare ${item.type}`);
  }
}

export function serializeParams(params) {
  let out = '';
  for (const [name, value] of Object.entries(params ?? {})) {
    out += ';' + name;
    if (!(value.type === 'boolean' && value.value === true)) out += '=' + serializeBareItem(value);
  }
  return out;
}

export function serializeItem(item) {
  if (item.type === 'inner') {
    return '(' + item.value.map(serializeItem).join(' ') + ')' + serializeParams(item.params);
  }
  return serializeBareItem(item) + serializeParams(item.params);
}

// Parsing

class Parser {
  constructor(input) {
    this.s = input;
    this.i = 0;
  }
  peek() { return this.s[this.i]; }
  eof() { return this.i >= this.s.length; }
  skipSp() { while (this.peek() === ' ') this.i++; }
  skipOws() { while (this.peek() === ' ' || this.peek() === '\t') this.i++; }
  fail(why) { throw new Error(`sf: ${why} at ${this.i} in ${JSON.stringify(this.s)}`); }

  key() {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(this.s.slice(this.i));
    if (!m) this.fail('expected a key');
    this.i += m[0].length;
    return m[0];
  }

  bareItem() {
    const c = this.peek();
    if (c === '"') return this.str();
    if (c === ':') return this.bytes();
    if (c === '?') return this.bool();
    if (c === '-' || /[0-9]/.test(c)) return this.num();
    if (/[A-Za-z*]/.test(c)) return this.token();
    return this.fail('expected an item');
  }

  str() {
    this.i++;
    let out = '';
    while (!this.eof()) {
      const c = this.s[this.i++];
      if (c === '\\') {
        const n = this.s[this.i++];
        if (n !== '"' && n !== '\\') this.fail('bad escape');
        out += n;
      } else if (c === '"') {
        return string(out);
      } else if (c < ' ' || c > '~') {
        this.fail('bad string character');
      } else {
        out += c;
      }
    }
    return this.fail('unterminated string');
  }

  bytes() {
    this.i++;
    const end = this.s.indexOf(':', this.i);
    if (end < 0) this.fail('unterminated byte sequence');
    const b64 = this.s.slice(this.i, end);
    if (!/^[A-Za-z0-9+/=]*$/.test(b64)) this.fail('bad byte sequence');
    this.i = end + 1;
    return bytes(Buffer.from(b64, 'base64'));
  }

  bool() {
    this.i++;
    const c = this.s[this.i++];
    if (c === '1') return boolean(true);
    if (c === '0') return boolean(false);
    return this.fail('bad boolean');
  }

  num() {
    const m = /^-?[0-9]{1,15}/.exec(this.s.slice(this.i));
    if (!m) this.fail('bad integer');
    this.i += m[0].length;
    if (this.peek() === '.') this.fail('decimals are not used here');
    return integer(Number(m[0]));
  }

  token() {
    const m = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(this.s.slice(this.i));
    this.i += m[0].length;
    return { type: 'token', value: m[0], params: {} };
  }

  params() {
    const params = {};
    while (this.peek() === ';') {
      this.i++;
      this.skipSp();
      const k = this.key();
      let v = boolean(true);
      if (this.peek() === '=') {
        this.i++;
        v = this.bareItem();
      }
      if (k in params) this.fail(`duplicate parameter ${k}`);
      params[k] = v;
    }
    return params;
  }

  itemOrInner() {
    if (this.peek() === '(') {
      this.i++;
      const items = [];
      for (;;) {
        this.skipSp();
        if (this.peek() === ')') {
          this.i++;
          break;
        }
        const item = this.bareItem();
        item.params = this.params();
        items.push(item);
        const c = this.peek();
        if (c !== ' ' && c !== ')') this.fail('bad inner list');
      }
      return inner(items, this.params());
    }
    const item = this.bareItem();
    item.params = this.params();
    return item;
  }

  dictionary() {
    const dict = {};
    this.skipSp();
    while (!this.eof()) {
      const k = this.key();
      let v;
      if (this.peek() === '=') {
        this.i++;
        v = this.itemOrInner();
      } else {
        v = boolean(true, this.params());
      }
      dict[k] = v;
      this.skipOws();
      if (this.eof()) break;
      if (this.peek() !== ',') this.fail('expected a comma');
      this.i++;
      this.skipOws();
      if (this.eof()) this.fail('trailing comma');
    }
    return dict;
  }
}

export function parseDictionary(input) {
  return new Parser(String(input)).dictionary();
}
