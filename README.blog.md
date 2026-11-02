<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Blog

Add latest posts at the end.

## 2026-03-20 — Hub election validated on 4-node test lab

- `@rljson/network` hub election algorithm validated on a 4-node Windows deployment (Node v24.14.0)
- Broadcast-based discovery, incumbent advantage, and manual override all working correctly in E2E tests (g1–g15)
- `hub-changed` event emission was already correct — the consumer bug was in `@rljson/server` Node class (fixed in v0.0.14)
- Flap dampening and probe scheduling stable across g8 (10s stability check) and g13 (no flapping)

## 2026-11-02 — Resolve the address of any peer

- `NetworkManager.resolvePeerAddress(nodeId)` and `staticHubNodeId(hubAddress)`
- Post: [doc/blog/2026/2026-11-02-resolve-the-address-of-any-peer.md](doc/blog/2026/2026-11-02-resolve-the-address-of-any-peer.md), German: [doc/de/blog/2026/2026-11-02-resolve-the-address-of-any-peer.md](doc/de/blog/2026/2026-11-02-resolve-the-address-of-any-peer.md)
