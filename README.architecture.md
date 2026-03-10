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
├── layers/
│   ├── discovery-layer.ts      // DiscoveryLayer interface — contract for all layers
│   ├── manual-layer.ts         // ManualLayer — always-present override
│   └── static-layer.ts         // StaticLayer — hardcoded hub fallback (Try 3)
├── peer-table.ts               // PeerTable — merged view of peers from all layers
├── network-manager.ts          // NetworkManager — central orchestrator
├── example.ts                  // Runnable example
└── index.ts                    // Public API exports
```

## Fallback Cascade

Discovery layers are tried in order of autonomy:

| Position     | Layer         | Required?          | Description                              |
| ------------ | ------------- | ------------------ | ---------------------------------------- |
| **Try 1**    | UDP Broadcast | **always on**      | Zero-config LAN discovery. Primary path. |
| **Try 2**    | Cloud Service | **optional**       | Cross-network fallback.                  |
| **Try 3**    | Static Config | **optional**       | Hardcoded `hubAddress`. Last resort.     |
| **Override** | Manual / UI   | **always present** | Human escape hatch. No config entry.     |

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

## DiscoveryLayer Contract

All discovery mechanisms implement the `DiscoveryLayer` interface:

```
start(identity) → Promise<boolean>   // Returns false if layer can't operate
stop()          → Promise<void>      // Clean up resources
isActive()      → boolean            // Whether currently running
getPeers()      → NodeInfo[]         // Currently known peers
getAssignedHub() → string | null     // Hub dictated by this layer
on/off          → event subscription // peer-discovered, peer-lost, hub-assigned
```

### ManualLayer

- **Always present**, cannot be disabled
- Does **not** discover peers — only overrides hub assignment
- `assignHub(nodeId)` / `clearOverride()` API
- Clearing returns control to the automatic cascade

### StaticLayer

- Last resort fallback (Try 3)
- Reads `hubAddress` from config (`"ip:port"`)
- Creates a **synthetic peer** with deterministic nodeId `static-hub-<address>`
- Returns `false` from `start()` if no `hubAddress` configured
- Emits `peer-discovered` + `hub-assigned` on start, `peer-lost` on stop

## PeerTable Design

Merged view of all peers from all discovery layers:

- **Deduplication by nodeId** — same peer from multiple layers appears once
- **Per-layer tracking** via `_layerPeers` map for correct removal semantics
- `peer-joined` fires only when a genuinely **new** peer is first seen
- `peer-left` fires only when **all** layers have lost the peer
- `setSelfId()` excludes own node from the peer table
- `attachLayer()` imports existing peers + subscribes to future events

## NetworkManager Design

Central orchestrator — the main public API:

- Creates `NodeIdentity` on start
- Starts ManualLayer + StaticLayer (Broadcast/Cloud in future epics)
- Uses `PeerTable` for merged peer tracking
- Applies **cascade logic** via `_computeHub()`:
  1. Manual override wins
  2. (Future: Broadcast election)
  3. (Future: Cloud assignment)
  4. Static config fallback
  5. No result → `unassigned`
- Emits events: `topology-changed`, `role-changed`, `hub-changed`,
  `peer-joined`, `peer-left`
- Continuous re-evaluation: any peer/hub change triggers recomputation

## Layer 0 — No Dependencies

This package has **zero** `@rljson/*` dependencies. It sits at Layer 0
alongside `@rljson/rljson`, meaning it can be published independently.
