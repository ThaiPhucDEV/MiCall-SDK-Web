# M1 state machines and event ordering

## Transport

| From                                         | Trigger               | To             |
| -------------------------------------------- | --------------------- | -------------- |
| `stopped`                                    | `start()`             | `connecting`   |
| `connecting`, `reconnecting`, `disconnected` | WSS connected         | `connected`    |
| `connected`                                  | unexpected disconnect | `reconnecting` |
| any non-stopped state                        | `stop()`/`destroy()`  | `stopped`      |

Unexpected disconnect starts one full-jitter reconnect loop. Delay is random in `[0, min(30000, 500 * 2^attempt)]` milliseconds. Attempts continue until stop/destroy. The attempt counter resets after 30 seconds of stable connectivity.

## Registration

| From                     | Trigger        | To              |
| ------------------------ | -------------- | --------------- |
| `unregistered`, `failed` | `register()`   | `registering`   |
| `registering`            | SIP 200        | `registered`    |
| `registering`            | final failure  | `failed`        |
| `registered`             | `unregister()` | `unregistering` |
| `unregistering`          | completed      | `unregistered`  |

Registration expiry is 600 seconds. Desired registration survives an unexpected WSS disconnect and causes re-registration after reconnect. Manual unregister clears that desire.

## Call

| From                                                  | Trigger                                  | To                 |
| ----------------------------------------------------- | ---------------------------------------- | ------------------ |
| none                                                  | incoming INVITE                          | `incoming-ringing` |
| none                                                  | `makeCall()` after microphone permission | `outgoing-dialing` |
| `outgoing-dialing`                                    | SIP 180                                  | `outgoing-ringing` |
| `outgoing-dialing`                                    | SIP 183                                  | `early-media`      |
| `outgoing-ringing`                                    | SIP 183                                  | `early-media`      |
| `incoming-ringing`                                    | `answerCall()`                           | `establishing`     |
| `outgoing-dialing`, `outgoing-ringing`, `early-media` | SIP 2xx processing                       | `establishing`     |
| `establishing`                                        | session established                      | `active`           |
| non-terminal                                          | local end action                         | `terminating`      |
| non-terminal                                          | terminal SIP/network outcome             | `ended`            |
| `terminating`                                         | session terminated                       | `ended`            |

Outgoing INVITE has a 120-second local timeout. Incoming INVITE has no SDK local timeout. Permission denial while answering sends SIP 480.

## Event ordering

1. State is committed to an immutable snapshot before any event is emitted.
2. A new incoming call emits `incomingCall`; it does not emit a synthetic `callStateChanged` because no previous call state exists.
3. Every later call transition emits `callStateChanged` after commit.
4. A terminal transition emits `callStateChanged(state=ended)` and then exactly one `callEnded` with the same snapshot.
5. Remote CANCEL before answer maps to `remote-cancel`; local reject maps to `rejected`; local outgoing CANCEL maps to `local-cancel`.
6. Local/remote BYE after establishment maps to `local-hangup`/`remote-hangup`.
7. A second incoming INVITE is rejected first, then `incomingCallRejected` is emitted; the active snapshot is unchanged.
8. On reconnect, transport events precede any new registration event.
9. `destroy()` advances the generation, unsubscribes the adapter, clears public listeners and suppresses all late callbacks.

## Action rules

- `start`, `register`, `unregister`, `stop`, `destroy`, repeated `answerCall` and repeated terminal call actions are idempotent.
- An action for an unknown `callId`, an action incompatible with direction/state, or a concurrent `makeCall` returns a typed `MiCallError`.
- Public payloads are frozen, JSON-safe values and never contain SIP.js, DOM, MediaStream or Error runtime objects.
- Mute and accepted hold/unhold update the immutable active snapshot without changing its call state.
- Hold state is committed only after the re-INVITE succeeds. Reject or timeout preserves the previous snapshot.
- Successful blind transfer emits `transferStateChanged(completed)` before the terminal `callEnded(transferred)` event.
- Local hangup takes precedence over pending in-call control transactions and cancels their SDK timers.
