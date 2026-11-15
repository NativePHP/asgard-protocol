# Changelog

## Draft 4 (unreleased)

- New `schema/constants.json`, with its own schema, holding the spec's
  numbers, names and enums with the section each comes from. New
  `conformance/` suite: byte-exact vectors, golden server cases run against
  a small set of fixture components, and a runner. No wire change.
- §1 now contrasts Asgard with the usual setup, where the server is the
  source of truth. The client is the source of truth for its own state, but
  that state is still untrusted input to the server.
- New SHOULD NOT in §1: a client should not provide any way for a server to
  deliver new executable code, such as a client action or method call that
  downloads code and runs it.
- The note comparing Asgard with a remote screen from a dev bridge is gone.
- New §8.3 on caching. What to cache, and for how long, is up to each
  implementation. Open question 2 is settled by it.
- Every fragment carries `made_at`, the server's Unix time in milliseconds
  when it was rendered, and may carry `max_age` in seconds (§8.3).
- Region cache (§8.3). Render, batch, action, call and upload requests may
  declare the copies the client holds in `cache`, as `{made_at, ttl}` per
  region. A server may answer a part with `{"cached":true}` for a fresh one instead of
  rendering it, and never for a region the request did not declare. A client
  that no longer holds the copy asks once more without declaring it.
- Render requests sent because of a push carry `"reason":"push"`.
- One request shape and one answer shape (§3.1). A region request always
  names `regions`, a list even for one region, and `region` is gone. Every
  answer is a `fragments` map keyed by region, so the top-level `region`,
  `version`, `made_at` and `fragment` are gone too. An action names exactly
  one region in `regions`, and its own region is a part of `fragments` next
  to any others it redraws. A server screen asks for `["screen"]`.
- `fragments` parts have no order, and a client ignores a part for a region
  it did not ask for, apart from an action's redraws (§3.1). A missing own
  region fails only that region. A part may leave out `version` when the
  server cannot read its push counters (§8.1).
- New §7.7 on floods: cheap rejections, rate-limiting handshakes, a
  hard-to-guess `{base}`, and why the session id stays out of the URL. New
  open question 13 on app attestation at the handshake.
- §4 calls an address from a client untrusted input rather than
  attacker-controlled.
- A server component has one list of methods exposed to clients, used for
  both actions (§10.2) and method calls (§10.5). An exposed method can be run
  either way. Uploads keep their own list (§10.6). The wire is unchanged.
- The fixed limit of 16 regions per request is gone. A server SHOULD set its
  own limit and answer a request over it with `422 too_many_regions`; a
  client may split the regions across smaller requests and try again.
- New response header `Asgard-Cache: invalidate`, which makes the server
  render every region in the answer. The response signature covers it,
  right after `asgard-protocol`, whenever it is present (§7.3).
- New §8.2 on patches, and a third stream event, `patch`. A patch adds
  nodes to the start or end of a list inside a region (`prepend`, `append`,
  with an optional `keep`) or removes children by key (`remove`). It names
  the list by node key and carries the version tokens before and after it,
  `from` and `version`. A client that can't apply a patch, because its token
  is not `from`, it holds no tree, the target is missing or the patch is bad,
  MUST treat it as a signal and fetch the region. Caching moves to §8.3.
- A `prepend` or `append` first removes any child with the same key as an
  inserted node, so an item already in a full answer is not shown twice.
  `target` and `keys` are strings, and `from` and `version` are the
  subscription's own tokens. A server sends patches only when it can account
  for every version step since the token it last sent, and a signal or
  fragment otherwise (§8.2).
- On connect, a server may send the patches that cover the gap from the
  client's token instead of a signal or fragment, when its records cover
  every step. It may also wait briefly for the record of the newest step
  before falling back (§8.2).
- Every answer from render, call and upload carries `delta`, the client
  state the server changed (new §5.4). Region requests, batches, server
  screens and actions used to throw state changes away. An action is no
  longer stateless: its changes come back in the delta.
- Requests that send state may name members the server must not change, in
  `read_only` (§5.4). The server never puts them in a delta, and the client
  ignores them if it does.
- A method call or upload may name `regions` to draw again after the method
  runs (§10.5), as well as any the method asks for. An unknown name is
  `404 unknown_component`, and the method does not run.
- A region or action answer may be compressed only when its delta is `{}`
  and every region in it allows it. An action's answer no longer simply
  follows its region (§7.4).
- "Canonical state" is defined (§5.1): the state object serialized with the
  JSON Canonicalization Scheme, RFC 8785. Two states are the same when their
  canonical states are the same bytes. It is used wherever the spec groups
  or matches by state: stream subscriptions and their ids, matching events
  and patches to instances, shared renders, and declaring a cached copy.
  RFC 8785 joins the references, and the vectors gain canonical states.
- Region names MUST match `^[A-Za-z0-9_.:-]{1,100}$` (§3), the pattern the
  reference implementations already use. §3 now says once how a server
  checks a region name wherever a request names one (render, batch, action,
  a call's or upload's `regions`, a stream subscription): a malformed name is
  `422 invalid_request`, and a well-formed name the component does not have
  is `404 unknown_component`.
- A stream subscription's `regions` no longer has a fixed limit of 16. It is
  held to the server's limit on regions per request, like render, and a
  subscription over it gets `422 too_many_regions`. A client may split it
  across several subscriptions (§8.1). The limit of 1 to 16 subscriptions
  stays.
- Every request after the handshake MUST carry `Asgard-Protocol: 1`, the
  session's protocol version (§6.2). Every sealed response carries it too.
  One that is missing or names a version the server does not speak gets the
  early rejection `422 {"error":"unsupported_protocol","protocols":[1]}`.
  The handshake carries its version in the body, and a server ignores the
  header there.
- Versions are agreed at the handshake (§6.1, §11). The client sends
  `protocols`, every version it speaks, in place of `protocol`. The server
  picks the highest one it also speaks and returns it as `protocol` in the
  handshake answer. With none in common it refuses with
  `422 unsupported_protocol`, as before. Both sides may speak several
  versions. A request whose `Asgard-Protocol` is not its session's version
  gets the same rejection.
- §11 now says when the version goes up (only for changes an older peer
  could get wrong) and that it stays 1 across drafts until 1.0.
- A request whose `Content-Encoding` is missing or not `aes128gcm` gets the
  early rejection `415 {"error":"unsupported_coding"}` (§7.4), which SHOULD
  carry `Accept-Encoding: aes128gcm`. The spec named no status before.
- A read (a render without an action, a stream request or the route list)
  whose signature carries a nonce is refused with a sealed
  `422 invalid_request` (§7.3).
- §7.6 lists the checks as numbered steps with the error each one gives:
  `Asgard-Protocol` and `Content-Encoding` come first, the nonce rules are
  split into what can be checked before decrypting and after, and the first
  seven are early rejections.
- Every error now has an `error` code. The handshake's 422s for a bad
  `client_public`, a bad `elements` or an unusable body are
  `invalid_request`, and so are a bad stream subscription, a stream request
  with an action, and an argument an action cannot take. A redraw or hint
  the server's own method gets wrong (a name that is not a region, an
  address that does not exist, or more than 16 of either) is the new
  `500 invalid_redraw` (§10.2).
- Args that do not fit an upload method are `422 invalid_request`, as for a
  call, not `404 unknown_method` (§10.6).
- The `cached` example in §8.3 now carries `delta`, as every render answer
  must (§5.4).
- The recommended client cap on uploads is 20 MiB (20,971,520 bytes), not
  "20 MB" (§10.6). Other sizes in the spec are given in bytes, KiB or MiB.
- §7.4 no longer claims the fixed gzip settings give the same bytes on any
  server. They keep answers comparable, but deflate builds differ, so a
  receiver checks a compressed body by inflating it, never by comparing
  bytes.

## Draft 3 (2026-11-14)

- Address segments may contain hyphens (§4), so `reports.sales-chart` is a
  valid address. A segment still starts with a letter.
- New section, "Building on HTTP", naming the HTTP standards Asgard relies on:
  RFC 9110 for semantics, the POST and QUERY methods, every status code it
  uses, and TLS. Deployments should follow BCP 195 for TLS.
- 419 is noted as an unregistered status code, with open question 12 on
  whether to replace it before 1.0.
- The References list is tidied, and adds RFC 3986, 8259, 8446, 9112, 9113,
  9114 and 9325.
- The spec talks about servers and clients only. A client is a native app on
  any kind of device, so "device" and "phone" are gone from the text and the
  schema. No wire change.
- Requests no longer carry `platform`. A client that wants the server to
  know its platform, or anything else about itself, sends it in the state
  (§3.1). A `platform` member from an older client is now an unknown member
  (§5.3): ignored in region and stream requests, refused in method calls and
  uploads. Shared push renders are no longer keyed by
  platform (§8.1).

## Draft 2 (2026-11-14)

- The transport probe uses only a safe request (a region request with no
  action, or the route list), and other requests go as POST plus the header
  until it settles. An unsigned answer counts for the probe only if its body
  matches the §7.3 table, so a firewall's 403 is not taken as Asgard's (§8).
- `{base}` may be `http:` in a development build, as media URLs may (§8).
- Reserved type names for chrome and regions are listed in §9.3, and
  `elements` has size limits (§6.1). A server ignores a reserved name in
  `elements` rather than refusing the handshake.
- The spec no longer names any language, framework or package. Code samples
  are replaced by wire examples, and concepts are described by what crosses
  the wire and what each side must do.
- Dropped the section on authoring fragments with server-side templates
  (§9.5). How a server builds a fragment is up to it.
- Addresses (§4) are dot-notation strings both sides agree on. How one is
  derived is not part of the protocol.
- New core element types every client must render (§9.7): `column`, `row`,
  `stack`, `scroll_view`, `text`, `button`, `image`, `spacer` and `divider`,
  with their props and the props common to every node. `list_item` is
  described as a well-known extension type that a client may advertise.
- New handshake field `elements` (§6.1): the extra types a client can render.
  A fragment may use only core and advertised types. This replaces the list
  of banned chrome types in §9.3.
- New general rule (§5.3): a receiver ignores JSON members it does not know.
  Callback slots, navigations and the method call body (including the upload
  header) still refuse them. The "ignored in production, throws in debug"
  text is gone.
- Stream subscriptions, event envelopes and chrome now ignore unknown members
  instead of refusing them.
- The handshake is always a plain POST, since it creates a session and is not
  safe (§6.1).
- Transport is probed, not negotiated (§8). The client tries QUERY on its
  first request after the handshake and falls back to POST with
  `X-Asgard-Method: QUERY` on a 405, a 501 or an answer that is not Asgard's,
  and remembers that per installation.
- The client is configured with a base URL, `{base}`. Endpoints are
  `{base}/session`, `/render`, `/stream`, `/call`, `/upload` and `/routes`
  (§8). The path is no longer derived from the app key.
- `Asgard-Session-Id` goes on every request after the handshake (§6.2), and
  every one of them is signed the same way (§7.3).
- All unsigned early rejections are listed in one table (§7.3): 405, 413, 419
  and 403. A missing nonce on a call or upload is an early 403.
- Fragment shape (§9.1): the root is one node or an array; `key` is a string
  or integer compared as a string; a client refuses nesting deeper than 64
  levels. For media props, `null`, `""` and absent all mean no image (§9.6).
- A fragment must not contain a web view that loads the client's own content
  (§9.3). The prop that turns that on is now called `local`.
- Three rules are now SHOULD rather than MUST: batching regions into one
  request (§3.1), treating a session as expired 60 seconds early (§6.2), and
  turning compression off for a region that shows secrets (§7.4).
- §3.1 now says plainly that a failed region is never retried automatically,
  and points at open question 10.
- Open question 5 is removed. It was about one client's internals.
- New open question 11: prop names are camelCase while the rest of the wire
  is snake_case.
- New `rationale.md` with the vendor evidence behind the QUERY fallback, the
  override header, the compression header and edge caching. §8 links to it.
- New references: gzip (RFC 1952), Server-Sent Events (WHATWG HTML), P-256
  (FIPS 186-5), the point encoding (SEC 1), and Tailwind CSS for `class`.
- Every RFC, standard and section reference is now a link.
- The schema allows a root array, refuses unknown members only in slots and
  navigations, accepts `null` media, and checks the web view rule. It no
  longer lists banned types.

## Draft 1 (2026-11-14)

First public draft. Taken from `docs/ASGARD-PROTOCOL.md` in NativePHP's mobile repo as of commit `3b7ca7b`, then:

- requirements now use the BCP 14 key words (RFC 2119, RFC 8174)
- added a Conventions section and a References section
- removed notes that were about NativePHP's internals rather than the protocol
- added a JSON Schema for the fragment format
