# The Asgard Protocol

**Status:** Draft 3, 2026-11-14.

This draft is not stable. It may change in incompatible ways before 1.0.
Please send feedback as issues on this repository.

Asgard lets a server render part of a native app's UI. A client app
marks a region of a screen as server-rendered, sends its state to a server, and
gets back a description of a native element subtree to paint in place. A
server can also own whole screens inside the app's shell, with their own
chrome and routes ([§12](#12-server-screens)).

This document describes only what crosses the wire and what each side MUST do
with it. Any client and any server, written in any language, that follow it
can talk to each other. Reference implementations of both halves exist; the
README lists them.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in BCP 14
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals, as
shown here.

Sections and paragraphs marked as examples or implementer notes are
non-normative. Examples show messages as they appear on the wire: JSON
bodies, after decryption where they are encrypted, and HTTP headers.

## Building on HTTP

Asgard is a thin layer on top of HTTP. Methods, status codes, header fields,
content codings and encryption in transit all come from HTTP and the
standards around it, which were written long before Asgard. This section
names what Asgard relies on, so an implementer knows where each piece is
defined and so that work is credited.

**Semantics.** The meaning of every method, status code and header field in
this document is the one [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) gives. Asgard works over any HTTP version,
[RFC 9112](https://www.rfc-editor.org/rfc/rfc9112) (HTTP/1.1), [RFC 9113](https://www.rfc-editor.org/rfc/rfc9113) (HTTP/2) or [RFC 9114](https://www.rfc-editor.org/rfc/rfc9114) (HTTP/3), and nothing in it
depends on which.

**Methods.** Two, both with a body:

- POST ([RFC 9110 §9.3.3](https://www.rfc-editor.org/rfc/rfc9110#section-9.3.3)), for the handshake and as the fallback form of
  every other request ([§8](#8-transport)).
- QUERY ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)), a safe method that carries a body, for every request
  that changes nothing on the server ([§8](#8-transport)).

**Status codes.** All but one are defined in [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110):

| Code | Name | Defined in | Used for |
|---|---|---|---|
| 200 | OK | [RFC 9110 §15.3.1](https://www.rfc-editor.org/rfc/rfc9110#section-15.3.1) | A successful answer |
| 204 | No Content | [RFC 9110 §15.3.5](https://www.rfc-editor.org/rfc/rfc9110#section-15.3.5) | Ending a push stream ([§8.1](#81-the-push-stream)) |
| 401 | Unauthorized | [RFC 9110 §15.5.2](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2) | The app's bearer token was rejected ([§6.3](#63-loss), [§7.5](#75-authentication-is-separate)) |
| 403 | Forbidden | [RFC 9110 §15.5.4](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.4) | A failed check or a missing nonce ([§7.3](#73-signatures)) |
| 404 | Not Found | [RFC 9110 §15.5.5](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.5) | An unknown address, region or method ([§4](#4-addressing-components), [§10.5](#105-method-calls)) |
| 405 | Method Not Allowed | [RFC 9110 §15.5.6](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.6) | A method the endpoint does not accept ([§8](#8-transport)) |
| 413 | Content Too Large | [RFC 9110 §15.5.14](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.14) | An upload over its size limit ([§10.6](#106-uploads)) |
| 415 | Unsupported Media Type | [RFC 9110 §15.5.16](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.16) | An upload of a type the method does not accept ([§10.6](#106-uploads)), or a request content coding other than `aes128gcm` ([§7.4](#74-encryption)) |
| 419 | (not registered) | This document | The session is missing, unknown or expired ([§6.3](#63-loss)) |
| 422 | Unprocessable Content | [RFC 9110 §15.5.21](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.21) | A body that is well formed but wrong, or a protocol version the server does not speak ([§6.1](#61-handshake), [§6.2](#62-use-and-renewal)) |
| 500 | Internal Server Error | [RFC 9110 §15.6.1](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.1) | A fragment, delta or redraw the server could not produce |
| 501 | Not Implemented | [RFC 9110 §15.6.2](https://www.rfc-editor.org/rfc/rfc9110#section-15.6.2) | Sent by something in front of the server that refuses QUERY ([§8](#8-transport)) |

419 is not a registered HTTP status code. Asgard borrows it from common web
framework practice for "the session expired", because 401 already means the
app's own credentials failed and the two need different handling. Whether to
move to a registered code before 1.0 is an open question
([§13](#13-open-questions)).

**Fields and content.** `Content-Type` and `Content-Encoding`
([RFC 9110 §8.3](https://www.rfc-editor.org/rfc/rfc9110#section-8.3), [RFC 9110 §8.4](https://www.rfc-editor.org/rfc/rfc9110#section-8.4)) carry JSON ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)), encrypted with
`aes128gcm` ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188)) and optionally compressed with gzip ([RFC 1952](https://www.rfc-editor.org/rfc/rfc1952)).
`Content-Digest` ([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530)) and HTTP Message Signatures ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)) sign
messages ([§7.3](#73-signatures)). URIs follow [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986). The push stream is
Server-Sent Events ([SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)).

**TLS.** Every Asgard request goes to an `https:` URI ([RFC 9110 §4.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-4.2.2)), so
over TLS ([RFC 8446](https://www.rfc-editor.org/rfc/rfc8446) for TLS 1.3). Asgard relies on TLS to authenticate the
server and to stop an attacker who rewrites traffic ([§7.1](#71-threat-model)). Its own
signing and encryption ([§7](#7-security)) add protection against something
that terminates TLS and reads what passes. Deployments SHOULD follow the TLS
recommendations in BCP 195 ([RFC 9325](https://www.rfc-editor.org/rfc/rfc9325)).

## 1. Who owns what

The client owns the shell and its own screens. The server may own screens
inside that shell.

In most server-rendered setups the server is the source of truth. The page
is a view of state the server keeps, and the client sends back little more
than what the user did. That suits a browser. Anyone can change a page with
dev tools, an extension or a line of JavaScript, so the server cannot rely on
anything the page holds, and keeping state on the server is the safe default.

Asgard inverts that. The **client owns the shell**: the app, its navigation
stack, its own screens and their state. It ships locally, renders offline,
and asks a server only for what it has been told to ask about. That is
either a region inside one of its own screens ([§3](#3-regions)), or a whole server screen
at a route the server listed ([§12](#12-server-screens)). A server screen lives inside the shell:
the client opens it, keeps it on its stack, wraps it in chrome the server
described, and MUST NOT let it replace a route of the app's own. The server is
a renderer for fragments and screens, not the owner of the app.

A native app is built to work offline and runs only code its developer
shipped, so the client is the source of truth for its own state. It holds
that state, changes it locally, and sends it with each request ([§5.1](#51-client-state)). The
server renders from what it is sent and does not need to keep a copy.

Owning state is not the same as being trusted. An app can be taken apart, its
key extracted, and the device it runs on rooted ([§7.1](#71-threat-model)). A server still
treats client state as untrusted input and authorizes every action against
the authenticated identity ([§7.5](#75-authentication-is-separate)), never against what the state claims.
Anything the client must not control, such as a balance or a permission,
belongs in the server's session state ([§5.2](#52-server-session-state)) or its own storage.

It is also not remote code. The server sends a description of elements. It
MUST NOT send code, templates, or anything else the client compiles or
executes. How a server produces a fragment is up to it ([§9.5](#95-authoring)). What crosses
the wire is always the fragment JSON of [§9](#9-fragment-format).

This version of the protocol has no way for a server to ship new executable
code to a client. Asgard cannot stop an app from building one of its own, but
a client SHOULD NOT provide one, for example through a client action
([§10.3](#103-client-actions)) or a method call ([§10.5](#105-method-calls)) that downloads code and runs it. Code
delivered that way lets whoever controls or impersonates the server change
what the app does, which is the attack the rest of this section rules out. A
later version may define a safe way to deliver code. This one does not.

## 2. Roles

| Term | Meaning |
|---|---|
| **Client** | A native app on any kind of device, including whatever it uses for rendering, transport, sessions and crypto. |
| **Server** | Any HTTPS server implementing this document. |
| **Region** | A named, server-rendered part of a client screen. |
| **Client component** | The part of a client screen that declares a region. It owns the state and renders the placeholder. |
| **Server component** | What the server resolves an address to ([§4](#4-addressing-components)). It renders the fragments for that address's regions. |
| **Fragment** | The element subtree a server returns for one region. |
| **Server screen** | A whole screen the server owns, opened at a route the server listed ([§12](#12-server-screens)). Its body is one region. |
| **Chrome** | A server screen's nav bar, tab bar and other bars, sent next to its fragment ([§12.2](#122-chrome)). |

## 3. Regions

A client marks a region of one of its own screens as server-rendered and
gives it a name. The name MUST be unique among the regions of the component
that declares it, and MUST match:

```
^[A-Za-z0-9_.:-]{1,100}$
```

That is 1 to 100 letters, digits, underscores, dots, colons and hyphens. A
server screen's body region is named `screen` ([§12.1](#121-screens)).

A request can name regions in several places: `regions` in a region request
or a batch ([§3.1](#31-when-the-client-asks)), the action's own region ([§10.2](#102-server-actions-the-default)), `regions` in a method
call or upload ([§10.5](#105-method-calls), [§10.6](#106-uploads)), and `regions` in a stream subscription
([§8.1](#81-the-push-stream)). Wherever it does, the server MUST check every name before it
renders anything or runs any method, and the same rules apply:

- A name that does not match the pattern above makes the body malformed,
  and the answer is `422 invalid_request`.
- A well-formed name that is not a region of the component is
  `404 unknown_component`, the same answer as for an unknown address
  ([§4](#4-addressing-components)).

What the client shows in the region before a fragment arrives is the
**placeholder**: a skeleton, a spinner, or anything else the app draws. It is
the client's own UI and it MUST render offline. When a fragment arrives, the
client replaces the placeholder subtree with it.

A region that never resolves MUST keep its placeholder. A screen with no network
is a screen with skeletons where the server regions would be, and everything
else working. That is the intended degraded state, not an error case.

The app still hears about it, so it can swap a skeleton for a message. When a
region request times out or fails, the client MUST surface the failure to the
app ([§3.1](#31-when-the-client-asks)), and the app can then show something else in the placeholder, such
as an error message and a retry control.

How the app asks for a refresh, and how it hears about failures, is up to the
client. A fragment MUST NOT be able to trigger either: a client action
([§10.3](#103-client-actions)) can only reach methods the app exposed to servers.

### 3.1 When the client asks

After a component first shows a region's placeholder, the client asks the
server for a fragment, once per component instance. Regions belong to the
component that declares them, so a region in a nested component is
requested and delivered for that component. The app can ask for a region
again (a **refresh**). The fragment on screen stays until the new one lands.
Fragments are held per component instance, so two screens with a region of
the same name never share one.

A region request goes to `{base}/render` ([§8](#8-transport)). Its body names the component's
address ([§4](#4-addressing-components)), the regions it wants in `regions`, and the component's state
([§5.1](#51-client-state)):

```json
{
  "protocol": 1,
  "component": "app.native.screens.home",
  "regions": ["stats"],
  "state": {"period": "week"}
}
```

`regions` MUST be a list of at least one distinct name. It is a list even for
one region, so there is one request shape and one answer shape. A server
MUST answer any other `regions` (absent, empty, not a list, or with a name
repeated) with `422 invalid_request`.

The protocol has no field for the platform, app version or anything else
about the client. A client that wants the server to know such a thing sends
it as part of the state, where it is checked and cached like any other value.

The answer has `delta`, the state the server changed ([§5.4](#54-state-sent-back)), and
`fragments`, one part per region, keyed by region name. Each
part carries the region's fragment ([§9](#9-fragment-format)), its version token ([§8.1](#81-the-push-stream)) and
when it was made ([§8.3](#83-caching)):

```json
{
  "protocol": 1,
  "delta": {},
  "fragments": {
    "stats": {
      "version": "q3V0bG9yZW1pcHN1",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "42 sales"}
      }
    }
  }
}
```

A server screen's part carries `chrome` too ([§12.2](#122-chrome)). A request may also
name the state members the server must not change, in `read_only` ([§5.4](#54-state-sent-back)), and
declare the copies of this component's regions the client holds, in `cache`,
and say it was sent because of a push, in `reason`. A server may then answer
a part with `{"cached":true}` instead of a fragment. Both are in [§8.3](#83-caching).

The server MUST check the address and every region name before it renders
anything, as [§3](#3-regions) and [§4](#4-addressing-components) say. The counters for every region's token MUST be
read once, before any of them renders.

An answer to a request that a newer one superseded, or for a component that
has gone, MUST be dropped.

#### Several regions in one request

When one component instance wants several regions at the same moment, it
SHOULD name them all in one request rather than send one each. That happens
on the first frame of a screen with several regions, on a refresh of all of a
component's regions, and when several hints or signals for one instance land
before it is drawn:

```json
{
  "protocol": 1,
  "component": "app.native.screens.home",
  "regions": ["stats", "feed"],
  "state": {"period": "week"}
}
```

```json
{
  "protocol": 1,
  "delta": {},
  "fragments": {
    "stats": {
      "version": "q3V0bG9yZW1pcHN1",
      "made_at": 1763150000123,
      "fragment": {"type": "spacer"}
    },
    "feed": {"cached": true}
  }
}
```

In the client each region in a request is still its own request, with its
own timer and its own supersede rule. The client delivers each part as if it
had been asked for alone. A region the answer left out MUST fail with reason
`invalid`, and the other parts are still delivered. When a request fails as a
whole, every region in it fails and each failure is surfaced on its own.

`fragments` is a JSON object, so its parts have no order ([RFC 8259 §4](https://www.rfc-editor.org/rfc/rfc8259#section-4)),
and a client MUST NOT depend on one. A client MUST ignore a part for a region
the request did not name, apart from the regions an action redraws
([§10.2](#102-server-actions-the-default)).

**Limits.** A server that renders every region a request names, however many,
lets one small request make it do any amount of work. A server SHOULD limit
how many regions one request may name. A request over its limit gets
`422 too_many_regions`, and nothing in it is rendered. A client that gets one
MAY send the same regions again, split across smaller requests. A request
for one region that gets it fails with reason `server` ([§10.2](#102-server-actions-the-default)). The protocol
does not fix the limit, or the order in which a server checks a request with
more than one problem. The reference implementations allow 16. The same
limit applies to the `regions` of a method call or upload ([§10.5](#105-method-calls)) and of
each subscription on the push stream ([§8.1](#81-the-push-stream)).

The server MUST NOT compress the answer unless its `delta` is `{}` and every
region in it allows compression ([§7.4](#74-encryption)). An answer that mixes a region with
compression turned off and others is sent uncompressed, so the opted-out
fragment is never in a compressed body.

#### Collapsing

A refresh is a mark on an instance and a region, not a request. Many marks
for the same instance and region before it is drawn (signals, hints, refresh
requests from the app) MUST make one fetch, after the next frame that draws
it. A signal whose version the instance already holds MUST NOT make a mark at
all ([§8.1](#81-the-push-stream)).

#### Timeouts and failures

Every region request waits at most the client's region timeout for its
answer. 15 seconds is RECOMMENDED as the default, and a client MAY let the app
set its own per component, with 0 meaning no limit. The timeout covers the
first fetch, a refresh, and a fetch a push stream signal or a refresh hint
started ([§8.1](#81-the-push-stream), [§10.2](#102-server-actions-the-default)). Each region in a request has its own timer. A hard
failure, with one of the reasons in [§10.2](#102-server-actions-the-default), counts at once.

A failed region MUST keep what it had. The client MUST surface the failure to
the app, on the screen the region is on, with:

- the region name;
- the component's address;
- the reason ([§10.2](#102-server-actions-the-default));
- the HTTP status, when there was one;
- a message for logs;
- whether the placeholder is still up: true when no fragment ever landed,
  false when an earlier fragment stays on screen.

A failed region MUST NOT be asked for again automatically. Later frames leave
it alone, so a server that is down is not asked on every frame. To try again,
the app asks for a refresh of that region, for example from a retry button.
The retry gets a timer of its own. Whether a client should retry by itself,
with a backoff, is open question 10 ([§13](#13-open-questions)). Until that is settled, it MUST NOT.

An answer that lands after the failure MUST be dropped. A request that a newer
one superseded fails silently. A covered screen's timers wait until it is on
top again, as in [§10.2](#102-server-actions-the-default). A server screen's own body ([§12.1](#121-screens)) has its own timer
and failure, and is never surfaced as a region failure. Regions cannot sit
inside a fragment ([§9.3](#93-what-a-fragment-may-not-contain)), so there are no others to leave out.

## 4. Addressing components

A region request names its server component by an **address**: a string of
one or more lower-case segments joined by dots. Each segment starts with a
letter and may then hold letters, digits, underscores and hyphens. An
address MUST match:

```
^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$
```

For example:

```
app.native.components.sales_summary
reports.sales-chart
home
```

The client and the server agree on addresses. How an implementation derives
one, for example from the name of a class or module, is not this document's
business. An address shares one namespace with server screen addresses
([§12.1](#121-screens)), so a component address MUST NOT also be a screen's address.

**The server MUST NOT turn an address into the name of code and load it.** The
address arrives from a client, so it is untrusted input. Most clients are the
app as shipped, but the threat model assumes some are hostile ([§7.1](#71-threat-model)), and
the server cannot tell which. If an address were turned into a class or module
name and instantiated, a hostile client could make the server create any
object it likes.

Instead the server MUST resolve it through a table its developer writes, from
address to server component. Server screens join the same table ([§12.1](#121-screens)).
Nothing is discovered by scanning, and an address outside the table MUST NOT
resolve.

An unknown address MUST be a `404 unknown_component`. It MUST NOT be a lookup
failure that leaks whether some piece of code exists.

## 5. State

Two pools, with different owners and different trust.

### 5.1 Client state

The client component's state: a JSON object the client authors, changes
locally, and sends with each region request.

It is **untrusted input**. The signature in [§7](#7-security) proves it arrived intact from a
holder of a valid session. It does not prove the values are true, because the
client that produced them runs outside the server's control. A server MUST
authorize every action against the authenticated identity from [§7.5](#75-authentication-is-separate), never
against something the state claims.

State is plain JSON. A server that turns its values into richer types (dates,
enumerations, records) MUST do so only through an explicit list of the target
types it allows. A state payload MUST NOT be able to make a server construct a
type or run code the server did not choose.

### 5.2 Server session state

State the server keeps across requests, keyed by session ([§6](#6-sessions)). This is where
anything the client must not control belongs.

### 5.3 Compatibility

Halves drift, so a receiver MUST ignore an object member it does not know.
That lets a later version add members without breaking older peers. This
holds for every JSON object in this document, on both sides, unless the
section that defines the object says otherwise.

Three kinds of object are the exceptions, because an unknown member in them
could change what runs:

- a callback slot ([§10.1](#101-callback-slots));
- a navigation ([§12.4](#124-navigation));
- the body of a method call ([§10.5](#105-method-calls)), and the header of an upload, which is
  a method call too ([§10.6](#106-uploads)).

In these, a receiver MUST refuse an object with a member it does not know, in
the way the section that defines it says.

Ignoring a member is not the same as accepting a value. A known member with a
value of the wrong type is still an error wherever this document says so.

### 5.4 State sent back

Every answer from `{base}/render`, `{base}/call` and `{base}/upload` carries
`delta`: the client state the server changed while it handled the request.
That holds for a region request, a batch, a server screen, an action, a
method call and an upload alike, so the client's state always follows what
the server did.

```json
{
  "protocol": 1,
  "delta": {"greeting": "Good morning"},
  "fragments": {
    "stats": {
      "version": "q3V0bG9yZW1pcHN1",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "42 sales"}
      }
    }
  }
}
```

- `delta` MUST be present, and MUST be an object. It is `{}` when nothing
  changed.
- It holds the members of the state that changed while the server handled
  the request, compared with the state as the server restored it from the
  request. A member set for the first time counts.
- A server may also supply members of its own on every request: values it
  works out from other state, or state it shares across the whole app. In
  the answer to an action, a method call or an upload, the delta carries
  every such member. In the answer to a region request with no action (a
  single region, a batch or a server screen), it carries one only when the
  client sent that member with a different value, and leaves out any the
  client did not send at all. That keeps a plain render's delta empty in the
  usual case, so the answer can still be compressed ([§7.4](#74-encryption)).
- Each value MUST be a plain JSON value, or the answer is `500 invalid_delta`.
- An answer has one `delta` for the whole request, however many regions it
  renders, since a request is for one component and one state.

The server works out the delta after it has rendered every region in the
answer, on every answer, so a member changed while a region renders is in
it, and the fragments always match the delta. The client MUST apply the delta before it
paints any fragment in the answer. It MUST apply each member under
compare-and-set: only if it still holds the value it sent. The delta may
change members the app does not let its own UI write. That restriction binds
the client's UI, not the server.

**Read-only members.** A request that sends state MAY also send `read_only`:
the names of state members the server may read but MUST NOT change.

```json
{
  "protocol": 1,
  "component": "app.native.screens.home",
  "regions": ["stats"],
  "state": {"period": "week", "user_id": 7},
  "read_only": ["user_id"]
}
```

- `read_only` is a list of distinct strings, each the name of a member of
  `state`. A server MUST answer any other shape with `422 invalid_request`.
- A client SHOULD leave it out when it is empty. A member the client works
  out from other state, rather than holds, SHOULD be in it.
- A server MUST NOT put a read-only member in `delta`, even when something
  it ran changed that member. It SHOULD make that visible to the developer:
  in development by failing the request with `500 read_only_changed`, and
  otherwise by leaving the member out and logging it.
- A member the server supplies itself never overwrites a read-only member of
  the same name. That is not an error.
- A client MUST ignore a member of `delta` that its request named in
  `read_only`, and SHOULD log it.

`read_only` limits what comes back, not what the server may read. A
read-only member is still sent in `state`, and is still untrusted input
([§5.1](#51-client-state)). A stream subscription MAY carry `read_only`, but it has no effect
there, since the stream sends no delta.

## 6. Sessions

Asgard sessions exist to correlate state across requests and to make requests
cheap to reject early. **They are not authentication.** See [§7.5](#75-authentication-is-separate).

They deliberately do not reuse cookie semantics. Cookies ride along
automatically; this exchange is explicit, so a client always knows whether it
has a session and a server MUST NOT issue one it was not asked for.

### 6.1 Handshake

The client holds `asgard_key`: a per-app, per-environment public identifier
compiled into the build. The server holds the same value in its
configuration and MUST refuse a handshake that names any other. It is not a
secret and it is not key material. It only lets a server turn away clients
built for some other app. A key SHOULD be random, and MUST be unique per app
and per environment.

The handshake agrees a session secret without sending it. Each side MUST make an
ephemeral P-256 key pair ([FIPS 186-5](https://doi.org/10.6028/NIST.FIPS.186-5)) for this one handshake and they run
ECDH, in the spirit of [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)'s Web Push key agreement.

The handshake is always a plain POST to `{base}/session`. It creates a
session on the server, so it is not a safe request, and QUERY
([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)) is only for safe
ones. It never carries `X-Asgard-Method`:

```
→  POST {base}/session
   Content-Type: application/json
   Authorization: Bearer <token>              (when the app has one)
   { "key": "<asgard_key>", "protocol": 1, "accepts": ["tree/json"],
     "elements": ["list_item", "toggle"],
     "client_public": "<base64url P-256 point>" }

←  200
   Content-Type: application/json
   { "session": "<opaque id>", "server_public": "<base64url P-256 point>",
     "expires_in": 1800, "encoding": "tree/json" }
```

- `client_public` and `server_public` MUST be uncompressed points,
  `0x04 || X || Y`, 65 bytes, as defined in [SEC 1 §2.3.3](https://www.secg.org/sec1-v2.pdf), in base64url
  without padding. A point that is malformed or not on the curve MUST be
  refused with `422 {"error":"invalid_request"}`.
- `elements` lists the element types the client can render beyond the core
  set ([§9.7](#97-element-types)). It MUST be an array of distinct type names, each matching
  `^[a-z][a-z0-9_]*$` and at most 64 characters long, with at most 256
  entries. It MAY be empty or absent, which means core types only. A server
  MUST refuse an `elements` that breaks these rules with
  `422 {"error":"invalid_request"}`. It MUST NOT
  name a reserved type ([§9.3](#93-what-a-fragment-may-not-contain)), and a server MUST ignore one that does
  rather than refuse the handshake. The server keeps it with the
  session and MUST NOT send a fragment that uses a type outside the core
  set and this list ([§9.3](#93-what-a-fragment-may-not-contain)).
- `session` is an opaque identifier. It goes in a header on every later
  request ([§6.2](#62-use-and-renewal)).
- Both sides MUST compute the ECDH shared secret (the 32-byte X coordinate) and
  derive the session secret from it with HKDF-SHA256
  ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)):

  ```
  secret = HKDF-SHA256(salt = empty,
                       IKM  = ECDH shared secret,
                       info = "asgard/1 session" || 0x00
                              || client_public || server_public,
                       L    = 32)
  ```

  The two public keys go into `info` as their 65 raw bytes. That ties the
  secret to the exact pair of keys this exchange used.
- Each side MUST discard its private key once the secret is derived. The server
  stores the secret against the session id. The client stores it with the id
  and the expiry ([§6.2](#62-use-and-renewal)).
- A key the server does not know is `403 {"error":"unknown_key"}`, and so is
  any key while the server has none configured. A protocol the server does
  not speak is `422 {"error":"unsupported_protocol","protocols":[1]}`, where
  `protocols` lists the versions it does speak. An `accepts` with no
  encoding the server speaks is `422 {"error":"unsupported_encoding"}`. Any
  other body the server cannot use (not a JSON object, or a member missing
  or of the wrong type) is `422 {"error":"invalid_request"}`.
- The handshake names its version in the body's `protocol`. It does not need
  the `Asgard-Protocol` header that every later request carries ([§6.2](#62-use-and-renewal)),
  and a server MUST ignore that header on `{base}/session`.

The handshake itself is neither signed nor encrypted. There is nothing to
sign it with yet, and nothing in it is secret. [§7.1](#71-threat-model) says what that does and
does not leave open.

The handshake does not tell the client which transport works. The client
finds that out on its first request after the handshake ([§8](#8-transport)).

### 6.2 Use and renewal

Every request after the handshake MUST carry `Asgard-Session-Id: <session>`:
region requests, actions, method calls, uploads, the push stream and the
route list. Each accepted request MUST slide the expiry forward on the server.
The client slides its own copy when a response verifies.

Every request after the handshake MUST also carry `Asgard-Protocol`: the
protocol version the session was made with, as a decimal integer. For this
version that is `Asgard-Protocol: 1`. Every sealed response carries it too.
It is a covered component of both ([§7.3](#73-signatures)). A server MUST refuse a request
whose `Asgard-Protocol` is missing, or is not a version it speaks, with the
early rejection `422 {"error":"unsupported_protocol","protocols":[1]}`
([§7.3](#73-signatures)), listing the versions it does speak as the handshake does. It
checks this before anything else ([§7.6](#76-rejecting-early)).

A client keeps one session per base URL and `asgard_key`, where every part of
the client that makes requests can use it. It need only store the 32-byte
secret, since the four keys of [§7.2](#72-keys) can be derived from it again. The client
SHOULD treat a session as gone 60 seconds before `expires_in` says it lapses,
so a request rarely races the server's expiry. A request that does lose the
race gets a 419 and is retried once ([§6.3](#63-loss)).

### 6.3 Loss

Either side can lose a session: expiry on the client, eviction on the server.
Both resolve to the same move, and it MUST be invisible to the app developer
and the user.

| Condition | Status | Client behavior |
|---|---|---|
| Session unknown or expired | `419` | Re-handshake once, retry the request once. |
| Digest, signature or decryption failed, signature expired, nonce reused or missing | `403` | **MUST NOT retry.** Surface an error. |
| `Asgard-Protocol` missing or unsupported, or a request content coding other than `aes128gcm` | `422`, `415` | **MUST NOT retry.** Surface an error. |
| Method the endpoint does not accept | `405` | On the first QUERY request after a handshake, fall back to POST as [§8](#8-transport) says. Otherwise **MUST NOT retry.** |
| Bearer token rejected | `401` | Hand to the app's auth flow. |
| Unknown component | `404` | Keep the placeholder, log. |

The split between 419 and 403 matters. A signature bug that returned 419 would
make every client re-handshake and retry forever. A client MUST make exactly
one re-handshake and one retry per originating request; a second failure
surfaces.

Some failures only the client can see: a response or pushed event whose
signature does not verify, that does not decrypt, that names a coding the
client does not know, or that inflates past the cap in [§7.4](#74-encryption). The client
treats all of them alike. It logs why. It MUST keep the placeholder (or the
last fragment it painted) and MUST NOT retry.

## 7. Security

Asgard does not define its own signing or encryption. It uses published
specs and says which parts of each it needs:

- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421), HTTP Message
  Signatures, for integrity in both directions.
- [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530), `Content-Digest`, to
  bring the body under the signature.
- [RFC 8188](https://www.rfc-editor.org/rfc/rfc8188), the `aes128gcm`
  content encoding, for the bodies.
- [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869), HKDF, and P-256 ECDH
  ([FIPS 186-5](https://doi.org/10.6028/NIST.FIPS.186-5)) for the key agreement in [§6.1](#61-handshake).

All of them have existing libraries and test vectors, and a reviewer can check
an implementation against the RFC instead of against this document.
Implementations SHOULD test against the published vectors:

- [RFC 8188 §3.1](https://www.rfc-editor.org/rfc/rfc8188#section-3.1) and
  [§3.2](https://www.rfc-editor.org/rfc/rfc8188#section-3.2);
- [RFC 9421 Appendix B.2.5](https://www.rfc-editor.org/rfc/rfc9421#appendix-B.2.5);
- [RFC 9530 Appendix B.1](https://www.rfc-editor.org/rfc/rfc9530#appendix-B.1);
- [RFC 5869 Appendix A](https://www.rfc-editor.org/rfc/rfc5869#appendix-A).

### 7.1 Threat model

Assume: TLS everywhere, but intermediaries that terminate it and log. Assume
the client binary is readable and `asgard_key` is extractable, because it is
compiled into an app anyone can download. Assume some clients are hostile.

The key agreement in [§6.1](#61-handshake) is what defeats the logging proxy. From the
handshake the proxy learns `asgard_key`, both public keys and the session id.
None of those, alone or together, gives it the secret: getting the secret from
the public keys is the elliptic-curve Diffie-Hellman problem. A proxy that
logs every byte of every request, the handshake included, can decrypt nothing
and forge nothing.

An active attacker that terminates TLS and rewrites traffic is a different
case. It can run one handshake with the client and another with the server
and relay between them. Asgard does not stop that. The client has no
long-term server key to check the handshake against, and giving it one would
be certificate pinning by another name. Authenticating the server is TLS's
job. Asgard protects against intermediaries that read, not ones that
rewrite.

### 7.2 Keys

Every key comes from the session `secret` agreed in the handshake ([§6.1](#61-handshake)).
`secret` MUST NOT be used directly. Each side derives four keys from it with
HKDF-SHA256 ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)), with an
empty salt and these `info` labels:

| Key | `info` | Used for |
|---|---|---|
| `sig_c` | `asgard/1 sig client` | HMAC signing of requests |
| `sig_s` | `asgard/1 sig server` | HMAC signing of responses |
| `enc_c` | `asgard/1 enc client` | IKM for request bodies |
| `enc_s` | `asgard/1 enc server` | IKM for response bodies |

Each key is 32 bytes, except `enc_c` and `enc_s`, which are 16. Separate keys
per direction mean a captured request can never be passed off as a response,
and separate keys per purpose mean a bug in one use cannot leak another.

**`keyid` is the session id.** It is already on every request in
`Asgard-Session-Id` and is not secret, so naming the key with it tells an
observer nothing new. The receiver looks the session up by `keyid`, derives
the key for the direction it is checking, and verifies. An unknown `keyid` is
the 419 in [§6.3](#63-loss); a known one that fails is the 403.

The secret itself MUST NOT cross the wire.

### 7.3 Signatures

Signatures use HTTP Message Signatures, [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421).

Both sides MUST sign with `hmac-sha256` ([RFC 9421 §3.3.3](https://www.rfc-editor.org/rfc/rfc9421#section-3.3.3)) under the label
`asgard`, with `tag="asgard/1"`, so a signature made for Asgard cannot be
confused with any other signature the app's HTTP stack adds.

Bodies MUST be covered through `Content-Digest`
([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530)) using `sha-256`. The
digest is taken over the content as sent, which is the ciphertext from [§7.4](#74-encryption).
That is what lets the receiver check the signature before it decrypts
anything ([§7.6](#76-rejecting-early)).

**A request** (every request after the handshake, [§6.2](#62-use-and-renewal)) covers:

```
("@method" "@authority" "@path" "content-type" "content-encoding"
 "content-digest" "asgard-protocol" "asgard-session-id")
;created=…;expires=…;keyid="<session>";alg="hmac-sha256";tag="asgard/1"
```

`@method` is the method on the wire. `@authority` is the host in lowercase,
with the port when it is not the scheme's default. `@path` is the path as
sent, without the query.

Two more headers MUST be covered when, and only when, the request carries
them, after the rest and in this order:

- `"x-asgard-method"`, when the client falls back to POST plus
  `X-Asgard-Method: QUERY` ([§8](#8-transport)), so the verb it meant is signed too.
- `"authorization"`, when the app sends a bearer token. Covering it binds the
  token to the session: a token cannot be lifted from one signed request and
  replayed under another session's signature. [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) cannot cover a
  component the message does not have, so a request without a token MUST NOT
  list it.

The receiver MUST work the list out from the headers it actually received and
MUST refuse a signature whose list differs in any way. Stripping the
`Authorization` header, or adding one, therefore breaks the signature.

The parameters MUST be exactly `created`, `expires`, `keyid`, `alg` and `tag`,
plus `nonce` where the next paragraph says. A receiver MUST refuse any other
parameter, a missing one, an `alg` other than `hmac-sha256`, a `tag` other
than `asgard/1`, and a `keyid` that is not the `Asgard-Session-Id`.

A server action (a request with an `action` member, [§10.2](#102-server-actions-the-default)) is not a safe
request, and neither is a method call ([§10.5](#105-method-calls)) or an upload ([§10.6](#106-uploads)), so its
signature MUST also carry a `nonce` parameter: 16 to 64 base64url characters,
which the client MUST fill with 16 random bytes. The server MUST remember
nonces per session until their `expires`, plus the clock skew allowance, and
MUST refuse a repeat with 403. An action, method call or upload whose
signature has no nonce MUST get `403 {"error":"nonce_required"}`. Region
renders without an action, stream requests and the route list are reads and
MUST NOT carry a nonce. A server MUST refuse a read whose signature carries
one with `422 {"error":"invalid_request"}`.

A call or an upload is known from its endpoint, so the server MUST refuse a
missing nonce there before it decrypts, as an early rejection (below). An
action is known only from its body, so on `{base}/render` the server can only
find a missing nonce after it decrypts. That 403 is sealed like any other
answer. A nonce on a read is also found after decrypting, since a render is
a read only when its body has no `action`, and its 422 is sealed too. The
server checks a nonce that a read carries against the ones it has seen, as
it does any other, before it decrypts ([§7.6](#76-rejecting-early)).

**A response** covers:

```
("@status" "content-type" "content-encoding" "asgard-content-coding"
 "content-digest" "asgard-protocol" "signature";req;key="asgard")
;created=…;keyid="<session>";alg="hmac-sha256";tag="asgard/1"
```

A response that carries `Asgard-Cache` ([§8.3](#83-caching)) MUST cover
`"asgard-cache"` too, right after `"asgard-protocol"` and before
`"signature";req;key="asgard"`. One that does not carry it MUST NOT list it.
As for a request, the client works the list out from the headers it received
and refuses a signature whose list differs, so the header cannot be added or
stripped on the way.

`"signature";req;key="asgard"` pulls the request's own signature into the
response's ([RFC 9421 §2.4](https://www.rfc-editor.org/rfc/rfc9421#section-2.4)). A response therefore only verifies against the
request it answers, and a fragment captured from one request cannot be
replayed as the answer to another.

Every answer to a request that passed the first seven checks in [§7.6](#76-rejecting-early) MUST
be sealed this way, whatever its status. A 404 or a 422 `invalid_request` is
signed and encrypted like a 200.

**Early rejections** are the exception. They are plain, unsigned JSON, because
there is either no session to sign with or no reason to trust the one
claimed. These are all of them:

| Status | Body | When |
|---|---|---|
| 405 | `{"error":"method_not_allowed"}` | The request used a method the endpoint does not accept: on `{base}/session` anything but POST, and elsewhere anything but QUERY or a POST with `X-Asgard-Method: QUERY` ([§8](#8-transport)). |
| 422 | `{"error":"unsupported_protocol","protocols":[1]}` | `Asgard-Protocol` is missing or is not a version the server speaks ([§6.2](#62-use-and-renewal)). `protocols` lists the ones it does. |
| 415 | `{"error":"unsupported_coding"}` | `Content-Encoding` is missing or is not `aes128gcm` ([§7.4](#74-encryption)). |
| 413 | `{"error":"too_large"}` | An upload the server can tell is too big from its size alone ([§10.6](#106-uploads)). |
| 419 | `{"error":"session_expired"}` | `Asgard-Session-Id` is missing, unknown or expired ([§6.3](#63-loss)). |
| 403 | `{"error":"forbidden"}` | A check in [§7.6](#76-rejecting-early) failed: the digest, the signature or its freshness, a reused nonce, or decryption. |
| 403 | `{"error":"nonce_required"}` | A method call or upload whose signature has no nonce (above). |

A body MAY also carry a `message` string for logs. A client MUST act on the
status of an unsigned answer only: to fall back on a 405 to the first QUERY
request after a handshake ([§8](#8-transport)), to re-handshake on 419, and to
stop on 403, 413, 415 or 422. It MUST NOT read anything else from it, with one
exception: while it probes the transport, it checks that the body is the one
this table gives for that status ([§8](#8-transport)). An unsigned answer
with any other status is a failure like a bad signature ([§6.3](#63-loss)).

Clock skew: `created` MAY be up to 60 seconds in the future, and `expires`
MUST be at most 300 seconds after `created`. A request past its `expires` MUST be
refused, so a captured request can be replayed for at most five minutes, and
an action not even once. A response has no `expires`. The client MUST refuse one
whose `created` is more than 60 seconds ahead of its clock or more than 300
seconds behind it.

What a valid signature proves: the message was produced by something holding
a live session secret and arrived unmodified. It does not prove the sender is
a genuine copy of the app, and it cannot. `asgard_key` is public by
construction, so anyone can complete a handshake. The signature is an
integrity check and a cheap early filter, not authentication.

### 7.4 Encryption

Bodies are encrypted with the `aes128gcm` content coding of [RFC 8188](https://www.rfc-editor.org/rfc/rfc8188).

Request and response bodies MUST use `Content-Encoding: aes128gcm`. The input key
material is `enc_c` for requests and `enc_s` for responses. Every message MUST get
a fresh random 16-byte salt, so the content-encryption key and nonce [RFC 8188](https://www.rfc-editor.org/rfc/rfc8188)
derives from them never repeat. The `keyid` in the [RFC 8188](https://www.rfc-editor.org/rfc/rfc8188) header MUST be the
session id, the same as in the signature, and the receiver MUST refuse a body
whose `keyid` is any other. The record size MUST be the default 4096. A body
longer than one record is split across several, and a receiver MUST refuse one
that is truncated: the last record MUST carry the `0x02` delimiter.

A client MUST NOT let its HTTP library decode the body for it. Some HTTP
libraries fail outright on a content coding they do not know.

Inside TLS this is redundant against a network attacker. It is not redundant
against a logging proxy, which is the case it exists for.

This is why the session id and the secret are different things. If the
session identifier in the header were also the key material, any intermediary
that logs headers and bodies could decrypt everything it logged, and the
encryption would protect against nothing it was added for. The identifier
travels on every request. The secret never travels at all.

Fragments in `tree/json` are encrypted before signing, and the `Content-Type`
stays `application/json`. The encoding is a property of the transfer, not of
the fragment format, so [§9](#9-fragment-format) is unchanged.

**Compression.** Nothing between the server and the client can compress an
encrypted body, so the server compresses fragments itself, before encrypting
them. A 200-row list fragment of about 52,000 bytes went over the wire as about
2,400.

- Only responses and pushed events are compressed. Requests MUST NOT be
  compressed: they are small, and they carry client state. A server MUST
  refuse a request whose `Content-Encoding` is missing or is anything other
  than `aes128gcm` with the early rejection
  `415 {"error":"unsupported_coding"}` ([§7.3](#73-signatures)), the status
  [RFC 9110 §15.5.16](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.16) gives for a content coding the server does not accept.
  The answer SHOULD carry `Accept-Encoding: aes128gcm`
  ([RFC 9110 §12.5.3](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.3)).
- `Content-Encoding` MUST stay `aes128gcm`. Every sealed response MUST also
  carry `Asgard-Content-Coding`, which is `gzip` when the plaintext was
  gzipped before encryption and `identity` when it was not. The header is a
  covered component of every response ([§7.3](#73-signatures)), so it cannot be stripped or
  flipped. The receiver undoes the steps in reverse: it decrypts, then gunzips
  when the header says `gzip`. Any other value, or no header, MUST be refused.
- Why not the stacked `Content-Encoding: gzip, aes128gcm` that [RFC 9110 §8.4](https://www.rfc-editor.org/rfc/rfc9110#section-8.4)
  allows: at least one major CDN rewrites that header to `aes128gcm` and
  passes the body through unchanged, so the signature fails and the response
  is lost. A header of Asgard's own is left alone.
- Only a region answer MAY be compressed, and only when it is at least
  1024 bytes. Below that the saving is too small to matter. A region or
  action answer MAY be compressed only when its `delta` is `{}` ([§5.4](#54-state-sent-back)) and
  every region in it allows compression. A delta mixes the server's values
  with text the client chose, and a region's choice about compression says
  nothing about what is in the delta, so an answer with a delta in it is
  sent uncompressed. Method call and upload answers MUST NOT be compressed.
  Errors MUST NOT be compressed: they are small and may echo what the client
  sent.
- The gzip member ([RFC 1952](https://www.rfc-editor.org/rfc/rfc1952)) MUST have a fixed header (no file name, mtime
  0, OS 255) and MUST be deflated at level 6. The settings are fixed so that
  answers from different servers are comparable, not so that they are the
  same bytes: two deflate libraries, or two builds of one, can deflate the
  same input at the same level to different bytes. A receiver checks a
  compressed body by inflating it, and MUST NOT check it by comparing its
  bytes with a compression of its own.
- A client inflates in small steps and MUST give up as soon as the output
  passes **8 MiB** (8,388,608 bytes). Going over is a failure like a bad
  signature ([§6.3](#63-loss)). No real fragment comes near it, and it stops a small body
  from expanding into one that exhausts the client's memory.

**When to turn it off.** Compressing a body that holds both a secret and text
someone else can choose leaks the secret through the body's length. That is
the BREACH attack, and encryption does not stop it, because encryption hides
the bytes and not how many there are. An attacker who can put guesses into a
fragment (a search term echoed back, a display name they set) and see the
size of the answer can recover the secret a character at a time.

So a server SHOULD turn compression off for a region whose fragment shows a
secret, such as a token, a recovery code or a full account number, next to
text that another person or the client can choose. That is the BREACH-style
risk: the secret and the attacker's guess share one compressed body, and the
body's length gives the guess away. When a region has compression turned off,
its responses and events MUST go out as plain `aes128gcm`. A region that shows
only the user's own data, or only public data, has nothing to leak and keeps
compression on. Which regions turn it off is the server's choice. It never
crosses the wire.

### 7.5 Authentication is separate

**A client never tells the server who the user is.** Identity MUST come from an
ordinary `Authorization: Bearer` credential the server verifies independently:
its own session, an OAuth access token, a personal access token. The Asgard
session correlates state; the bearer token establishes identity. A request with
a valid signature and an invalid token MUST be rejected.

### 7.6 Rejecting early

Order of checks, cheapest and most decisive first:

1. `Asgard-Protocol` is a version the server speaks ([§6.2](#62-use-and-renewal)): else
   `422 unsupported_protocol`.
2. `Content-Encoding` is `aes128gcm` ([§7.4](#74-encryption)): else `415 unsupported_coding`.
3. The session id is known: else `419 session_expired`.
4. `Content-Digest` matches the body: else `403 forbidden`.
5. The signature is valid and fresh: else `403 forbidden`.
6. A call or upload carries a nonce: else `403 nonce_required`. Any nonce
   the signature carries has not been seen before: else `403 forbidden`.
7. The body decrypts: else `403 forbidden`.
8. The request has a nonce if it is an action and none if it is a read
   ([§7.3](#73-signatures)): else a sealed `403 nonce_required` or `422 invalid_request`.
9. The bearer token is valid ([§7.5](#75-authentication-is-separate)): else a sealed `401`.
10. The component, and every region the request names, resolve ([§3](#3-regions), [§4](#4-addressing-components)).
11. The state is restored.

A request that fails any of the first seven MUST be discarded before
anything parses its body, and gets the unsigned early rejection that
[§7.3](#73-signatures) lists. On the server the first seven MUST run ahead of the rest of
the server's own request handling, so bearer auth only ever sees a request
already known to be intact.

A client MUST check a response the same way, digest and signature before it
decrypts anything, and MUST keep the placeholder on any failure. It MUST NOT render a fragment whose signature did not verify,
and the same holds for pushed events ([§8.1](#81-the-push-stream)).

### 7.7 Floods

Asgard does not stop a client sending a server more requests than it can
handle. That is the deployment's job, but a few things make it easier.

- **Rejections are cheap.** The early checks in [§7.6](#76-rejecting-early) cost one session
  lookup and a digest before anything is decrypted or parsed, so a flood of
  bad requests is turned away for little work.
- **The handshake is the costly one.** [§6.1](#61-handshake) does a key agreement, and its
  URL is fixed. A server SHOULD rate-limit handshakes, for example by client
  address.
- **Limit what one request can ask for.** See the limit on regions per
  request ([§3.1](#31-when-the-client-asks)).
- **`{base}` can be hard to guess.** Each deployment chooses its own base URL
  ([§8](#8-transport)), such as `https://api.example.com/x7k2q9`, so there is no shared
  path to scan for. This only keeps out traffic that is looking for Asgard
  servers in general. Anyone with the app can read the base URL from it.

Moving the session id into the URL would not help. A server does the same
lookup to reject a request whatever part of it carries the id, and URLs are
logged far more widely than headers, which would spread a value that links
all of one client's requests.

None of this tells the real app from a script that has extracted its key
([§7.1](#71-threat-model)). Open question 13 asks whether the handshake should.

## 8. Transport

A client is configured with one base URL for its server, written `{base}`
in this document: an `https:` URL with no query or fragment, such as
`https://api.example.com/asgard`. A client MAY also accept an `http:` base
in a development build, for a server on a developer's machine, as for media
URLs ([§9.6](#96-media-urls)). A production build MUST NOT. Every endpoint is
a path below it:

| Endpoint | Used for |
|---|---|
| `{base}/session` | The handshake, always plain POST ([§6.1](#61-handshake)) |
| `{base}/render` | Region requests and actions ([§3.1](#31-when-the-client-asks), [§10.2](#102-server-actions-the-default)) |
| `{base}/stream` | The push stream ([§8.1](#81-the-push-stream)) |
| `{base}/call` | Method calls ([§10.5](#105-method-calls)) |
| `{base}/upload` | Uploads ([§10.6](#106-uploads)) |
| `{base}/routes` | The server's route list ([§12.3](#123-routes)) |

`{base}` has no trailing slash. A client MUST NOT derive it from anything
else, such as `asgard_key`.

Requests prefer **HTTP QUERY** ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)) over HTTPS: a safe method that
carries a body. A body is required (state can be large and structured) and a
GET query string is the wrong place for it: length-limited, and logged by
everything in the path.

**QUERY cannot be the only transport.** The most widely deployed web
application firewall rule set allows only GET, HEAD, POST and OPTIONS by
default, and blocks every other method at its lowest paranoia level, which is
on by default. That rule set ships inside several of the big cloud
providers' managed firewalls, so the failure follows any server whose owner
switches one on, on any platform. Some CDNs refuse unknown methods with a 501
and offer no setting to allow QUERY at all.

The handshake is the exception. It always goes as a plain POST, because it
creates a session and so is not safe ([§6.1](#61-handshake)). Every other
endpoint takes QUERY or its fallback.

A server cannot know whether something in front of it blocks QUERY. So
transport is probed by the client, not negotiated:

1. The client sends its first **safe** request after the handshake as
   **QUERY**. A safe request is a region request with no action, or the
   route list. Until the probe has settled, every other request (an action,
   a method call, an upload, the push stream) goes as POST plus
   `X-Asgard-Method: QUERY`. That way a request that changes something on
   the server is never sent twice.
2. If the answer is a 405, a 501, or anything that is not a valid Asgard
   answer, the client MUST send that request again as **POST plus
   `X-Asgard-Method: QUERY`**, signed afresh, since the method is a covered
   component ([§7.3](#73-signatures)).
3. The client MUST remember which form worked, for the installation, and use
   it for every later request except the handshake.

A valid Asgard answer is a response sealed as [§7.3](#73-signatures) says, or
one of the unsigned early rejections listed there other than 405, with the
body that table gives for its status. The body check matters: a firewall
that blocks QUERY often answers 403, and a client that took any 403 as
Asgard's would remember QUERY as working. A network
failure is not an answer: the client tries QUERY again on its next request.
When the POST form fails too, that request has failed with the usual reason
([§10.2](#102-server-actions-the-default)), and the client remembers
nothing.

A server MUST accept both forms on every endpoint except `{base}/session`,
which takes only a plain POST. On those endpoints it MUST refuse a POST
without `X-Asgard-Method: QUERY`, and any other method, with 405
([§7.3](#73-signatures)). On `{base}/session` it MUST refuse any method other
than POST with 405.

Background on why QUERY needs a fallback is in [rationale.md](rationale.md).

The override header is Asgard's own. The conventional names
(`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`) are blocked by
default in common firewall rule sets, and at least one CDN strips the first.
A `_method` body parameter is blocked at higher paranoia levels too.

Two more rules:

- **A client MUST send `Content-Type`.** [RFC 10008](https://www.rfc-editor.org/rfc/rfc10008) requires it on QUERY, and
  some proxies already reject a QUERY without one.
- **The verb MUST be uppercase.**

### 8.1 The push stream

A client holds one Server-Sent Events stream ([SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)) open at a time, so the
server can say a region changed without being asked. The stream carries a
**subscription** for each component instance it has on screen, and
nothing else.

By default the stream renders nothing. When a region changes it sends a
**signal**: the region and its new version. The client fetches the region
through a normal region request, with its own credentials. A region the
server marks **shared** renders the same for everyone with the same state,
and for those the stream sends the fragment inline instead. Shared is
opt-in, so a region left unmarked costs a round trip, never a leak.

**Cost.** On many servers an open stream holds a worker process or thread for
its whole lifetime. That is why a client opens one stream, not one per
component, and why it drops what is no longer on screen. A client with no
server regions on screen holds no stream at all.

**Opening it.** `{base}/stream`, in either form from [§8](#8-transport). The body
lists every subscription the client wants:

```json
{
  "protocol": 1,
  "subscriptions": [
    {
      "id": "3f9a0c1d2e4b5a6c",
      "component": "promos.show",
      "regions": ["screen"],
      "state": {"id": "1"},
      "versions": {"screen": "q3V0bG9yZW1pcHN1"}
    },
    {
      "id": "8b2d77e01c9f4a35",
      "component": "promos.show",
      "regions": ["screen"],
      "state": {"id": "2"}
    }
  ]
}
```

- `subscriptions` MUST hold 1 to 16 subscriptions.
- `id` is the client's name for a subscription. It MUST be 1 to 32 characters of
  `A-Z a-z 0-9 _ -`, unique within the request. The server only echoes it.
- `component`, `state` and each name in `regions` follow the rules of a
  region request ([§3](#3-regions), [§4](#4-addressing-components), [§5](#5-state)). `regions` MUST hold at least one
  distinct name, and is held to the server's limit on regions per request
  ([§3.1](#31-when-the-client-asks)), applied to each subscription on its own.
- `versions` is optional. It maps a region to the version token the client
  holds for it (below).
- There MUST NOT be an `action`, at the top level or in a subscription. A
  server answers one with `422 invalid_request`. Other members the server
  does not know are ignored ([§5.3](#53-compatibility)).

A subscription is one component instance's view of the server: one address
and one state. Two instances with the same address and the same state share a
subscription. Two with different state (`/promos/1` under `/promos/2`) are
two subscriptions, and each gets the pushes rendered for its own state.

The server MUST check every subscription before it streams anything, and a
request it refuses gets the answer render would give, sealed the same way:

- `422 invalid_request` for a malformed body, such as a bad subscription
  count, a bad or repeated `id`, or a malformed region name;
- `422 too_many_regions` for a subscription that names more regions than
  the server's limit ([§3.1](#31-when-the-client-asks));
- `404 unknown_component` for an unknown address or region in any
  subscription ([§3](#3-regions), [§4](#4-addressing-components));
- `500 invalid_fragment` for a fragment it cannot send.

A client that gets `too_many_regions` MAY split that subscription's regions
across several subscriptions, each with its own `id`, and open the stream
again. That is the one case where instances with the same address and state
have more than one subscription. Nothing streams until the request is
accepted whole. It works out which push channels each subscription watches from that
subscription's state, and reads every counter of every subscription in one
read per poll.

The request MUST be sealed exactly like a region request ([§7.3](#73-signatures), [§7.4](#74-encryption)). It is a
read, so it has no nonce.

**The client declares the whole set.** The client works the set out from what
is on screen: for each live component instance, each region that holds a
fragment from a good answer, grouped by address and by the state the answer
was rendered for. Only answered regions are watched, so a session already
exists when the stream opens. Whenever the set changes (a region gets its
first answer, a state changes, an instance unmounts) the client MUST open the
stream again with the new set, signed afresh. An empty set MUST close it. A
change that leaves the set as it was does nothing, so subscription ids are
derived from the address and the canonical state, and an unchanged set is
recognizably unchanged. Changes that land together, such as a navigation
that unmounts one screen and mounts another, make one reopen.

**Version tokens.** Reopening is frequent, so the server does not send every
region again each time. Every part of a region answer carries a `version`: an opaque
token of up to 64 characters of `A-Z a-z 0-9 _ -`, derived from the push
counters that region watches for that address, state and set of channels.
A server that cannot read its counters at the time leaves `version` out
rather than failing the render. The client then holds no token for that
region, so the stream sends the region again when it connects.

```json
{
  "protocol": 1,
  "delta": {},
  "fragments": {
    "screen": {
      "version": "q3V0bG9yZW1pcHN1",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "Promo 1"}
      },
      "chrome": {}
    }
  }
}
```

The client keeps the latest token per instance and region, from render
answers and from fragment events, and sends it in `versions`. On connect the
server MUST send an event only for regions whose current token differs from the
client's, or that have none. The server MUST read the counters before it renders
a region answer, so a push that lands between that answer and the stream
opening leaves the client holding a stale token, and the stream sends the
region again. Nothing is lost. Instances that share a subscription but hold
different tokens for a region MUST NOT send one for it.

**Shared regions.** A server renders a shared region once per push for each
distinct address, region, canonical state and version, and every
stream that needs that answer reuses it (from a short-lived cache, say),
sealing it for its own session. Because that cache is not keyed by user, a
server MUST render a shared region on the stream with no authenticated user. A
shared region therefore MUST NOT depend on the user or on secrets, which
also makes compressing it safe ([§7.4](#74-encryption)). The region request itself is not
affected: a shared region renders there as any other, with the caller's
credentials.

**The answer** is `200 text/event-stream`, and its headers are not signed.
The part of a client that holds a long-lived connection is often not the part
that checks signatures, and may not pass headers on, so a signature on them
would protect nothing. Each event carries its own instead.

**Events.** There are three, `signal`, `fragment` and `patch` ([§8.2](#82-patches)),
sealed the same way:

```
id: 7
event: signal
data: {"body":"<base64url>","enc":"identity","sig":"<base64url>"}

id: 7
event: fragment
data: {"body":"<base64url>","enc":"gzip","sig":"<base64url>"}
```

The three members MUST be present, and SHOULD be sent in this order. A client
ignores any other member ([§5.3](#53-compatibility)), since none of them is covered by `sig`.

A `signal`'s message is
`{"protocol":1,"subscription":…,"region":…,"version":…}` and MUST NOT be
compressed. A `fragment` event MUST be sent only for a shared region, and its
message adds the fragment, with `chrome` too for a server screen ([§12.2](#122-chrome)):
`{"protocol":1,"subscription":…,"region":…,"version":…,"made_at":…,"fragment":…}`,
with `max_age` when the server sets one ([§8.3](#83-caching)).

`body` is the message, compressed when `enc` says so, encrypted as `aes128gcm`
under `enc_s` with the session id as `keyid`, a fresh salt per event and
record size 4096, then encoded as base64url without padding.

`enc` is `gzip` when the message was gzipped before encryption and
`identity` when it was not. The rules are those for responses in [§7.4](#74-encryption): the
1024-byte minimum, the region's opt-out and the 8 MiB cap.

`sig` is HMAC-SHA256 under `sig_s`, in base64url without padding, of this
string:

```
asgard/1 event
<the stream request's signature>
<id>
<event>
<enc>
<body>
```

The six lines are joined by a single LF (0x0A), with no LF after `body`. The
stream request's signature is the 32 raw bytes from its `Signature` header,
in base64 with padding ([RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648#section-4)), as that header carries it. `id` and
`event` are the SSE fields as sent. `body` is the base64url text exactly as it
appears in `data`.

Covering the request's signature binds every event to the one request that
opened its stream, the way `"signature";req` binds a response ([§7.3](#73-signatures)). An event
replayed into another session, another stream, or the same stream after it
reconnects carries the wrong request signature and fails. Covering `id` and
`event` stops an event being renumbered or renamed. Covering `enc` stops the
marker being stripped or flipped, which would otherwise make a client gunzip
a body that was never compressed, or paint a compressed one as it stands.
The fixed first line means the string can never be read as an [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)
signature base.

The client MUST verify `sig`, then decrypt, then gunzip when `enc` is `gzip`,
then check that `subscription` is one it opened this stream with and that
`region` is one of that subscription's. An event that fails any of those
checks is logged and MUST be dropped, never acted on. Then it MUST act only on
instances of that address that asked with that subscription's state:

- On a `signal`, each instance whose token for the region differs from the
  signal's is marked to fetch the region again, exactly as a refresh would
  ([§3.1](#31-when-the-client-asks)). It fetches after the next frame that draws it, so an instance on a
  covered screen fetches when that screen is drawn again, and several
  signals before then make one fetch. The fragment on screen stays until the
  answer lands, and a server screen's chrome comes with it. An instance that
  already holds that version MUST ignore it. A refresh hint ([§10.2](#102-server-actions-the-default)) is handled
  the same way, without a version.
- On a `fragment`, it paints the fragment and keeps its `version`.

`retry:` lines and `: ping` comments are not covered. They carry nothing a
client paints. Within one live connection, ordering and duplication are TLS's
job, as for any response.

**Reconnecting.** A stream request's signature expires 300 seconds after its
`created`, like any other. So a client MUST NOT reconnect by replaying the
request it opened with: once the signature has expired the server refuses
it, and before then the server would be accepting a replay. Every connection
MUST be signed afresh.

1. When a connection drops for a reason worth retrying (a network error, a
   5xx, or the server ending the stream), the client waits out its backoff:
   the server's `retry`, doubled for each failure in a row, at most 30
   seconds.
2. Then it signs a new stream request with the current session and opens the
   stream again, carrying `Last-Event-ID` and the backoff over to the new
   connection.
3. A 419 gets one new handshake and one more try. That allowance resets once
   a connection succeeds. The client MUST NOT block its UI on the handshake.
4. A 403, a 204 or any other 4xx MUST end the stream. The regions keep their
   last fragments, and the next change to the set opens it again.

A reconnect sends the tokens the client holds, so it only hears about what
it missed. A token that is behind only costs an extra event. `Last-Event-ID`
is not signed, and a server MUST ignore it: the tokens decide what is sent on
connect.

The server MUST send a `: ping` comment every 5 seconds. A server only learns
that a client went away when a write fails, so the ping is also how soon a
dead connection gives its worker back.

The signature is checked once, when the stream opens. How long a server then
keeps the stream open (300 seconds is a sensible default) has nothing to do
with the signature window.

*Implementer note.* A signal carries nothing rendered, so the stream does not
have to be held by the application that renders. Something else could hold
it later, as long as it can seal events: it would need the session keys, or a
ticket the application issues for them.

### 8.2 Patches

A signal makes every client fetch the whole region again. For a long list
that grows a little at a time, such as a feed that gains an item at the top
many times a second and keeps the newest thousand, that is a lot of work for
a small change. A **patch** sends only the change: it adds nodes to, or
removes nodes from, one list inside a region the client already holds.

A patch is an optimization, never the only way to reach a state. Whatever a
client can't apply, it fetches instead, as it would after a signal. So a lost,
late or out-of-order patch costs a round trip and never leaves a wrong list
on screen.

**The target.** A patch names its target by node `key` ([§9.1](#91-node-shape)). The target is
the first node in the region's tree, searched depth first in document order,
whose `key` equals the target string, comparing keys as strings. A patch
changes the target's `children` (an empty list when it has none), and nothing
else in the tree.

**Operations.** A patch is one of three:

```json
{
  "op": "prepend",
  "target": "items",
  "nodes": [
    {
      "type": "text",
      "key": "1043",
      "props": {"text": "New item"}
    }
  ],
  "keep": 1000
}

{
  "op": "append",
  "target": "items",
  "nodes": [
    {
      "type": "text",
      "key": "1044",
      "props": {"text": "Older item"}
    }
  ],
  "keep": 1000
}

{
  "op": "remove",
  "target": "items",
  "keys": ["42", "43"]
}
```

- `prepend` inserts `nodes`, in their order, before the target's first child.
- `append` inserts `nodes`, in their order, after its last child.
- Before a `prepend` or `append` inserts anything, the client MUST remove
  every existing child of the target whose `key` equals the key of one of
  the inserted nodes, comparing keys as strings. A server can read a
  region's version before the app saves a change and pushes the patch for
  it, so a full answer may already hold an item that the next patch adds
  again. This rule makes that harmless: the item ends up once, where the
  patch puts it.
- `keep` is OPTIONAL on `prepend` and `append`: a positive integer, absent
  when not set. After inserting, the target keeps at most this many
  children. A `prepend` drops them from the end and an `append` from the
  start.
- `remove` drops the target's direct children whose `key` is in `keys`. A
  key that matches no child is ignored.
- `nodes` holds 1 to 100 nodes. Each is an ordinary fragment node, and a
  server MUST build it exactly as it would in a fragment: the rules of [§9.1](#91-node-shape),
  [§9.3](#93-what-a-fragment-may-not-contain) and [§9.6](#96-media-urls), and callback slots that work as they would on a rendered
  node ([§10.1](#101-callback-slots)).
- `target` is a string, and `keys` holds 1 to 1,000 strings. A node's own
  `key` inside `nodes` may still be a string or an integer, as in any
  fragment ([§9.1](#91-node-shape)).
- `keep`, when present, is at most 100,000.

A server MUST NOT send a patch that breaks these rules. Other members the
client does not know are ignored ([§5.3](#53-compatibility)).

A patch MUST describe a change the server has already made to whatever the
region renders from. A client fetches the whole region whenever it can't
apply a patch, and also when it first loads the region and after it
reconnects, so a full render at any time MUST give the tree the patches
would have left.

**Versions.** A patch moves the region's version exactly as the push that
would otherwise have caused a signal. It carries `from`, the version token
before it, and `version`, the token after. Both are the tokens of the
subscription the event is for ([§8.1](#81-the-push-stream)). A token depends on the channels that
subscription watches, so the same patch can carry different tokens on
different subscriptions.

A server can only send a patch when it knows the change between two tokens
was that patch and nothing else. So it MUST send patches only when it can
account for every version step since the token this stream last sent for
the region, with a record of the patch that made each step. When it can, it
sends one `patch` event per step, in order, and never merges them. When it
can't, it MUST send what it would have sent without patches: a signal, or a
fragment for a shared region. That includes:

- a step it has no record of, because the record has expired or the step was
  an ordinary push;
- two different counters behind the token moving between two reads, such as
  one for every subscriber and one for a channel, since the records can't
  say how those steps interleave;
- a patch with a node of a type the client did not list at the handshake
  ([§6.1](#61-handshake)).

How long a server keeps those records is up to it. Without them, it sends
signals.

When the record for the newest step is not there yet, because the push that
made it has not finished writing it, a server MAY wait a short time for it
before falling back. Asgard's reference server waits 250 ms, and at least
one poll.

On connect the server compares tokens as before ([§8.1](#81-the-push-stream)). For a region whose
token the client holds and which is behind, the server MAY send the patches
its records hold for the gap, in order, instead of a signal or a fragment.
It MUST do so only when the records cover every step from the client's
token to the current one. Otherwise it sends a signal or a fragment as
before.

**The event.** A `patch` event is sealed like the others ([§8.1](#81-the-push-stream)):

```
id: 8
event: patch
data: {"body":"<base64url>","enc":"identity","sig":"<base64url>"}
```

Its message is:

```json
{
  "protocol": 1,
  "subscription": "3f9a0c1d2e4b5a6c",
  "region": "feed",
  "from": "q3V0bG9yZW1pcHN1",
  "version": "bG9yZW1pcHN1q3V0",
  "patch": {
    "op": "remove",
    "target": "items",
    "keys": ["42"]
  }
}
```

The rules in [§7.4](#74-encryption) for compressing responses apply to it: the 1024-byte
minimum, the region's opt-out and the 8 MiB cap.

The server renders a patch once, when it is pushed, and every stream that
watches that region's counters gets the same nodes, whoever its user is. So
a patch MUST NOT carry anything that some client watching the region should
not see, just as a shared region must not ([§8.1](#81-the-push-stream)).

**Applying it.** After the checks every event gets ([§8.1](#81-the-push-stream)), a client applies a
patch to each instance of that address that asked with that subscription's
state, one instance at a time. It MUST apply the patch only if all of these
hold:

- the instance is showing a tree it got from the server for that region, not
  its placeholder;
- the version token it holds for the region equals `from`;
- the patch is one of the three operations and follows the rules above;
- the target is found in the tree;
- the tree the patch would leave, after removing the children that share
  an inserted node's key, still meets [§9.1](#91-node-shape) and [§9.3](#93-what-a-fragment-may-not-contain): no node of a type the
  client can't render, no two inserted nodes with the same key, and no
  nesting deeper than 64 levels.

Then it MUST change the tree as the operation says, repaint the region, and
hold `version` as its token. A patch changes only the fragment. A server
screen's chrome stays as it is.

If any of them fails, the client MUST NOT change the tree, and MUST treat the
event as a `signal` carrying the patch's `version`: the instance fetches the
whole region, unless it already holds that version. A version mismatch, a
missing tree or target, and a bad operation all end this way. The client
SHOULD log why.

While that fetch is out, more patches may arrive. A client MAY keep them
and, once the answer lands, apply in order those that follow on from the
version it now holds, under the same checks. Any it can't apply are treated
as signals, as above.

Patches apply in the order they arrive, and each must match the token the
one before it left. Applying one SHOULD cost no more than changing the held
tree and repainting that region: no request, and no redraw of anything else.

A patch is not an answer from the server in the sense of [§8.3](#83-caching). The copy a
client cached for the region no longer describes what is on screen, so after
a patch the client MUST NOT declare that copy in `cache`. The simplest way is
to drop it. The next full answer is stored as usual. A patch never counts as
an invalidation of a cached copy.

### 8.3 Caching

Whether to cache, what to keep, for how long and where is up to each
implementation. A server may cache what it renders, and a client may keep
fragments, route lists or anything else it has received, in memory or on
disk.

The protocol defines only what the two sides need to agree on: when a
fragment was made, and a way for a client to tell the server which copies it
holds, so the server can skip rendering one that is still good. A client that
never declares a copy never gets one skipped. A server that never skips one
is always correct.

Whatever an implementation caches, the rest of this document still applies.
A client that paints a stored fragment paints it as if it had just arrived,
so it is still checked against [§9.3](#93-what-a-fragment-may-not-contain) and refused under [§9.4](#94-fragments-the-client-cannot-render). A server that reuses a
render across users is rendering a shared region and follows the rules for
those in [§8.1](#81-the-push-stream).

#### When a fragment was made

Every fragment a server sends MUST carry `made_at`, next to `version`: an
integer, the server's Unix time in milliseconds when it began rendering the
fragment. That covers region and screen answers, every part of a `fragments`
map, and `fragment` events on the push stream. It MAY also carry `max_age`,
an integer number of seconds from 0 up: the longest the server will treat a
copy of it as fresh. No `max_age` means the server sets no limit.

A client that keeps a fragment MUST keep its `made_at` exactly as sent, and
its `version` and `chrome` with it. It picks its own TTL for each region. The
**effective TTL** of a copy is the smaller of that and `max_age`. A client
MUST NOT keep a fragment whose effective TTL is 0 beyond the instance that
shows it, so a server can stop a region being stored at all with
`"max_age":0`.

#### Declaring a copy

A render, action, method call or upload request MAY carry `cache`:
the copies the client holds of regions of the request's component, keyed by
region name (`screen` for a server screen).

```json
{
  "protocol": 1,
  "component": "app.native.screens.home",
  "regions": ["stats"],
  "state": {"period": "week"},
  "cache": {
    "stats": {"made_at": 1763150000123, "ttl": 300}
  }
}
```

`cache` MUST be an object of at most 64 entries. Each entry MUST have exactly
`made_at`, a positive integer, and `ttl`, an integer from 0 to 31536000.
`made_at` is the server's own value from the copy. `ttl` is the copy's
effective TTL in seconds. A server MUST answer a malformed `cache` with
`422 invalid_request`, and ignores a name that is not a region of the
component. The push stream and the route list never carry `cache`.

A client SHOULD declare only a copy made for the same address, region and
state as the request, and whose age by its own clock is within its effective
TTL. It MAY paint an older copy while the request is in flight, but MUST NOT
declare one.

#### Keeping the client's copy

A declared copy is **fresh** when the time since `made_at` by the server's
clock is at least -60 seconds (a client's `made_at` can be ahead of a server
whose clock is behind the one that made it) and less than the smaller of
`ttl` and the server's current `max_age` for that region.

For a region it is about to render, a server MAY skip a fresh copy and
answer that the client should keep it. It MUST NOT do so for a region the
request did not declare, or for a copy that is not fresh. A server SHOULD
render a copy that has little time left anyway, so the client gets a new
`made_at` before its copy runs out. How little is up to the server (30
seconds is a sensible default).

A kept region's part is `{"cached":true}`, in place of the fragment and with
no `version`, `made_at`, `max_age` or `chrome`. The copy keeps the ones it
came with:

```json
{
  "protocol": 1,
  "delta": {},
  "fragments": {"stats": {"cached": true}}
}
```

On `cached`, the client keeps what it shows and the copy it holds, unchanged.
It counts as a good answer, like a fragment. If the client no longer holds
the copy (it was cleared while the request was in flight), it MUST send that
region's request once more, without declaring it. A `cached` answer for a
region the request did not declare is invalid, with reason `invalid`
([§10.2](#102-server-actions-the-default)).

A server that skips a copy after something changed what the region shows
leaves the client showing the old one. A server that keeps copies needs a way
to tell when that happens, and to invalidate (below).

#### Fetches caused by a push

A render request the client sends because of a push stream signal
([§8.1](#81-the-push-stream)), including a covered screen drawing again after one arrived, SHOULD
carry `"reason":"push"`. No other request carries `reason`, an action
included, and `push` is its only value. A server MUST answer any other value
with `422 invalid_request`.

A server need not act on it. It is there so a server can choose to render a
region it would otherwise keep, since a push usually means the region has
changed. A client can claim a push falsely, but all that gets it is a render.

#### Invalidating

A server MAY send the response header `Asgard-Cache: invalidate` on any
sealed answer: render, action, method call or upload, including one
with no fragments in it. It tells the client that the fragments in this
answer replace any copies it holds of those regions. An answer that carries
it MUST render every region it answers and MUST NOT contain `cached`.

The header is covered by the response signature whenever it is present
([§7.3](#73-signatures)). Its value is one lowercase word of up to 32 letters, and
`invalidate` is the only one defined. A client ignores any other value.
Unsigned answers never carry it.

What the client does with the replaced copies, beyond painting the new
fragments, is up to it. It might let the app decide whether to show the new
fragment straight away.

#### Before designing a cache

Every answer is encrypted for one session ([§7.4](#74-encryption)), so a shared HTTP cache in
front of the server cannot usefully keep one, and QUERY requests are not
cached at the edge in practice ([rationale.md](rationale.md#why-fragments-are-not-cached-at-the-edge)). A fragment can show the
user's own data, so a client that keeps fragments on disk is storing that
data too, and SHOULD clear it when the user signs out.

*Implementer note.* In the reference implementations, a client sets a TTL in
its configuration and per region, and a server sets a max age the same way.
The server lets the app look at each declared copy before it is skipped, for
example to compare `made_at` with when the data last changed, and invalidate
the answer if it is older.

## 9. Fragment format

A server returns a **logical tree**: element type names, props, and children.
It does not return any client's in-memory node layout.

This is forced. A client's own render format is its business. It may number
element types in the order it meets them, lay nodes out in its own byte
order, or change between builds. A server also cannot know the client's
platform-specific icon names, its platform style variants, or which fonts
are in its bundle.

So the server emits names and the **client encodes**. The client resolves
types, icons and platform variants for the platform it is actually running on,
and builds its own render tree. One encode per fragment, in exchange for a
payload that is immune to byte order, platform, and format version drift.

`accepts` in the handshake exists so a future encoding can be added without a
breaking change. Version 1 defines one: `tree/json`.

### 9.1 Node shape

A fragment's root is either one node or an array of nodes. An array puts its
nodes side by side in the region, in order, as children of the region.

```json
{
  "type": "column",
  "key": "total",
  "class": "p-4 gap-2",
  "props": {"a11yLabel": "Sales total"},
  "on_press": {"call": "select", "args": ["a"]},
  "children": [
    {
      "type": "text",
      "props": {"text": "42"}
    }
  ]
}
```

- `type` is REQUIRED: an element type name ([§9.7](#97-element-types)).
- `key` is OPTIONAL: a stable identity among siblings ([§9.2](#92-the-client-owns-its-identifiers-in-two-separate-namespaces)). It is a
  string or an integer, and the client compares keys as strings, so `7` and
  `"7"` are the same key. Siblings MUST NOT share a key.
- `class` is OPTIONAL: style utility names ([§9.7](#97-element-types)).
- `props` is OPTIONAL: an object of the type's props ([§9.7](#97-element-types)).
- `on_press`, `on_long_press`, `on_double_tap`, `on_change` and `on_submit`
  are OPTIONAL callback slots ([§10.1](#101-callback-slots)).
- `children` is OPTIONAL: an array of nodes, in order.

The root is at depth 1, and each level of `children` adds one. A client MUST
refuse a fragment nested deeper than 64 levels ([§9.4](#94-fragments-the-client-cannot-render)), and a server MUST NOT
send one.

### 9.2 The client owns its identifiers, in two separate namespaces

A server MUST NOT return **node ids or callback ids**. These are not one
mechanism, and getting only the first right leaves fragment callbacks
colliding with the screen's own.

- **Node ids** come from a **key path**. The client keys the region's own
  node with the region name, so a fragment key `total` lands at
  `/sales-summary/total`. A fragment needs no id arithmetic.
- **Callback ids** belong to a **callback scope**. A fragment's callbacks
  MUST register in a scope of their own, one per region, apart from the
  screen's ([§10.4](#104-scopes)).

A server sends relative keys and callback **slots** ([§10.1](#101-callback-slots)), never ids. The
client turns each slot into a callback of its own and registers it. The
server never needs to know how either id is computed.

Placeholder callbacks MUST stay in the screen's own scope. The placeholder is
the client's UI, and a callback in a region's scope on it would fail to
dispatch.

### 9.3 What a fragment may not contain

A fragment describes a subtree inside a region. It is not a screen.

- **Only types the client can render.** A fragment MUST use only core types
  ([§9.7](#97-element-types)) and the types the client listed in `elements` at the handshake
  ([§6.1](#61-handshake)). A server MUST NOT send any other, and a client MUST refuse a
  fragment that does ([§9.4](#94-fragments-the-client-cannot-render)).

  Two kinds of type are never in either set. A **chrome** type (a nav bar,
  tab bar, bottom bar, side menu or floating action button) belongs to the
  screen that owns the region, not to the region, so no core type is chrome
  and a client MUST NOT advertise one. A server screen describes its chrome
  too, but as its own checked part of the answer ([§12.2](#122-chrome)), never inside a
  fragment. And a type that **declares a region** is never one either:
  regions are declared by the client, in its own UI, and a server MUST NOT
  create one.

  These type names are reserved for those two kinds, so that both sides can
  recognize them: `top_bar`, `top_bar_action`, `top_bar_title`, `bottom_nav`,
  `bottom_nav_item`, `bottom_bar`, `side_nav`, `side_nav_item`,
  `side_nav_group`, `side_nav_header`, `native_drawer`, `fab` and
  `server_region`. A client that has a chrome or region type by another name
  MUST NOT advertise it either.
- **Props are presentational.** `props` is written by a server, so no prop
  may choose a method to run, bind a callback, move the app, or set a node's
  identity. Callbacks come only from slots ([§10.1](#101-callback-slots), [§12.4](#124-navigation)), and identity only
  from `key`. Prop names that begin with `_`, `native-` or `native:` are
  reserved. A server MUST NOT send one, and a client MUST drop it before it
  reads `props`. A client MUST NOT let a prop reach anything that is not
  presentational.
- **No local media.** A prop that loads a URL MUST be an absolute `https:` URL,
  or mean no image. See [§9.6](#96-media-urls).
- **No local web view.** A fragment MUST NOT contain a web view that loads the
  client's own local content. That is the app's to open, not a server's.
  `webview` is not a core type. A client that advertises it MUST refuse a
  `webview` node whose `src` is not a media URL under [§9.6](#96-media-urls), and one whose
  `local` prop is present with any value other than `false` or `null`. It MUST
  also refuse one with any other prop that would make it load the client's
  own content.

### 9.4 Fragments the client cannot render

A fragment may break [§9.3](#93-what-a-fragment-may-not-contain): a type the client did not advertise, a type from a
newer protocol, a bad media URL, or nesting deeper than 64 levels ([§9.1](#91-node-shape)). The
natural implementation fails mid-render and takes the whole screen down,
which is the opposite of what [§3](#3-regions) promises.

A fragment MUST therefore be **validated before it is stored**, not during
render. One that fails validation MUST be rejected whole, and the region keeps
its placeholder, exactly as if the request had failed with reason `invalid`
([§10.2](#102-server-actions-the-default)).

### 9.5 Authoring

How a server produces a fragment is up to it, and the wire is the same either
way.

### 9.6 Media URLs

In an app's own UI, a relative path can mean an asset the app shipped, and an
absolute path can mean a local file. From a server neither means what
its author meant, and a server should not be able to point at the app's
files at all.

So in a fragment, and in chrome (`nav_bar.logo.src`, an action's `image`),
every media URL MUST be absolute:

- The client accepts `https:` URLs with a host. A client MAY also accept
  `http:` URLs in a development build, for a server on a developer's machine.
  A production build MUST NOT.
- On a node, `null`, `""` and an absent prop all mean no image. In chrome,
  an empty `src` or `image` is refused: leave the member out instead.
- Anything else (relative paths, `/` paths, `//host`, `file:`, `content:`,
  `data:`, `javascript:`) MUST fail [§9.4](#94-fragments-the-client-cannot-render), and the whole fragment is rejected.
  The check is on the prop name: `src` on any type, so an advertised type
  that loads one is covered, plus `leadingAvatar` and `leadingImage` on any
  type. Those two apply when a fragment uses the well-known `list_item` type
  ([§9.7](#97-element-types)) that a client has advertised.
- A media URL MUST be at most 2048 bytes, with no whitespace or control
  characters.

The server MUST turn what its author wrote into that form before it sends it.
It SHOULD resolve a relative path against its own public URL, and MUST NOT
send `data:` URLs: support for them differs between platforms, and a
fragment is re-sent on every push, so an inline image costs every redraw
instead of being cached once.

The client's own UI is not affected. It resolves its own media as it always
has.

**Media is public.** The client loads these URLs itself, with no Asgard
session and none of the user's auth. Anything private needs a URL that
carries its own permission, such as a signed URL that expires.

### 9.7 Element types

Every client MUST render the **core** types below. A client lists any others
it can render in `elements` at the handshake ([§6.1](#61-handshake)), and a fragment MUST NOT
use a type outside the two sets ([§9.3](#93-what-a-fragment-may-not-contain)). This document does not define the
props of an advertised type. Client and server agree on those themselves,
apart from the well-known types at the end of this section.

The core types are `column`, `row`, `stack`, `scroll_view`, `text`, `button`,
`image`, `spacer` and `divider`.

#### Common to every node

Every node may carry `key`, `class` and callback slots ([§9.1](#91-node-shape)). No core type
has a value, so `on_change` and `on_submit` only apply to advertised types
that do.

`class` is a space-separated list of style utility names: padding, margin,
gap, size, alignment, background, border, corner radius, opacity, and the
like. The vocabulary is that of [Tailwind CSS](https://tailwindcss.com/docs), including the
`dark:` variant and the `ios:` and `android:` platform variants. The client
resolves the names for its own platform, and MUST ignore a name it does not
support. Layout and decoration come from `class`, not from props.

Every type accepts these props:

| Prop | Type | Meaning |
|---|---|---|
| `a11yLabel` | string | What a screen reader announces for the node. |
| `a11yHint` | string | A screen reader hint for what the node does. |

Values in the tables below:

- A **color** is a string, `#RRGGBB`, or `#AARRGGBB` with alpha first.
- A **size** is a number in points (iOS) or density-independent pixels
  (Android).

A client MUST ignore a prop a type does not define, as [§5.3](#53-compatibility) says, and MUST
treat a prop whose value has the wrong type as absent.

#### `column`

Lays its children out top to bottom. No props of its own.

#### `row`

Lays its children out side by side, in the reading direction. No props of its
own.

#### `stack`

Layers its children on top of each other, the first at the back. No props of
its own.

#### `scroll_view`

Scrolls its children when they do not fit.

| Prop | Type | Meaning |
|---|---|---|
| `axis` | string | `vertical` (the default), `horizontal` or `both`. |
| `showsIndicators` | boolean | Whether scroll indicators show. Default true. |

#### `text`

A run of text. Its children, if any, MUST be `text` nodes, which become
inline runs inside it with their own styling.

| Prop | Type | Meaning |
|---|---|---|
| `text` | string | The text. |
| `color` | color | Text color. |
| `fontSize` | size | Font size. |
| `fontWeight` | integer | 1 thin, 2 light, 3 regular, 4 medium, 5 semibold, 6 bold, 7 heaviest. A client clamps other values into that range. |
| `textAlign` | string | `left`, `center` or `right`. |
| `maxLines` | integer | Truncate after this many lines. |

#### `button`

A tappable button with a text label. Its action is its `on_press` slot.

| Prop | Type | Meaning |
|---|---|---|
| `label` | string | The label. |
| `disabled` | boolean | Shown disabled, and taps do nothing. Default false. |
| `labelColor` | color | Label color. |
| `fontSize` | size | Label font size. |

#### `image`

An image loaded from a URL.

| Prop | Type | Meaning |
|---|---|---|
| `src` | media URL | The image ([§9.6](#96-media-urls)). |
| `fit` | string | `contain` (the default), `cover`, `fill` or `none`. |
| `tintColor` | color | Draws the image's opaque pixels in this color. |
| `alt` | string | What a screen reader announces. An image without one is decorative and hidden from screen readers. |

#### `spacer`

Takes up the remaining space along its parent's main axis. No props of its
own.

#### `divider`

A thin line across its parent, to separate content. No props of its own. Its
color and thickness come from `class`.

#### Well-known extension types

These types are not core. A client renders one only if it lists it in
`elements`. They are described here so that clients and servers that use
them agree on what they mean.

`list_item` is one row of a list, in the platform's own style: an optional
leading visual, one to three lines of text, and optional trailing text.

| Prop | Type | Meaning |
|---|---|---|
| `headline` | string | The main line. |
| `supporting` | string | A secondary line below it. |
| `overline` | string | A small line above it. |
| `leadingAvatar` | media URL | A round image before the text ([§9.6](#96-media-urls)). |
| `leadingImage` | media URL | A square image before the text ([§9.6](#96-media-urls)). |
| `leadingMonogram` | string | One or two letters in a circle before the text. |
| `trailingText` | string | Short text at the end of the row. |
| `disabled` | boolean | Shown disabled, and taps do nothing. Default false. |

When more than one leading prop is set, the client shows one of them.

## 10. Events

A tap inside a fragment runs on the server unless the fragment says otherwise.
The server owns the fragment, so by default it owns what the fragment's
buttons do.

### 10.1 Callback slots

The slots are `on_press`, `on_long_press`, `on_double_tap`, `on_change` and
`on_submit`. Each MUST hold an object, never a string:

```json
{
  "on_press": {"call": "shuffle", "args": [3]}
}

{
  "on_press": {
    "call": "celebrate",
    "args": [],
    "target": "client"
  }
}
```

- `call` MUST be a method name matching `^[A-Za-z_][A-Za-z0-9_]{0,99}$`.
- `args` MUST be a list of at most 16 JSON values (null, booleans, numbers,
  strings, and lists or objects of those), nested at most 4 deep.
- `target` MUST be absent, `"server"` or `"client"`.
- A slot MUST NOT have other members ([§5.3](#53-compatibility)).

A slot may instead move the app ([§12.4](#124-navigation)):

```json
{
  "on_press": {
    "navigate": "/promos/42",
    "replace": true,
    "transition": "fade"
  }
}

{"on_press": {"back": true}}
```

A server MUST always send `args`, even when empty. A client MUST treat a missing
`args` as empty. For `on_change` and `on_submit`, the control's value MUST be
appended to `args` on either target.

The object is structured on purpose. Neither side parses a call expression out
of a string, so there is no expression language to get wrong.

A client MUST refuse a slot of any other shape, including one with a member it
does not know. It drops the slot, logs why, and the node renders without that
handler.

### 10.2 Server actions (the default)

On a tap, the client sends the usual region request ([§3.1](#31-when-the-client-asks)) plus an `action`
member, to the same endpoint:

```json
{
  "protocol": 1,
  "component": "app.native.screens.home",
  "regions": ["stats"],
  "state": {"period": "week"},
  "action": {"call": "shuffle", "args": [3]}
}
```

The `action` object follows the rules of a slot: `call`, `args`, and no other
members. A tap belongs to one region, so a request with an `action` MUST name
exactly one, the **action's own region**, in `regions`. A server MUST answer
any other count with `422 invalid_request`.

The server restores the component from the state as for a render, runs the
action, renders the action's own region and answers with an ordinary region
answer.
The client applies it the same way it applies a render.

A server MUST run `call` only when the server component has explicitly
exposed a method of that name to clients. Each server component has one such
list, and it covers both actions and method calls ([§10.5](#105-method-calls)). Otherwise the
server MUST answer `404 unknown_action`. In particular:

- Nothing is callable by default. Being public, or existing, is not enough.
- A method that renders a region is not an action unless it is also exposed.
- Nothing the server's own framework provides is an action.
- Arguments are plain JSON values, passed in order. The server MUST NOT turn
  an argument into a record or object by looking it up, so a client cannot
  make the server load a record by sending its id where an object was
  expected.

An argument the method cannot take MUST be a `422 invalid_request`, not a
`500`. Everything in
`args` is untrusted input in the same sense as client state ([§5.1](#51-client-state)): an action
MUST authorize against the bearer identity ([§7.5](#75-authentication-is-separate)), never against what it was
sent.

Changes an action makes to the component's state come back in the answer's
`delta` ([§5.4](#54-state-sent-back)), and the client applies them before it paints. The server
renders after the action runs, so the action's own region already shows
them. Anything a server needs to remember across taps that does not belong
in the client's state, it stores itself ([§5.2](#52-server-session-state)).

#### Redrawing other regions

An action, or a method call ([§10.5](#105-method-calls)), can say which other regions need drawing
again. There are three cases.

**Same component, inline.** The method names one or more regions of the same
component. The server already has the component restored from the request's
state, so after the method runs it renders those regions too, as the
request's user, and adds them to `fragments` next to the action's own region,
which is always there. A region named twice is rendered once.

```json
{
  "protocol": 1,
  "delta": {},
  "fragments": {
    "greeting": {
      "version": "bG9yZW1pcHN1cTNW",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "Hi"}
      }
    },
    "stats": {
      "version": "q3V0bG9yZW1pcHN1",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "42"}
      }
    }
  }
}
```

Each part is shaped like any other part ([§3.1](#31-when-the-client-asks)). Its token MUST be read after the
method runs and before anything renders. The client MUST paint a part only on
the instance that sent the request, and only when that instance drew the
region. It MUST skip a region with a request that went out after this one,
because that answer is newer. A painted part supersedes any older request
for its region still in flight. Each part MUST be checked as a region render is
([§9.4](#94-fragments-the-client-cannot-render)), and one that is refused is not surfaced as a failure. A name that is
not a region of the component is a server error, and the server answers
`500 invalid_redraw`.

**Other components in this client, a hint.** The method names another
component's address and at most one of its regions. Leaving the region out
means all of them. The server does not have that component's state, so it
does not render it. It only names it, after checking the address and region
exist. One that does not exist is a server error too, and also gets
`500 invalid_redraw`, not `404 unknown_component`: the request named nothing
wrong, the server's own method did:

```json
{
  "protocol": 1,
  "delta": {},
  "fragments": {
    "greeting": {
      "version": "bG9yZW1pcHN1cTNW",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "Hi"}
      }
    }
  },
  "refresh": [
    {
      "component": "app.native.screens.inbox",
      "region": "unread"
    }
  ]
}
```

A hint for a whole component covers hints for its regions, and an answer
MUST carry at most 16 hints and 16 inline regions besides the action's own,
so at most 17 parts. A method that asks for more is a server error,
`500 invalid_redraw`.

In the client a hint is handled like a stream signal ([§8.1](#81-the-push-stream)): every live
instance at that address that drew the region is marked, and fetches it with
its own current state after its next frame. An instance on a covered screen
fetches when that screen is drawn again. A hint for a region nobody drew, or
for a screen that has closed, does nothing.

**Other clients.** The server pushes ([§8.1](#81-the-push-stream)). A hint only reaches the client that
sent the request.

`refresh` MUST be present only when the method asked for it. In a method
call's answer, `fragments` and `refresh` are left out when they would be
empty ([§10.5](#105-method-calls)).
An action's answer is compressed only under the rule for any region answer
([§3.1](#31-when-the-client-asks)): its `delta` is `{}` and every region in it, its own and the
inline ones, allows compression ([§7.4](#74-encryption)).

#### Timeouts and failures

The client waits at most its action timeout for the answer. 15 seconds is
RECOMMENDED as the default, and a client MAY let the app set its own per
component, with 0 meaning no limit. The same applies to a chrome action
([§12.2](#122-chrome)) and to a method call ([§10.5](#105-method-calls)). A client SHOULD set the HTTP timeout of
its transport longer, so this is the one that fires and a slow server reads as
`timeout` rather than `network`.

An action fails when the timeout passes, or at once on a hard failure:

| reason    | when                                                                       |
|-----------|----------------------------------------------------------------------------|
| `timeout` | no answer in time                                                          |
| `network` | the request never reached the server, or nothing came back                |
| `server`  | the server answered with an error, including a 419 after its one retry    |
| `invalid` | the answer failed verification, or its fragment cannot be rendered ([§9.4](#94-fragments-the-client-cannot-render)) |

The client MUST surface a failed action to the app, on the screen it was sent
from, with the action's `call`, the component's address, the region, the
reason, the HTTP status when there was one, and a message for logs.

The region MUST keep what it had. An answer that lands after the failure MUST
be dropped. A failure for an action that a newer request for the same region
has superseded is not surfaced, since its answer would have been dropped
anyway. A client MUST act on a deadline when it passes, without waiting for
user input. A covered screen's timers wait until it is on top again.

### 10.3 Client actions

`"target": "client"` asks the client to run a method of its own. This is how a
server-drawn button opens a sheet, plays a sound, or changes something on the
screen around the region without a round trip.

The server names the method, but the app decides whether it may. The client
MUST run `call` only when:

- the method belongs to the component that owns the region;
- the app has explicitly exposed that method to servers;
- it is not part of the client's own machinery: lifecycle hooks, navigation,
  events, state sync, region refresh, and the like;
- it takes plain JSON values, in order, with nothing looked up from them,
  as in [§10.2](#102-server-actions-the-default).

If any of these fail, nothing runs and the client logs it. It **MUST NOT** fall
back to sending the call to the server. A misspelt client action that quietly
became a server call would change where code runs without anyone noticing.

The client's own machinery is out of reach. A fragment cannot name a method
the client uses to navigate, raise events or sync state, and [§9.3](#93-what-a-fragment-may-not-contain) keeps props
from binding one. The one way a fragment moves the app is the navigation slot
in [§12.4](#124-navigation), which the client checks against its own routes.

**What this leaves a hostile server.** It can only trigger what the app chose
to expose to servers, and it could already draw a button the user would tap.
It does choose the label. A button reading "Cancel" can call whatever exposed
method the server likes. Keep destructive methods unexposed, or have them
confirm with the user themselves.

### 10.4 Scopes

Fragment callbacks register in the region's own callback scope ([§9.2](#92-the-client-owns-its-identifiers-in-two-separate-namespaces)). The
scope MUST store the target with the call, so a server callback can never be
dispatched as a client one, and a fragment cannot reach the screen's callbacks
or another region's.

If a client's callback ids are short hashes, a hostile server could search for
a callback whose id matches one of the screen's own. Such a client MUST drop
any id claimed by more than one scope, and log it, rather than run either
handler. The worst a server can do this way is disable one button.

A fragment's callbacks go when the fragment is replaced or cleared. A tap that
arrives for a fragment that is no longer current MUST do nothing.

A region inside a nested component belongs to that component, and its client
actions run there. Its scope sits inside that component's scope, so two
sibling cards showing the same fragment never share callback ids.

### 10.5 Method calls

A method call runs a method on the server component that the app's own code
calls directly, rather than a tap in a fragment. It goes to its own endpoint,
`{base}/call`, signed and encrypted like everything else and with a nonce
([§7.3](#73-signatures)):

```json
{
  "protocol": 1,
  "component": "app.native.screens.home",
  "method": "roll",
  "args": [],
  "state": {"roll": 0}
}
```

The body MAY also carry:

- `read_only`, the state members the server must not change ([§5.4](#54-state-sent-back));
- `regions`, the regions of this component the client wants drawn again
  after the method runs;
- `cache` ([§8.3](#83-caching)), for the regions the answer might draw.

It MUST NOT carry `reason`.

A method call has its own endpoint because it is not about a region. It is
about a method, and its answer is the state that method left. If calls went
to `{base}/render`, every check there would need an exception for them.

The server restores the component from the state as for a render, runs the
method of that name, and answers with `delta` ([§5.4](#54-state-sent-back)):

```json
{"protocol": 1, "delta": {"roll": 4}}
```

The client decides which of the component's regions a call redraws, if any,
by naming them in `regions`: a list of distinct region names, where an empty
list means none. The server checks it before the method runs, as [§3](#3-regions) says:
a malformed name is `422 invalid_request`, and a name that is not a region
of the component is `404 unknown_component`. A list over the server's limit
on regions per request ([§3.1](#31-when-the-client-asks)) is `422 too_many_regions`. In each case the
method does not run. With no `regions`, a call changes state
only, unless the method itself asks for more.

The answer carries `fragments` for the regions the request named and the
regions of this component the method asked for ([§10.2](#102-server-actions-the-default)), each rendered once,
before the delta is worked out. A region the client declared a fresh copy of
may come back as `{"cached":true}` ([§8.3](#83-caching)). It carries `refresh` for the
method's hints for other components. Both are left out when empty:

```json
{
  "protocol": 1,
  "delta": {"roll": 4},
  "fragments": {
    "stats": {
      "version": "q3V0bG9yZW1pcHN1",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "4"}
      }
    }
  }
}
```

The client MUST apply the delta first, then paint the regions on the calling
instance under the rules of [§10.2](#102-server-actions-the-default), then handle the hints, and only then hand
the result to the app code that made the call. A call answer MUST NOT be
compressed, fragments or not, even with an empty delta ([§7.4](#74-encryption)).

A server MUST run `method` only under the rules of [§10.2](#102-server-actions-the-default). The method must be
on the same list a tap's action is checked against. Otherwise the server
answers `404 unknown_method`. An unknown address, or an unknown region in
`regions`, is `404 unknown_component`.
A malformed body, a member it does not know ([§5.3](#53-compatibility)), or state or args that do
not fit is `422 invalid_request`.

Failures and timeouts are as in [§10.2](#102-server-actions-the-default), with no region.

### 10.6 Uploads

The app can send a file to a method on the server component. The server
method is exposed for uploads, on a list of its own, separate from the one
for actions and method calls. It receives the file, then the args, which are checked as an
action's are. There is no matching client method and no client body.
The request carries the component's state as it is when the upload starts.

It goes to `{base}/upload`, signed and encrypted like everything else and with
a nonce ([§7.3](#73-signatures)). The decrypted body is a frame rather than JSON:

```
uint32, big-endian   N, the length of the header, at most 1 MiB (1,048,576 bytes)
N bytes              the header, a JSON object
the rest             the file, exactly `size` bytes
```

```json
{
  "protocol": 1,
  "component": "app.native.screens.home",
  "method": "savePhoto",
  "args": [],
  "state": {"caption": ""},
  "filename": "IMG_0001.jpg",
  "mime": "image/jpeg",
  "size": 2483113
}
```

A frame rather than JSON with the file in base64, because base64 makes every
upload a third bigger and has to be decoded in memory on the server too. The
header is a method call's body plus `filename`, `mime` and `size`, so the
rules for args, state and unknown members ([§5.3](#53-compatibility)) are a call's. `Content-Type`
on the wire stays `application/json`, as the signature in [§7.3](#73-signatures) covers it and
the body is opaque until it is decrypted. Requests are never compressed
([§7.4](#74-encryption)), and files are usually compressed already.

`filename` and `mime` are what the client says, and the server MUST NOT trust
either. It MUST sniff the type from the bytes and check it against the types
the method accepts. It MUST write the bytes to a temporary file it names
itself, and keep the filename, cleaned, only as the file's original name. It
deletes the temporary file when the method returns.

The header MAY carry `read_only`, `regions` and `cache` as a call's body
does. The answer is a call's ([§10.5](#105-method-calls)): `{"protocol": 1, "delta": {...}}`, plus
`fragments` for the regions the request named or the method asked for, and
`refresh` for the method's hints. The client
handles it exactly as it does a call's: the delta under compare-and-set,
then the regions, then the hints.

Errors are a call's, plus:

| Status | Body | When |
|---|---|---|
| 413 | `{"error":"too_large"}` | Over the method's limit or the server's. When the server can tell from the size alone, it refuses before decrypting, and that 413 is plain and unsigned ([§7.3](#73-signatures)). |
| 415 | `{"error":"unsupported_type"}` | The sniffed type is not one the method accepts. |
| 404 | `{"error":"unknown_method"}` | Not a method exposed for uploads. A method exposed only for actions and calls does not count. |
| 422 | `{"error":"invalid_request"}` | A bad frame, a `size` that is not the bytes sent, an empty file, a header member the server does not know, or args that do not fit, as for a call. |

Failures are surfaced as for a call, with the method name as the action and
no region. Two reasons are only for uploads, and both mean nothing was sent:

- `unreadable`: the file the app named cannot be read as a regular file. A
  directory, a symbolic link, anything that is not a local file, and a path
  with a NUL byte MUST all be refused.
- `too_large`: the file is over the client's own limit. 20 MiB
  (20,971,520 bytes) is RECOMMENDED.

A file the server finds too big or the wrong type is `server`, with status 413
or 415.

An upload waits for its answer longer than an action does, since 20 MiB on a
slow network can take a while. 120 seconds is RECOMMENDED, with the HTTP
timeout of the transport longer again, so the client's own timer fires first.

A client holds the whole file in memory to seal it, since [§7.4](#74-encryption) encrypts the
body as one piece. That is why it has a cap. Streaming a file record by
record is future work.

## 11. Versioning

`protocol` in the handshake is an integer. A server that does not speak the
client's version MUST say so at handshake, not mid-render. Clients support exactly
one version per build; servers MAY support several.

After the handshake the version travels in the `Asgard-Protocol` header of
every request and every sealed response ([§6.2](#62-use-and-renewal)), and `protocol` in every
body carries the same value.

## 12. Server screens

A region fills part of a screen the app owns. A server screen is a whole
screen the server owns: its body, its chrome, and the route that opens it.
It still lives inside the app's shell. The app opens it, stacks it, and
can always go back from it, and an app route always wins over a server
route.

### 12.1 Screens

A server screen has a route and a **screen address**. The server lists its
routes ([§12.3](#123-routes)), and resolves a screen address through the same developer-written
table as any component address ([§4](#4-addressing-components)): nothing from the wire names code. Two
screens MUST NOT share a route or an address.

In the client a server route always opens one generic screen that the client
provides for server screens. It MUST NOT open one of the app's own screens, so
a server cannot point a route at app code. Its body is a single region named
`screen`, so everything in [§3](#3-regions), [§8.1](#81-the-push-stream) and [§10](#10-events) applies unchanged:

- It asks for its fragment with the usual region request. `component` is
  the screen address and `regions` is `["screen"]`.
- Its `state` is the route's parameters over its query string. Route values
  are strings on the wire. A server that wants a number or a boolean
  converts it: a numeric string to a number, and `"true"`, `"false"`, `"1"`
  or `"0"` to a boolean. It converts nothing else.
- Until an answer lands, it shows a placeholder skeleton. It does not wait
  for ever: see [Giving up](#giving-up) below.
- Server actions and pushed fragments work as in regions. The generic
  screen exposes no methods to servers, so a client target in a server
  screen runs nothing ([§10.3](#103-client-actions)).
- A server screen has one body region, `screen`, and no others. Its chrome
  comes only from the `chrome` member, so a chrome type in the body is
  refused like any other ([§9.3](#93-what-a-fragment-may-not-contain)).

The `screen` part of a screen's render or action answer, and a push event
for it, carries the chrome next to the fragment:

```json
{
  "protocol": 1,
  "delta": {},
  "fragments": {
    "screen": {
      "version": "q3V0bG9yZW1pcHN1",
      "made_at": 1763150000123,
      "fragment": {
        "type": "text",
        "props": {"text": "Promo 7"}
      },
      "chrome": {
        "nav_bar": {"title": "Promo", "back": true}
      }
    }
  }
}
```

`chrome` MUST be an object for a screen, `{}` for none, and MUST be absent for
any other component. On a push it rides in the same event body ([§8.1](#81-the-push-stream)).

#### Giving up

A server screen waits at most its screen timeout for its first body, from its
first frame. 15 seconds is RECOMMENDED. It gives up when that passes, or at
once when the request for the body fails hard (the reasons in [§10.2](#102-server-actions-the-default):
`network`, `server` or `invalid`). Giving up means:

1. It goes back to the screen below. When there is none, as with a cold deep
   link straight onto a server screen, it replaces itself with the app's `/`
   route.
2. Once that screen is the live one, the client surfaces the failure to the
   app with the screen's URI and address, the reason, the HTTP status when
   there was one, and a message for logs.

An answer that lands after the screen gave up MUST be dropped. The timer stops
for good once a body lands: a later refresh, action or push that fails leaves
that body on screen, as for any region. Leaving the screen stops it too.

A client MAY let the app change the generic screen's skeleton and timeout.

### 12.2 Chrome

Chrome is to a server screen what a layout is to one of the app's own
screens: its nav bar, tab bar and bottom content, said all at once.

The client MUST check chrome before it uses it: every known member of the
right type, every button slot a valid slot ([§10.1](#101-callback-slots), [§12.4](#124-navigation)), every tab URL an
app path, every content slot a valid fragment ([§9.3](#93-what-a-fragment-may-not-contain), [§9.4](#94-fragments-the-client-cannot-render)), and every media
URL valid ([§9.6](#96-media-urls)). It MUST ignore a member it does not know ([§5.3](#53-compatibility)), except in
a slot or a navigation, where it MUST refuse it. Chrome that fails MUST leave
the screen on the chrome it had, and the client logs why. Until the first
answer, a screen wears the chrome it last had while the app has been running,
or a plain nav bar with a back button when it is not the root.

Buttons in chrome MUST register in the `screen` region's callback scope
([§10.4](#104-scopes)), so a chrome tap dispatches exactly like a tap in the body.

The members of `chrome`:

| Field | Type | Meaning |
|---|---|---|
| `native` | boolean | Draw the bars with the platform's own controls. Default false. |
| `font` | string | Default font name for the chrome. |
| `nav_bar` | object | The nav bar, below. Absent means no nav bar. |
| `tab_bar` | object | The tab bar, below. Absent means no tab bar. |
| `bottom_bar` | fragment | Content pinned to the bottom of the screen. Only with `native`. |
| `tab_accessory` | fragment | Content attached to the tab bar. Only with `native`. |

`nav_bar`:

| Field | Type | Meaning |
|---|---|---|
| `title`, `subtitle` | string | Title text. |
| `back` | boolean | Show a back button. |
| `hidden` | boolean | Hide the bar. |
| `background_color`, `text_color` | string | Colors ([§9.7](#97-element-types)). |
| `font` | string | Font name. |
| `elevation` | integer | Shadow depth, 0 to 64. |
| `display_mode` | string | `large`, `inline` or `automatic`. |
| `scroll_behavior` | string | `collapse`, `pinned` or `enterAlways`. |
| `logo` | object | `{"src", "height"?}`. `src` is a media URL ([§9.6](#96-media-urls)). `height` is a size up to 200, default 28. |
| `title_view` | fragment | Content shown in place of the title. |
| `search` | object | `{"placeholder"?, "debounce_ms"?, "on_query"?}`. `debounce_ms` is 0 to 5000. `on_query` is a call slot. The query is appended to its args, and it cannot navigate. |
| `actions` | array | Up to 16 buttons: `{"id", "label"?, "a11y_label"?, "icon"?, "ios_icon"?, "android_icon"?, "image"?, "destructive"?, "disabled"?, "on_press"?, "items"?}`. `image` is a media URL ([§9.6](#96-media-urls)). `items` is a menu of up to 32 more actions, one level deep, where `{"id", "divider": true}` is a separator. |

`tab_bar`:

| Field | Type | Meaning |
|---|---|---|
| `hidden` | boolean | Hide the bar. |
| `active_color`, `background_color`, `text_color` | string | Colors ([§9.7](#97-element-types)). |
| `font` | string | Font name. |
| `label_visibility` | string | `labeled`, `selected` or `unlabeled`. |
| `dark` | boolean | Use the dark style. |
| `minimize_on_scroll` | boolean | Shrink the bar while content scrolls. |
| `highlight` | string | The `id` of the tab to show as selected. |
| `presentation` | object | `{"id", "configuration"?}`: a presentation style the client provides, named by a lower-case id. A client ignores one it does not have. |
| `tabs` | array | Up to 10 tabs: `{"id", "label", "url"?, "icon"?, "ios_icon"?, "android_icon"?, "badge"?, "badge_color"?, "news"?, "active"?, "search"?, "on_press"?}`. `url` is an app path ([§12.4](#124-navigation)). `search` takes `placeholder` and `debounce_ms` as above. |

An `id` is 1 to 100 characters of `A-Z a-z 0-9 _ . : -`. A string is at most
1024 bytes. Icon names are the client's to resolve, and a client shows no
icon for a name it does not know.

A link tab opens its route with `replace`, like one of the app's own tabs, but
through the checked navigation path in [§12.4](#124-navigation). Its URL MUST match a route when
tapped. The next answer's chrome replaces the old one whole.

A client MAY add chrome of its own to a server screen, as it would for any
screen.

### 12.3 Routes

A server lists its screens' routes at one more endpoint, sealed like render
([§7.3](#73-signatures), [§7.4](#74-encryption)) and read-only like it, so it carries no nonce:

```
→  QUERY {base}/routes        (or POST plus X-Asgard-Method: QUERY)
   {"protocol": 1}

←  200
   {"protocol": 1, "version": "3f9c0a1b2c3d4e5f",
    "routes": [{"uri": "/promos/{id}", "screen": "promos.show"}]}
```

- `uri` MUST be a route pattern of literal segments (`A-Za-z0-9._~-`) and
  `{name}` parameters, with an optional `{name?}` allowed last. `/` is the
  root. Nothing else.
- `screen` MUST be a screen address, as in [§4](#4-addressing-components).
- `version` MUST change whenever the list does.

The client MUST fetch the list **in the background, never in the way of
start-up or a frame.** At start-up it registers the list it cached last time,
with no network. Once the first screen has shown, it fetches the list,
caches it, and registers it if the version changed. A failed fetch MUST keep
the cached list, and MAY be retried a minute later. An app that has never
reached its server has no server routes.

Registering replaces the whole server table. The client MUST check each entry
again and MUST drop one that is malformed, or whose pattern is already an app
route. Server routes MUST be matched only after every app route, literal and
parameterized, so a server route can add a screen but never replace one of
the app's.

A server route can also be reached by a deep link rather than a tap. A client
MUST resolve it the same way: app routes first, then server routes, opening
the generic server screen for a match. Because the cached list is registered
at start-up, this works offline for any route the client has seen before.

### 12.4 Navigation

A press slot (`on_press`, `on_long_press`, `on_double_tap`) in a fragment or
in chrome can move the app instead of calling a method:

```json
{"navigate": "/promos/42"}

{
  "navigate": "/inbox?unread=1",
  "replace": true,
  "transition": "fade"
}

{
  "back": true,
  "transition": "slide_from_left"
}
```

- `navigate` MUST be an app path: one leading `/`, no scheme or host, no
  backslash, no whitespace or control characters, at most 2048 bytes. A web
  URL is never one.
- `replace` is a boolean. `transition` MUST be one of the client's transitions:
  `slide_from_right`, `slide_from_left`, `slide_from_bottom`, `fade`,
  `fade_from_bottom`, `scale_from_center`, `parallax_push`, `morph`,
  `none`.
- `{"back": true}` takes only `transition`.
- A navigation MUST NOT have other members ([§5.3](#53-compatibility)). `on_change` and
  `on_submit` cannot navigate, and neither can a search field's `on_query`.

The server MUST check the shape. The client MUST check it again, and refuse
the slot if it is wrong. When the tap lands the client MUST check that the
path matches a route it knows right now: one of its own or a server screen's.
Any route qualifies; no opt-in is needed. A path that matches nothing runs
nothing and is logged. It MUST NOT fall through to a browser or web view, and
there is no way to leave the app.

## 13. Open questions

1. Whether a region can be rendered without a bearer token at all, for public
   screens shown before sign-in.
2. ~~Fragment caching.~~ Settled: caching is up to each implementation
   ([§8.3](#83-caching)). Edge caches will not help, for the reasons in
   [rationale.md](rationale.md#why-fragments-are-not-cached-at-the-edge).
3. ~~Navigation from inside a fragment.~~ Settled: a press slot can hold a
   navigation ([§12.4](#124-navigation)). Any route the app knows is a target, its own or a
   server screen's, and the client checks the route exists when the tap
   lands. Web URLs and leaving the app are not possible. Props can never
   navigate ([§9.3](#93-what-a-fragment-may-not-contain)).
4. Offline queueing of events fired against a fragment that is no longer
   current.
5. *Removed in Draft 2. It was about one client's internals, not the
   protocol.*
6. ~~The handshake response carries the session `secret` in its body, so a
   logging proxy that sees the handshake sees every key derived from it.~~
   Settled: the handshake is an ephemeral P-256 ECDH exchange, in the spirit
   of [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), and the secret never crosses the wire ([§6.1](#61-handshake)). An active
   attacker that terminates TLS is still TLS's to stop ([§7.1](#71-threat-model)).
7. The push stream holds a server worker or connection per client for its
   lifetime ([§8.1](#81-the-push-stream)). One stream per client keeps that to one each, but a
   server with many clients on server regions at once still needs one per
   client. Whether pushes should move to something built to hold many idle
   connections (a separate event service fed by the push counters, say) is
   open.
8. Bursts after a wide push. A push to a channel many clients joined sends
   each of them a signal at about the same time, and each fetches the region
   at once. Whether clients should spread those fetches out (a random delay
   of a second or two, say) is open.
9. Timeouts are set per component or screen, not per action. Whether an
   action should be able to say it needs longer is open, and the same
   question applies to regions ([§3.1](#31-when-the-client-asks)). Uploads have their own ([§10.6](#106-uploads)).
10. Whether a region that failed should retry by itself, with a backoff.
    Today a client MUST NOT ([§3.1](#31-when-the-client-asks)). It waits for the app to ask for a
    refresh, so the app decides when.
11. Prop names are camelCase (`fontSize`, `a11yLabel`, `leadingAvatar`),
    while every other name on the wire is snake_case (`on_press`,
    `nav_bar`, `scroll_view`). One convention should be chosen before 1.0.
12. 419 is not a registered status code ([Building on HTTP](#building-on-http)).
    Whether to replace it before 1.0, for example with 401 and a
    `WWW-Authenticate` challenge ([RFC 9110 §11.6.1](https://www.rfc-editor.org/rfc/rfc9110#section-11.6.1)) that tells a lost session
    apart from a rejected bearer token, is open.
13. Whether the handshake should accept proof that the client is the app as
    shipped, from the platform's app attestation service, so a server can
    refuse sessions to scripts. It would be optional, since not every client
    has such a service.

## References

### Normative references

- [FIPS 186-5](https://doi.org/10.6028/NIST.FIPS.186-5): Digital Signature Standard (DSS), NIST, February 2023. Defines the P-256 curve.
- [RFC 1952](https://www.rfc-editor.org/rfc/rfc1952): GZIP file format specification version 4.3
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119): Key words for use in RFCs to Indicate Requirement Levels, BCP 14
- [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986): Uniform Resource Identifier (URI): Generic Syntax, STD 66
- [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648): The Base16, Base32, and Base64 Data Encodings
- [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869): HMAC-based Extract-and-Expand Key Derivation Function (HKDF)
- [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174): Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words, BCP 14
- [RFC 8188](https://www.rfc-editor.org/rfc/rfc8188): Encrypted Content-Encoding for HTTP
- [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259): The JavaScript Object Notation (JSON) Data Interchange Format, STD 90
- [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446): The Transport Layer Security (TLS) Protocol Version 1.3
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110): HTTP Semantics, STD 97
- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421): HTTP Message Signatures
- [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530): Digest Fields
- [RFC 10008](https://www.rfc-editor.org/rfc/rfc10008): The HTTP QUERY Method
- [SEC 1](https://www.secg.org/sec1-v2.pdf): Elliptic Curve Cryptography, version 2.0, Standards for Efficient Cryptography Group, May 2009. Section 2.3.3 defines the point encoding used in [§6.1](#61-handshake).
- [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html): Server-sent events, HTML Living Standard, WHATWG.

### Informative references

- [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291): Message Encryption for Web Push
- [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112): HTTP/1.1, STD 99
- [RFC 9113](https://www.rfc-editor.org/rfc/rfc9113): HTTP/2
- [RFC 9114](https://www.rfc-editor.org/rfc/rfc9114): HTTP/3
- [RFC 9325](https://www.rfc-editor.org/rfc/rfc9325): Recommendations for Secure Use of Transport Layer Security (TLS) and Datagram Transport Layer Security (DTLS), BCP 195
- [TAILWIND](https://tailwindcss.com/docs): Tailwind CSS utility classes, the vocabulary of `class` in [§9.7](#97-element-types).
