# VaporView WCP integration

VaporView implements version 0 of the
[Waveform Viewer Control Protocol (WCP)](https://gitlab.com/waveform-control-protocol/wcp).
This document covers endpoint discovery and VaporView-specific behavior. The WCP
repository remains the source of truth for protocol messages and semantics.

## Supported waveform files

VaporView can open VCD, FST, and GHW files. FSDB is also supported when the
optional native reader and its vendor libraries are installed; see the
[FSDB setup instructions](GETTING_STARTED.md#optional-build-fsdb-addon).

The WCP `load` command accepts a local filesystem path or `file:` URI in its
`source` field.

## Connecting to VaporView

VaporView supports two endpoint-discovery models.

### From another VS Code extension

A VS Code extension can open a waveform and obtain its WCP endpoint with
`vaporview.wcp.openWaveform`:

```typescript
const endpoint = await vscode.commands.executeCommand<{
  host: string;
  port: number;
}>("vaporview.wcp.openWaveform", vscode.Uri.file("/path/to/waveform.vcd"));
```

The argument may be a `vscode.Uri` or a filesystem path string. If it is
omitted, VaporView displays a file picker. The command opens or reveals the
waveform and returns an endpoint such as:

```json
{
  "host": "127.0.0.1",
  "port": 49152
}
```

VaporView listens only on the loopback interface and lets the operating system
choose an available port. Calling the command again for the same open waveform
reuses its endpoint.

Each WCP session controls one active waveform. VaporView creates an endpoint
for the waveform passed to `openWaveform`; the standard `load` command can
replace the active waveform on that session.

### From an external or container process

An external process that cannot invoke VS Code commands can enable a stable
startup endpoint in VS Code's machine settings:

```json
{
  "vaporview.wcp.enabled": true,
  "vaporview.wcp.port": 54322
}
```

These settings use machine scope so they can be supplied by a devcontainer's
`customizations.vscode.settings`. They can also be set in local or remote User
settings, but not in workspace or folder settings. VaporView activates after
VS Code finishes starting and listens on `127.0.0.1` at the configured port.
The endpoint starts without an active waveform; connect, complete the greeting,
send `load`, and wait for `waveforms_loaded` before sending document-dependent
commands.

Setting the port to `0` lets the operating system choose a port, which is
reported in the VaporView output log. Processes that need a predetermined
endpoint should configure a nonzero port. Configuration changes start, stop,
or restart this endpoint automatically; there are no manual WCP start, stop,
or status commands.

## Transport and greeting

Messages are UTF-8 JSON terminated by a null byte (`U+0000`), not a newline.
Immediately after connecting, the client sends a WCP greeting. Its `commands`
array names the events the client wants to receive:

```json
{"type":"greeting","version":"0","commands":["waveforms_loaded","cursor_set"]}
```

The server replies with a greeting whose `commands` array lists the commands
implemented by VaporView. Command messages use `type: "command"` and a
`command` name. WCP is not JSON-RPC: messages have no `method`, `params`, or
request ID fields, and responses are returned in command order.

See the [WCP TypeScript bindings](https://gitlab.com/waveform-control-protocol/wcp/-/tree/main/bindings/typescript)
for generated types and TCP client support.

## Supported WCP commands and events

VaporView currently advertises these commands:

- `get_item_list`
- `get_item_info`
- `set_item_color`
- `add_items`
- `remove_items`
- `focus_item`
- `set_viewport_to`
- `set_viewport_range`
- `zoom_to_fit`
- `set_cursor`
- `load`
- `reload`
- `clear`
- `shutdown`

It can emit these events when the client advertises them in its greeting:

- `waveforms_loaded`, after a `load` or `reload` finishes
- `cursor_set`, when the main VaporView cursor moves

## VaporView-specific behavior

- Displayed item references are numeric VaporView netlist IDs. Clients should
  still treat them as opaque and only use IDs returned by `get_item_list` or
  `add_items`.
- `add_items` accepts signal paths and scope paths. A scope adds its direct
  signals; with `recursive: true`, signals in nested scopes are also added.
- `set_item_color` recognizes `green`, `orange`, `blue`, `purple`, `custom1`,
  `custom2`, `custom3`, and `custom4`. Other color names have no effect.
- `load` acknowledges once the source exists and then loads asynchronously.
  Advertise and wait for `waveforms_loaded` before issuing commands that depend
  on the newly loaded waveform.

## The former `uri` extension

Earlier experimental VaporView builds accepted an optional `uri` on almost
every command and included a URI in acknowledgements and loading events. That
was a VaporView-specific extension used to multiplex multiple documents over
one global TCP server; it was never part of WCP.

The extra fields were nonstandard extensions. Together with the former
JSON-RPC-like envelope and newline framing, they made the old server
wire-incompatible with standard WCP clients.

The extension has been removed. Select a document by calling
`vaporview.wcp.openWaveform`, or connect to the configured startup endpoint and
send `load`. Do not add a `uri` field to WCP commands. Standard WCP uses
`source` only on `load` and the `waveforms_loaded` event, and an `ack` response
contains no URI.

Clients of the earlier VaporView dialect must also migrate from newline-framed
JSON-RPC-like calls to null-delimited WCP messages. The common command mappings
are `open_document` to `load`, `add_signal` to `add_items`, and
`waveform_loaded` to `waveforms_loaded`.

## Value formats and other VaporView APIs

WCP version 0 does not define `set_value_format`, `open_document`, `add_signal`,
or the other commands from VaporView's earlier experimental server. Value
formatting remains available in VaporView itself, with binary, hexadecimal,
decimal, signed, octal, floating-point, bfloat16, tensorfloat32, ASCII, epoch,
string, enum, and fixed-point display modes, but it is not currently
controllable through WCP.

For non-WCP extension integration, see the [VaporView API documentation](API_DOCS.md).
