# Asgard conformance suite

Tools for checking an implementation of [protocol.md](../protocol.md)
against the spec rather than against another implementation. The idea
follows Datastar's SDK kit: one file of constants every implementation reads
from ([schema/constants.json](../schema/constants.json)), and one set of
language-neutral test cases every server is run against.

```
conformance/
  FIXTURES.md     the components a server adds to its app for a test run
  vectors/        byte-exact vectors, checked with no server
  cases/          golden server cases, one directory each
  runner/         a zero-dependency Node.js runner for both
```

The runner needs Node 24 and nothing else. It only uses Node's built-in
modules.

## Vectors

`vectors/vectors.json` holds fixed inputs and the exact bytes they must
produce:

- the handshake: both key pairs, the ECDH shared secret, the HKDF `info`, the
  session secret and the four keys (§6.1, §7.2);
- sealed requests: an action with a bearer token and a nonce, a QUERY render,
  a method call, an upload frame and a stream request, each with its
  headers, signature base, signature and aes128gcm body (§7.3, §7.4, §10.6);
- sealed responses: an action answer, a gzipped render answer, an answer
  carrying `Asgard-Cache: invalidate`, a sealed 404, a call answer and an
  upload answer, each bound to its request (§7.3, §7.4, §8.3);
- stream events: a signal, a fragment, a gzipped fragment and a patch, each
  bound to the stream request (§8.1, §8.2);
- a body of three aes128gcm records (§7.4);
- things a receiver must refuse: a truncated body, a body for another key id,
  a response for another request, a response with `Asgard-Cache` stripped or
  `Asgard-Content-Coding` flipped, a renumbered event, an event with `enc`
  flipped, and a point that is not on P-256.

The handshake inputs are the ones in the interop file that the reference
client and server already share, so every key matches theirs. The message
plaintexts use the current shapes, and none has a `platform` member.

```sh
node conformance/runner/run.mjs --vectors
```

This also checks that `schema/fragment.schema.json` and
`schema/constants.json` agree wherever both say something.

**gzip bytes.** §7.4 fixes the gzip header and level 6 so answers are
comparable, but not so that they are the same bytes. Node bundles a fork of
zlib that deflates to different bytes at level 6 than stock zlib does, and so
may zlib-ng or miniz. The gzip bytes in the vectors come from stock zlib 1.3.
As §7.4 says, an implementation checks them by inflating, and its own gzip
output by checking the fixed header and that it inflates to the plaintext.
The runner says when its own deflate differs.

`vectors/make-vectors.mjs` rebuilds the file from its fixed inputs. It needs
`php` on the path for stock zlib. Rebuild only when the protocol changes what
a vector holds, never to make a failing implementation pass.

## Testing a server

1. Add the components in [FIXTURES.md](FIXTURES.md) to a build of your app
   used only for testing. Follow its server setup notes: the bearer token to
   refuse, and a push store the stream and the call both see.
2. Run the server where the runner can reach it. Something that can carry
   QUERY is best. PHP's built-in web server, for one, answers QUERY with 501,
   so the runner falls back to POST and `transport-query` fails.
3. Run:

```sh
node conformance/runner/run.mjs --server https://app.test/_asgard --key <asgard_key>
```

Options:

| Option | |
|---|---|
| `--server URL` | The server's `{base}`. `http:` is accepted for a development server. |
| `--key KEY` | The server's `asgard_key`, or set `ASGARD_KEY`. |
| `--case NAME` | Run only these cases. Repeat it or separate with commas. `stream-*` matches a prefix. |
| `--transport auto\|query\|post` | `auto` probes as a client does (§8): the first safe request goes as QUERY and the runner falls back to POST with `X-Asgard-Method: QUERY` on a 405, a 501 or an answer that is not Asgard's. |
| `--insecure` | Accept a TLS certificate the system does not trust, such as a local development one. |
| `-v` | Print every request and answer in plaintext. |
| `--json` | Print results as JSON. |
| `--list` | List the cases with their sections. |

The runner is a client. Each case gets its own handshake with a fresh P-256
key pair, and every request is sealed and signed exactly as §7.3 and §7.4
say, with a fresh nonce wherever one is needed. Every sealed answer is
verified against the request it answers, then decrypted and, when
`Asgard-Content-Coding` says so, inflated. Every stream event's `sig` is
checked against the stream request's signature before it is opened.

It prints PASS or FAIL per case, with every mismatch under a failure, and
exits 1 when anything failed (2 on a usage error).

### Checks on every answer

Some rules hold for every answer, whatever the case is about, so the runner
checks them on each sealed answer as well as the case's own expectations:

- a gzipped answer is a 200 for a region, at least 1024 bytes before
  compression, with `delta` `{}`; call, upload and error answers are never
  gzipped (§7.4);
- every fragment in an answer or event passes the client's checks of §9.3:
  only core and advertised types, no reserved type or prop, nesting of at
  most 64, unique sibling keys, well-formed slots and https media URLs;
- an answer with `Asgard-Cache: invalidate` has no `cached` part (§8.3);
- a signal event is never compressed (§8.1).

## Cases

Each case is a directory in `cases/`:

```
cases/action-increment/
  case.json        what it checks and which sections
  request.json     the plaintext request
  response.json    the plaintext answer expected
```

A case with several steps numbers them instead: `1.request.json`,
`1.response.json`, `2.request.json` and so on. Steps share one session and
one set of saved values.

### case.json

```json
{
  "description": "An action runs, its change comes back in delta, and its region shows it.",
  "sections": ["§5.4", "§10.2"],
  "session": {"elements": ["list_item"]}
}
```

`session` is optional. It sets the `elements` the case's handshake
advertises.

### request.json

```json
{
  "endpoint": "render",
  "body": {
    "protocol": 1,
    "component": "conformance.counter",
    "regions": ["count"],
    "state": {"count": 2},
    "action": {"call": "increment", "args": [1]}
  }
}
```

| Member | |
|---|---|
| `endpoint` | `session`, `render`, `stream`, `call`, `upload` or `routes`. |
| `body` | The plaintext JSON body. |
| `raw` | A plaintext body as a string, instead of `body`, for one that is not JSON. |
| `upload` | Instead of `body`, an upload frame: `header` (the JSON header, with `size` filled in unless given), and the file as `file` (text), `file_base64`, or `file_repeat` (`{"length", "byte"}`). `header_length` overwrites the frame's length prefix. |
| `method`, `override` | Force the HTTP method, and whether to send `X-Asgard-Method: QUERY`. Left out, the request uses the form the probe settled on. |
| `authorization` | A bearer token header, sent and covered by the signature. |
| `headers` | More headers, sent but not signed (`last-event-id`, say). |
| `seal` | How to seal it. `nonce`: `true`, `false` or `"reuse"` (the previous step's). Left out, a nonce goes on actions, calls and uploads only. `session`: `"none"` or `"unknown"`. `created_offset`: seconds added to `created`. `tamper`: break one thing on purpose: `flip_body`, `flip_signature`, `lifetime`, `keyid`, `alg`, `tag`, `params`, `drop_component`, `add_headers` (unsigned), `body_key_id`. |
| `session` | `"fresh"` for a new handshake before this step. |
| `use` | On a `session` step: carry on with the session this handshake made. |

A `session` step is sent as the plain JSON the handshake uses. In its body,
`{{key}}` is the key given to the runner and `{{client_public}}` the runner's
public key for that handshake.

Stream steps take three more:

| Member | |
|---|---|
| `listen_ms` | How long to hold the stream open. Default 2500. |
| `during` | Steps, each `{"request", "response"}`, sent while the stream is open (a call that pushes, say). |
| `during_after_ms` | How long to wait after the stream opens before them. Default 800. |

### response.json

```json
{
  "status": 200,
  "sealed": true,
  "headers": {"asgard-content-coding": "identity"},
  "body": {
    "$partial": true,
    "protocol": 1,
    "delta": {"count": 3},
    "fragments": {
      "count": {
        "version": "{{version?}}",
        "made_at": "{{made_at}}",
        "max_age": "{{int?}}",
        "fragment": {"type": "text", "key": "count", "props": {"text": "Count: 3"}}
      }
    }
  }
}
```

| Member | |
|---|---|
| `status` | The status, or a list of acceptable ones. |
| `sealed` | `true` for an answer signed and encrypted as §7.3 says, `false` for a plain one. Left out, either is accepted. |
| `headers` | Headers to check, by lowercase name. |
| `body` | The plaintext body expected. |
| `body_by_status` | A body per status, when `status` is a list. |
| `events` | For a stream: the events expected, each `{"event", "data"}` with `data` the opened message. They may arrive in any order. |
| `exact` | For a stream: fail on any event not listed. |
| `ping` | For a stream: fail unless a `: ping` comment arrived. |

### Matchers

Expected values match exactly, with these exceptions:

- An object fails on a member it does not list, unless it has
  `"$partial": true`. A `message` string next to `error` is always allowed,
  since §7.3 lets any error carry one. Answer bodies are usually partial,
  because §5.3 lets a sender add members. Fragments from the fixtures are
  exact.
- An array whose first item is `"{{contains}}"` matches when each of its
  other items matches some item of the answer.
- `{"$anyOf": [a, b]}` matches when either does.
- A string `"{{...}}"` is a matcher:

| Matcher | Matches |
|---|---|
| `{{any}}` | any value |
| `{{absent}}` | a member that is not there |
| `{{string}}`, `{{nonempty}}`, `{{int}}`, `{{bool}}`, `{{object}}`, `{{array}}` | a value of that type |
| `{{version}}` | a version token (§8.1) |
| `{{made_at}}` | a Unix time in milliseconds, within a day of now |
| `{{point}}` | an uncompressed P-256 point in base64url |
| `{{oneOf:a\|b}}` | one of the listed strings |
| `{{save:NAME}}`, `{{version:NAME}}` | the value, which is then saved as NAME |
| `{{=NAME}}`, `{{!=NAME}}` | a value equal, or not equal, to a saved one |

A `?` after the name, as in `{{int?}}`, also accepts a missing member.

In a request, a string that is exactly `{{NAME}}` is replaced by the saved
value, and `{{unique:NAME}}` by a new random string that is saved as NAME.
An upload step saves `upload_sha256` and `upload_size`.

### Adding a case

1. Pick the rule. Name its section, and check that no case covers it yet.
2. If the rule needs server behavior the fixtures do not have, add it to
   [FIXTURES.md](FIXTURES.md) in plain terms, with the exact JSON it returns.
   Keep fixtures few and general: a new region or method that several cases
   can use beats one per case.
3. Write the directory. Match what the spec fixes, and use a matcher for
   anything it leaves to the server. Do not match a `message`, or a status
   the spec does not name.
4. Run it against a server you trust to see it pass, and against one with
   the rule broken to see it fail.

## Out of scope

- **Client conformance.** Testing a client needs a fake server that answers
  the client's requests from these same cases, and a way to drive the client.
  That is a later step. The cases are written so it can reuse them:
  `response.json` describes what a server sends, so a fake server can answer
  with it, filling each matcher with a sample value (a version token, the
  current time for `made_at`) and sealing it with the vectors' code.
- Client-only rules: placeholders, timers and timeouts, failure surfacing,
  delta compare-and-set, patch application, callback scopes, client actions,
  navigation checks, chrome checks, route registration, reconnect backoff and
  the 8 MiB inflate cap.
- Load, floods and rate limits (§7.7), TLS (§7.1), and anything that needs
  waiting minutes, such as session expiry.

## Coverage

Sections with no server case yet, and why:

| Section | Not covered |
|---|---|
| §3.1 | `too_many_regions`: the limit is the server's own (SHOULD), so a case cannot know it. Reading counters once before rendering. |
| §5.1 | That state cannot make a server construct a type. |
| §5.4 | Members a server supplies itself, and `invalid_delta`: the fixtures have neither. `read_only` on a call or upload. |
| §6.2 | Sliding expiry: it needs waiting out a session lifetime. |
| §7.4 | A request with a coding other than aes128gcm (the spec names no status). Gzip correctness is checked whenever a server compresses, but not forced. |
| §7.6 | The order of checks beyond what single failures show. |
| §8.1 | A shared region rendered with no user on the stream, `max_age` on events, 204, the stream's lifetime and `retry`. Version tokens shared by two instances. |
| §8.2 | Patches sent on connect for a gap, `append`, `remove` and `keep`, and fallback when a record is missing. A server that never patches passes `stream-patch` with a signal. |
| §8.3 | `Asgard-Cache: invalidate` (no fixture triggers it), `max_age`, and refusing `cached` for an undeclared region. |
| §9.3, §9.6 | A server never sending a reserved type, a reserved prop, a non-https media URL or a fragment deeper than 64. Every fragment is checked for these, but no fixture tries to produce one. |
| §10.1 | Slots in fragments: no fixture region has a button. |
| §10.2 | The 16-hint and 16-inline-region limits, and the 500 for redrawing a region that does not exist. |
| §10.5 | `too_many_regions` on a call. |
| §10.6 | Cleaning the file name, and an empty file. |
| §12.1 | Boolean route values, and actions on a screen. |
| §12.3 | `version` changing when the list does. |
| §12.4 | A server checking the shape of a navigation. |
| §1, §2, §3, §7.1, §7.7, §9.2, §9.4, §10.3, §10.4, §12.2 | Client behavior, or nothing on the wire to test. |
