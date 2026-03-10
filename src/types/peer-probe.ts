// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

/** Result of probing a peer's reachability */
export interface PeerProbe {
  /** Node that initiated the probe */
  fromNodeId: string;
  /** Node that was probed */
  toNodeId: string;
  /** Whether the peer was reachable */
  reachable: boolean;
  /** TCP round-trip in ms, -1 if unreachable */
  latencyMs: number;
  /** Timestamp of measurement */
  measuredAt: number;
}

/** Example PeerProbe for tests and documentation */
export const examplePeerProbe: PeerProbe = {
  fromNodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  toNodeId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  reachable: true,
  latencyMs: 0.3,
  measuredAt: 1741123456800,
};
