---
description: "Package map for bidirectional enterprise messaging channels that drive ordinary DSH Sessions."
kind: "package-group"
---

# channel/ — enterprise messaging channels

English | [中文](README.zh.md)

## Summary

The channel family connects authenticated enterprise messaging transports to ordinary Workspace Sessions. A channel owns provider delivery admission, conversation identity, result projection, and transport lifecycle while reusing the Agent, Session, permission, preset, and persistence layers.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`channel-wecom/`](channel-wecom/README.md) | Enterprise WeCom AI Bot long connection, durable conversation routing, and streamed replies | function plugin; no service key |

<a id="related-documentation"></a>
## Related documentation

Channels are protocol drivers rather than model-facing tools. They activate regular Agents and project only correlated visible assistant text back to the provider.

- [Core subsystem](../../docs/subsystems/core.md) — Agent creation, Session lifecycle, model routing, and the event flow that channels drive.

<a id="dev-note"></a>
## Dev Note

None.
