# Asgard: background and rationale

This document is not part of the protocol. It records the evidence behind some
choices in [protocol.md](protocol.md), so that the spec itself can stay free of
vendor names. Vendor behavior changes, so check anything here before relying
on it.

## Why QUERY needs a fallback

The spec prefers HTTP QUERY
([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)) for every request after
the handshake, and falls back to POST plus `X-Asgard-Method: QUERY`
([§8](protocol.md#8-transport)). QUERY cannot be the only transport, because
common infrastructure blocks it.

**Web application firewalls.** The OWASP Core Rule Set (CRS) ships
`tx.allowed_methods=GET HEAD POST OPTIONS` as its default, in
`REQUEST-901-INITIALIZATION.conf`. Rule 911100 blocks every other method at
paranoia level 1, which is on by default. CRS runs inside Cloudflare's
managed rules, Azure Front Door and Application Gateway's default rule set
(DRS), and Google Cloud Armor. So the failure follows any server whose owner
switches on a managed WAF, on any platform. It is not confined to particular
vendors.

**CDNs.** Akamai is worse. Its `allowOptions` behavior permits GET, HEAD and
OPTIONS and answers 501 to the rest. It has a separate allow behavior per
verb and no `allowQuery` among them, so an Akamai customer has no setting
that turns QUERY on at all.

A server cannot see any of this from where it sits, which is why the client
probes rather than the server negotiating.

## Why the override header is Asgard's own

All three conventional method override headers, `X-HTTP-Method-Override`,
`X-HTTP-Method` and `X-Method-Override`, are in CRS's default
`tx.restricted_headers_basic` list and are blocked at paranoia level 1.
CloudFront also strips `X-HTTP-Method-Override` on its own. A `_method` body
parameter is blocked at paranoia level 2 and above. So Asgard uses
`X-Asgard-Method`, which nothing in that path knows to block.

## Why a client must send Content-Type

RFC 10008 requires `Content-Type` on a QUERY request. Envoy 1.40 will reject
a QUERY without one on every protocol, so traffic that works today would break
when a proxy in the path is upgraded.

## Why compression has its own header

The spec signals gzip with `Asgard-Content-Coding` rather than the stacked
`Content-Encoding: gzip, aes128gcm` that
[RFC 9110 §8.4](https://www.rfc-editor.org/rfc/rfc9110#section-8.4) allows
([§7.4](protocol.md#74-encryption)). Cloudflare rewrites that stacked header
to `aes128gcm` and passes the body through unchanged. The signature then
fails and the response is lost. A header of Asgard's own is left alone.

## Why a client decodes bodies itself

A client must not let its HTTP library decode an `aes128gcm` body for it
([§7.4](protocol.md#74-encryption)). curl, for one, fails outright on a content
coding it does not know.

## Why fragments are not cached at the edge

Caching is up to each implementation ([§8.2](protocol.md#82-caching)), but a cache in
front of the server will not help. No CDN or reverse proxy caches QUERY. Fastly turns a
request that is not GET or POST into a GET on cache lookup and drops the body,
and documents that as not overridable. A cache inside the server can mix the
request body into its key, so that works. Edge-cached fragments do not.
