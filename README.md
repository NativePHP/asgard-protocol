# The Asgard Protocol

Asgard lets a server render parts of a native mobile app's UI. The app marks a region of a screen as server-rendered, sends its state to a server, and paints the description of native elements that comes back. A server can also own whole screens inside the app.

The app stays in charge. It ships its own screens, works offline, and only asks a server about the regions and routes it has been told to. The server sends a description of elements, never code.

**[Read the protocol](protocol.md)**

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
