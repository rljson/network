// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  CloudLayer,
  defaultCreateCloudHttpClient,
  type CloudHttpClient,
  type CloudPeerListResponse,
} from '../../src/layers/cloud-layer.ts';
import { NodeIdentity } from '../../src/identity/node-identity.ts';
import type { NodeInfo } from '../../src/types/node-info.ts';
import type { PeerProbe } from '../../src/types/peer-probe.ts';

// .............................................................................

/** Create a minimal NodeIdentity for testing */
function testIdentity(overrides?: Partial<NodeInfo>): NodeIdentity {
  return new NodeIdentity({
    nodeId: 'test-node-1',
    hostname: 'test-host',
    localIps: ['10.0.0.1'],
    domain: 'test-domain',
    port: 3000,
    startedAt: 1700000000000,
    ...overrides,
  });
}

/** Create a fake peer NodeInfo */
function fakePeer(id: string, domain = 'test-domain'): NodeInfo {
  return {
    nodeId: id,
    hostname: `host-${id}`,
    localIps: ['10.0.0.2'],
    domain,
    port: 3001,
    startedAt: 1700000001000,
  };
}

// .............................................................................

/**
 * In-memory mock cloud service for testing.
 *
 * Tracks register/poll/report calls and returns configurable responses.
 */
class MockCloudService implements CloudHttpClient {
  registerCalls: Array<{ endpoint: string; info: NodeInfo; apiKey?: string }> =
    [];
  pollCalls: Array<{
    endpoint: string;
    nodeId: string;
    domain: string;
    apiKey?: string;
  }> = [];
  reportCalls: Array<{
    endpoint: string;
    nodeId: string;
    probes: PeerProbe[];
    apiKey?: string;
  }> = [];

  /** Response to return from register/poll */
  nextResponse: CloudPeerListResponse = { peers: [], assignedHub: null };

  /** If set, register() throws this error */
  registerError: Error | null = null;

  /** If set, poll() throws this error */
  pollError: Error | null = null;

  /** If set, reportProbes() throws this error */
  reportError: Error | null = null;

  async register(
    endpoint: string,
    info: NodeInfo,
    apiKey?: string,
  ): Promise<CloudPeerListResponse> {
    this.registerCalls.push({ endpoint, info, apiKey });
    if (this.registerError) throw this.registerError;
    return this.nextResponse;
  }

  async poll(
    endpoint: string,
    nodeId: string,
    domain: string,
    apiKey?: string,
  ): Promise<CloudPeerListResponse> {
    this.pollCalls.push({ endpoint, nodeId, domain, apiKey });
    if (this.pollError) throw this.pollError;
    return this.nextResponse;
  }

  async reportProbes(
    endpoint: string,
    nodeId: string,
    probes: PeerProbe[],
    apiKey?: string,
  ): Promise<void> {
    this.reportCalls.push({ endpoint, nodeId, probes, apiKey });
    if (this.reportError) throw this.reportError;
  }
}

// .............................................................................

describe('CloudLayer', () => {
  let cloud: MockCloudService;
  let layer: CloudLayer;

  beforeEach(() => {
    cloud = new MockCloudService();
    layer = new CloudLayer(
      {
        enabled: true,
        endpoint: 'https://cloud.example.com',
        apiKey: 'test-key',
        pollIntervalMs: 60000, // Long interval — manual polling in tests
      },
      { createHttpClient: () => cloud },
    );
  });

  afterEach(async () => {
    if (layer.isActive()) {
      await layer.stop();
    }
  });

  // .........................................................................
  // Basic properties
  // .........................................................................

  it('has name "cloud"', () => {
    expect(layer.name).toBe('cloud');
  });

  it('is not active before start', () => {
    expect(layer.isActive()).toBe(false);
  });

  it('has no peers before start', () => {
    expect(layer.getPeers()).toEqual([]);
  });

  it('has no assigned hub before start', () => {
    expect(layer.getAssignedHub()).toBeNull();
  });

  it('uses default HTTP client when no deps provided', () => {
    const defaultLayer = new CloudLayer({
      enabled: true,
      endpoint: 'https://cloud.example.com',
    });
    // Should construct without error — uses defaultCreateCloudHttpClient
    expect(defaultLayer.name).toBe('cloud');
  });

  // .........................................................................
  // start — disabled / no config
  // .........................................................................

  describe('start — disabled', () => {
    it('returns false when enabled is false', async () => {
      const disabled = new CloudLayer(
        { enabled: false, endpoint: 'https://cloud.example.com' },
        { createHttpClient: () => cloud },
      );
      const result = await disabled.start(testIdentity());
      expect(result).toBe(false);
      expect(disabled.isActive()).toBe(false);
    });

    it('returns false when config is undefined', async () => {
      const noConfig = new CloudLayer(undefined, {
        createHttpClient: () => cloud,
      });
      const result = await noConfig.start(testIdentity());
      expect(result).toBe(false);
    });

    it('returns false when endpoint is empty', async () => {
      const emptyEndpoint = new CloudLayer(
        { enabled: true, endpoint: '' },
        { createHttpClient: () => cloud },
      );
      const result = await emptyEndpoint.start(testIdentity());
      expect(result).toBe(false);
    });
  });

  // .........................................................................
  // start — registration
  // .........................................................................

  describe('start — registration', () => {
    it('registers with cloud on start', async () => {
      await layer.start(testIdentity());

      expect(cloud.registerCalls).toHaveLength(1);
      expect(cloud.registerCalls[0]!.endpoint).toBe(
        'https://cloud.example.com',
      );
      expect(cloud.registerCalls[0]!.info.nodeId).toBe('test-node-1');
      expect(cloud.registerCalls[0]!.apiKey).toBe('test-key');
    });

    it('returns true on successful registration', async () => {
      const result = await layer.start(testIdentity());
      expect(result).toBe(true);
      expect(layer.isActive()).toBe(true);
    });

    it('returns false when cloud is unreachable', async () => {
      cloud.registerError = new Error('ECONNREFUSED');
      const result = await layer.start(testIdentity());
      expect(result).toBe(false);
      expect(layer.isActive()).toBe(false);
    });

    it('processes initial peer list from registration', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: 'peer-a',
      };

      await layer.start(testIdentity());

      expect(layer.getPeers()).toHaveLength(2);
      expect(layer.getAssignedHub()).toBe('peer-a');
    });

    it('emits peer-discovered for initial peers', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };

      const discovered: NodeInfo[] = [];
      layer.on('peer-discovered', (peer) => discovered.push(peer));

      await layer.start(testIdentity());

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.nodeId).toBe('peer-a');
    });

    it('emits hub-assigned when cloud assigns a hub', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: 'peer-a',
      };

      const hubs: Array<string | null> = [];
      layer.on('hub-assigned', (hubId) => hubs.push(hubId));

      await layer.start(testIdentity());

      expect(hubs).toEqual(['peer-a']);
    });

    it('does not emit hub-assigned when hub is null initially', async () => {
      cloud.nextResponse = { peers: [], assignedHub: null };

      const hubs: Array<string | null> = [];
      layer.on('hub-assigned', (hubId) => hubs.push(hubId));

      await layer.start(testIdentity());

      // null → null = no change
      expect(hubs).toHaveLength(0);
    });

    it('excludes self from peer list', async () => {
      cloud.nextResponse = {
        peers: [
          fakePeer('test-node-1'), // same nodeId as identity
          fakePeer('peer-a'),
        ],
        assignedHub: null,
      };

      await layer.start(testIdentity());

      expect(layer.getPeers()).toHaveLength(1);
      expect(layer.getPeers()[0]!.nodeId).toBe('peer-a');
    });
  });

  // .........................................................................
  // Polling
  // .........................................................................

  describe('polling', () => {
    it('polls the cloud at the configured interval', async () => {
      vi.useFakeTimers();
      const fastLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 1000,
        },
        { createHttpClient: () => cloud },
      );

      await fastLayer.start(testIdentity());
      expect(cloud.pollCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(cloud.pollCalls).toHaveLength(1);
      expect(cloud.pollCalls[0]!.nodeId).toBe('test-node-1');
      expect(cloud.pollCalls[0]!.domain).toBe('test-domain');

      await vi.advanceTimersByTimeAsync(1000);
      expect(cloud.pollCalls).toHaveLength(2);

      await fastLayer.stop();
      vi.useRealTimers();
    });

    it('discovers new peers from poll response', async () => {
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );

      // Start with no peers
      cloud.nextResponse = { peers: [], assignedHub: null };
      await pollLayer.start(testIdentity());
      expect(pollLayer.getPeers()).toHaveLength(0);

      const discovered: NodeInfo[] = [];
      pollLayer.on('peer-discovered', (peer) => discovered.push(peer));

      // Next poll returns a new peer
      cloud.nextResponse = {
        peers: [fakePeer('new-peer')],
        assignedHub: null,
      };
      await vi.advanceTimersByTimeAsync(100);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.nodeId).toBe('new-peer');

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('removes peers no longer in cloud response', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: null,
      };
      await layer.start(testIdentity());
      expect(layer.getPeers()).toHaveLength(2);

      const lost: string[] = [];
      layer.on('peer-lost', (nodeId) => lost.push(nodeId));

      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: null,
      };
      await pollLayer.start(testIdentity());
      expect(pollLayer.getPeers()).toHaveLength(2);

      pollLayer.on('peer-lost', (nodeId) => lost.push(nodeId));

      // Next poll: peer-b disappears
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };
      await vi.advanceTimersByTimeAsync(100);

      expect(lost).toContain('peer-b');
      expect(pollLayer.getPeers()).toHaveLength(1);

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('updates hub assignment from poll', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      await pollLayer.start(testIdentity());

      const hubs: Array<string | null> = [];
      pollLayer.on('hub-assigned', (hubId) => hubs.push(hubId));

      // Cloud assigns hub on next poll
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: 'peer-a',
      };
      await vi.advanceTimersByTimeAsync(100);

      expect(hubs).toEqual(['peer-a']);
      expect(pollLayer.getAssignedHub()).toBe('peer-a');

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('survives poll failure gracefully', async () => {
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      await pollLayer.start(testIdentity());

      cloud.pollError = new Error('Network timeout');

      // Should not throw
      await vi.advanceTimersByTimeAsync(100);

      expect(pollLayer.isActive()).toBe(true);

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('uses default pollIntervalMs when not configured', async () => {
      vi.useFakeTimers();
      const defaultLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          // No pollIntervalMs → defaults to 30000
        },
        { createHttpClient: () => cloud },
      );
      await defaultLayer.start(testIdentity());

      await vi.advanceTimersByTimeAsync(29999);
      expect(cloud.pollCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(cloud.pollCalls).toHaveLength(1);

      await defaultLayer.stop();
      vi.useRealTimers();
    });
  });

  // .........................................................................
  // Probe reporting
  // .........................................................................

  describe('reportProbes', () => {
    it('reports probe results to the cloud', async () => {
      await layer.start(testIdentity());

      const probes: PeerProbe[] = [
        {
          nodeId: 'peer-a',
          address: '10.0.0.2:3001',
          reachable: true,
          latencyMs: 1.5,
          timestamp: Date.now(),
          probedBy: 'test-node-1',
        },
      ];

      await layer.reportProbes(probes);

      expect(cloud.reportCalls).toHaveLength(1);
      expect(cloud.reportCalls[0]!.nodeId).toBe('test-node-1');
      expect(cloud.reportCalls[0]!.probes).toEqual(probes);
      expect(cloud.reportCalls[0]!.apiKey).toBe('test-key');
    });

    it('survives report failure gracefully', async () => {
      await layer.start(testIdentity());
      cloud.reportError = new Error('Server error');

      // Should not throw
      await expect(layer.reportProbes([])).resolves.toBeUndefined();
    });
  });

  // .........................................................................
  // stop
  // .........................................................................

  describe('stop', () => {
    it('emits peer-lost for all peers on stop', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: 'peer-a',
      };
      await layer.start(testIdentity());

      const lost: string[] = [];
      layer.on('peer-lost', (nodeId) => lost.push(nodeId));

      await layer.stop();

      expect(lost).toContain('peer-a');
      expect(lost).toContain('peer-b');
    });

    it('clears all state on stop', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: 'peer-a',
      };
      await layer.start(testIdentity());

      await layer.stop();

      expect(layer.isActive()).toBe(false);
      expect(layer.getPeers()).toEqual([]);
      expect(layer.getAssignedHub()).toBeNull();
    });

    it('stops polling on stop', async () => {
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      await pollLayer.start(testIdentity());
      await pollLayer.stop();

      cloud.pollCalls = [];
      await vi.advanceTimersByTimeAsync(500);

      // No polls after stop
      expect(cloud.pollCalls).toHaveLength(0);

      vi.useRealTimers();
    });

    it('stop is safe when not started', async () => {
      const notStarted = new CloudLayer(
        { enabled: true, endpoint: 'https://cloud.example.com' },
        { createHttpClient: () => cloud },
      );
      await expect(notStarted.stop()).resolves.toBeUndefined();
    });
  });

  // .........................................................................
  // Events
  // .........................................................................

  describe('events', () => {
    it('on/off subscribe/unsubscribe', async () => {
      const discovered: NodeInfo[] = [];
      const cb = (peer: NodeInfo): void => {
        discovered.push(peer);
      };

      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };

      layer.on('peer-discovered', cb);
      await layer.start(testIdentity());

      expect(discovered).toHaveLength(1);

      layer.off('peer-discovered', cb);

      // Trigger another response via new start
      await layer.stop();
      cloud.nextResponse = {
        peers: [fakePeer('peer-b')],
        assignedHub: null,
      };
      await layer.start(testIdentity());

      // Should still be 1 — callback was unsubscribed
      expect(discovered).toHaveLength(1);
    });

    it('delivers to multiple listeners for the same event', async () => {
      const results: string[] = [];
      layer.on('peer-discovered', (p) => results.push(`A:${p.nodeId}`));
      layer.on('peer-discovered', (p) => results.push(`B:${p.nodeId}`));

      cloud.nextResponse = {
        peers: [fakePeer('peer-x')],
        assignedHub: null,
      };
      await layer.start(testIdentity());

      expect(results).toEqual(['A:peer-x', 'B:peer-x']);
    });
  });

  // .........................................................................
  // defaultCreateCloudHttpClient
  // .........................................................................

  describe('defaultCreateCloudHttpClient', () => {
    it('creates an HTTP client', () => {
      const client = defaultCreateCloudHttpClient();
      expect(client).toBeDefined();
      expect(typeof client.register).toBe('function');
      expect(typeof client.poll).toBe('function');
      expect(typeof client.reportProbes).toBe('function');
    });

    it('register calls fetch with correct args', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const info = testIdentity().toNodeInfo();
      await client.register('https://cloud.test', info, 'my-key');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cloud.test/register');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['Authorization']).toBe('Bearer my-key');
      expect(JSON.parse(opts.body as string)).toEqual(info);

      vi.unstubAllGlobals();
    });

    it('register throws on non-ok response', async () => {
      const client = defaultCreateCloudHttpClient();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      );

      await expect(
        client.register('https://cloud.test', testIdentity().toNodeInfo()),
      ).rejects.toThrow('Cloud register failed: 500');

      vi.unstubAllGlobals();
    });

    it('register works without apiKey', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.register('https://cloud.test', testIdentity().toNodeInfo());

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['Authorization']).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('poll calls fetch with correct args', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.poll('https://cloud.test', 'node-1', 'my-domain', 'key-1');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toContain('https://cloud.test/peers?');
      expect(url).toContain('nodeId=node-1');
      expect(url).toContain('domain=my-domain');
      expect(opts.method).toBe('GET');
      expect(opts.headers['Authorization']).toBe('Bearer key-1');

      vi.unstubAllGlobals();
    });

    it('poll throws on non-ok response', async () => {
      const client = defaultCreateCloudHttpClient();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 403 }),
      );

      await expect(
        client.poll('https://cloud.test', 'node-1', 'dom'),
      ).rejects.toThrow('Cloud poll failed: 403');

      vi.unstubAllGlobals();
    });

    it('poll works without apiKey', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.poll('https://cloud.test', 'node-1', 'dom');

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['Authorization']).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('reportProbes calls fetch with correct args', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const probes: PeerProbe[] = [
        {
          nodeId: 'peer-1',
          address: '10.0.0.2:3001',
          reachable: true,
          latencyMs: 2.0,
          timestamp: 1700000000000,
          probedBy: 'node-1',
        },
      ];

      await client.reportProbes(
        'https://cloud.test',
        'node-1',
        probes,
        'key-1',
      );

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cloud.test/probes');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer key-1');
      const body = JSON.parse(opts.body as string);
      expect(body.nodeId).toBe('node-1');
      expect(body.probes).toEqual(probes);

      vi.unstubAllGlobals();
    });

    it('reportProbes throws on non-ok response', async () => {
      const client = defaultCreateCloudHttpClient();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 502 }),
      );

      await expect(
        client.reportProbes('https://cloud.test', 'node-1', []),
      ).rejects.toThrow('Cloud reportProbes failed: 502');

      vi.unstubAllGlobals();
    });

    it('reportProbes works without apiKey', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await client.reportProbes('https://cloud.test', 'node-1', []);

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['Authorization']).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  // .........................................................................
  // Lifecycle hardening
  // .........................................................................

  describe('lifecycle hardening', () => {
    it('start is idempotent — calling twice does not create duplicate poll timers', async () => {
      vi.useFakeTimers();
      await layer.start(testIdentity());

      // Track poll calls
      let pollCount = 0;
      const originalPoll = cloud.poll.bind(cloud);
      cloud.poll = async (...args: Parameters<typeof cloud.poll>) => {
        pollCount++;
        return originalPoll(...args);
      };

      // Call start again — should be a no-op
      const secondResult = await layer.start(testIdentity());
      expect(secondResult).toBe(true);

      // Advance time — should only get polls from the FIRST timer
      await vi.advanceTimersByTimeAsync(60000);
      // If duplicate timers existed, pollCount would be ~2
      expect(pollCount).toBe(1);

      await layer.stop();
      vi.useRealTimers();
    });

    it('stop → start resets backoff state completely', async () => {
      vi.useFakeTimers();

      const restartLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 1000,
        },
        { createHttpClient: () => cloud },
      );

      await restartLayer.start(testIdentity());

      // Accumulate backoff
      cloud.pollError = new Error('down');
      await vi.advanceTimersByTimeAsync(100); // fail 1, interval→200
      await vi.advanceTimersByTimeAsync(200); // fail 2, interval→400
      expect(restartLayer.getConsecutivePollFailures()).toBe(2);
      expect(restartLayer.getCurrentPollIntervalMs()).toBe(400);

      // Stop — should reset
      await restartLayer.stop();
      expect(restartLayer.getConsecutivePollFailures()).toBe(0);
      expect(restartLayer.getCurrentPollIntervalMs()).toBe(100);

      // Start again — should work fresh
      cloud.pollError = null;
      await restartLayer.start(testIdentity());
      expect(restartLayer.isActive()).toBe(true);
      expect(restartLayer.getConsecutivePollFailures()).toBe(0);
      expect(restartLayer.getCurrentPollIntervalMs()).toBe(100);

      // Verify polling works at base interval
      await vi.advanceTimersByTimeAsync(100);
      expect(restartLayer.getConsecutivePollFailures()).toBe(0);

      await restartLayer.stop();
      vi.useRealTimers();
    });

    it('enforces minimum pollIntervalMs of 100', async () => {
      const minLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 0, // would cause tight loop without guard
        },
        { createHttpClient: () => cloud },
      );

      await minLayer.start(testIdentity());
      expect(minLayer.getCurrentPollIntervalMs()).toBe(100); // clamped
      await minLayer.stop();
    });

    it('enforces minimum maxBackoffMs of 100', async () => {
      vi.useFakeTimers();
      const minLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 0, // would disable backoff without guard
        },
        { createHttpClient: () => cloud },
      );

      await minLayer.start(testIdentity());

      cloud.pollError = new Error('down');
      await vi.advanceTimersByTimeAsync(100); // fail 1
      // Without min guard, interval would be min(200,0)=0 — tight loop
      // With guard, maxBackoffMs is 100, so interval is min(200,100)=100
      expect(minLayer.getCurrentPollIntervalMs()).toBe(100);

      await minLayer.stop();
      vi.useRealTimers();
    });

    it('enforces minimum reRegisterAfterFailures of 1', async () => {
      vi.useFakeTimers();
      const minLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 200,
          reRegisterAfterFailures: 0, // without guard, would re-register on every poll
        },
        { createHttpClient: () => cloud },
      );

      await minLayer.start(testIdentity());

      // First poll failure should NOT immediately re-register (threshold clamped to 1)
      cloud.pollError = new Error('down');
      cloud.registerCalls = [];
      await vi.advanceTimersByTimeAsync(100); // fail 1
      expect(minLayer.getConsecutivePollFailures()).toBe(1);

      // Now at threshold=1, next cycle DOES re-register
      cloud.pollError = null;
      cloud.registerCalls = [];
      await vi.advanceTimersByTimeAsync(200);
      expect(cloud.registerCalls).toHaveLength(1);
      expect(minLayer.getConsecutivePollFailures()).toBe(0);

      await minLayer.stop();
      vi.useRealTimers();
    });

    it('stop during active polling does not re-schedule', async () => {
      vi.useFakeTimers();

      const stopLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );

      await stopLayer.start(testIdentity());
      expect(stopLayer.isActive()).toBe(true);

      // Stop immediately
      await stopLayer.stop();
      expect(stopLayer.isActive()).toBe(false);

      // Advance time — no polls should fire
      let pollFired = false;
      const originalPoll = cloud.poll.bind(cloud);
      cloud.poll = async (...args: Parameters<typeof cloud.poll>) => {
        pollFired = true;
        return originalPoll(...args);
      };

      await vi.advanceTimersByTimeAsync(500);
      expect(pollFired).toBe(false);

      vi.useRealTimers();
    });

    it('survives a throwing listener without killing poll loop', async () => {
      vi.useFakeTimers();

      // Start with no peers — the peer will appear on the first scheduled poll
      cloud.nextResponse = { peers: [], assignedHub: null };

      const throwLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );

      // Listener that throws every time
      let throwCount = 0;
      throwLayer.on('peer-discovered', () => {
        throwCount++;
        throw new Error('Listener exploded!');
      });

      await throwLayer.start(testIdentity());
      expect(throwCount).toBe(0); // No peers during start

      // Add a peer before first scheduled poll
      cloud.nextResponse = {
        peers: [
          {
            nodeId: 'throw-peer',
            hostname: 'tp',
            localIps: ['10.0.0.1'],
            domain: 'test',
            port: 3000,
            startedAt: 1700000000000,
          },
        ],
        assignedHub: null,
      };

      // First scheduled poll triggers peer-discovered → listener throws
      // The .catch() in _schedulePoll should absorb it
      await vi.advanceTimersByTimeAsync(100);
      expect(throwCount).toBe(1);

      // Polling should continue despite the throw
      // Add another new peer so peer-discovered fires again
      cloud.nextResponse = {
        peers: [
          {
            nodeId: 'throw-peer',
            hostname: 'tp',
            localIps: ['10.0.0.1'],
            domain: 'test',
            port: 3000,
            startedAt: 1700000000000,
          },
          {
            nodeId: 'throw-peer-2',
            hostname: 'tp2',
            localIps: ['10.0.0.2'],
            domain: 'test',
            port: 3001,
            startedAt: 1700000000001,
          },
        ],
        assignedHub: null,
      };

      await vi.advanceTimersByTimeAsync(100);
      expect(throwCount).toBe(2); // Listener called again — poll loop survived

      await throwLayer.stop();
      vi.useRealTimers();
    });
  });

  // .........................................................................
  // Backoff and re-registration
  // .........................................................................

  describe('exponential backoff', () => {
    it('doubles poll interval after each consecutive failure', async () => {
      vi.useFakeTimers();
      const backoffLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 10000,
        },
        { createHttpClient: () => cloud },
      );

      await backoffLayer.start(testIdentity());
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(100);
      expect(backoffLayer.getConsecutivePollFailures()).toBe(0);

      // First failure → interval doubles to 200
      cloud.pollError = new Error('down');
      await vi.advanceTimersByTimeAsync(100);
      expect(backoffLayer.getConsecutivePollFailures()).toBe(1);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(200);

      // Second failure → interval doubles to 400
      await vi.advanceTimersByTimeAsync(200);
      expect(backoffLayer.getConsecutivePollFailures()).toBe(2);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(400);

      // Third failure → interval doubles to 800
      await vi.advanceTimersByTimeAsync(400);
      expect(backoffLayer.getConsecutivePollFailures()).toBe(3);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(800);

      await backoffLayer.stop();
      vi.useRealTimers();
    });

    it('caps backoff at maxBackoffMs', async () => {
      vi.useFakeTimers();
      const backoffLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 300, // low cap for fast test
        },
        { createHttpClient: () => cloud },
      );

      await backoffLayer.start(testIdentity());

      cloud.pollError = new Error('down');

      // 100 → 200
      await vi.advanceTimersByTimeAsync(100);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(200);

      // 200 → 300 (capped)
      await vi.advanceTimersByTimeAsync(200);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(300);

      // 300 → still 300 (capped)
      await vi.advanceTimersByTimeAsync(300);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(300);

      await backoffLayer.stop();
      vi.useRealTimers();
    });

    it('resets backoff on successful poll', async () => {
      vi.useFakeTimers();
      const backoffLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 10000,
        },
        { createHttpClient: () => cloud },
      );

      await backoffLayer.start(testIdentity());

      // Fail twice → interval 400
      cloud.pollError = new Error('down');
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      expect(backoffLayer.getConsecutivePollFailures()).toBe(2);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(400);

      // Success → interval reset to 100
      cloud.pollError = null;
      await vi.advanceTimersByTimeAsync(400);
      expect(backoffLayer.getConsecutivePollFailures()).toBe(0);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(100);

      await backoffLayer.stop();
      vi.useRealTimers();
    });

    it('uses default maxBackoffMs (300000) when not configured', async () => {
      const backoffLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );

      await backoffLayer.start(testIdentity());
      // Default maxBackoffMs is 300000 — we can't easily test the cap
      // without many iterations, but we can verify the initial state
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(100);

      await backoffLayer.stop();
    });

    it('stop resets backoff state', async () => {
      vi.useFakeTimers();
      const backoffLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 10000,
        },
        { createHttpClient: () => cloud },
      );

      await backoffLayer.start(testIdentity());

      // Accumulate some failures
      cloud.pollError = new Error('down');
      await vi.advanceTimersByTimeAsync(100);
      expect(backoffLayer.getConsecutivePollFailures()).toBe(1);

      await backoffLayer.stop();

      // After stop, backoff is reset
      expect(backoffLayer.getConsecutivePollFailures()).toBe(0);
      expect(backoffLayer.getCurrentPollIntervalMs()).toBe(100);

      vi.useRealTimers();
    });
  });

  describe('re-registration after prolonged failure', () => {
    it('attempts re-registration after reRegisterAfterFailures', async () => {
      vi.useFakeTimers();
      const reRegLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 200, // keep backoff small for fast test
          reRegisterAfterFailures: 3, // re-register after 3 failures
        },
        { createHttpClient: () => cloud },
      );

      await reRegLayer.start(testIdentity());

      cloud.pollError = new Error('down');

      // Fail 3 times to reach threshold
      await vi.advanceTimersByTimeAsync(100); // fail 1, interval→200
      await vi.advanceTimersByTimeAsync(200); // fail 2, interval→200 (capped)
      await vi.advanceTimersByTimeAsync(200); // fail 3, interval→200 (capped)

      expect(reRegLayer.getConsecutivePollFailures()).toBe(3);

      // Next cycle: re-registration (not poll)
      cloud.pollError = null;
      cloud.registerCalls = [];
      await vi.advanceTimersByTimeAsync(200);

      // Should have called register, not poll
      expect(cloud.registerCalls).toHaveLength(1);
      expect(reRegLayer.getConsecutivePollFailures()).toBe(0);
      expect(reRegLayer.getCurrentPollIntervalMs()).toBe(100); // reset

      await reRegLayer.stop();
      vi.useRealTimers();
    });

    it('continues backoff if re-registration also fails', async () => {
      vi.useFakeTimers();
      const reRegLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 1000,
          reRegisterAfterFailures: 2, // re-register after 2 failures
        },
        { createHttpClient: () => cloud },
      );

      await reRegLayer.start(testIdentity());

      // Fail polls to reach threshold
      cloud.pollError = new Error('down');
      await vi.advanceTimersByTimeAsync(100); // fail 1, interval=200
      await vi.advanceTimersByTimeAsync(200); // fail 2, interval=400

      expect(reRegLayer.getConsecutivePollFailures()).toBe(2);

      // Re-registration also fails
      cloud.registerError = new Error('still down');
      await vi.advanceTimersByTimeAsync(400);

      // Failure count increased, backoff continued
      expect(reRegLayer.getConsecutivePollFailures()).toBe(3);
      expect(reRegLayer.getCurrentPollIntervalMs()).toBe(800);

      await reRegLayer.stop();
      vi.useRealTimers();
    });

    it('defaults to reRegisterAfterFailures=10', async () => {
      vi.useFakeTimers();
      const defaultLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
          maxBackoffMs: 200,
        },
        { createHttpClient: () => cloud },
      );

      await defaultLayer.start(testIdentity());
      const initialRegisterCount = cloud.registerCalls.length;

      cloud.pollError = new Error('down');

      // Fail 9 times — should NOT re-register yet (all at maxBackoff=200)
      for (let i = 0; i < 9; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }
      expect(defaultLayer.getConsecutivePollFailures()).toBe(9);
      expect(cloud.registerCalls.length).toBe(initialRegisterCount);

      // Fail 10th time — threshold reached, next will re-register
      await vi.advanceTimersByTimeAsync(200);
      expect(defaultLayer.getConsecutivePollFailures()).toBe(10);

      // Next cycle triggers re-registration
      cloud.pollError = null;
      cloud.registerCalls = [];
      await vi.advanceTimersByTimeAsync(200);
      expect(cloud.registerCalls).toHaveLength(1);

      await defaultLayer.stop();
      vi.useRealTimers();
    });
  });
});
