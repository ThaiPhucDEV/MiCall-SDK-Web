# ADR 0001: Headless core boundary

Status: Accepted

## Decision

- `@micall/core` owns public state, immutable snapshots, event ordering, single-call policy and stable errors. It has no DOM or SIP.js dependency.
- `@micall/sipjs-browser` owns SIP.js `UserAgent`, `Registerer`, `Invitation`, `Inviter`, browser permission checks and page lifecycle observation.
- Only one non-ended call may exist. A second incoming INVITE is rejected with SIP 486; a concurrent outgoing action fails with `CALL_ALREADY_EXISTS`.
- Background support is best effort. Hiding a page never unregisters or hangs up. Frozen, discarded and closed pages cannot be guaranteed to receive calls.
- `callId` is an SDK-generated UUID. A PBX call identifier is exposed only when its header is explicitly allowlisted.
- Public metadata is `Readonly<Record<string, string>>`. Header names are matched case-insensitively and emitted as lowercase keys. The first parsed value wins.

## Dependency graph

```text
@micall/core <- @micall/sipjs-browser <- @mitek/webrtc
      ^                                      |
      +--------------- UI adapters ----------+
```

No package may access SIP.js private members such as `_sessions`.

## Ownership

| Resource                        | Owner                         | Release rule                                            |
| ------------------------------- | ----------------------------- | ------------------------------------------------------- |
| Core snapshots/listeners        | `MiCallClient`                | `destroy()` clears listeners and rejects future actions |
| SIP.js `UserAgent`/`Registerer` | SIP adapter                   | Adapter `destroy()` unregisters/disposes/stops once     |
| SIP.js session                  | SIP adapter                   | Removed exactly once after terminal state               |
| Permission probe tracks         | Browser media permission gate | Stopped immediately after the permission decision       |
| Retry and call timeout timers   | SIP adapter                   | Cleared on success, manual stop or destroy              |
| DOM lifecycle listeners         | Page lifecycle observer       | Returned unsubscribe removes all listeners              |

## Consequences

The core can be tested without browser globals and can be consumed by JavaScript embedded in PHP, React, Vue or any other host. Framework adapters do not define call behavior.
