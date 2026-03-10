// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  hostname as osHostname,
  homedir as osHomedir,
  networkInterfaces,
} from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { randomUUID as cryptoRandomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

import type { NodeInfo } from '../types/node-info.ts';

// .............................................................................

/**
 * Parse IPv4 non-internal addresses from network interface data.
 * @param interfaces - OS network interface data (from os.networkInterfaces())
 */
export function parseLocalIps(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  const ips: string[] = [];
  for (const infos of Object.values(interfaces)) {
    /* v8 ignore if -- @preserve */
    if (!infos) continue;
    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

// .............................................................................

/** Injectable dependencies for NodeIdentity (testing) */
export interface NodeIdentityDeps {
  readNodeId: (filePath: string) => Promise<string | null>;
  writeNodeId: (filePath: string, nodeId: string) => Promise<void>;
  hostname: () => string;
  localIps: () => string[];
  randomUUID: () => string;
  now: () => number;
  homedir: () => string;
}

/** Default deps using real Node.js APIs */
export function defaultNodeIdentityDeps(): NodeIdentityDeps {
  return {
    readNodeId: async (filePath: string): Promise<string | null> => {
      try {
        return (await readFile(filePath, 'utf-8')).trim();
      } catch {
        return null;
      }
    },
    writeNodeId: async (filePath: string, nodeId: string): Promise<void> => {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, nodeId, 'utf-8');
    },
    hostname: () => osHostname(),
    localIps: () => parseLocalIps(networkInterfaces()),
    randomUUID: () => cryptoRandomUUID(),
    now: () => Date.now(),
    homedir: () => osHomedir(),
  };
}

// .............................................................................

/** Options for creating a NodeIdentity */
export interface CreateNodeIdentityOptions {
  /** Network domain — which group of nodes discover each other */
  domain: string;
  /** Port this node listens on when hub */
  port: number;
  /** Where to persist nodeId (default: ~/.rljson-network/) */
  identityDir?: string;
  /** Override dependencies for testing */
  deps?: Partial<NodeIdentityDeps>;
}

// .............................................................................

/**
 * Represents this node's identity in the network.
 *
 * On first run, generates a persistent UUID stored on disk.
 * On subsequent runs, reads the same UUID — same machine = same identity.
 */
export class NodeIdentity {
  readonly nodeId: string;
  readonly hostname: string;
  readonly localIps: string[];
  readonly domain: string;
  readonly port: number;
  readonly startedAt: number;

  constructor(info: NodeInfo) {
    this.nodeId = info.nodeId;
    this.hostname = info.hostname;
    this.localIps = [...info.localIps];
    this.domain = info.domain;
    this.port = info.port;
    this.startedAt = info.startedAt;
  }

  /** Convert to a plain NodeInfo data object */
  toNodeInfo(): NodeInfo {
    return {
      nodeId: this.nodeId,
      hostname: this.hostname,
      localIps: [...this.localIps],
      domain: this.domain,
      port: this.port,
      startedAt: this.startedAt,
    };
  }

  /**
   * Create a NodeIdentity, loading or generating a persistent UUID.
   * @param options - Configuration and optional dependency overrides
   */
  static async create(
    options: CreateNodeIdentityOptions,
  ): Promise<NodeIdentity> {
    const deps = { ...defaultNodeIdentityDeps(), ...options.deps };

    const identityDir =
      options.identityDir ?? join(deps.homedir(), '.rljson-network');
    const nodeIdPath = join(identityDir, options.domain, 'node-id');

    let nodeId = await deps.readNodeId(nodeIdPath);
    if (!nodeId) {
      nodeId = deps.randomUUID();
      await deps.writeNodeId(nodeIdPath, nodeId);
    }

    return new NodeIdentity({
      nodeId,
      hostname: deps.hostname(),
      localIps: deps.localIps(),
      domain: options.domain,
      port: options.port,
      startedAt: deps.now(),
    });
  }
}
