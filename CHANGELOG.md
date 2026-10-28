# Changelog

## [0.0.25]

**A machine that rejoined its site alone became a second hub — and a hub that
restarted alone could leave its site with none.**

Both seen on a lab of two-machine sites whose host keeps its own server on the
hub port of every machine, whatever the machine's role. Such a host could only
switch probing off, because the probe listener could not bind the port — and a
node that cannot probe has nothing to elect with: it takes the cloud's word.

A machine that rejoined alone learned its peer from the cloud's register
answer, long before the peer's next broadcast, so it never probed. The running
hub heard the newcomer's broadcast first, probed it once, reported it
reachable, and kept itself as incumbent on that one probe. The coordinator,
ranking by reported reachability, named the newcomer — the only node anyone had
reported. Two hubs, for good, and nothing on either machine said so.

### What changed

- **`probing.listen: false`.** Probing and election run every cycle while the
  host's own server holds the port: the listener is never started, and the port
  is advertised as configured. `test/e2e/two-hub-race.spec.ts` reproduces the
  split with real network managers, real TCP probes and host servers, and shows
  one hub when a machine joins alone, when both start together, and when the
  hub restarts alone.
- **A restarted peer is reported again.** A restart keeps the node id and moves
  `startedAt`. The broadcast and cloud layers announced an id only once, so
  every election kept the start of a process that was gone: when a hub
  restarted alone, the survivor handed the hub back to it as "started earlier",
  while the restarted node, knowing its real start, deferred to the survivor —
  no hub at all. Layers now announce a known peer again when its report changed
  (`nodeInfoChanged`), the peer table emits `peer-updated`, and the network
  manager probes the peer where it is now.
- **One-shot probes say who took them.** With probing off the scheduler never
  started, so the one probe of a peer heard by broadcast reached the cloud with
  an empty `fromNodeId` — dropped by a coordinator that joins probe rows to
  registered nodes. The network manager now sets the id on start
  (`ProbeScheduler.setSelfId()`).

Every change came with a test that failed before it.

### Releases go through gg

**What changed for contributors.** The CI no longer publishes:
`.github/workflows/publish.yml` is disabled, and a release happens only when
the owner runs `gg one do publish`, which merges first and uploads only what
`main` holds (`--merge-only` merges without a release). CLAUDE.md describes
the whole workflow through gg — `gg one do create ticket`, `gg one do
commit`, `gg one do push`, `gg one do publish`. The scripts gg replaces —
`create-branch.js`, `push-branch.js`, `wait-for-pr.js`, `publish-to-npm.js`,
`add-version-tag.js` — are removed.

## [0.0.24]

**A node that failed to register once stayed invisible for ever.**

`CloudLayer.start()` registers, and on any failure returns `false` so the
NetworkManager falls through to broadcast. That much is right: a node must not
block on the cloud, and one that cannot reach it should still form its LAN and
work.

What was wrong is everything after. The only code that re-registers lives in
`_poll()`, and `_poll()` is scheduled at the END of `start()` — the part a
failed registration never reaches. So one refused call left the layer dead for
the life of the process. The node synced perfectly over the LAN while the
Coordinator had never heard of it, which is the state nothing complains about,
because everything works.

Seen on 2026-09-29: a workstation booted during the three seconds its platform
took to restart, got `503` from `/register`, and was still absent from the
tenant's topology hours later — reported from the UI as *online, nicht
registriert*.

### What changed

A failed registration now schedules a retry and keeps doing so until it gets
through: 5 s, doubling to a 60 s ceiling. A cloud that is merely restarting is
picked up within seconds; one that is down for an hour costs a handful of
requests rather than thousands.

`start()` still returns `false` and the node still falls through to broadcast
immediately — nothing waits on the cloud. The retry runs behind that, and the
layer activates itself the moment the cloud answers.

The timer is `unref`'d, so a node is never held alive by its wish to be
registered, and `stop()` cancels it: a retry that outlived `stop()` would
register a node that has been told to go away.

410 tests, and the retry is asserted on the call log rather than on a log line
— same identity every attempt, so a retry can never add a second node to the
register.

## [0.0.1]

Initial commit.
