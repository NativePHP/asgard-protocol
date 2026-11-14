# Changelog

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
