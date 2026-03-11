// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, afterEach } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  CloudLayer,
  defaultCreateCloudHttpClient,
  type CloudPeerListResponse,
} from '../../src/layers/cloud-layer.ts';
import { NodeIdentity } from '../../src/identity/node-identity.ts';
import type { NodeInfo } from '../../src/types/node-info.ts';
import type { PeerProbe } from '../../src/types/peer-probe.ts';

// .............................................................................

/**
 * CloudLayer localhost tests — real HTTP server via node:http.
 *
 * These tests run a real HTTP server on 127.0.0.1 and exercise the full
 * stack: `defaultCreateCloudHttpClient()` → real `fetch()` → real server.
 *
 * This validates:
 * - Real HTTP request/response cycle
 * - JSON serialization/deserialization
 * - Header handling (Content-Type, Authorization)
 * - URL construction (query params for poll)
 * - Error status handling
 * - Full CloudLayer lifecycle against a real endpoint
 */

// .............................................................................

/** Create a minimal NodeIdentity for testing */
function testIdentity(overrides?: Partial<NodeInfo>): NodeIdentity {
  return new NodeIdentity({
    nodeId: 'localhost-test-node',
    hostname: 'test-host',
    localIps: ['127.0.0.1'],
    domain: 'test-domain',
    port: 3000,
    startedAt: 1700000000000,
    ...overrides,
  });
}

/** Parse request body as JSON */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

// .............................................................................

/**
 * Minimal in-process cloud service.
 *
 * Implements POST /register, GET /peers, POST /probes on a real HTTP
 * server bound to 127.0.0.1:0 (OS-assigned port).
 */
class LocalCloudServer {
  private _server: ReturnType<typeof createServer> | null = null;
  private _port = 0;

  /** Registered nodes */
  registeredNodes: NodeInfo[] = [];

  /** Probes reported by clients */
  reportedProbes: Array<{ nodeId: string; probes: PeerProbe[] }> = [];

  /** Hub to assign (null = no hub yet) */
  assignedHub: string | null = null;

  /** If true, /register returns 500 */
  failRegister = false;

  /** If true, /peers returns 500 */
  failPoll = false;

  /** If true, /probes returns 500 */
  failProbes = false;

  /** The API key the server expects (null = no auth) */
  expectedApiKey: string | null = null;

  /** Last Authorization header received */
  lastAuthHeader: string | null = null;

  /** Endpoint URL */
  get endpoint(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  /** Start the server on a random port */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this._server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          void this._handleRequest(req, res);
        },
      );
      this._server.listen(0, '127.0.0.1', () => {
        const addr = this._server!.address();
        this._port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });
  }

  /** Stop the server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Build the response peers list (all registered nodes except requester) */
  private _peersFor(excludeNodeId?: string): NodeInfo[] {
    return this.registeredNodes.filter((n) => n.nodeId !== excludeNodeId);
  }

  /** Handle incoming HTTP requests */
  private async _handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.lastAuthHeader = (req.headers['authorization'] as string) ?? null;

    // Check API key if configured
    if (this.expectedApiKey) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${this.expectedApiKey}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // POST /register
    if (req.method === 'POST' && url.pathname === '/register') {
      if (this.failRegister) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }

      const body = await readBody(req);
      const info = JSON.parse(body) as NodeInfo;
      // Upsert by nodeId
      const idx = this.registeredNodes.findIndex(
        (n) => n.nodeId === info.nodeId,
      );
      if (idx >= 0) {
        this.registeredNodes[idx] = info;
      } else {
        this.registeredNodes.push(info);
      }

      const response: CloudPeerListResponse = {
        peers: this._peersFor(info.nodeId),
        assignedHub: this.assignedHub,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    // GET /peers?nodeId=...&domain=...
    if (req.method === 'GET' && url.pathname === '/peers') {
      if (this.failPoll) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }

      const nodeId = url.searchParams.get('nodeId') ?? '';
      const response: CloudPeerListResponse = {
        peers: this._peersFor(nodeId),
        assignedHub: this.assignedHub,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    // POST /probes
    if (req.method === 'POST' && url.pathname === '/probes') {
      if (this.failProbes) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }

      const body = await readBody(req);
      const data = JSON.parse(body) as {
        nodeId: string;
        probes: PeerProbe[];
      };
      this.reportedProbes.push(data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Unknown route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
}

// .............................................................................

describe('CloudLayer localhost — real HTTP', () => {
  let server: LocalCloudServer;
  let layer: CloudLayer | null = null;

  afterEach(async () => {
    if (layer) {
      await layer.stop();
      layer = null;
    }
    if (server) {
      await server.stop();
    }
  });

  // .........................................................................
  // defaultCreateCloudHttpClient — real fetch
  // .........................................................................

  describe('defaultCreateCloudHttpClient with real server', () => {
    it('register sends POST and receives peers', async () => {
      server = new LocalCloudServer();
      await server.start();

      // Pre-register a peer so the response contains it
      const existingPeer: NodeInfo = {
        nodeId: 'peer-1',
        hostname: 'host-1',
        localIps: ['10.0.0.2'],
        domain: 'test-domain',
        port: 3001,
        startedAt: 1700000001000,
      };
      server.registeredNodes.push(existingPeer);

      const client = defaultCreateCloudHttpClient();
      const info = testIdentity().toNodeInfo();
      const response = await client.register(server.endpoint, info);

      // Should receive the pre-existing peer
      expect(response.peers).toHaveLength(1);
      expect(response.peers[0]!.nodeId).toBe('peer-1');
      expect(response.assignedHub).toBeNull();

      // Server should have registered our node
      expect(server.registeredNodes).toHaveLength(2);
      expect(server.registeredNodes[1]!.nodeId).toBe('localhost-test-node');
    });

    it('poll sends GET with query params and receives peers', async () => {
      server = new LocalCloudServer();
      await server.start();

      // Register two nodes
      server.registeredNodes.push(
        {
          nodeId: 'node-a',
          hostname: 'a',
          localIps: ['10.0.0.1'],
          domain: 'test-domain',
          port: 3000,
          startedAt: 1700000000000,
        },
        {
          nodeId: 'node-b',
          hostname: 'b',
          localIps: ['10.0.0.2'],
          domain: 'test-domain',
          port: 3001,
          startedAt: 1700000001000,
        },
      );
      server.assignedHub = 'node-a';

      const client = defaultCreateCloudHttpClient();
      const response = await client.poll(
        server.endpoint,
        'node-a',
        'test-domain',
      );

      // Should get node-b (excludes self 'node-a')
      expect(response.peers).toHaveLength(1);
      expect(response.peers[0]!.nodeId).toBe('node-b');
      expect(response.assignedHub).toBe('node-a');
    });

    it('reportProbes sends POST with probe data', async () => {
      server = new LocalCloudServer();
      await server.start();

      const probes: PeerProbe[] = [
        {
          fromNodeId: 'node-a',
          toNodeId: 'node-b',
          reachable: true,
          latencyMs: 2.5,
          measuredAt: Date.now(),
        },
      ];

      const client = defaultCreateCloudHttpClient();
      await client.reportProbes(server.endpoint, 'node-a', probes);

      expect(server.reportedProbes).toHaveLength(1);
      expect(server.reportedProbes[0]!.nodeId).toBe('node-a');
      expect(server.reportedProbes[0]!.probes).toHaveLength(1);
      expect(server.reportedProbes[0]!.probes[0]!.reachable).toBe(true);
    });

    it('sends Authorization header when apiKey provided', async () => {
      server = new LocalCloudServer();
      server.expectedApiKey = 'secret-key';
      await server.start();

      const client = defaultCreateCloudHttpClient();
      const info = testIdentity().toNodeInfo();

      await client.register(server.endpoint, info, 'secret-key');
      expect(server.lastAuthHeader).toBe('Bearer secret-key');
    });

    it('register throws on server error', async () => {
      server = new LocalCloudServer();
      server.failRegister = true;
      await server.start();

      const client = defaultCreateCloudHttpClient();
      const info = testIdentity().toNodeInfo();

      await expect(client.register(server.endpoint, info)).rejects.toThrow(
        'Cloud register failed: 500',
      );
    });

    it('poll throws on server error', async () => {
      server = new LocalCloudServer();
      server.failPoll = true;
      await server.start();

      const client = defaultCreateCloudHttpClient();

      await expect(
        client.poll(server.endpoint, 'node-a', 'test-domain'),
      ).rejects.toThrow('Cloud poll failed: 500');
    });

    it('reportProbes throws on server error', async () => {
      server = new LocalCloudServer();
      server.failProbes = true;
      await server.start();

      const client = defaultCreateCloudHttpClient();

      await expect(
        client.reportProbes(server.endpoint, 'node-a', []),
      ).rejects.toThrow('Cloud reportProbes failed: 500');
    });

    it('register throws on auth failure', async () => {
      server = new LocalCloudServer();
      server.expectedApiKey = 'correct-key';
      await server.start();

      const client = defaultCreateCloudHttpClient();
      const info = testIdentity().toNodeInfo();

      // Send wrong key
      await expect(
        client.register(server.endpoint, info, 'wrong-key'),
      ).rejects.toThrow('Cloud register failed: 401');
    });
  });

  // .........................................................................
  // Full CloudLayer lifecycle — real HTTP
  // .........................................................................

  describe('full CloudLayer lifecycle with real server', () => {
    it('registers with server and discovers peers on start', async () => {
      server = new LocalCloudServer();
      await server.start();

      // Pre-register a peer
      server.registeredNodes.push({
        nodeId: 'existing-peer',
        hostname: 'peer-host',
        localIps: ['10.0.0.5'],
        domain: 'test-domain',
        port: 3005,
        startedAt: 1700000005000,
      });

      const discovered: NodeInfo[] = [];
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999, // no auto-poll
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      layer.on('peer-discovered', (peer) => discovered.push(peer));

      const started = await layer.start(testIdentity());

      expect(started).toBe(true);
      expect(layer.isActive()).toBe(true);
      expect(layer.getPeers()).toHaveLength(1);
      expect(layer.getPeers()[0]!.nodeId).toBe('existing-peer');
      expect(discovered).toHaveLength(1);
    });

    it('receives hub assignment from server', async () => {
      server = new LocalCloudServer();
      server.assignedHub = 'the-hub';
      await server.start();

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      await layer.start(testIdentity());

      expect(layer.getAssignedHub()).toBe('the-hub');
    });

    it('fails to start when server is unreachable', async () => {
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'http://127.0.0.1:1', // nothing listening
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      const started = await layer.start(testIdentity());

      expect(started).toBe(false);
      expect(layer.isActive()).toBe(false);
    });

    it('fails to start when server returns 500', async () => {
      server = new LocalCloudServer();
      server.failRegister = true;
      await server.start();

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      const started = await layer.start(testIdentity());

      expect(started).toBe(false);
      expect(layer.isActive()).toBe(false);
    });

    it('reports probes to real server', async () => {
      server = new LocalCloudServer();
      await server.start();

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      await layer.start(testIdentity());

      const probes: PeerProbe[] = [
        {
          fromNodeId: 'localhost-test-node',
          toNodeId: 'some-peer',
          reachable: true,
          latencyMs: 5.0,
          measuredAt: Date.now(),
        },
      ];
      await layer.reportProbes(probes);

      expect(server.reportedProbes).toHaveLength(1);
      expect(server.reportedProbes[0]!.nodeId).toBe('localhost-test-node');
    });

    it('stop emits peer-lost and cleans up', async () => {
      server = new LocalCloudServer();
      await server.start();

      server.registeredNodes.push({
        nodeId: 'temp-peer',
        hostname: 'h',
        localIps: ['10.0.0.3'],
        domain: 'test-domain',
        port: 3003,
        startedAt: 1700000003000,
      });

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      await layer.start(testIdentity());
      expect(layer.getPeers()).toHaveLength(1);

      const lostIds: string[] = [];
      layer.on('peer-lost', (id) => lostIds.push(id));

      await layer.stop();

      expect(lostIds).toEqual(['temp-peer']);
      expect(layer.isActive()).toBe(false);
      expect(layer.getPeers()).toHaveLength(0);
    });

    it('full multi-node scenario with hub election', async () => {
      server = new LocalCloudServer();
      await server.start();

      // Node A starts — no peers yet
      const layerA = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      const identityA = testIdentity({ nodeId: 'node-A' });
      await layerA.start(identityA);
      expect(layerA.getPeers()).toHaveLength(0); // alone in the cloud

      // Node B starts — should see node A
      const layerB = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      const identityB = testIdentity({ nodeId: 'node-B' });
      await layerB.start(identityB);
      expect(layerB.getPeers()).toHaveLength(1);
      expect(layerB.getPeers()[0]!.nodeId).toBe('node-A');

      // Cloud assigns hub
      server.assignedHub = 'node-A';

      // Node C polls — should see A and B, with hub assigned
      const layerC = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      const identityC = testIdentity({ nodeId: 'node-C' });
      await layerC.start(identityC);
      expect(layerC.getPeers()).toHaveLength(2); // A and B
      expect(layerC.getAssignedHub()).toBe('node-A');

      // Cleanup
      await layerA.stop();
      await layerB.stop();
      await layerC.stop();
      layer = null; // prevent afterEach double-stop
    });
  });

  // .........................................................................
  // Dynamic lifecycle — polling, reconnect, rejoin
  // .........................................................................

  describe('dynamic lifecycle with real polling', () => {
    /** Wait for at least one poll cycle to complete */
    const waitForPoll = (ms = 120) => new Promise((r) => setTimeout(r, ms));

    it('poll discovers a peer that joins after startup', async () => {
      server = new LocalCloudServer();
      await server.start();

      const discovered: NodeInfo[] = [];
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('peer-discovered', (peer) => discovered.push(peer));

      await layer.start(testIdentity({ nodeId: 'watcher' }));
      expect(layer.getPeers()).toHaveLength(0);

      // A new node registers with the cloud server AFTER we started
      server.registeredNodes.push({
        nodeId: 'late-joiner',
        hostname: 'late',
        localIps: ['10.0.0.99'],
        domain: 'test-domain',
        port: 4000,
        startedAt: 1700000099000,
      });

      await waitForPoll();

      expect(layer.getPeers()).toHaveLength(1);
      expect(layer.getPeers()[0]!.nodeId).toBe('late-joiner');
      expect(discovered.some((p) => p.nodeId === 'late-joiner')).toBe(true);
    });

    it('poll detects peer departure', async () => {
      server = new LocalCloudServer();
      await server.start();

      // Pre-register a peer
      server.registeredNodes.push({
        nodeId: 'leaving-peer',
        hostname: 'lp',
        localIps: ['10.0.0.10'],
        domain: 'test-domain',
        port: 5000,
        startedAt: 1700000010000,
      });

      const lost: string[] = [];
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('peer-lost', (id) => lost.push(id));

      await layer.start(testIdentity({ nodeId: 'observer' }));
      expect(layer.getPeers()).toHaveLength(1);

      // The peer disappears from the cloud
      server.registeredNodes = server.registeredNodes.filter(
        (n) => n.nodeId !== 'leaving-peer',
      );

      await waitForPoll();

      expect(layer.getPeers()).toHaveLength(0);
      expect(lost).toContain('leaving-peer');
    });

    it('poll detects hub reassignment', async () => {
      server = new LocalCloudServer();
      server.assignedHub = 'old-hub';
      await server.start();

      const hubEvents: Array<string | null> = [];
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('hub-assigned', (hubId) => hubEvents.push(hubId));

      await layer.start(testIdentity());
      expect(layer.getAssignedHub()).toBe('old-hub');

      // Cloud changes hub
      server.assignedHub = 'new-hub';

      await waitForPoll();

      expect(layer.getAssignedHub()).toBe('new-hub');
      // Events: initial 'old-hub' + change to 'new-hub'
      expect(hubEvents).toContain('old-hub');
      expect(hubEvents).toContain('new-hub');
    });

    it('poll detects hub removal (hub → null)', async () => {
      server = new LocalCloudServer();
      server.assignedHub = 'temp-hub';
      await server.start();

      const hubEvents: Array<string | null> = [];
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('hub-assigned', (hubId) => hubEvents.push(hubId));

      await layer.start(testIdentity());
      expect(layer.getAssignedHub()).toBe('temp-hub');

      // Cloud removes hub assignment
      server.assignedHub = null;

      await waitForPoll();

      expect(layer.getAssignedHub()).toBeNull();
      expect(hubEvents).toContain(null);
    });

    it('layer survives cloud outage during polling', async () => {
      server = new LocalCloudServer();
      await server.start();

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      await layer.start(testIdentity());
      expect(layer.isActive()).toBe(true);

      // Cloud goes down
      server.failPoll = true;

      await waitForPoll();

      // Layer stays active — does not crash or deactivate
      expect(layer.isActive()).toBe(true);
    });

    it('layer recovers when cloud comes back after outage', async () => {
      server = new LocalCloudServer();
      await server.start();

      const discovered: NodeInfo[] = [];
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 100,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('peer-discovered', (peer) => discovered.push(peer));

      await layer.start(testIdentity({ nodeId: 'resilient' }));

      // Cloud goes down
      server.failPoll = true;
      await waitForPoll(150);

      // Cloud comes back with a new peer
      server.failPoll = false;
      server.registeredNodes.push({
        nodeId: 'recovered-peer',
        hostname: 'rp',
        localIps: ['10.0.0.50'],
        domain: 'test-domain',
        port: 6000,
        startedAt: 1700000050000,
      });

      // After one failure, backoff doubles to 200ms — wait long enough
      await waitForPoll(300);

      // Should have discovered the new peer after recovery
      expect(layer.getPeers()).toHaveLength(1);
      expect(discovered.some((p) => p.nodeId === 'recovered-peer')).toBe(true);
    });

    it('node can rejoin after stop + restart', async () => {
      server = new LocalCloudServer();
      await server.start();

      // Pre-register a peer
      server.registeredNodes.push({
        nodeId: 'persistent-peer',
        hostname: 'pp',
        localIps: ['10.0.0.20'],
        domain: 'test-domain',
        port: 7000,
        startedAt: 1700000020000,
      });

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 999999,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );

      // First join
      await layer.start(testIdentity({ nodeId: 'rejoiner' }));
      expect(layer.getPeers()).toHaveLength(1);
      expect(layer.isActive()).toBe(true);

      // Leave
      await layer.stop();
      expect(layer.isActive()).toBe(false);
      expect(layer.getPeers()).toHaveLength(0);

      // Rejoin — a new peer appeared while we were away
      server.registeredNodes.push({
        nodeId: 'new-while-away',
        hostname: 'nwa',
        localIps: ['10.0.0.30'],
        domain: 'test-domain',
        port: 7001,
        startedAt: 1700000030000,
      });

      await layer.start(testIdentity({ nodeId: 'rejoiner' }));
      expect(layer.isActive()).toBe(true);
      // Should see both the persistent peer and the one added while away
      expect(layer.getPeers()).toHaveLength(2);
      const peerIds = layer.getPeers().map((p) => p.nodeId);
      expect(peerIds).toContain('persistent-peer');
      expect(peerIds).toContain('new-while-away');
    });

    it('multiple peers join and leave across poll cycles', async () => {
      server = new LocalCloudServer();
      await server.start();

      const discovered: string[] = [];
      const lost: string[] = [];
      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('peer-discovered', (p) => discovered.push(p.nodeId));
      layer.on('peer-lost', (id) => lost.push(id));

      await layer.start(testIdentity({ nodeId: 'tracker' }));

      // Cycle 1: two peers join
      server.registeredNodes.push(
        {
          nodeId: 'peer-X',
          hostname: 'x',
          localIps: ['10.0.0.1'],
          domain: 'test-domain',
          port: 8001,
          startedAt: 1700000001000,
        },
        {
          nodeId: 'peer-Y',
          hostname: 'y',
          localIps: ['10.0.0.2'],
          domain: 'test-domain',
          port: 8002,
          startedAt: 1700000002000,
        },
      );

      await waitForPoll();
      expect(layer.getPeers()).toHaveLength(2);
      expect(discovered).toContain('peer-X');
      expect(discovered).toContain('peer-Y');

      // Cycle 2: peer-X leaves, peer-Z joins
      server.registeredNodes = server.registeredNodes.filter(
        (n) => n.nodeId !== 'peer-X',
      );
      server.registeredNodes.push({
        nodeId: 'peer-Z',
        hostname: 'z',
        localIps: ['10.0.0.3'],
        domain: 'test-domain',
        port: 8003,
        startedAt: 1700000003000,
      });

      await waitForPoll();
      expect(layer.getPeers()).toHaveLength(2); // Y + Z
      expect(lost).toContain('peer-X');
      expect(discovered).toContain('peer-Z');

      const finalIds = layer.getPeers().map((p) => p.nodeId);
      expect(finalIds).toContain('peer-Y');
      expect(finalIds).toContain('peer-Z');
      expect(finalIds).not.toContain('peer-X');
    });

    it('off() stops delivering events', async () => {
      server = new LocalCloudServer();
      await server.start();

      const discovered: string[] = [];
      const handler = (peer: NodeInfo) => discovered.push(peer.nodeId);

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('peer-discovered', handler);

      await layer.start(testIdentity({ nodeId: 'unsub-test' }));

      // First peer arrives — handler fires
      server.registeredNodes.push({
        nodeId: 'seen-peer',
        hostname: 's',
        localIps: ['10.0.0.1'],
        domain: 'test-domain',
        port: 9001,
        startedAt: 1700000001000,
      });

      await waitForPoll();
      expect(discovered).toContain('seen-peer');

      // Unsubscribe
      layer.off('peer-discovered', handler);

      // Second peer arrives — handler must NOT fire
      server.registeredNodes.push({
        nodeId: 'unseen-peer',
        hostname: 'u',
        localIps: ['10.0.0.2'],
        domain: 'test-domain',
        port: 9002,
        startedAt: 1700000002000,
      });

      await waitForPoll();

      // Layer sees the peer internally, but handler wasn't called
      expect(layer.getPeers()).toHaveLength(2);
      expect(discovered).not.toContain('unseen-peer');
    });
  });

  // .........................................................................
  // Complete lifecycle — single node, birth to death to rebirth
  // .........................................................................

  describe('complete node lifecycle (end-to-end)', () => {
    const waitForPoll = (ms = 120) => new Promise((r) => setTimeout(r, ms));

    it('walks a node through its entire journey', async () => {
      server = new LocalCloudServer();
      await server.start();

      const discovered: string[] = [];
      const lost: string[] = [];
      const hubEvents: Array<string | null> = [];

      layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 50,
        },
        { createHttpClient: defaultCreateCloudHttpClient },
      );
      layer.on('peer-discovered', (p) => discovered.push(p.nodeId));
      layer.on('peer-lost', (id) => lost.push(id));
      layer.on('hub-assigned', (h) => hubEvents.push(h));

      // ── Phase 1: Boot ─────────────────────────────────────────────
      // Node registers, cloud is empty → no peers, no hub
      const started = await layer.start(
        testIdentity({ nodeId: 'lifecycle-node' }),
      );
      expect(started).toBe(true);
      expect(layer.isActive()).toBe(true);
      expect(layer.getPeers()).toHaveLength(0);
      expect(layer.getAssignedHub()).toBeNull();

      // ── Phase 2: Peers join ───────────────────────────────────────
      // Two peers appear in the cloud
      server.registeredNodes.push(
        {
          nodeId: 'peer-alpha',
          hostname: 'alpha',
          localIps: ['10.0.0.1'],
          domain: 'test-domain',
          port: 4001,
          startedAt: 1700000001000,
        },
        {
          nodeId: 'peer-beta',
          hostname: 'beta',
          localIps: ['10.0.0.2'],
          domain: 'test-domain',
          port: 4002,
          startedAt: 1700000002000,
        },
      );

      await waitForPoll();

      expect(layer.getPeers()).toHaveLength(2);
      expect(discovered).toContain('peer-alpha');
      expect(discovered).toContain('peer-beta');

      // ── Phase 3: Hub assigned ─────────────────────────────────────
      server.assignedHub = 'peer-alpha';

      await waitForPoll();

      expect(layer.getAssignedHub()).toBe('peer-alpha');
      expect(hubEvents).toContain('peer-alpha');

      // ── Phase 4: Report probes ────────────────────────────────────
      const probes: PeerProbe[] = [
        {
          fromNodeId: 'lifecycle-node',
          toNodeId: 'peer-alpha',
          reachable: true,
          latencyMs: 1.5,
          measuredAt: Date.now(),
        },
        {
          fromNodeId: 'lifecycle-node',
          toNodeId: 'peer-beta',
          reachable: true,
          latencyMs: 3.0,
          measuredAt: Date.now(),
        },
      ];
      await layer.reportProbes(probes);

      expect(server.reportedProbes).toHaveLength(1);
      expect(server.reportedProbes[0]!.probes).toHaveLength(2);

      // ── Phase 5: Peer leaves, hub changes ─────────────────────────
      server.registeredNodes = server.registeredNodes.filter(
        (n) => n.nodeId !== 'peer-alpha',
      );
      server.assignedHub = 'peer-beta';

      await waitForPoll();

      expect(layer.getPeers()).toHaveLength(1);
      expect(lost).toContain('peer-alpha');
      expect(layer.getAssignedHub()).toBe('peer-beta');
      expect(hubEvents).toContain('peer-beta');

      // ── Phase 6: Cloud outage ─────────────────────────────────────
      server.failPoll = true;

      await waitForPoll(200);

      // Layer stays active, keeps last known state
      expect(layer.isActive()).toBe(true);
      expect(layer.getPeers()).toHaveLength(1);
      expect(layer.getAssignedHub()).toBe('peer-beta');

      // ── Phase 7: Cloud recovery — new peer appeared during outage ─
      // After the outage, backoff doubled the poll interval (50 → 100ms),
      // so we wait longer to ensure the backed-off poll fires.
      server.failPoll = false;
      server.registeredNodes.push({
        nodeId: 'peer-gamma',
        hostname: 'gamma',
        localIps: ['10.0.0.3'],
        domain: 'test-domain',
        port: 4003,
        startedAt: 1700000003000,
      });

      await waitForPoll(250);

      expect(layer.getPeers()).toHaveLength(2);
      expect(discovered).toContain('peer-gamma');

      // ── Phase 8: Shutdown ─────────────────────────────────────────
      const lostDuringStop: string[] = [];
      layer.on('peer-lost', (id) => lostDuringStop.push(id));

      await layer.stop();

      expect(layer.isActive()).toBe(false);
      expect(layer.getPeers()).toHaveLength(0);
      expect(layer.getAssignedHub()).toBeNull();
      // peer-lost emitted for every known peer
      expect(lostDuringStop).toContain('peer-beta');
      expect(lostDuringStop).toContain('peer-gamma');

      // ── Phase 9: Rejoin — world changed while offline ─────────────
      // peer-beta left, peer-delta appeared, hub changed
      server.registeredNodes = server.registeredNodes.filter(
        (n) => n.nodeId !== 'peer-beta',
      );
      server.registeredNodes.push({
        nodeId: 'peer-delta',
        hostname: 'delta',
        localIps: ['10.0.0.4'],
        domain: 'test-domain',
        port: 4004,
        startedAt: 1700000004000,
      });
      server.assignedHub = 'peer-delta';

      // Re-register event trackers (stop() cleared listeners)
      const rejoinDiscovered: string[] = [];
      const rejoinHubs: Array<string | null> = [];
      layer.on('peer-discovered', (p) => rejoinDiscovered.push(p.nodeId));
      layer.on('hub-assigned', (h) => rejoinHubs.push(h));

      const restarted = await layer.start(
        testIdentity({ nodeId: 'lifecycle-node' }),
      );

      expect(restarted).toBe(true);
      expect(layer.isActive()).toBe(true);
      // Should see gamma + delta (not beta, not self)
      expect(layer.getPeers()).toHaveLength(2);
      const rejoinPeerIds = layer.getPeers().map((p) => p.nodeId);
      expect(rejoinPeerIds).toContain('peer-gamma');
      expect(rejoinPeerIds).toContain('peer-delta');
      expect(rejoinPeerIds).not.toContain('peer-beta');
      expect(layer.getAssignedHub()).toBe('peer-delta');
      expect(rejoinDiscovered).toContain('peer-gamma');
      expect(rejoinDiscovered).toContain('peer-delta');
      expect(rejoinHubs).toContain('peer-delta');
    });
  });

  // .........................................................................
  // Backoff integration (real HTTP)
  // .........................................................................

  describe('backoff with real HTTP server', () => {
    it('increases poll interval on server failure, resets on recovery', async () => {
      const server = new LocalCloudServer();
      await server.start();

      const basePoll = 100;
      const layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: basePoll,
          maxBackoffMs: 800,
        },
        { createHttpClient: () => defaultCreateCloudHttpClient() },
      );

      // Start and register a peer
      server.registeredNodes.push({
        nodeId: 'backoff-peer',
        hostname: 'bp-host',
        localIps: ['127.0.0.1'],
        domain: 'test-domain',
        port: 4001,
        startedAt: 1700000000000,
      });

      await layer.start(testIdentity({ nodeId: 'backoff-node' }));
      expect(layer.getCurrentPollIntervalMs()).toBe(basePoll);

      // Wait for a successful poll
      const waitForPoll = (ms: number = 150): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      await waitForPoll(150);
      expect(layer.getConsecutivePollFailures()).toBe(0);
      expect(layer.getPeers()).toHaveLength(1);

      // Server goes down → failures accumulate, interval grows
      server.failPoll = true;
      await waitForPoll(350); // enough for ~1-2 poll failures at 100ms base
      expect(layer.getConsecutivePollFailures()).toBeGreaterThan(0);
      expect(layer.getCurrentPollIntervalMs()).toBeGreaterThan(basePoll);

      const backedOffInterval = layer.getCurrentPollIntervalMs();

      // Server recovers → interval resets
      server.failPoll = false;
      await waitForPoll(backedOffInterval + 150);
      expect(layer.getConsecutivePollFailures()).toBe(0);
      expect(layer.getCurrentPollIntervalMs()).toBe(basePoll);

      await layer.stop();
      await server.stop();
    });

    it('caps backoff at maxBackoffMs with real server', async () => {
      const server = new LocalCloudServer();
      await server.start();

      const layer = new CloudLayer(
        {
          enabled: true,
          endpoint: server.endpoint,
          pollIntervalMs: 100,
          maxBackoffMs: 200,
        },
        { createHttpClient: () => defaultCreateCloudHttpClient() },
      );

      await layer.start(testIdentity({ nodeId: 'cap-node' }));

      // Let it do one successful poll first
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Fail many times to hit the cap
      server.failPoll = true;
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Interval should be capped at 200, not growing beyond
      expect(layer.getCurrentPollIntervalMs()).toBeLessThanOrEqual(200);
      expect(layer.getConsecutivePollFailures()).toBeGreaterThan(0);

      await layer.stop();
      await server.stop();
    });
  });
});
