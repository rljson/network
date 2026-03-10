// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { examplePeerProbe } from '../../src/types/peer-probe';
import type { PeerProbe } from '../../src/types/peer-probe';

describe('PeerProbe', () => {
  it('examplePeerProbe has all required fields', () => {
    expect(examplePeerProbe.fromNodeId).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );
    expect(examplePeerProbe.toNodeId).toBe(
      'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    );
    expect(examplePeerProbe.reachable).toBe(true);
    expect(examplePeerProbe.latencyMs).toBe(0.3);
    expect(examplePeerProbe.measuredAt).toBe(1741123456800);
  });

  it('can create an unreachable probe', () => {
    const probe: PeerProbe = {
      fromNodeId: 'node-a',
      toNodeId: 'node-b',
      reachable: false,
      latencyMs: -1,
      measuredAt: Date.now(),
    };
    expect(probe.reachable).toBe(false);
    expect(probe.latencyMs).toBe(-1);
  });
});
