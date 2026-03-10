// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

/** Configuration for the UDP broadcast discovery layer (Try 1) */
export interface BroadcastConfig {
  /** Whether broadcast discovery is enabled (default: true) */
  enabled: boolean;
  /** UDP port for announcements (default: 41234) */
  port: number;
  /** How often to announce in ms (default: 5000) */
  intervalMs?: number;
  /** Remove peer after N ms silence (default: 15000) */
  timeoutMs?: number;
}

/** Configuration for the cloud discovery layer (Try 2) */
export interface CloudConfig {
  /** Whether cloud discovery is enabled (default: false) */
  enabled: boolean;
  /** Cloud service URL */
  endpoint: string;
  /** Authentication key */
  apiKey?: string;
  /** How often to poll in ms (default: 30000) */
  pollIntervalMs?: number;
}

/** Configuration for the static discovery layer (Try 3) */
export interface StaticConfig {
  /** Hardcoded hub address — "ip:port" */
  hubAddress?: string;
}

/** Configuration for peer probing */
export interface ProbingConfig {
  /** Whether probing is enabled (default: true) */
  enabled: boolean;
  /** How often to probe all peers in ms (default: 10000) */
  intervalMs?: number;
  /** Probe timeout in ms (default: 2000) */
  timeoutMs?: number;
}

/** Full network configuration */
export interface NetworkConfig {
  /** Network domain — which group of nodes discover each other */
  domain: string;
  /** Port this node listens on when hub */
  port: number;
  /** Where to persist nodeId (default: ~/.rljson-network/) */
  identityDir?: string;

  /** Try 1: Broadcast — primary automatic discovery */
  broadcast?: BroadcastConfig;
  /** Try 2: Cloud — first fallback (optional, must be explicitly configured) */
  cloud?: CloudConfig;
  /** Try 3: Static — last resort fallback (optional) */
  static?: StaticConfig;
  /** Peer probing configuration */
  probing?: ProbingConfig;

  // NOTE: Manual / UI override has NO config entry here.
  // It is always present, always available, and cannot be disabled.
}

/**
 * Create a default NetworkConfig with broadcast enabled.
 * @param domain - Network domain name
 * @param port - Port this node listens on
 */
export function defaultNetworkConfig(
  domain: string,
  port: number,
): NetworkConfig {
  return {
    domain,
    port,
    broadcast: { enabled: true, port: 41234 },
    probing: { enabled: true },
  };
}
