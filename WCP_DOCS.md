## Vaporview WCP Server Usage

The Vaporview extension includes a Waveform Control Protocol (WCP) server so external tools can control the viewer over TCP, following the WCP specification ([wcp on GitLab](https://gitlab.com/waveform-control-protocol/wcp)).

This document explains how to enable the server, configure it, and use it from external clients.

---

## Configuration

Vaporview exposes a small set of settings under the `vaporview` configuration section.

- **`vaporview.wcp.enabled`**  
  - **Type**: boolean  
  - **Default**: `false`  
  - **Behavior**:  
    - When `true`, the WCP server is started automatically when the extension is activated (VS Code startup or first use of Vaporview).
    - When `false`, the server is not started automatically; you can still start it manually via commands.

- **`vaporview.wcp.port`**  
  - **Type**: number  
  - **Default**: `54322`  
  - **Range**: `0`–`65535`  
  - **Behavior**:  
    - **0**: Ask the OS to auto-assign an available port.  
    - **Non-zero**: Use the specified TCP port.  
    - If the port is already in use, the server will fail to start and an error will be logged to the Vaporview output channel.

You can edit these settings via:

- VS Code Settings UI:  
  - Open Settings → search for **“vaporview wcp”**.
- `settings.json`:

```json
"vaporview.wcp.enabled": true,
"vaporview.wcp.port": 54322
```

---

## Starting and Stopping the Server

There are three commands exposed by the extension for controlling the WCP server:

- **`vaporview.wcp.start`**  
  - Starts the WCP server if it is not already running.  
  - Uses the value of `vaporview.wcp.port` (default `54322`, `0` for auto-assign).  
  - Shows a notification with the actual port in use.  
  - If the server cannot be started (e.g., port in use), an error message is shown.

- **`vaporview.wcp.stop`**  
  - Stops the server if it is running.  
  - Shows a notification when the server is stopped.

- **`vaporview.wcp.status`**  
  - Shows the current state of the server:  
    - If running: the TCP port and the number of active connections.  
    - If not running: a simple “not running” message.

These commands can be run from:

- The Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P` → search for **“WCP:”**).  
- Keybindings or custom commands that you define yourself.

---

## When the Server Starts

The server is created and managed by the extension (`src/extension_core/extension.ts`):

- On activation:
  - The extension reads `vaporview.wcp.enabled` and `vaporview.wcp.port`.
  - If `vaporview.wcp.enabled` is `true`, it creates a `WCPServer` instance and calls `start()`.
- On configuration change:
  - If you toggle `vaporview.wcp.enabled` or change `vaporview.wcp.port`, the extension will:
    - Start the server if it was disabled and is now enabled.
    - Stop the server if it was enabled and is now disabled.
    - Restart the server if it is enabled and the port value changes.
- On extension shutdown:
  - The server is stopped as part of the normal VS Code disposal process.

Internally, the server listens only on `127.0.0.1` (loopback) and accepts multiple TCP clients. It keeps track of active connections and exposes this count to the `vaporview.wcp.status` command.

---

## Protocol Overview

The server implements the **Waveform Control Protocol (WCP)** as defined in the reference project:  
[https://gitlab.com/waveform-control-protocol/wcp](https://gitlab.com/waveform-control-protocol/wcp)

- **Transport**:  
  - TCP, JSON messages separated by newline (`\n`).
- **Message format**:  
  - Requests are objects with at least `method` and `id` (and optional `params`).  
  - Responses include either a `result` field (on success) or an `error` field (on failure), plus the original `id`.

Example request:

```json
{"method": "greeting", "params": {}, "id": 1}
```

Example response:

```json
{
  "result": {
    "name": "VaporView",
    "version": "X.Y.Z",
    "protocol": "WCP",
    "protocol_version": "0",
    "capabilities": ["greeting", "get_item_list", "..."]
  },
  "id": 1
}
```

The exact command set and semantics follow the WCP specification where possible. Some commands are specific to Vaporview (e.g., `open_document`, `add_signal`) but still use the same JSON-RPC-like pattern.

---

## Basic Usage from a Client

1. **Start the WCP server**
   - Ensure VS Code with the Vaporview extension is running.  
   - Either:
     - Set `vaporview.wcp.enabled = true` (auto-start on activation), or  
     - Run `vaporview.wcp.start` from the Command Palette.

2. **Determine the port**
   - If you use a fixed port (e.g., `54322`), connect directly to that.  
   - If you set `vaporview.wcp.port = 0`, retrieve the actual port using:
     - The notification shown when the server starts.  
     - The `vaporview.wcp.status` command.

3. **Connect from your client**
   - Open a TCP connection to `127.0.0.1:<port>`.  
   - Send newline-delimited JSON WCP requests.  
   - Read newline-delimited JSON responses.

4. **Typical command sequence**
   - `greeting` – discover capabilities and verify connectivity.  
   - `open_document` or `load` – open a waveform file (responds immediately with `ack`, then sends `waveform_loaded` event when loading completes).
   - Wait for `waveform_loaded` event before proceeding with other commands.
   - `add_items` / `add_signal` – add signals to the viewer.
   - `get_item_list`, `get_item_info`, `focus_item`, `set_viewport_to`, etc.

For a full list of commands and expected parameters/results, see the server implementation in `src/extension_core/wcp_server.ts` and the WCP specification ([wcp on GitLab](https://gitlab.com/waveform-control-protocol/wcp)).

---

## Troubleshooting

- **Server fails to start (port in use)**  
  - Choose a different `vaporview.wcp.port` or set it to `0` to let the OS pick an available port.

- **Client cannot connect**  
  - Confirm the server is running via `vaporview.wcp.status`.  
  - Check that you are connecting to `127.0.0.1` and the correct port.

- **Commands return errors**  
  - The `error` object in the response includes a code and message.  
  - Common causes include invalid parameters (e.g., unknown netlist ID, out-of-range time).

---

## Differences from the WCP Reference Specification

Vaporview aims to follow the WCP specification as defined in the reference project ([wcp on GitLab](https://gitlab.com/waveform-control-protocol/wcp)), but there are a few intentional behavior differences and extensions:

- **Document selection via `uri` parameter (all commands)**  
  - Every WCP command in Vaporview accepts an **optional** `uri` parameter in `params`.  
  - If `uri` is provided, the command targets that specific document.  
  - If `uri` is omitted, Vaporview applies the command to the **active document**, or if none is active, the **last active document**.  
  - This is an extension to the spec to better fit VS Code’s multi-document model.

- **Use of `netlist_id` as Displayed Item Reference**  
  - Vaporview uses its internal `netlist_id` as the WCP "displayed item" identifier.
  - Anywhere the WCP spec refers to an item ID (e.g., in `get_item_info`, `get_item_list`, `set_item_color`, `set_value_format`, `focus_item`, etc.), Vaporview uses `netlist_id` values that come from its netlist table.

- **`add_items` return behavior**  
  - In the reference spec, `add_items` may return IDs of added items and can report errors for items that could not be added.  
  - In Vaporview:
    - `add_items` **does not return an error** if no items were added (e.g., nothing matched or all items were skipped). It still returns a successful response.  
    - On success, `add_items` **always returns**:
      - `{"ids": []}`  
      even if items were actually added in the viewer. The command is effectively "fire and forget" from the client's perspective.

- **`waveform_loaded` event for `load`, `reload`, and `open_document`**
  - Per the WCP specification, the `load` command responds instantly with `ack` if the file is found, and sends a `waveform_loaded` event when loading completes.
  - Vaporview implements this behavior for `load`, `reload`, and `open_document` commands.
  - The server preserves the **exact URI format** from the input parameter in both the `ack` response and the `waveform_loaded` event.
  - Clients should listen for the `waveform_loaded` event **before** sending these commands to avoid race conditions, and wait for the **exact URI** they sent in the command.

These differences should be kept in mind when using generic WCP clients or comparing behavior against the reference implementation described in the WCP project ([wcp on GitLab](https://gitlab.com/waveform-control-protocol/wcp)).

---

## Vaporview-Specific Commands

In addition to the standard WCP methods described in the reference project ([wcp on GitLab](https://gitlab.com/waveform-control-protocol/wcp)), the Vaporview server exposes several **Vaporview-specific** commands. Many of these correspond directly to VS Code API commands described in `API_DOCS.md` (for example, `vaporview.openFile`, `waveformViewer.addVariable`, `waveformViewer.removeVariable`, and others).

- **`get_capabilities`**  
  - Returns a list of all supported server capabilities (both standard WCP and Vaporview-specific methods).  
  - Clients should use this to discover which methods are available in the running server.

- **`open_document`**  
  - Convenience wrapper to open a waveform file in Vaporview.  
  - Internally maps to the `vaporview.openFile` command and supports options like `uri`, `load_all`, and `max_signals`.  
  - Returns a WCP-style ack object including the document `uri` **immediately** if the file is found.  
  - The `uri` in the ack response uses the **exact same format** as the `uri` parameter in the request.  
  - Sends a `waveform_loaded` event to all connected clients when the document is fully loaded, using the same URI format as the input.

- **`add_signal`**  
  - Adds a single signal to the viewer using either `netlist_id`, `instance_path`, or `scope_path + name`.  
  - Internally maps to `waveformViewer.addVariable`.  
  - Returns `{ "success": true }` on success (or an error response on failure).

- **`remove_signal`**  
  - Removes a single signal from the viewer; accepts the same selectors as `add_signal`.  
  - Internally maps to `waveformViewer.removeVariable`.  
  - Returns `{ "success": true }` when the removal command is issued successfully.

- **`set_marker`**  
  - Sets the main or alternate marker in the viewer at a given time (optionally with units) and marker type (`0` main, `1` alt).  
  - Internally maps to the `waveformViewer.setMarker` command.

- **`set_value_format`**
  - Sets the displayed value format for a signal (e.g., binary, hexadecimal, decimal, octal, signed, float formats, etc.).
  - **Parameters:**
    - `id` (required): The netlist ID of the signal to format
    - `format` (required): The format string (see supported formats below)
    - `uri` (optional): Document URI (defaults to active document)
  - **Supported formats:**
    - `binary` - Binary representation
    - `hexadecimal` - Hexadecimal representation
    - `decimal` - Decimal representation
    - `octal` - Octal representation
    - `signed` - Signed decimal representation
    - `float8`, `float16`, `float32`, `float64` - Floating point formats
    - `bfloat16` - BFloat16 format
    - `tensorfloat32` - TensorFloat32 format
    - `ascii` - ASCII character representation
    - `string` - String representation
  - **Returns:** WCP-style ack response with document URI
  - **Errors:** Returns error if signal is not found, not displayed, or format is invalid (invalid formats return ack without error, per WCP spec)
  - **Example:**
    ```json
    {
      "method": "set_value_format",
      "params": {
        "id": 123,
        "format": "hexadecimal"
      },
      "id": 1
    }
    ```

- **`get_marker`**  
  - Reads back the current marker time and units for either the main or alternate marker.  
  - Internally uses `waveformViewer.getViewerState` and translates the result into the WCP `get_marker` response shape.

- **`get_viewer_state`**  
  - Returns a snapshot of the viewer state including URI, marker times, time unit, zoom ratio, scroll position, and displayed signals.
  - **Parameters:**
    - `uri` (optional): Document URI (defaults to active document)
  - **Response format:**
    ```json
    {
      "uri": "file:///path/to/waveform.vcd",
      "marker_time": 1000,
      "alt_marker_time": 2000,
      "time_unit": "ns",
      "zoom_ratio": 1.5,
      "scroll_left": 500,
      "displayed_signals": [
        {
          "name": "top.a",
          "id": 123
        },
        {
          "name": "top.b",
          "id": 124
        }
      ]
    }
    ```
  - **Response fields:**
    - `uri`: The document URI
    - `marker_time`: Main marker time in document time units
    - `alt_marker_time`: Alternate marker time in document time units
    - `time_unit`: Display time unit (e.g., "ns", "ps", "us")
    - `zoom_ratio`: Current zoom ratio
    - `scroll_left`: Horizontal scroll position in time units
    - `displayed_signals`: Array of displayed signals, each with `name` (instance path) and `id` (netlist ID)
  - Internally maps to `waveformViewer.getViewerState` and converts the result into the WCP-style response.

- **`get_values_at_time`**  
  - Returns the values of one or more signals (specified by `instance_paths`) at a given time.  
  - Internally maps to `waveformViewer.getValuesAtTime`, then adapts the return value to the WCP `get_values_at_time` result format (list of `{instance_path, value}`).

- **`get_open_documents`**  
  - Lists all open Vaporview documents and the last active document.  
  - Internally maps to `waveformViewer.getOpenDocuments` and converts the resulting URIs into strings for WCP clients.

All of these Vaporview-specific WCP methods follow the same transport and request/response structure as the standard WCP commands and respect the optional `uri` parameter described above.

---

## Events

The WCP server broadcasts events to all connected clients. Events are JSON messages with `type: "event"` and do not have an `id` field (unlike command responses).

### `waveform_loaded` Event

The `waveform_loaded` event is sent when a waveform document finishes loading. This event is fired by the following commands:

- **`load`** – After the waveform file is fully loaded
- **`reload`** – After the document is reloaded and ready
- **`open_document`** – After the waveform file is fully loaded

**Event Format:**
```json
{
  "type": "event",
  "event": "waveform_loaded",
  "uri": "file:///path/to/waveform.vcd"
}
```

**Important Notes:**
- The `load`, `reload`, and `open_document` commands return an `ack` response **immediately** if the file is found (per WCP specification).
- The `waveform_loaded` event is sent **asynchronously** when loading completes.
- Clients should set up event listeners **before** sending these commands to avoid missing the event due to race conditions.
- The server **preserves the exact URI format** from the input parameter. The `uri` field in both the `ack` response and the `waveform_loaded` event will match the URI format that was sent in the command.
- Clients should wait for the **exact URI** they sent in the command (e.g., if you send `/path/to/file.vcd`, wait for `/path/to/file.vcd`; if you send `file:///path/to/file.vcd`, wait for `file:///path/to/file.vcd`).
- Clients can filter events by URI to wait for a specific document to load.

