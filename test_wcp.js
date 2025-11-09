#!/usr/bin/env node
/**
 * Simple test script for WCP (Waveform Control Protocol) server
 * 
 * Usage:
 *   node test_wcp.js [port]
 * 
 * Default port: 0 (will try to connect to port from config or common ports)
 */

const net = require('net');
const readline = require('readline');

// Default configuration
const DEFAULT_PORT = 0; // Will try common ports or read from config
const TEST_PORTS = [8888, 9999, 12345, 54321]; // Common test ports

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

class WCPClient {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.buffer = '';
    this.requestId = 1;
    this.pendingRequests = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`${colors.cyan}Connecting to WCP server on port ${this.port}...${colors.reset}`);
      
      this.socket = net.createConnection({ port: this.port, host: '127.0.0.1' }, () => {
        console.log(`${colors.green}Connected to WCP server${colors.reset}`);
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (err) => {
        console.error(`${colors.red}Connection error: ${err.message}${colors.reset}`);
        reject(err);
      });

      this.socket.on('close', () => {
        console.log(`${colors.yellow}Connection closed${colors.reset}`);
      });

      this.socket.on('end', () => {
        console.log(`${colors.yellow}Server ended connection${colors.reset}`);
      });
    });
  }

  handleData(data) {
    this.buffer += data.toString('utf8');
    
    // Process newline-delimited JSON messages
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, newlineIndex).trim();
      this.buffer = this.buffer.substring(newlineIndex + 1);

      if (line.length > 0) {
        this.handleMessage(line);
      }
    }
  }

  handleMessage(message) {
    try {
      const response = JSON.parse(message);
      
      if (response.id !== undefined && this.pendingRequests.has(response.id)) {
        const { resolve, reject } = this.pendingRequests.get(response.id);
        this.pendingRequests.delete(response.id);

        if (response.error) {
          console.error(`${colors.red}Error response:${colors.reset}`, response.error);
          reject(response.error);
        } else {
          console.log(`${colors.green}Response:${colors.reset}`, JSON.stringify(response.result, null, 2));
          resolve(response.result);
        }
      } else {
        // Notification or response without ID
        console.log(`${colors.blue}Received:${colors.reset}`, JSON.stringify(response, null, 2));
      }
    } catch (error) {
      console.error(`${colors.red}Error parsing response: ${error.message}${colors.reset}`);
      console.error(`Raw message: ${message}`);
    }
  }

  sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const command = {
        method: method,
        params: params,
        id: id
      };

      this.pendingRequests.set(id, { resolve, reject });

      const jsonCommand = JSON.stringify(command) + '\n';
      console.log(`${colors.cyan}Sending: ${method}${colors.reset}`);
      console.log(`${colors.blue}Command:${colors.reset}`, JSON.stringify(command, null, 2));

      this.socket.write(jsonCommand, 'utf8');
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.end();
    }
  }
}

async function runTests(port) {
  const client = new WCPClient(port);

  try {
    // Connect
    await client.connect();
    console.log('');

    // Test 1: Greeting (initial handshake)
    console.log(`${colors.yellow}=== Test 1: Greeting (Initial Handshake) ===${colors.reset}`);
    await client.sendCommand('greeting');
    await sleep(500);

    // Test 2: Get capabilities
    console.log(`\n${colors.yellow}=== Test 2: Get Capabilities ===${colors.reset}`);
    await client.sendCommand('get_capabilities');
    await sleep(500);

    // Test 3: Get open documents
    console.log(`\n${colors.yellow}=== Test 3: Get Open Documents ===${colors.reset}`);
    await client.sendCommand('get_open_documents');
    await sleep(500);

    // Test 3.5: Open waveform document
    console.log(`\n${colors.yellow}=== Test 3.5: Open Waveform Document ===${colors.reset}`);
    try {
      await client.sendCommand('open_document', {
        uri: 'file:///home/heyfey/waveform/Design/dump.vcd',
        load_all: false,
        max_signals: 64
      });
      console.log(`${colors.green}Document opened successfully, waiting for it to load...${colors.reset}`);
      await sleep(2000); // Wait for document to load
    } catch (error) {
      console.log(`${colors.yellow}Could not open document: ${error.message || error}${colors.reset}`);
      console.log(`${colors.yellow}This is OK if the document is already open or path is incorrect${colors.reset}`);
    }
    await sleep(500);

    // Test 4: Get signals (if document is open)
    console.log(`\n${colors.yellow}=== Test 4: Get Signals ===${colors.reset}`);
    try {
      await client.sendCommand('get_signals');
    } catch (error) {
      console.log(`${colors.yellow}No active document (this is OK if no waveform is open)${colors.reset}`);
    }
    await sleep(500);

    // Test 5: Get hierarchy (if document is open)
    console.log(`\n${colors.yellow}=== Test 5: Get Hierarchy ===${colors.reset}`);
    try {
      await client.sendCommand('get_hierarchy');
    } catch (error) {
      console.log(`${colors.yellow}No active document${colors.reset}`);
    }
    await sleep(500);

    // Test 6: Get viewer state (if document is open)
    console.log(`\n${colors.yellow}=== Test 6: Get Viewer State ===${colors.reset}`);
    try {
      await client.sendCommand('get_viewer_state');
    } catch (error) {
      console.log(`${colors.yellow}No active document (this is OK if no waveform is open)${colors.reset}`);
    }
    await sleep(500);

    // Test 7: Get marker
    console.log(`\n${colors.yellow}=== Test 7: Get Marker ===${colors.reset}`);
    try {
      await client.sendCommand('get_marker');
    } catch (error) {
      console.log(`${colors.yellow}No active document${colors.reset}`);
    }
    await sleep(500);

    // Test 8: Add signal by instance path
    // Note: Adjust the instance path based on your VCD file structure
    console.log(`\n${colors.yellow}=== Test 8: Add Signal ===${colors.reset}`);
    try {
      await client.sendCommand('add_signal', {
        instance_path: 'tb_CPUsystem.CLOCK1'  // Adjust this to match your VCD file
      });
    } catch (error) {
      console.log(`${colors.yellow}Could not add signal (may need to adjust instance_path)${colors.reset}`);
    }
    await sleep(500);

    // Test 9: Set marker
    console.log(`\n${colors.yellow}=== Test 9: Set Marker ===${colors.reset}`);
    try {
      await client.sendCommand('set_marker', {
        time: 1000,
        units: 'ns'
      });
    } catch (error) {
      console.log(`${colors.yellow}Could not set marker${colors.reset}`);
    }
    await sleep(500);

    // Test 10: Get marker after setting
    console.log(`\n${colors.yellow}=== Test 10: Get Marker (after setting) ===${colors.reset}`);
    try {
      await client.sendCommand('get_marker');
    } catch (error) {
      console.log(`${colors.yellow}Could not get marker${colors.reset}`);
    }
    await sleep(500);

    // Test 11: Get signal info
    console.log(`\n${colors.yellow}=== Test 11: Get Signal Info ===${colors.reset}`);
    try {
      await client.sendCommand('get_signal_info', {
        instance_path: 'tb_CPUsystem.CLOCK1'  // Adjust this to match your VCD file
      });
    } catch (error) {
      console.log(`${colors.yellow}Could not get signal info${colors.reset}`);
    }
    await sleep(500);

    // Test 12: Navigate time (next edge)
    console.log(`\n${colors.yellow}=== Test 12: Navigate Time (Next Edge) ===${colors.reset}`);
    try {
      await client.sendCommand('navigate_time', {
        direction: 'next_edge'
      });
    } catch (error) {
      console.log(`${colors.yellow}Could not navigate time${colors.reset}`);
    }
    await sleep(500);

    // Test 13: Get values at time
    console.log(`\n${colors.yellow}=== Test 13: Get Values at Time ===${colors.reset}`);
    try {
      await client.sendCommand('get_values_at_time', {
        time: 1000,
        instance_paths: ['tb_CPUsystem.CLOCK1']  // Adjust this to match your VCD file
      });
    } catch (error) {
      console.log(`${colors.yellow}Could not get values at time${colors.reset}`);
    }
    await sleep(500);

    console.log(`\n${colors.green}=== All tests completed ===${colors.reset}`);

  } catch (error) {
    console.error(`${colors.red}Test error: ${error.message}${colors.reset}`);
  } finally {
    // Disconnect
    console.log(`\n${colors.cyan}Disconnecting...${colors.reset}`);
    client.disconnect();
    await sleep(200);
    process.exit(0);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main execution
async function main() {
  let port = parseInt(process.argv[2]) || DEFAULT_PORT;

  if (port === 0) {
    // Try to find the port from VS Code config or try common ports
    console.log(`${colors.yellow}No port specified. Trying common ports...${colors.reset}`);
    
    for (const testPort of TEST_PORTS) {
      try {
        const client = new WCPClient(testPort);
        await client.connect();
        client.disconnect();
        port = testPort;
        console.log(`${colors.green}Found WCP server on port ${port}${colors.reset}`);
        break;
      } catch (error) {
        // Continue to next port
      }
    }

    if (port === 0) {
      console.error(`${colors.red}Could not find WCP server. Please specify port:${colors.reset}`);
      console.error(`  node test_wcp.js <port>`);
      console.error(`\nOr enable WCP server in VS Code settings:`);
      console.error(`  1. Open VS Code Settings`);
      console.error(`  2. Search for "vaporview.wcp.enabled"`);
      console.error(`  3. Enable it and note the port number`);
      process.exit(1);
    }
  }

  await runTests(port);
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log(`\n${colors.yellow}Interrupted by user${colors.reset}`);
  process.exit(0);
});

main().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
});

