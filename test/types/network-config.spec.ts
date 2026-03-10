// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { defaultNetworkConfig } from '../../src/types/network-config';
import type {
  NetworkConfig,
  BroadcastConfig,
  CloudConfig,
  StaticConfig,
  ProbingConfig,
} from '../../src/types/network-config';

describe('NetworkConfig', () => {
  describe('defaultNetworkConfig', () => {
    it('creates config with broadcast enabled', () => {
      const config = defaultNetworkConfig('office-sync', 3000);
      expect(config.domain).toBe('office-sync');
      expect(config.port).toBe(3000);
      expect(config.broadcast?.enabled).toBe(true);
      expect(config.broadcast?.port).toBe(41234);
      expect(config.probing?.enabled).toBe(true);
    });

    it('does not include cloud or static by default', () => {
      const config = defaultNetworkConfig('test', 4000);
      expect(config.cloud).toBeUndefined();
      expect(config.static).toBeUndefined();
      expect(config.identityDir).toBeUndefined();
    });
  });

  it('can create a full config with all layers', () => {
    const broadcast: BroadcastConfig = {
      enabled: true,
      port: 41234,
      intervalMs: 5000,
      timeoutMs: 15000,
    };
    const cloud: CloudConfig = {
      enabled: true,
      endpoint: 'https://cloud.example.com',
      apiKey: 'secret',
      pollIntervalMs: 30000,
    };
    const staticCfg: StaticConfig = {
      hubAddress: '192.168.1.100:3000',
    };
    const probing: ProbingConfig = {
      enabled: true,
      intervalMs: 10000,
      timeoutMs: 2000,
    };

    const config: NetworkConfig = {
      domain: 'full-config',
      port: 3000,
      identityDir: '/tmp/test-identity',
      broadcast,
      cloud,
      static: staticCfg,
      probing,
    };

    expect(config.cloud?.endpoint).toBe('https://cloud.example.com');
    expect(config.static?.hubAddress).toBe('192.168.1.100:3000');
    expect(config.probing?.intervalMs).toBe(10000);
  });

  it('can create a minimal static-only config', () => {
    const config: NetworkConfig = {
      domain: 'minimal',
      port: 3000,
      static: { hubAddress: '10.0.0.1:3000' },
    };
    expect(config.broadcast).toBeUndefined();
    expect(config.static?.hubAddress).toBe('10.0.0.1:3000');
  });
});
