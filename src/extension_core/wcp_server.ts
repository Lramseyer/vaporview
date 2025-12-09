// Waveform Control Protocol (WCP) Server Implementation
// Based on WCP specification: https://gitlab.com/waveform-control-protocol/wcp
// Reference implementation: https://gitlab.com/surfer-project/surfer/-/tree/main/libsurfer/src/wcp

import * as net from 'net';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { WaveformViewerProvider, scaleFromUnits } from './viewer_provider';
import { VaporviewDocument } from './document';
import { getInstancePath } from './tree_view';

export interface WCPCommand {
  method: string;
  params?: any;
  id?: string | number;
}

export interface WCPResponse {
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id?: string | number;
}

interface WCPConnection {
  socket: net.Socket;
  buffer: string;
  remoteAddress: string;
}

export const wcpDefaultPort = 54322;

export function updateWCPServerFromConfiguration(wcpServer: WCPServer | null, viewerProvider: WaveformViewerProvider, context: vscode.ExtensionContext): void {
  const newEnabled = vscode.workspace.getConfiguration('vaporview').get<boolean>('wcp.enabled', false);
  const newPort = vscode.workspace.getConfiguration('vaporview').get<number>('wcp.port', wcpDefaultPort);

  if (newEnabled && !wcpServer) {
    wcpServer = new WCPServer(viewerProvider, context, newPort);
    wcpServer.start();
  } else if (!newEnabled && wcpServer) {
    wcpServer.stop();
    wcpServer = null;
  } else if (newEnabled && wcpServer && newPort !== wcpServer.getPort()) {
    wcpServer.stop();
    wcpServer = new WCPServer(viewerProvider, context, newPort);
    wcpServer.start()
  }
}

// #region WCPServer
export class WCPServer {
  private server: net.Server | null = null;
  private port: number;
  private viewerProvider: WaveformViewerProvider;
  private context: vscode.ExtensionContext;
  private isRunning: boolean = false;
  private connections: Set<WCPConnection> = new Set();

  constructor(
    viewerProvider: WaveformViewerProvider,
    context: vscode.ExtensionContext,
    port: number = 54322 // 0 means auto-assign
  ) {
    this.viewerProvider = viewerProvider;
    this.context = context;
    this.port = port;
  }

  public async start(): Promise<number> {
    if (this.isRunning) {
      return this.port;
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        this.isRunning = true;
        this.viewerProvider.log.appendLine(`WCP server started on TCP port ${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        this.viewerProvider.log.appendLine(`Failed to start WCP server: ${err.message}`);
        if (err.code === 'EADDRINUSE') {
          this.viewerProvider.log.appendLine(`WCP server port ${this.port} is already in use`);
          reject(err);
        } else {
          this.viewerProvider.log.appendLine(`WCP server error: ${err.message}`);
          reject(err);
        }
      });
    });
  }

  public stop(): void {
    // Close all connections
    for (const conn of this.connections) {
      try {
        conn.socket.end();
      } catch (e) {
        // Ignore errors when closing
      }
    }
    this.connections.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
      this.isRunning = false;
      this.viewerProvider.log.appendLine('WCP server stopped');
    }
  }

  public getPort(): number {
    return this.port;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getConnectionCount(): number {
    return this.connections.size;
  }

  private handleConnection(socket: net.Socket): void {
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    this.viewerProvider.log.appendLine(`WCP client connected from ${remoteAddress}`);

    const connection: WCPConnection = {
      socket: socket,
      buffer: '',
      remoteAddress: remoteAddress
    };

    this.connections.add(connection);

    socket.on('data', (data: Buffer) => {
      this.handleData(connection, data);
    });

    socket.on('error', (err: Error) => {
      this.viewerProvider.log.appendLine(`WCP connection error from ${remoteAddress}: ${err.message}`);
    });

    socket.on('close', () => {
      this.connections.delete(connection);
      this.viewerProvider.log.appendLine(`WCP client disconnected from ${remoteAddress}`);
    });

    socket.on('end', () => {
      this.connections.delete(connection);
      this.viewerProvider.log.appendLine(`WCP client ended connection from ${remoteAddress}`);
    });
  }

  private handleData(connection: WCPConnection, data: Buffer): void {
    // Append new data to buffer
    connection.buffer += data.toString('utf8');

    // Process complete messages (newline-delimited JSON)
    let newlineIndex: number;
    while ((newlineIndex = connection.buffer.indexOf('\n')) !== -1) {
      const line = connection.buffer.substring(0, newlineIndex).trim();
      connection.buffer = connection.buffer.substring(newlineIndex + 1);

      if (line.length > 0) {
        this.processMessage(connection, line);
      }
    }
  }

  private async processMessage(connection: WCPConnection, message: string): Promise<void> {
    try {
      const command: WCPCommand = JSON.parse(message);
      const response = await this.handleCommand(command);
      this.sendResponse(connection, response);
    } catch (error: any) {
      this.viewerProvider.log.appendLine(`WCP server error parsing message from ${connection.remoteAddress}: ${error.message}`);
      this.viewerProvider.log.appendLine(`Message: ${message}`);

      // Send error response if we can parse the ID
      try {
        const parsed = JSON.parse(message);
        this.sendResponse(connection, {
          error: {
            code: -32700,
            message: 'Parse error',
            data: error.message
          },
          id: parsed.id
        });
      } catch {
        // If we can't even parse the message to get the ID, send a generic error
        this.sendResponse(connection, {
          error: {
            code: -32700,
            message: 'Parse error',
            data: error.message
          }
        });
      }
    }
  }

  // #region handleCommand
  private async handleCommand(command: WCPCommand): Promise<WCPResponse> {
    try {
      let result: any = null;

      switch (command.method) {
        // Standard WCP commands
        case 'greeting':
          result = await this.handleGreeting(command.params);
          break;
        case 'add_items':
          result = await this.handleAddItems(command.params);
          break;
        case 'get_item_info':
          result = await this.handleGetItemInfo(command.params);
          break;
        case 'get_item_list':
          result = await this.handleGetItemList(command.params);
          break;
        case 'set_item_color':
          result = await this.handleSetItemColor(command.params);
          break;
        case 'set_value_format':
          result = await this.handleSetValueFormat(command.params);
          break;
        case 'add_markers':
          this.viewerProvider.log.appendLine('WCP: add_markers command requested but not yet implemented');
          return {
            error: {
              code: -32601,
              message: 'Method not yet implemented: add_markers'
            },
            id: command.id
          };
        case 'remove_items':
          result = await this.handleRemoveItems(command.params);
          break;
        case 'focus_item':
          result = await this.handleFocusItem(command.params);
          break;
        case 'set_viewport_to':
          result = await this.handleSetViewportTo(command.params);
          break;
        case 'set_viewport_range':
          result = await this.handleSetViewportRange(command.params);
          break;
        case 'zoom_to_fit':
          result = await this.handleZoomToFit(command.params);
          break;
        case 'load':
          result = await this.handleLoad(command.params);
          break;
        case 'reload':
          result = await this.handleReload(command.params);
          break;
        case 'clear':
          this.viewerProvider.log.appendLine('WCP: clear command requested but not yet implemented');
          return {
            error: {
              code: -32601,
              message: 'Method not yet implemented: clear'
            },
            id: command.id
          };
        case 'shutdown':
          result = await this.handleShutdown(command.params);
          break;

        // Deprecated WCP commands
        case 'add_variables':
          result = await this.handleAddVariables(command.params);
          break;
        case 'add_scope':
          this.viewerProvider.log.appendLine('WCP: add_scope command requested but not yet implemented');
          return {
            error: {
              code: -32601,
              message: 'Method not yet implemented: add_scope'
            },
            id: command.id
          };

        // VaporView-specific commands
        case 'get_capabilities':
          result = await this.handleGetCapabilities();
          break;
        case 'open_document':
          result = await this.handleOpenDocument(command.params);
          break;
        case 'add_signal':
          result = await this.handleAddSignal(command.params);
          break;
        case 'remove_signal':
          result = await this.handleRemoveSignal(command.params);
          break;
        case 'set_marker':
          result = await this.handleSetMarker(command.params);
          break;
        case 'get_marker':
          result = await this.handleGetMarker(command.params);
          break;
        case 'get_viewer_state':
          result = await this.handleGetViewerState(command.params);
          break;
        case 'get_values_at_time':
          result = await this.handleGetValuesAtTime(command.params);
          break;
        case 'get_open_documents':
          result = await this.handleGetOpenDocuments();
          break;
        default:
          return {
            error: {
              code: -32601,
              message: `Method not found: ${command.method}`
            },
            id: command.id
          };
      }

      return {
        result: result,
        id: command.id
      };
    } catch (error: any) {
      return {
        error: {
          code: -32000,
          message: error.message || 'Internal error'
        },
        id: command.id
      };
    }
  }

  // #region Standard WCP command handlers
  private async handleGreeting(params: any): Promise<any> {
    // Greeting command - initial handshake
    // Returns server information, protocol version, and capabilities
    return {
      name: 'VaporView',
      version: '1.4.3',
      protocol: 'WCP',
      protocol_version: '0',
      capabilities: await this.getCapabilitiesList()
    };
  }

  private async handleAddItems(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (!params.items || !Array.isArray(params.items)) {
      throw new Error('items array is required');
    }

    if (params.items.length === 0) {
      return { ids: [] };
    }

    await this.viewerProvider.addItemsToDocument(document, params);

    // TODO(heyfey): Return the IDs for added items
    return { ids: [] };
  }

  private async handleGetItemInfo(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (!params.ids || !Array.isArray(params.ids)) {
      throw new Error('ids array is required');
    }

    // Process each ID in order and build results array
    const results: any[] = [];

    for (const netlistId of params.ids) {
      // Validate netlist ID
      if (netlistId === undefined || netlistId === null || typeof netlistId !== 'number') {
        throw new Error(`Invalid netlist ID: ${netlistId}`);
      }

      // Get the item from netlistIdTable
      const item = document.netlistIdTable[netlistId];
      if (!item) {
        throw new Error(`Item not found: ${netlistId}`);
      }

      // Get the full instance path as the name using the helper function
      const instancePath = getInstancePath(item);

      // Build ItemInfo
      results.push({
        name: instancePath,
        type: item.type,
        id: netlistId
      });
    }

    // Return get_item_info response (WCP spec format)
    return {
      type: "response",
      command: "get_item_info",
      results: results
    };
  }

  private async handleGetItemList(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    // Extract netlist IDs from displayed signals via webview context
    const ids = document.getDisplayedNetlistIds();

    // Return get_item_list response (WCP spec format)
    return {
      type: "response",
      command: "get_item_list",
      ids: ids
    };
  }

  private async handleSetItemColor(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.id === undefined || params.id === null) {
      throw new Error('id (netlist ID) parameter is required');
    }

    if (!params.color) {
      throw new Error('color parameter is required');
    }

    // Validate id is a number (netlist ID)
    if (typeof params.id !== 'number') {
      throw new Error('id must be a number (netlist ID)');
    }

    const netlistId = params.id;
    const uri = document.uri;

    // Get the item from netlistIdTable
    const item = document.netlistIdTable[netlistId];
    if (!item) {
      throw new Error(`Item not found: ${netlistId}`);
    }

    // Check if it's a signal (only signals can have colors)
    if (item.contextValue === 'netlistScope') {
      throw new Error('Cannot set color for scope items');
    }

    // Require that the signal is currently displayed
    if (!document.isSignalDisplayed(netlistId)) {
      throw new Error(`Signal is not displayed: ${netlistId}`);
    }

    // Map color name to colorIndex
    // Supported colors: green, orange, blue, purple, custom1, custom2, custom3, custom4
    // See: src/webview/viewport.ts for the colorKey array
    const colorMap: { [key: string]: number } = {
      'green': 0,
      'orange': 1,
      'blue': 2,
      'purple': 3,
      'custom1': 4,
      'custom2': 5,
      'custom3': 6,
      'custom4': 7
    };

    const colorIndex = colorMap[params.color.toLowerCase()];

    // If color is invalid, do nothing (no error, just return ack)
    if (colorIndex === undefined) {
      // Invalid color - do nothing, return ack as per spec
      return {
        type: "response",
        command: "ack",
        uri: uri.toString()
      };
    }

    // Set the color using setValueFormat
    this.viewerProvider.setValueFormat(netlistId, 0, undefined, { colorIndex: colorIndex });

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleSetValueFormat(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.id === undefined || params.id === null) {
      throw new Error('id (netlist ID) parameter is required');
    }

    if (!params.format) {
      throw new Error('format parameter is required');
    }

    // Validate id is a number (netlist ID)
    if (typeof params.id !== 'number') {
      throw new Error('id must be a number (netlist ID)');
    }

    const netlistId = params.id;
    const uri = document.uri;

    // Get the item from netlistIdTable
    const item = document.netlistIdTable[netlistId];
    if (!item) {
      throw new Error(`Item not found: ${netlistId}`);
    }

    // Check if it's a signal (only signals can have formats)
    if (item.contextValue === 'netlistScope') {
      throw new Error('Cannot set format for scope items');
    }

    // Require that the signal is currently displayed
    if (!document.isSignalDisplayed(netlistId)) {
      throw new Error(`Signal is not displayed: ${netlistId}`);
    }

    // Valid format values (from valueFormatList)
    const validFormats = [
      'binary',
      'hexadecimal',
      'decimal',
      'octal',
      'signed',
      'float8',
      'float16',
      'float32',
      'float64',
      'bfloat16',
      'tensorfloat32',
      'ascii',
      'string'
    ];

    const format = params.format.toLowerCase();

    // If format is invalid, do nothing (no error, just return ack)
    if (!validFormats.includes(format)) {
      // throw new Error(`Invalid format: ${params.format}. Valid formats: ${validFormats.join(', ')}`);
      return {
        type: "response",
        command: "ack",
        uri: uri.toString()
      };
    }

    // Set the format using setValueFormat
    this.viewerProvider.setValueFormat(netlistId, 0, undefined, { valueFormat: format });

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleRemoveItems(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (!params.ids || !Array.isArray(params.ids)) {
      throw new Error('ids array is required');
    }

    const uri = document.uri;

    if (params.ids.length === 0) {
      // Return ack response with uri (WCP spec format)
      return {
        type: "response",
        command: "ack",
        uri: uri.toString()
      };
    }

    // Remove each item by netlist ID - process sequentially to ensure proper state tracking
    for (const netlistId of params.ids) {
      // Skip invalid IDs (don't throw error, just continue)
      if (netlistId === undefined || netlistId === null || typeof netlistId !== 'number') {
        continue;
      }

      // Check if the signal is displayed before trying to remove it
      if (!document.isSignalDisplayed(netlistId)) {
        // Signal not displayed, skip it (don't throw error)
        continue;
      }

      // Remove the signal using the document's uri
      const args: any = {
        uri: uri.toString(),
        netlistId: netlistId
      };

      await vscode.commands.executeCommand('waveformViewer.removeVariable', args);
    }

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleFocusItem(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.id === undefined || params.id === null) {
      throw new Error('id (netlist ID) parameter is required');
    }

    // Validate id is a number (netlist ID)
    if (typeof params.id !== 'number') {
      throw new Error('id must be a number (netlist ID)');
    }

    const netlistId = params.id;
    const uri = document.uri;

    // Get the item from netlistIdTable
    const item = document.netlistIdTable[netlistId];
    if (!item) {
      throw new Error(`Item not found: ${netlistId}`);
    }

    // Check if the signal is displayed - error if not displayed
    if (!document.isSignalDisplayed(netlistId)) {
      throw new Error(`Signal is not displayed: ${netlistId}`);
    }

    // Reveal the signal in the webview
    document.revealSignalInWebview(netlistId);

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleSetViewportTo(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.timestamp === undefined) {
      throw new Error('time parameter is required');
    }

    const uri = document.uri;

    // Convert time units if provided, using the same logic as setMarkerAtTimeWithUnits
    let time = params.timestamp;
    if (params.units) {
      const metadata = document.metadata;
      const timeScale = metadata.timeScale;
      const timeUnit = scaleFromUnits(metadata.timeUnit);

      if (!timeScale || !timeUnit) {
        throw new Error('Document metadata missing timeScale or timeUnit');
      }

      const scaleFactor = scaleFromUnits(params.units) / (timeUnit * timeScale);
      time = Math.round(time * scaleFactor);
    }

    // Check time bounds (same logic as setMarkerAtTime)
    const timeEnd = document.metadata.timeEnd;
    if (time < 0 || time > timeEnd) {
      throw new Error(`Time ${time} is out of bounds (0 to ${timeEnd})`);
    }

    // Send message to webview to scroll viewport to the specified time
    if (document.webviewPanel) {
      document.webviewPanel.webview.postMessage({
        command: 'setViewportTo',
        time: time
      });
    } else {
      throw new Error('Webview not available');
    }

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleSetViewportRange(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.start === undefined || params.end === undefined) {
      throw new Error('start and end parameters are required');
    }

    const uri = document.uri;

    // Convert time units if provided, using the same logic as setMarkerAtTimeWithUnits
    let startTime = params.start;
    let endTime = params.end;

    if (params.units) {
      const metadata = document.metadata;
      const timeScale = metadata.timeScale;
      const timeUnit = scaleFromUnits(metadata.timeUnit);

      if (!timeScale || !timeUnit) {
        throw new Error('Document metadata missing timeScale or timeUnit');
      }

      const scaleFactor = scaleFromUnits(params.units) / (timeUnit * timeScale);
      startTime = Math.round(startTime * scaleFactor);
      endTime = Math.round(endTime * scaleFactor);
    }

    // Check time bounds
    const timeEnd = document.metadata.timeEnd;
    if (startTime < 0 || endTime > timeEnd || startTime >= endTime) {
      throw new Error(`Invalid time range: start_time ${startTime} to end_time ${endTime} (valid range: 0 to ${timeEnd})`);
    }

    // Send message to webview to set viewport range
    if (document.webviewPanel) {
      document.webviewPanel.webview.postMessage({
        command: 'setViewportRange',
        startTime: startTime,
        endTime: endTime
      });
    } else {
      throw new Error('Webview not available');
    }

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleZoomToFit(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const uri = document.uri;

    // Zoom to fit using the existing command
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri: uri });

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleLoad(params: any): Promise<any> {
    // load is an alias for open_document - both return ack response
    return this.loadDocumentAndReturnAck(params);
  }

  private async handleReload(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document to reload');
    }

    const uri = document.uri;
    const normalizedUriString = uri.toString();

    // Use original URI from params if provided, otherwise use document URI
    const originalUriString = params?.uri ? (typeof params.uri === 'string' ? params.uri : params.uri.toString()) : normalizedUriString;

    // Reload the document
    await vscode.commands.executeCommand('vaporview.reloadFile', uri);

    // Wait for reload to complete and send waveform_loaded event asynchronously
    this.waitForDocumentAndSendEvent(normalizedUriString, originalUriString).catch((error: any) => {
      this.viewerProvider.log.appendLine(`WCP: Error waiting for reloaded document ${originalUriString}: ${error.message}`);
    });

    // Return ack response with original URI format (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: originalUriString
    };
  }

  private async handleShutdown(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const uri = document.uri;

    // Close the document by closing its editor
    // Find all editors for this document and close them
    const tabs = vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .filter(tab => {
        const input = tab.input;
        if (input instanceof vscode.TabInputCustom) {
          return (input as any).uri?.toString() === uri.toString();
        }
        return false;
      });

    // Close all tabs for this document
    for (const tab of tabs) {
      await vscode.window.tabGroups.close(tab);
    }

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  // #region Deprecated WCP command handlers
  private async handleAddVariables(params: any): Promise<any> {
    // Deprecated command - maps to add_items functionality
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (!params.variables || !Array.isArray(params.variables)) {
      throw new Error('variables array is required');
    }

    if (params.variables.length === 0) {
      return { success: true, added_count: 0 };
    }

    // Add each variable - process sequentially
    let addedCount = 0;
    for (const variable of params.variables) {
      // Apply recursive flag from params if not specified in variable
      const variableWithRecursive = { ...variable };
      if (params.recursive !== undefined && variableWithRecursive.recursive === undefined) {
        variableWithRecursive.recursive = params.recursive;
      }

      const args = this.buildAddVariableArgs(variableWithRecursive, document.uri.toString());
      if (!args) {
        // Skip invalid variables but continue processing others
        continue;
      }

      try {
        await vscode.commands.executeCommand('waveformViewer.addVariable', args);
        addedCount++;
      } catch (error: any) {
        // Log error but continue processing other variables
        this.viewerProvider.log.appendLine(`WCP: Error adding variable: ${error.message}`);
      }
    }

    return { success: true, added_count: addedCount };
  }

  // #region VaporView-specific command handlers
  private async handleGetCapabilities(): Promise<any> {
    // Get server capabilities
    return {
      capabilities: await this.getCapabilitiesList()
    };
  }

  private async handleOpenDocument(params: any): Promise<any> {
    return this.loadDocumentAndReturnAck(params);
  }

  private async handleAddSignal(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    // Map WCP params to Vaporview API using helper function
    const args = this.buildAddVariableArgs(params, document.uri.toString());
    if (!args) {
      throw new Error('Signal must be specified with netlist_id, instance_path, or scope_path+name');
    }

    await vscode.commands.executeCommand('waveformViewer.addVariable', args);

    return { success: true };
  }

  private async handleRemoveSignal(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const args: any = {
      uri: document.uri.toString()
    };

    if (params.netlist_id !== undefined) {
      args.netlistId = params.netlist_id;
    } else if (params.instance_path) {
      args.instancePath = params.instance_path;
    } else if (params.scope_path && params.name) {
      args.scopePath = params.scope_path;
      args.name = params.name;
    } else {
      throw new Error('Signal must be specified with netlist_id, instance_path, or scope_path+name');
    }

    await vscode.commands.executeCommand('waveformViewer.removeVariable', args);

    return { success: true };
  }

  private async handleSetMarker(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.time === undefined) {
      throw new Error('Time parameter is required');
    }

    const args: any = {
      uri: document.uri.toString(),
      time: params.time,
      units: params.units,
      markerType: params.marker_type || 0 // 0 = main marker, 1 = alt marker
    };

    await vscode.commands.executeCommand('waveformViewer.setMarker', args);

    return { success: true };
  }

  private async handleGetMarker(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const state: any = await vscode.commands.executeCommand('waveformViewer.getViewerState', {
      uri: document.uri.toString()
    });

    if (!state) {
      throw new Error('Could not get viewer state');
    }

    const markerType = params.marker_type || 0;
    const markerTime = markerType === 0 ? state.markerTime : state.altMarkerTime;
    const timeUnit = state.displayTimeUnit || document.metadata.timeUnit;

    return {
      time: markerTime,
      units: timeUnit,
      marker_type: markerType
    };
  }

  private async handleGetViewerState(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const state: any = await vscode.commands.executeCommand('waveformViewer.getViewerState', {
      uri: document.uri.toString()
    });

    if (!state) {
      throw new Error('Could not get viewer state');
    }

    // Transform Vaporview state to WCP format
    return {
      uri: document.uri.toString(),
      marker_time: state.markerTime,
      alt_marker_time: state.altMarkerTime,
      time_unit: state.displayTimeUnit || document.metadata.timeUnit,
      zoom_ratio: state.zoomRatio,
      scroll_left: state.scrollLeft,
      displayed_signals: state.displayedSignals?.map((sig: any) => ({
        name: sig.name,
        id: sig.netlistId
      })) || []
    };
  }

  private async handleGetValuesAtTime(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (!params.instance_paths || !Array.isArray(params.instance_paths)) {
      throw new Error('instance_paths array is required');
    }

    const args: any = {
      uri: document.uri.toString(),
      time: params.time,
      instancePaths: params.instance_paths
    };

    const values: any = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', args);

    if (!values || !Array.isArray(values)) {
      return [];
    }

    return values.map((v: any) => ({
      instance_path: v.instancePath,
      value: v.value,
    }));
  }

  private async handleGetOpenDocuments(): Promise<any> {
    const docs: any = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');

    if (!docs) {
      return { documents: [], last_active_document: null };
    }

    return {
      documents: docs.documents?.map((uri: vscode.Uri) => uri.toString()) || [],
      last_active_document: docs.lastActiveDocument?.toString() || null
    };
  }

  // #region Helper functions
  private buildAddVariableArgs(variable: any, uri: string): any {
    // Helper function to build args for addVariable command from a variable/signal object
    const args: any = {
      uri: uri
    };

    if (variable.netlist_id !== undefined) {
      args.netlistId = variable.netlist_id;
    } else if (variable.instance_path) {
      args.instancePath = variable.instance_path;
    } else if (variable.scope_path && variable.name) {
      args.scopePath = variable.scope_path;
      args.name = variable.name;
    } else {
      return null; // Invalid variable specification
    }

    if (variable.msb !== undefined) args.msb = variable.msb;
    if (variable.lsb !== undefined) args.lsb = variable.lsb;
    if (variable.recursive !== undefined) args.recursive = variable.recursive;

    return args;
  }

  private async loadDocumentAndReturnAck(params: any): Promise<any> {
    if (!params || !params.uri) {
      throw new Error('uri parameter is required');
    }

    // Preserve the original URI format from input
    const originalUriString = typeof params.uri === 'string' ? params.uri : params.uri.toString();
    const parsed = vscode.Uri.parse(originalUriString);
    const uri = vscode.Uri.file(parsed.fsPath);

    // Check if file exists (WCP spec: respond instantly if file is found)
    try {
      await fs.promises.access(uri.fsPath, fs.constants.F_OK);
    } catch (error: any) {
      throw new Error(`File not found: ${uri.fsPath}`);
    }

    // Start loading the document asynchronously (don't wait for it)
    // Use original URI format for event, but normalized URI for document lookup
    const normalizedUriString = uri.toString();
    this.loadDocumentAndSendEvent(uri, normalizedUriString, originalUriString, params).catch((error: any) => {
      this.viewerProvider.log.appendLine(`WCP: Error loading document ${originalUriString}: ${error.message}`);
    });

    // Return ack response immediately with original URI format (WCP spec: respond instantly if file is found)
    return {
      type: "response",
      command: "ack",
      uri: originalUriString
    };
  }

  private async loadDocumentAndSendEvent(uri: vscode.Uri, normalizedUriString: string, originalUriString: string, params: any): Promise<void> {
    // Open the document with VaporView
    await vscode.commands.executeCommand('vaporview.openFile', {
      uri: uri,
      loadAll: params.load_all || false,
      maxSignals: params.max_signals || 64
    });

    // Wait for document to be loaded and send event with original URI format
    await this.waitForDocumentAndSendEvent(normalizedUriString, originalUriString);
  }

  private async waitForDocumentAndSendEvent(normalizedUriString: string, originalUriString: string): Promise<void> {
    // Wait for the document to be ready
    const maxWaitTime = 600000; // 600 seconds timeout
    const pollInterval = 100; // Poll every 100ms
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const document = this.viewerProvider.getDocumentFromUri(normalizedUriString);
      if (document && document.webviewInitialized) {
        // Document is ready - send waveform_loaded event with original URI format
        this.broadcastEvent({
          type: "event",
          event: "waveform_loaded",
          uri: originalUriString
        });
        return;
      }
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout - log error but don't throw (we already sent ack)
    this.viewerProvider.log.appendLine(`WCP: Document loading timeout for ${originalUriString}`);
  }

  private async getCapabilitiesList(): Promise<string[]> {
    return [
      // Standard WCP commands
      'greeting',
      'get_item_list',
      'get_item_info',
      'add_items',
      'load',
      'reload',
      'clear',
      'zoom_to_fit',
      'set_viewport_to',
      'set_viewport_range',
      'focus_item',
      'set_item_color',
      'set_value_format',
      'remove_items',
      'shutdown',
      'add_variables', // Deprecated but still supported
      // VaporView-specific commands
      'get_capabilities',
      'open_document',
      'close_document',
      'get_open_documents',
      'add_signal',
      'remove_signal',
      'set_marker',
      'get_marker',
      'get_viewer_state',
      'get_values_at_time',
    ];
  }

  private getDocumentFromParams(params: any): VaporviewDocument | undefined {
    if (params?.uri) {
      const path = typeof params.uri === 'string' ? params.uri : params.uri.toString();
      const parsed = vscode.Uri.parse(path);
      const uri = vscode.Uri.file(parsed.fsPath);
      return this.viewerProvider.getDocumentFromUri(uri.toString());
    }
    return this.viewerProvider.getActiveDocument || this.viewerProvider.getLastActiveDocument;
  }

  private sendResponse(connection: WCPConnection, response: WCPResponse): void {
    try {
      const jsonResponse = JSON.stringify(response) + '\n';
      connection.socket.write(jsonResponse, 'utf8');
    } catch (error: any) {
      this.viewerProvider.log.appendLine(`WCP server error sending response to ${connection.remoteAddress}: ${error.message}`);
    }
  }

  private broadcastEvent(event: { type: string;[key: string]: any }): void {
    // Broadcast event to all connected clients (events don't have an id)
    const eventMessage = JSON.stringify(event) + '\n';
    for (const connection of this.connections) {
      try {
        connection.socket.write(eventMessage, 'utf8');
      } catch (error: any) {
        this.viewerProvider.log.appendLine(`WCP server error broadcasting event to ${connection.remoteAddress}: ${error.message}`);
      }
    }
  }
}
