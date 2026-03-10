<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Architecture

## Design Principle: Zero RLJSON Knowledge

The network package knows **nothing** about Io, Bs, Db, trees, hashes, or
sync. It only knows about nodes, peers, and topology. This makes it reusable
for any application that needs self-organizing star topology.

- Use `domain` (network grouping), **never** `treeKey` (RLJSON concept)
- No imports from `@rljson/io`, `@rljson/bs`, `@rljson/db`, `@rljson/server`
- The bridge between network → RLJSON lives in `@rljson/server`, not here

## Module Structure

```
src/
├── types/
│   ├── node-info.ts            // NodeId, NodeInfo — core identity type
│   ├── peer-probe.ts           // PeerProbe — probe result
│   ├── network-topology.ts     // NetworkTopology, NodeRole, FormedBy
│   ├── network-config.ts       // Config interfaces for all discovery layers
│   └── network-events.ts       // Event types emitted by NetworkManager
├── identity/
│   └── node-identity.ts        // Persistent UUID, hostname, IP discovery
├── example.ts                  // Runnable example
└── index.ts                    // Public API exports
```

## Fallback Cascade

Discovery layers are tried in order of autonomy:

| Position     | Layer         | Required?          | Description                               |
| ------------ | ------------- | ------------------ | ----------------------------------------- |
| **Try 1**    | UDP Broadcast | **always on**      | Zero-config LAN discovery. Primary path.  |
| **Try 2**    | Cloud Service | **optional**       | Cross-network fallback.                   |
| **Try 3**    | Static Config | **optional**       | Hardcoded `hubAddress`. Last resort.      |
| **Override** | Manual / UI   | **always present** | Human escape hatch. No config entry.      |

## Hub Election Rules

1. **Incumbent advantage**: If a hub exists and is reachable, keep it.
2. **Earliest `startedAt`**: If no incumbent, the node started first wins.
3. **Tiebreaker**: Lexicographic `nodeId` comparison.

## NodeIdentity Design

`NodeIdentity` uses dependency injection for full testability:

- `NodeIdentityDeps` interface — all OS/fs functions injectable
- `defaultNodeIdentityDeps()` — real Node.js implementations
- `NodeIdentity.create(options)` — async factory, loads or generates UUID
- UUID persisted at `<identityDir>/<domain>/node-id`
- Same machine + same domain = same identity across restarts

## Layer 0 — No Dependencies

This package has **zero** `@rljson/*` dependencies. It sits at Layer 0
alongside `@rljson/rljson`, meaning it can be published independently.
