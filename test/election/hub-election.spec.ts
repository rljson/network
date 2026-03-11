// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { electHub } from '../../src/election/hub-election';
import type { ElectionResult } from '../../src/election/hub-election';
import type { NodeInfo } from '../../src/types/node-info';
import type { PeerProbe } from '../../src/types/peer-probe';

// .............................................................................

/** Helper: create a NodeInfo with minimal fields */
function makeNode(
  nodeId: string,
  startedAt: number,
  overrides?: Partial<NodeInfo>,
): NodeInfo {
  return {
    nodeId,
    hostname: `host-${nodeId}`,
    localIps: ['127.0.0.1'],
    domain: 'test',
    port: 3000,
    startedAt,
    ...overrides,
  };
}

/** Helper: create a passing probe */
function reachableProbe(
  fromNodeId: string,
  toNodeId: string,
  latencyMs = 1.0,
): PeerProbe {
  return {
    fromNodeId,
    toNodeId,
    reachable: true,
    latencyMs,
    measuredAt: Date.now(),
  };
}

/** Helper: create a failing probe */
function unreachableProbe(fromNodeId: string, toNodeId: string): PeerProbe {
  return {
    fromNodeId,
    toNodeId,
    reachable: false,
    latencyMs: -1,
    measuredAt: Date.now(),
  };
}

// .............................................................................

describe('HubElection', () => {
  const selfId = 'self-node';

  // .........................................................................
  // No candidates
  // .........................................................................

  describe('no candidates', () => {
    it('returns null when candidates list is empty', () => {
      const result = electHub([], [], null, selfId);
      expect(result).toEqual<ElectionResult>({
        hubId: null,
        reason: 'no-candidates',
      });
    });

    it('returns null when all candidates are unreachable', () => {
      const nodeA = makeNode('node-a', 1000);
      const nodeB = makeNode('node-b', 2000);
      const probes = [
        unreachableProbe(selfId, 'node-a'),
        unreachableProbe(selfId, 'node-b'),
      ];

      const result = electHub([nodeA, nodeB], probes, null, selfId);
      expect(result).toEqual<ElectionResult>({
        hubId: null,
        reason: 'no-candidates',
      });
    });
  });

  // .........................................................................
  // Self is always reachable
  // .........................................................................

  describe('self reachability', () => {
    it('considers self as always reachable even without probes', () => {
      const self = makeNode(selfId, 1000);
      const result = electHub([self], [], null, selfId);
      expect(result.hubId).toBe(selfId);
    });

    it('elects self when all other candidates are unreachable', () => {
      const self = makeNode(selfId, 5000); // started later
      const nodeA = makeNode('node-a', 1000); // started earlier but unreachable
      const probes = [unreachableProbe(selfId, 'node-a')];

      const result = electHub([self, nodeA], probes, null, selfId);
      expect(result.hubId).toBe(selfId);
      expect(result.reason).toBe('earliest-start');
    });
  });

  // .........................................................................
  // Incumbent advantage
  // .........................................................................

  describe('incumbent advantage', () => {
    it('keeps incumbent hub if still reachable', () => {
      const incumbent = makeNode('old-hub', 5000); // started LATER
      const challenger = makeNode('new-node', 1000); // started EARLIER
      const probes = [
        reachableProbe(selfId, 'old-hub'),
        reachableProbe(selfId, 'new-node'),
      ];

      // old-hub should stay despite new-node being older
      const result = electHub(
        [incumbent, challenger],
        probes,
        'old-hub',
        selfId,
      );
      expect(result).toEqual<ElectionResult>({
        hubId: 'old-hub',
        reason: 'incumbent',
      });
    });

    it('does not keep incumbent if it became unreachable', () => {
      const incumbent = makeNode('old-hub', 5000);
      const challenger = makeNode('new-node', 1000);
      const probes = [
        unreachableProbe(selfId, 'old-hub'), // hub went down
        reachableProbe(selfId, 'new-node'),
      ];

      const result = electHub(
        [incumbent, challenger],
        probes,
        'old-hub',
        selfId,
      );
      expect(result.hubId).toBe('new-node');
      expect(result.reason).toBe('earliest-start');
    });

    it('incumbent self stays elected', () => {
      const self = makeNode(selfId, 5000);
      const nodeA = makeNode('node-a', 1000);
      const probes = [reachableProbe(selfId, 'node-a')];

      // Self was hub and is always reachable
      const result = electHub([self, nodeA], probes, selfId, selfId);
      expect(result).toEqual<ElectionResult>({
        hubId: selfId,
        reason: 'incumbent',
      });
    });

    it('no incumbent advantage when currentHubId is null', () => {
      const nodeA = makeNode('node-a', 1000);
      const nodeB = makeNode('node-b', 2000);
      const probes = [
        reachableProbe(selfId, 'node-a'),
        reachableProbe(selfId, 'node-b'),
      ];

      const result = electHub([nodeA, nodeB], probes, null, selfId);
      expect(result.hubId).toBe('node-a'); // earliest startedAt
      expect(result.reason).toBe('earliest-start');
    });
  });

  // .........................................................................
  // Earliest startedAt
  // .........................................................................

  describe('earliest startedAt', () => {
    it('elects the node with the earliest startedAt', () => {
      const nodeA = makeNode('node-a', 3000);
      const nodeB = makeNode('node-b', 1000); // earliest
      const nodeC = makeNode('node-c', 2000);
      const probes = [
        reachableProbe(selfId, 'node-a'),
        reachableProbe(selfId, 'node-b'),
        reachableProbe(selfId, 'node-c'),
      ];

      const result = electHub([nodeA, nodeB, nodeC], probes, null, selfId);
      expect(result).toEqual<ElectionResult>({
        hubId: 'node-b',
        reason: 'earliest-start',
      });
    });

    it('ignores unreachable nodes with earlier startedAt', () => {
      const earliest = makeNode('node-early', 1000); // earliest but down
      const middle = makeNode('node-mid', 2000); // reachable
      const latest = makeNode('node-late', 3000); // reachable
      const probes = [
        unreachableProbe(selfId, 'node-early'),
        reachableProbe(selfId, 'node-mid'),
        reachableProbe(selfId, 'node-late'),
      ];

      const result = electHub([earliest, middle, latest], probes, null, selfId);
      expect(result.hubId).toBe('node-mid');
    });

    it('works with a single reachable candidate', () => {
      const nodeA = makeNode('node-a', 1000);
      const probes = [reachableProbe(selfId, 'node-a')];

      const result = electHub([nodeA], probes, null, selfId);
      expect(result).toEqual<ElectionResult>({
        hubId: 'node-a',
        reason: 'earliest-start',
      });
    });
  });

  // .........................................................................
  // Tiebreaker (same startedAt)
  // .........................................................................

  describe('tiebreaker', () => {
    it('breaks ties with lexicographic nodeId comparison', () => {
      // Same startedAt → lexicographic nodeId
      const nodeAlpha = makeNode('alpha', 1000);
      const nodeBeta = makeNode('beta', 1000);
      const probes = [
        reachableProbe(selfId, 'alpha'),
        reachableProbe(selfId, 'beta'),
      ];

      const result = electHub([nodeAlpha, nodeBeta], probes, null, selfId);
      expect(result).toEqual<ElectionResult>({
        hubId: 'alpha',
        reason: 'tiebreaker',
      });
    });

    it('tiebreaker is stable regardless of input order', () => {
      const nodeX = makeNode('x-node', 1000);
      const nodeA = makeNode('a-node', 1000);
      const probes = [
        reachableProbe(selfId, 'x-node'),
        reachableProbe(selfId, 'a-node'),
      ];

      // Forward order
      const r1 = electHub([nodeX, nodeA], probes, null, selfId);
      // Reverse order
      const r2 = electHub([nodeA, nodeX], probes, null, selfId);

      expect(r1.hubId).toBe('a-node');
      expect(r2.hubId).toBe('a-node');
      expect(r1.reason).toBe('tiebreaker');
      expect(r2.reason).toBe('tiebreaker');
    });

    it('three-way tie resolves to lexicographically first', () => {
      const nodeC = makeNode('charlie', 1000);
      const nodeA = makeNode('alpha', 1000);
      const nodeB = makeNode('bravo', 1000);
      const probes = [
        reachableProbe(selfId, 'charlie'),
        reachableProbe(selfId, 'alpha'),
        reachableProbe(selfId, 'bravo'),
      ];

      const result = electHub([nodeC, nodeA, nodeB], probes, null, selfId);
      expect(result.hubId).toBe('alpha');
      expect(result.reason).toBe('tiebreaker');
    });
  });

  // .........................................................................
  // Mixed scenarios
  // .........................................................................

  describe('mixed scenarios', () => {
    it('incumbent advantage wins over earlier startedAt', () => {
      const incumbent = makeNode('hub', 5000); // started late
      const older = makeNode('older', 1000); // started early
      const probes = [
        reachableProbe(selfId, 'hub'),
        reachableProbe(selfId, 'older'),
      ];

      const result = electHub([incumbent, older], probes, 'hub', selfId);
      expect(result.hubId).toBe('hub');
      expect(result.reason).toBe('incumbent');
    });

    it('re-election after incumbent fails promotes earliest', () => {
      const deadHub = makeNode('dead-hub', 1000);
      const nodeA = makeNode('node-a', 3000);
      const nodeB = makeNode('node-b', 2000);
      const probes = [
        unreachableProbe(selfId, 'dead-hub'),
        reachableProbe(selfId, 'node-a'),
        reachableProbe(selfId, 'node-b'),
      ];

      const result = electHub(
        [deadHub, nodeA, nodeB],
        probes,
        'dead-hub',
        selfId,
      );
      expect(result.hubId).toBe('node-b'); // earliest reachable
      expect(result.reason).toBe('earliest-start');
    });

    it('self participates in election as a normal candidate', () => {
      const self = makeNode(selfId, 1000); // earliest
      const nodeA = makeNode('node-a', 2000);
      const probes = [reachableProbe(selfId, 'node-a')];

      const result = electHub([self, nodeA], probes, null, selfId);
      expect(result.hubId).toBe(selfId); // self is earliest
      expect(result.reason).toBe('earliest-start');
    });

    it('large cluster election is deterministic', () => {
      const nodes = Array.from({ length: 20 }, (_, i) =>
        makeNode(`node-${String(i).padStart(3, '0')}`, 1000 + i * 100),
      );
      const probes = nodes.map((n) => reachableProbe(selfId, n.nodeId));

      const r1 = electHub(nodes, probes, null, selfId);
      const r2 = electHub([...nodes].reverse(), probes, null, selfId);

      expect(r1.hubId).toBe(r2.hubId);
      expect(r1.hubId).toBe('node-000'); // earliest startedAt
      expect(r1.reason).toBe('earliest-start');
    });
  });
});
