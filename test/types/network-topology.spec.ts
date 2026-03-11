// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import {
  nodeRoles,
  formedByValues,
  exampleNetworkTopology,
} from '../../src/types/network-topology';
import type {
  NodeRole,
  FormedBy,
  NetworkTopology,
} from '../../src/types/network-topology';

describe('NetworkTopology', () => {
  describe('nodeRoles', () => {
    it('contains all three roles', () => {
      expect(nodeRoles).toEqual(['hub', 'client', 'unassigned']);
    });

    it('values are assignable to NodeRole', () => {
      const role: NodeRole = nodeRoles[0];
      expect(role).toBe('hub');
    });
  });

  describe('formedByValues', () => {
    it('contains all five formation sources', () => {
      expect(formedByValues).toEqual([
        'broadcast',
        'cloud',
        'election',
        'manual',
        'static',
      ]);
    });

    it('values are assignable to FormedBy', () => {
      const formed: FormedBy = formedByValues[3];
      expect(formed).toBe('manual');
    });
  });

  describe('exampleNetworkTopology', () => {
    it('has all required fields', () => {
      expect(exampleNetworkTopology.domain).toBe('office-sync');
      expect(exampleNetworkTopology.hubNodeId).toBe(
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      );
      expect(exampleNetworkTopology.hubAddress).toBe('192.168.1.42:3000');
      expect(exampleNetworkTopology.formedBy).toBe('broadcast');
      expect(exampleNetworkTopology.formedAt).toBe(1741123456800);
      expect(exampleNetworkTopology.myRole).toBe('hub');
      expect(exampleNetworkTopology.probes).toEqual([]);
    });

    it('has nodes as a Record', () => {
      const nodeIds = Object.keys(exampleNetworkTopology.nodes);
      expect(nodeIds).toHaveLength(1);
      expect(nodeIds[0]).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });
  });

  it('can create an unassigned topology', () => {
    const topology: NetworkTopology = {
      domain: 'test',
      hubNodeId: null,
      hubAddress: null,
      formedBy: 'static',
      formedAt: 0,
      nodes: {},
      probes: [],
      myRole: 'unassigned',
    };
    expect(topology.hubNodeId).toBeNull();
    expect(topology.myRole).toBe('unassigned');
  });
});
