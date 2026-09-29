# Changelog

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
