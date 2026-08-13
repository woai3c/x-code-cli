# Cross-session messaging

Cross-session messaging lets interactive X-Code sessions on the same machine discover one another and exchange plain-text work requests. Each participating root session keeps its own model, conversation, working directory, and local permission boundary.

> This release supports peer messaging on macOS and Linux. Windows sessions remain usable, but peer messaging reports `PEER_UNSUPPORTED_PLATFORM` until a Windows transport is available. Print mode (`--print`) does not register a peer.

## Start named sessions

Open a terminal for each project or role and assign a name:

```bash
# Terminal 1
cd frontend
xc --name frontend

# Terminal 2
cd backend
xc --name backend
```

Names are discovery labels, not durable identities. If two live sessions use the same name, address the intended one by the `peer:<uuid>` value shown by `/list-agents`.

Sessions discover peers through the same X-Code user directory. With the default setup, sessions running as the same OS user share `~/.x-code`; if `X_CODE_HOME` is set, they must use the same value.

## Discover and send

Run this inside a named session:

```text
/list-agents
```

The list includes each peer's name, process address, state, and working directory. You can then ask the agent naturally, for example:

```text
Ask backend whether the API response type is ready for the frontend.
```

Named root agents receive two model tools:

- `listAgents` lists reachable sessions.
- `sendMessage` sends plain text to a unique name or exact `peer:<uuid>` address. An optional summary is shown to the receiver.

These tools are not exposed to sub-agents. There is no direct `/send-message` command; the root agent chooses when to call `sendMessage` from your instruction.

## Inbound policy

Configure the receiving policy in `~/.x-code/config.json`:

```json
{
  "peerMessaging": {
    "inbound": "auto",
    "dialogExpiryMs": 300000
  }
}
```

| Policy   | Behavior                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `auto`   | Accept when sender and receiver use the same permission class; otherwise hold for a local decision. This is the default. |
| `accept` | Accept every authenticated local peer message immediately.                                                               |
| `hold`   | Show the message and require the receiver to choose **Accept** or **Refuse**.                                            |
| `refuse` | Reject every incoming peer message.                                                                                      |

The permission classes compared by `auto` are the default prompted mode and bypass mode (`--trust`). `dialogExpiryMs` applies to held messages, defaults to five minutes, and accepts values from 10 seconds through 30 minutes.

Changes take effect when a new named session starts.

## Authority and safety

A peer message is data, not user authority:

- Peer names, summaries, and payloads are stripped of terminal control sequences before display.
- Accepted messages and responses derived from them are marked as peer-influenced in the session transcript.
- In the default prompted mode, audited operations require a local, allow-once authority decision that shows the complete canonical payload. Unclassified or incompletely displayable operations fail closed.
- Configuration changes, long-term memory search, goal updates, and sub-agent dispatch are denied for peer-influenced work in prompted mode.
- Starting the receiving session with `--trust` is an explicit local decision to authorize peer-triggered tools without those prompts. Use it only when every reachable local peer is trusted.
- `/clear-peer-context` can delete the first peer-influenced message and every derived response after it, then restore normal authority. It refuses to run while peer messages are still queued.

Peer transport is local-only: it uses a runtime registry and Unix-domain sockets under the X-Code user directory, not a network listener. Authentication tokens and delivery ledgers are implementation details and are never model-visible.

## Delivery results

`sendMessage` reports one of these outcomes:

- `delivered`: the receiver accepted the message.
- `held`: the receiver must make a local decision before the deadline.
- Refused or error: the message was not accepted.
- `PEER_DELIVERY_UNKNOWN`: the connection closed before a matching acknowledgement. Retry only with the returned message ID and the exact same target and payload; changing any of them is rejected.

Messages arriving while the receiver is busy are queued and processed without interrupting the active turn.

## Troubleshooting

- **This session is not a named agent** — restart it with `xc --name <name>`.
- **No other reachable sessions** — verify that both sessions are named, run on macOS/Linux, and share the same `X_CODE_HOME`.
- **Name is ambiguous** — copy the exact `peer:<uuid>` address from `/list-agents`.
- **A message stays held** — accept or refuse it in the receiving terminal before `dialogExpiryMs` elapses.
- **Need diagnostics** — launch with `DEBUG_STDOUT=1`; details go to `~/.x-code/logs/debug.log`.
