# The Asgard Protocol

Asgard lets a server render parts of a native mobile app's UI. The app marks a region of a screen as server-rendered, sends its state to a server, and paints the description of native elements that comes back. A server can also own whole screens inside the app.

The app stays in charge. It ships its own screens, works offline, and only asks a server about the regions and routes it has been told to. The server sends a description of elements, never code.

**[Read the protocol](protocol.md)**

## What you can build with it

### Server-driven UI

Change what part of an app looks like by deploying the server, not by shipping a new release through the app stores. The app marks a [region](protocol.md#3-regions) and keeps a placeholder for it, so it still works offline or when the server is down. A server can also own whole [screens](protocol.md#12-server-screens) at routes it lists, inside the app's own navigation.

### Generative UI for AI agents

An agent can answer with a native UI instead of a wall of text: a comparison table, a booking form, a chart with buttons to drill in. The agent's server returns a fragment, the same JSON any other server would.

This is safer than letting a model write code. A fragment is only data. The client checks it against the [element types](protocol.md#97-element-types) it can render and [what a fragment may not contain](protocol.md#93-what-a-fragment-may-not-contain). A tap can only reach a method the app has [exposed to servers](protocol.md#103-client-actions). A confused or manipulated model can produce a bad answer, but it cannot make the app run something new.

### Live data

Order tracking, delivery maps, sports scores, dashboards. The server tells the client when a region has changed over the [push stream](protocol.md#81-the-push-stream), and the client fetches the new fragment. The app doesn't have to poll.

### Experiments and personalisation

The server sees the state the client sends with each request, so it can render a different fragment per user, per region or per experiment arm. A/B tests and feature rollouts become server deploys, and turning one off doesn't need an app update.

### Content managed outside the app

Home screens, promotions, onboarding and seasonal campaigns can come from a CMS. Editors change them on the server and every installed version of the app picks up the change.

### Third-party widgets

A partner's server can render a region in your app, such as a payment summary, a loyalty card or a booking status. The same rules that make generative UI safe apply. The partner sends data your app chooses how to draw, it can't run code, and it can only call methods you exposed.

## Status

Draft 2. It is not stable and may change incompatibly before 1.0. We would like to hear from anyone implementing it, so please open an issue.

## Implementations

The protocol is written so that the server half can be anything. A Rails, Django or Go server that follows [protocol.md](protocol.md) is as much a part of it as the reference one.

The reference implementations are built by [NativePHP](https://nativephp.com):

- `nativephp/midgard`, the client, for apps built with [NativePHP for Mobile](https://nativephp.com/docs/mobile)
- `nativephp/asgard`, the server, a Laravel package

## What's here

- [protocol.md](protocol.md), the specification
- [schema/fragment.schema.json](schema/fragment.schema.json), a JSON Schema for the fragment format in §9
- [rationale.md](rationale.md), non-normative background, including the vendor evidence for the QUERY fallback
- [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
