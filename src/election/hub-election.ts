// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeId, NodeInfo } from '../types/node-info.ts';
import type { PeerProbe } from '../types/peer-probe.ts';

// .............................................................................

/** Result of a hub election */
export interface ElectionResult {
  /** The elected hub's nodeId, or null if no candidate qualifies */
  hubId: NodeId | null;
  /** Why this hub was chosen */
  reason: ElectionReason;
}

/** Reason for the election outcome */
export type ElectionReason =
  | 'incumbent' // Current hub is still reachable → keep it
  | 'earliest-start' // Earliest startedAt wins
  | 'tiebreaker' // Same startedAt → lexicographic nodeId
  | 'no-candidates'; // No reachable peers (or no peers at all)

// .............................................................................

/**
 * Deterministic hub election algorithm.
 *
 * Rules (in priority order):
 * 1. Filter to reachable peers only (those with a passing probe)
 * 2. Incumbent advantage — if the current hub is reachable, keep it
 * 3. Earliest `startedAt` wins
 * 4. Lexicographic `nodeId` tiebreaker (astronomically rare)
 *
 * This is a pure function — no I/O, no side effects.
 * @param candidates - All known peers (including self)
 * @param probes - Latest probe results for reachability
 * @param currentHubId - The current hub's nodeId (null if none)
 * @param selfId - This node's own nodeId (always considered reachable)
 * @returns The election result with hubId and reason
 */
export function electHub(
  candidates: NodeInfo[],
  probes: PeerProbe[],
  currentHubId: NodeId | null,
  selfId: NodeId,
): ElectionResult {
  if (candidates.length === 0) {
    return { hubId: null, reason: 'no-candidates' };
  }

  // Build reachability set from probes
  const reachable = new Set<NodeId>();
  reachable.add(selfId); // Self is always reachable

  for (const probe of probes) {
    if (probe.reachable) {
      reachable.add(probe.toNodeId);
    }
  }

  // Filter candidates to reachable only
  const reachableCandidates = candidates.filter((c) => reachable.has(c.nodeId));

  if (reachableCandidates.length === 0) {
    return { hubId: null, reason: 'no-candidates' };
  }

  // Rule 2: Incumbent advantage — if current hub is reachable, keep it
  if (currentHubId !== null) {
    const incumbentStillReachable = reachableCandidates.some(
      (c) => c.nodeId === currentHubId,
    );
    if (incumbentStillReachable) {
      return { hubId: currentHubId, reason: 'incumbent' };
    }
  }

  // Rule 3+4: Sort by startedAt (ascending), then nodeId (ascending)
  reachableCandidates.sort((a, b) => {
    const timeDiff = a.startedAt - b.startedAt;
    if (timeDiff !== 0) return timeDiff;
    return a.nodeId.localeCompare(b.nodeId);
  });

  const winner = reachableCandidates[0]!;

  // Determine reason: check if there was a tie on startedAt
  const reason: ElectionReason =
    reachableCandidates.length > 1 &&
    reachableCandidates[1]!.startedAt === winner.startedAt
      ? 'tiebreaker'
      : 'earliest-start';

  return { hubId: winner.nodeId, reason };
}
