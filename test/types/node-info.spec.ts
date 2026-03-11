// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { exampleNodeInfo } from '../../src/types/node-info';
import type { NodeInfo, NodeId } from '../../src/types/node-info';

describe('NodeInfo', () => {
  it('exampleNodeInfo has all required fields', () => {
    expect(exampleNodeInfo.nodeId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(exampleNodeInfo.hostname).toBe('WORKSTATION-7');
    expect(exampleNodeInfo.localIps).toEqual(['192.168.1.42']);
    expect(exampleNodeInfo.domain).toBe('office-sync');
    expect(exampleNodeInfo.port).toBe(3000);
    expect(exampleNodeInfo.startedAt).toBe(1741123456789);
  });

  it('NodeId is a string type alias', () => {
    const id: NodeId = 'test-id';
    expect(id).toBe('test-id');
  });

  it('can create a custom NodeInfo', () => {
    const info: NodeInfo = {
      nodeId: 'custom-id',
      hostname: 'my-host',
      localIps: ['10.0.0.1', '10.0.0.2'],
      domain: 'test-domain',
      port: 4000,
      startedAt: 123456,
    };
    expect(info.localIps).toHaveLength(2);
  });
});
