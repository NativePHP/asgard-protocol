# Conformance fixtures

The cases in `cases/` talk to a small set of server components that a server
implementer adds to their app for the test run. They are described here by
what they do on the wire, so they can be written in any language and with any
framework. Nothing in them depends on a real app.

Register them only in a build used for conformance testing. Several of them
exist to be refused, and one pushes on demand.

Values in `code` are exact. A case compares fragments member for member, so a
fragment must be exactly the JSON shown: no extra members, and no `class`
unless one is shown. Member order does not matter.

## Server setup

- `{base}` is whatever the server uses. Pass it to the runner with
  `--server`, and the `asgard_key` with `--key`.
- **Bearer tokens.** Accept requests with no `Authorization` header at all.
  Refuse the token `Bearer conformance-reject` with 401, after the checks of
  §7.6, so the 401 is sealed. Any other token may be accepted.
- **Regions per request.** The cases never name more than 4 regions at once,
  so any limit of 4 or more works.
- **Push store.** `ping`, `post` and `shout` below push while a stream is open
  in another request. The worker that handles the call and the one that holds
  the stream must see the same push store, and the server must be able to
  serve a call while a stream is open.
- **Feed store.** `post` keeps a list on the server. It can be in memory, a
  cache or a database, as long as every worker sees it.

## `conformance.counter`

A server component at address `conformance.counter`.

### State

| Member | Type | Default |
|---|---|---|
| `count` | integer | `0` |
| `label` | string | `"Counter"` |
| `user_id` | integer or null | `null` |
| `attachment` | object or null | `null` |

State members it does not know are ignored (§5.3).

### Regions

| Region | Shared | Compression | Fragment |
|---|---|---|---|
| `count` | no | allowed | `{"type":"text","key":"count","props":{"text":"Count: <count>"}}` |
| `label` | no | allowed | `{"type":"text","props":{"text":"<label>"}}` |
| `big` | no | allowed | the 40-row list below |
| `quiet` | no | **off** | the same 40-row list |
| `fancy` | no | allowed | `{"type":"list_item","props":{"headline":"Fancy"}}` |
| `feed` | no | allowed | the feed list below |
| `shared` | **yes** | allowed | `{"type":"text","props":{"text":"Shared <label>"}}` |

`<count>` and `<label>` are the state values, with the count written as a
plain integer.

The 40-row list is a `column` whose children are 40 `text` nodes, for `i` from
1 to 40:

```json
{"type":"column","children":[
  {"type":"text","key":1,"props":{"text":"Row 1 of the conformance list"}},
  {"type":"text","key":2,"props":{"text":"Row 2 of the conformance list"}}
]}
```

(and so on to 40; `key` is the integer `i`). It is well over 1024 bytes, so a
server may compress `big`, and MUST NOT compress `quiet` (§7.4).

`fancy` uses `list_item`, which is not a core type. It renders only for a
session whose handshake listed `list_item` in `elements`. For any other
session the server answers `500 invalid_fragment` (§6.1, §9.3).

The feed list is a `column` with key `items`, whose children are the feed
store's items, newest first, each a `text` node keyed by the item's id as a
string:

```json
{"type":"column","key":"items","children":[
  {"type":"text","key":"17","props":{"text":"<text>"}}
]}
```

`children` is `[]` when the store is empty.

### Methods exposed to clients

These are on the one list that covers both actions (§10.2) and method calls
(§10.5). Arguments are positional plain JSON values.

| Method | Args | Does |
|---|---|---|
| `increment` | `by`: integer | `count = count + by` |
| `rename` | `label`: string | `label = label` |
| `redraw` | none | `count = count + 1`, then asks for `label` of this component to be redrawn inline, and hints region `note` of `conformance.other` (§10.2) |
| `setUser` | `id`: integer | `user_id = id` |
| `ping` | none | pushes region `count` of `conformance.counter` to every subscriber. Changes no state. |
| `post` | `text`: string | adds an item with a new id and that text to the front of the feed store, keeps the newest 50, and pushes region `feed`. A server that sends patches (§8.2) pushes it as a `prepend` to target `items` with `keep` 50. Changes no state. |
| `shout` | none | pushes region `shared` to every subscriber. Changes no state. |

An argument of the wrong type is `422`, never `500` (§10.2).

### A method that is not exposed

`reset`, with no args, sets `count` to 0. It exists on the component but is
**not** exposed, so both an action and a call naming it get `404`.

### Upload method

On the upload list only (§10.6), not on the list for actions and calls:

| Method | Args | Accepts | Does |
|---|---|---|---|
| `attach` | `caption`: string | `text/plain`, at most 1024 bytes | sets state `attachment` to `{"size": <bytes>, "sha256": "<hex of the file's SHA-256>", "caption": <caption>}` |

The type is sniffed from the bytes: plain ASCII text is `text/plain`, and a
PNG signature is `image/png`. A file over 1024 bytes is `413 too_large`,
either plain before decrypting or sealed after.

## `conformance.other`

A server component at address `conformance.other`, with no state, one region
and no methods:

| Region | Fragment |
|---|---|
| `note` | `{"type":"text","props":{"text":"Note"}}` |

It is the target of `redraw`'s hint.

## `conformance.screen`

A server screen (§12) at address `conformance.screen`, route
`/conformance/{id}`.

- State: `id`, from the route. Route values arrive as strings, and the server
  converts a numeric string to a number (§12.1).
- Body: `{"type":"text","props":{"text":"Item <id>"}}`.
- Chrome: `{"nav_bar":{"title":"Item <id>","back":true}}`.
- No methods. Not shared.

The route list (§12.3) MUST include
`{"uri":"/conformance/{id}","screen":"conformance.screen"}`. It may include
the app's other routes too.
