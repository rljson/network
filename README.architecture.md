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
├── election/
│   └── hub-election.ts         // Deterministic hub election algorithm
├── probing/
│   ├── peer-prober.ts          // Real TCP connect probe via node:net
│   └── probe-scheduler.ts      // Periodic probing + change detection
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

### Election Implementation

`electHub()` in `src/election/hub-election.ts` is a **pure function** — no
I/O, no side effects, fully deterministic:

- **Input**: candidates (`NodeInfo[]`), probes (`PeerProbe[]`), current hub, self
- **Output**: `ElectionResult` with `hubId` and `reason`
- Self is **always** considered reachable (no need for self-probe)
- Returns `{ hubId: null, reason: 'no-candidates' }` when no reachable nodes
- Reasons: `'incumbent'`, `'earliest-start'`, `'tiebreaker'`, `'no-candidates'`

## Probing Design

### PeerProber

`probePeer()` in `src/probing/peer-prober.ts` uses real TCP connect via
`node:net`:

- `connect({ host, port, timeout })` — non-blocking socket connect
- Never rejects — always resolves with a `PeerProbe` result
- `reachable: true` on `'connect'`, `false` on `'timeout'` or `'error'`
- Latency measured with `performance.now()` (sub-millisecond precision)
- Socket is destroyed immediately after result (no keep-alive)

### ProbeScheduler

`ProbeScheduler` in `src/probing/probe-scheduler.ts` manages periodic
probing of all known peers:

- **Injectable probe function** (`ProbeFn`) for Tier-1 mock tests
- **Real TCP** by default (uses `probePeer`)
- **Self-exclusion at probe time** — filters self in `_runCycle()`, not
  `setPeers()`, because `setPeers()` may be called before `start()` sets
  the self ID
- **Change detection**: tracks `_wasReachable` state per peer, emits
  `'peer-unreachable'` and `'peer-reachable'` only on state transitions
- **Flap dampening**: a peer must fail `failThreshold` consecutive probes
  (default: 3) before being declared unreachable. A single success resets
  the counter immediately. This prevents flapping on transient network glitches.
- **No false alerts**: first probe sets baseline, subsequent probes detect
  changes
- `runOnce()` — manual single cycle for deterministic test control
- Events: `'probes-updated'`, `'peer-unreachable'`, `'peer-reachable'`

## Testing Strategy (3-Tier)

| Tier   | Scope                  | What's real        | Used for                             |
| ------ | ---------------------- | ------------------ | ------------------------------------ |
| Tier 1 | Unit (mock probes)     | Logic + state only | Election, scheduling, event emission |
| Tier 2 | Real TCP (localhost)   | Actual socket I/O  | Probing, latency, connection refused |
| Tier 3 | Multi-process (future) | Full network stack | True distributed scenarios           |

- Tier 1 uses `ProbeFn` injection for deterministic, fast tests
- Tier 2 uses `node:net.createServer()` on localhost with random ports
- All tiers run in the same `pnpm test` suite

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
- Creates and manages `ProbeScheduler` for reachability checking
- Uses `PeerTable` for merged peer tracking
- Applies **cascade logic** via `_computeHub()`:
  1. Manual override wins
  2. Election via probes (if probes available → `electHub()`)
  3. (Future: Cloud assignment)
  4. Static config fallback
  5. No result → `unassigned`
- Accepts `NetworkManagerOptions` with injectable `probeFn` for testing
- Emits events: `topology-changed`, `role-changed`, `hub-changed`,
  `peer-joined`, `peer-left`
- Continuous re-evaluation: any peer/hub change or probe update triggers
  `_recomputeTopology()`
- `getProbeScheduler()` provides public access for advanced usage

## Known Limitations (Future Work)

The current election system is designed for **LAN office sync** (2–10 nodes)
and works well in that scope. The following distributed-systems gaps are
documented for future epics:

### Split-Brain — No Consensus Protocol

Each node runs its own `electHub()` independently. In a network partition,
two isolated groups may each elect a different hub. There is no Raft, Paxos,
or gossip protocol to reach agreement.

**Mitigation**: On LAN, partitions are rare. When the partition heals, probes
converge and nodes re-elect the same hub (incumbent advantage + earliest
`startedAt`).

**Future**: A gossip protocol (Epic 5+) or Raft-based consensus could
guarantee a single hub across partitions.

### No Quorum

Election doesn't require a majority of nodes to agree. A single node
in isolation will elect itself as hub. This is by design for small LANs
but may be undesirable in larger deployments.

**Future**: Add optional `quorum: true` config that requires `>50%` of
known peers to be reachable before accepting an election result.

### Probe Staleness Window

The default probe interval is 10 seconds. During this window, a hub can
go down without being detected. This is acceptable for file sync but not
for real-time systems.

**Mitigation**: `intervalMs` is configurable. For faster detection, reduce
the interval (at the cost of higher network traffic).

**Future**: Hub heartbeat / lease mechanism — the hub actively sends
keepalives; clients consider the hub down if heartbeat stops.

### No Handover Protocol

When a hub is replaced, there is no graceful handover of state (e.g.,
pending syncs, in-flight messages). Clients simply reconnect to the new hub.

**Future**: Handover protocol lives in `@rljson/server`, not in the
network layer. The network layer only signals topology changes; the
application layer (`@rljson/server`) must handle state transfer.

### No Hub Lease / Heartbeat

There is no mechanism for the hub to "renew" its leadership. If the hub
stops responding but probe timing creates a race, two nodes might briefly
disagree about who is hub.

**Mitigation**: Flap dampening (3 consecutive failures required) prevents
transient disagreements. Incumbent advantage prevents unnecessary re-elections.

**Future**: A time-limited hub lease (e.g., 30 seconds) with active renewal
would provide stronger guarantees.

## Layer 0 — No Dependencies

This package has **zero** `@rljson/*` dependencies. It sits at Layer 0
alongside `@rljson/rljson`, meaning it can be published independently.
