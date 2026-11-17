# The Asgard Protocol

Asgard lets a server render parts of a native app's UI. The app marks a region of a screen as server-rendered, sends its state to a server, and paints the description of native elements that comes back. A server can also own whole screens inside the app.

The app stays in charge. It ships its own screens, works offline, and only asks a server about the regions and routes it has been told to. The server sends a description of elements, never code.

**[Read the protocol](protocol.md)**

## What you can build with it

### Server-driven UI

Change what part of an app looks like by deploying the server, not by shipping a new release through the app stores. The app marks a [region](protocol.md#3-regions) and keeps a placeholder for it, so it still works offline or when the server is down. A server can also own whole [screens](protocol.md#12-server-screens) at routes it lists, inside the app's own navigation.

Some of the things that makes possible:

- **Live data.** Order tracking, sports scores, dashboards. The server tells the client when a region has changed over the [push stream](protocol.md#81-the-push-stream), and the client fetches the new fragment. The app doesn't have to poll.
- **Experiments and personalization.** The server sees the state the client sends with each request, so it can render a different fragment per user or per experiment arm. A/B tests and feature rollouts become server deploys, and turning one off doesn't need an app update.
- **Content by country.** Pricing, legal notices, payment options, or a checkout or sign-up form that has to differ by country. The server renders the right one for where the user is. Each installation doesn't need to carry every country's version, and a new rule ships the day it takes effect.
- **Content managed outside the app.** Home screens, promotions, onboarding and seasonal campaigns can come from a CMS. Editors change them on the server and every installed version of the app picks up the change.
- **Third-party widgets.** A partner's server can render a region in your app, such as a payment summary, a loyalty card or a booking status. The partner sends data your app chooses how to draw. It can't run code, and it can only call methods you [exposed to servers](protocol.md#103-client-actions).

### Generative UI

The server builds the UI for each request, rather than picking from screens someone designed in advance. A fragment is only data, which is what makes this safe. The client checks it against the [element types](protocol.md#97-element-types) it can render and [what a fragment may not contain](protocol.md#93-what-a-fragment-may-not-contain), and a tap can only reach a method the app has [exposed to servers](protocol.md#103-client-actions). Whatever generates the fragment, the app never runs anything new.

- **AI agents.** An agent can answer with a native UI instead of a wall of text: a comparison table, a booking form, a chart with buttons to drill in. This is safer than letting a model write code. A confused or manipulated model can produce a bad answer, but it can't make the app do anything it wasn't built to do.
- **One app for many customers.** A platform ships one app, and each customer's screens are generated from their own configuration, branding and data. A new customer doesn't need a new build, and one customer's setup can't reach into the app beyond what the platform exposed.

## How it compares

The idea isn't new. Plenty of tools render UI on a server and update it in place, on the web and in cross-platform frameworks. What they share is that each one comes with its own stack: you get the format, the transport and the state model by adopting that tool's server, client library or language. Datastar and Inertia come closest, with short written protocols that servers in many languages implement, but each still has one client and covers far less.

On the web:

- **Phoenix LiveView** keeps state on the server over a WebSocket and sends diffs. Its wire format belongs to Phoenix, and so does LiveView Native, which brings the same model to SwiftUI and Jetpack Compose.
- **Livewire** sends component state with each request and gets HTML back. It is a Laravel package for Blade, and its payload is an implementation detail.
- **HTMX** and **Hotwire** swap in HTML fragments from any server. They work with any server, but the fragment is HTML and the client is a browser. Hotwire Native wraps those web pages in a native shell rather than drawing native elements.
- **Datastar** is the closest in spirit. The client sends its state ("signals") with each request, except signals whose names start with an underscore, which stay in the browser. The server answers over Server-Sent Events with two kinds of event: one patches HTML elements into the page, the other patches signals using JSON Merge Patch. There are SDKs for over a dozen server languages, written against a short design document and checked by a shared test suite. But the client is Datastar's own JavaScript library in a browser, the elements are HTML with expressions in their attributes, and a server can send a script to run. Security is left to HTTP.
- **Inertia.js** has a short published protocol too (a header, a page object with a component name and its props, a version check and partial reloads), and there are server adapters for Laravel, Rails, Django, Phoenix and others. But the server only sends data: the client must already ship every page as a React, Vue or Svelte component, so a new screen still means a new client build. It works on whole pages, leaves security to cookies and CSRF, and has no push or uploads of its own.
- **ASP.NET Web Forms ViewState** round-tripped serialized page state on every post. It is the old lesson in what happens when that state gets big or is trusted too much.

All of these start from a page that needs the network. A web app can work offline, with a service worker, the Cache API and IndexedDB, but it has to opt in and build that itself. The first visit still needs a connection, and the browser may clear what was stored when space runs low or the site goes unused. A native app is offline-first by default: its code and screens are installed with it. Asgard keeps that, because every region has a placeholder the app ships, so the app still works when the server can't be reached.

In cross-platform frameworks:

- **React Server Components in Expo** render a tree of native components on the server and stream it to the app, with server functions for calls. It needs React on both sides, and the stream uses React's own internal format.
- **Remote Flutter Widgets (`rfw`)** is the Flutter team's package for widget descriptions sent from a server. It defines the format and leaves fetching, state, security and updates to you. Community packages such as Stac and `json_dynamic_widget` do the same for JSON.
- **DivKit**, from Yandex, has a published JSON layout format with renderers for iOS, Android, the web and Flutter. It is the nearest thing to a shared format, but it has no transport, state or security model.
- **NativeScript** can build a view from XML at runtime, and that is as far as it goes.
- Large apps such as Airbnb have built their own server-driven UI systems, which stay in-house.

Asgard tries to cover the whole conversation in one document that doesn't assume a language, framework or rendering engine: the [handshake](protocol.md#6-sessions), [signed and encrypted requests](protocol.md#7-security), state going up and [deltas](protocol.md#105-method-calls) coming back, [regions with placeholders](protocol.md#3-regions), the [push stream](protocol.md#81-the-push-stream), [uploads](protocol.md#106-uploads) and [server-owned screens](protocol.md#12-server-screens). A server in any language can talk to any client that follows it.

### Why not just HTML and JavaScript?

HTML and JavaScript are open standards, run everywhere and can describe almost any UI. A native app can show them in a web view today. Asgard deliberately does much less, and that is the point:

- **Native elements, not a web page.** A fragment becomes the platform's own controls inside a native screen, with their look, accessibility, gestures and performance. A web view is a separate world, with its own navigation, back stack, keyboard handling and state, that the native screen around it can't easily share.
- **Data, not code.** A fragment is a description of [element types](protocol.md#97-element-types) from a fixed list, and a tap can only reach a method the app has [exposed to servers](protocol.md#103-client-actions). A page with JavaScript is a program: it can do whatever the web view and any bridge into the app allow, and app store rules limit what downloaded code may change.
- **A small vocabulary both sides agree on.** At the [handshake](protocol.md#61-handshake) the client lists the element types it can draw, and the server sends only those. A browser has to cope with decades of markup, several engines and many versions of each, so web code leans on feature detection, polyfills and fallbacks. An Asgard server knows exactly what the client in front of it supports.
- **The app stays in charge.** The client owns the state, the screen and the [placeholder](protocol.md#3-regions), so a region still works offline or when the server is down. A web view that can't load shows nothing useful.

If you want arbitrary UI, a whole website, or something to run in a browser, use the web. Asgard is for the parts of a native app that should change without a release, and nothing more.

## Status

Draft 4. It is not stable and may change incompatibly before 1.0. We would like to hear from anyone implementing it, so please open an issue.

## Implementations

The protocol is written so that the server half can be anything. A Rails, Django or Go server that follows [protocol.md](protocol.md) is as much a part of it as the reference one.

The reference implementations are built by [NativePHP](https://nativephp.com):

- [nativephp/midgard](https://github.com/NativePHP/midgard), the client, for apps built with [NativePHP for Mobile](https://nativephp.com/docs/mobile)
- [nativephp/asgard](https://github.com/NativePHP/asgard), the server, a Laravel package

## What's here

- [protocol.md](protocol.md), the specification
- [schema/fragment.schema.json](schema/fragment.schema.json), a JSON Schema for the fragment format in §9
- [schema/constants.json](schema/constants.json), every number, name and enum in the spec with the section it comes from, and [schema/constants.schema.json](schema/constants.schema.json), its schema
- [conformance/](conformance/README.md), a conformance suite: byte-exact vectors, golden server cases, the fixture components a server adds to run them ([FIXTURES.md](conformance/FIXTURES.md)), and a Node.js runner with no dependencies
- [rationale.md](rationale.md), non-normative background, including the vendor evidence for the QUERY fallback
- [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
