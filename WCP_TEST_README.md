# WCP Server Test Script

## Quick Start

### 1. Enable WCP Server in VS Code

**Option A: Via Settings UI**
1. Open VS Code Settings (Ctrl+, or Cmd+,)
2. Search for "vaporview.wcp"
3. Enable `vaporview.wcp.enabled`
4. Set `vaporview.wcp.port` to a port number (e.g., 8888) or leave as 0 for auto-assign
5. Reload VS Code window or restart the extension

**Option B: Via Command Palette**
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "WCP: Start Server"
3. Select the command
4. Note the port number shown in the notification

**Option C: Via settings.json**
Add to your VS Code settings.json:
```json
{
  "vaporview.wcp.enabled": true,
  "vaporview.wcp.port": 8888
}
```

### 2. Open a Waveform File (Optional but Recommended)

Open your VCD file in VaporView:
- Open `/home/heyfey/waveform/Design/dump.vcd` in VS Code
- It should open with the VaporView waveform viewer

### 3. Run the Test Script

**Method 1: Auto-detect port (recommended)**
```bash
node test_wcp.js
```

The script will try common ports (8888, 9999, 12345, 54321) to find the WCP server.

**Method 2: Specify port explicitly**
```bash
node test_wcp.js 8888
```

Replace `8888` with the actual port number your WCP server is using.

**Method 3: Make it executable and run directly**
```bash
./test_wcp.js 8888
```

### 4. Check WCP Server Status

In VS Code, you can check the server status:
- Press `Ctrl+Shift+P` (or `Cmd+Shift+P`)
- Type "WCP: Show Status"
- It will show the port and connection count

## Troubleshooting

### "Could not find WCP server"
- Make sure WCP server is enabled in VS Code settings
- Check that the extension is activated (open a waveform file)
- Try specifying the port explicitly: `node test_wcp.js <port>`
- Check VS Code Output panel → "Vaporview" channel for server logs

### "Connection refused"
- The WCP server might not be running
- Check if the port is correct
- Try restarting VS Code or the extension

### "No active document" errors
- Open a waveform file (VCD, FST, etc.) in VaporView first
- The test script will still run but some commands require an open document

### Adjusting Test for Your VCD File

Edit `test_wcp.js` and update the signal paths to match your VCD file structure:

```javascript
// In the test script, find these lines and update:
instance_path: 'top.clk'  // Change to match your actual signal path
```

To find signal paths in your VCD file:
1. Open the file in VaporView
2. Look at the netlist view on the left
3. Use the full path shown there (e.g., `top.module.signal`)

## Example Output

When running successfully, you should see:
```
Connecting to WCP server on port 8888...
Connected to WCP server

=== Test 1: Get Open Documents ===
Sending: get_open_documents
Response: {
  "documents": ["file:///home/heyfey/waveform/Design/dump.vcd"],
  "last_active_document": "file:///home/heyfey/waveform/Design/dump.vcd"
}

=== Test 2: Get Viewer State ===
...
```

## Manual Testing

You can also test manually using `netcat` or `nc`:

```bash
# Connect to the server
nc 127.0.0.1 8888

# Send a command (press Enter after typing)
{"method": "get_open_documents", "id": 1}

# You should receive a response
{"result": {...}, "id": 1}
```

## Available WCP Commands

The test script demonstrates these commands:
- `get_open_documents` - List open waveform documents
- `get_viewer_state` - Get current viewer state
- `get_marker` - Get marker time
- `set_marker` - Set marker to a specific time
- `add_signal` - Add a signal to the viewer
- `remove_signal` - Remove a signal from the viewer
- `get_signal_info` - Get information about a signal
- `navigate_time` - Navigate to next/previous edge
- `get_values_at_time` - Get signal values at a specific time

