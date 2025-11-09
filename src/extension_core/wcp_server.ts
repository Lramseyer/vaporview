// Waveform Control Protocol (WCP) Server Implementation
// Based on WCP specification: https://gitlab.com/waveform-control-protocol/wcp
// Reference implementation: https://gitlab.com/surfer-project/surfer/-/tree/main/libsurfer/src/wcp

import * as net from 'net';
import * as vscode from 'vscode';
import { WaveformViewerProvider } from './viewer_provider';
import { VaporviewDocument } from './document';

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
    port: number = 0 // 0 means auto-assign
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

  private async handleCommand(command: WCPCommand): Promise<WCPResponse> {
    try {
      let result: any = null;

      switch (command.method) {
        case 'greeting':
          result = await this.handleGreeting(command.params);
          break;
        case 'get_capabilities':
          result = await this.handleGetCapabilities();
          break;
        case 'open_document':
          result = await this.handleOpenDocument(command.params);
          break;
        case 'close_document':
          result = await this.handleCloseDocument(command.params);
          break;
        case 'get_signals':
          result = await this.handleGetSignals(command.params);
          break;
        case 'get_hierarchy':
          result = await this.handleGetHierarchy(command.params);
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
        case 'navigate_time':
          result = await this.handleNavigateTime(command.params);
          break;
        case 'get_signal_info':
          result = await this.handleGetSignalInfo(command.params);
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

  private async handleAddSignal(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    // Map WCP params to Vaporview API
    const args: any = {
      uri: params.uri ? vscode.Uri.parse(params.uri) : undefined
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

    if (params.msb !== undefined) args.msb = params.msb;
    if (params.lsb !== undefined) args.lsb = params.lsb;

    await vscode.commands.executeCommand('waveformViewer.addVariable', args);
    
    return { success: true };
  }

  private async handleRemoveSignal(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const args: any = {
      uri: params.uri ? vscode.Uri.parse(params.uri) : undefined
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
      uri: params.uri ? vscode.Uri.parse(params.uri) : undefined,
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
      uri: params.uri ? vscode.Uri.parse(params.uri) : undefined
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
      uri: params.uri ? vscode.Uri.parse(params.uri) : undefined
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
        netlist_id: sig.netlistId,
        instance_path: sig.instancePath,
        name: sig.name
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
      uri: params.uri ? vscode.Uri.parse(params.uri) : undefined,
      time: params.time,
      instancePaths: params.instance_paths
    };

    const values: any = await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', args);
    
    if (!values || !Array.isArray(values)) {
      return [];
    }

    // Transform to WCP format
    return values.map((v: any) => ({
      instance_path: v.instancePath,
      value: v.value,
      previous_value: v.value.length > 1 ? v.value[0] : undefined,
      current_value: v.value.length > 0 ? v.value[v.value.length - 1] : undefined
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

  private async handleNavigateTime(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.direction === undefined) {
      throw new Error('direction parameter is required (next_edge, previous_edge, or time_value)');
    }

    // For time navigation, we'll use the set_marker command
    if (params.direction === 'time_value' && params.time !== undefined) {
      return this.handleSetMarker({
        uri: params.uri,
        time: params.time,
        units: params.units
      });
    }

    // For edge navigation, we need to use key bindings
    // This is a simplified implementation - actual edge detection would require more complex logic
    const webviews = Array.from(this.viewerProvider['webviews'].get(document.uri));
    if (webviews.length > 0) {
      const panel = webviews[0];
      if (params.direction === 'next_edge') {
        await vscode.commands.executeCommand('vaporview.nextEdge', { uri: document.uri });
      } else if (params.direction === 'previous_edge') {
        await vscode.commands.executeCommand('vaporview.previousEdge', { uri: document.uri });
      }
    }

    return { success: true };
  }

  private async handleGetSignalInfo(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    let netlistId: number | undefined;
    
    if (params.netlist_id !== undefined) {
      netlistId = params.netlist_id;
    } else if (params.instance_path) {
      // Try to find netlistId from instance path
      const netlistItem = await document.findTreeItem(params.instance_path, undefined, undefined);
      if (netlistItem) {
        netlistId = netlistItem.netlistId;
      }
    }

    if (netlistId === undefined) {
      throw new Error('Could not find signal');
    }

    const netlistIdRef = document.netlistIdTable[netlistId];
    if (!netlistIdRef) {
      throw new Error('Signal not found');
    }

    const item = netlistIdRef.netlistItem;
    
    return {
      netlist_id: netlistId,
      instance_path: item.scopePath ? `${item.scopePath}.${item.name}` : item.name,
      scope_path: item.scopePath || '',
      name: item.name,
      type: item.type,
      width: item.width || 0,
      encoding: item.encoding || 'none'
    };
  }

  private async handleGreeting(params: any): Promise<any> {
    // Greeting command - initial handshake
    // Returns server information, protocol version, and capabilities
    return {
      name: 'VaporView',
      version: '1.4.3',
      protocol: 'WCP',
      protocol_version: '1.0',
      capabilities: await this.getCapabilitiesList()
    };
  }

  private async handleGetCapabilities(): Promise<any> {
    // Get server capabilities
    return {
      capabilities: await this.getCapabilitiesList()
    };
  }

  private async getCapabilitiesList(): Promise<string[]> {
    return [
      'greeting',
      'get_capabilities',
      'open_document',
      'close_document',
      'get_open_documents',
      'get_signals',
      'get_hierarchy',
      'add_signal',
      'remove_signal',
      'get_signal_info',
      'set_marker',
      'get_marker',
      'get_viewer_state',
      'get_values_at_time',
      'navigate_time'
    ];
  }

  private async handleOpenDocument(params: any): Promise<any> {
    if (!params || !params.uri) {
      throw new Error('uri parameter is required');
    }

    const uri = vscode.Uri.parse(params.uri);
    
    // Open the document with VaporView
    await vscode.commands.executeCommand('vaporview.openFile', {
      uri: uri,
      loadAll: params.load_all || false,
      maxSignals: params.max_signals || 64
    });

    return { success: true, uri: uri.toString() };
  }

  private async handleCloseDocument(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('Document not found');
    }

    // Close the document
    const uri = document.uri;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    
    // Also try to close via document URI if available
    const allDocs = await vscode.commands.executeCommand('waveformViewer.getOpenDocuments');
    // if (allDocs && allDocs.documents) {
    //   // Document will be closed by VS Code when editor is closed
    // }

    return { success: true, uri: uri.toString() };
  }

  private async handleGetSignals(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    // Get all signals from the document
    const signals: any[] = [];
    
    // Iterate through netlistIdTable to get all signals
    for (const netlistId in document.netlistIdTable) {
      const netlistIdRef = document.netlistIdTable[parseInt(netlistId)];
      if (netlistIdRef && netlistIdRef.netlistItem) {
        const item = netlistIdRef.netlistItem;
        signals.push({
          netlist_id: parseInt(netlistId),
          instance_path: item.scopePath ? `${item.scopePath}.${item.name}` : item.name,
          scope_path: item.scopePath || '',
          name: item.name,
          type: item.type,
          width: item.width || 0,
          encoding: item.encoding || 'none'
        });
      }
    }

    return {
      signals: signals,
      count: signals.length
    };
  }

  private async handleGetHierarchy(params: any): Promise<any> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    // Get signal hierarchy
    // This returns a tree structure of scopes and signals
    const buildHierarchy = (item: any): any => {
      const result: any = {
        name: item.name,
        scope_path: item.scopePath || '',
        type: item.type,
        netlist_id: item.netlistId
      };

      if (item.width !== undefined) {
        result.width = item.width;
      }
      if (item.encoding) {
        result.encoding = item.encoding;
      }
      if (item.msb !== undefined) {
        result.msb = item.msb;
      }
      if (item.lsb !== undefined) {
        result.lsb = item.lsb;
      }

      // Get children if this is a scope (children are loaded on demand)
      if (item.children && item.children.length > 0) {
        result.children = item.children.map((child: any) => buildHierarchy(child));
      }

      return result;
    };

    // Get root items from the document's treeData
    const hierarchy: any[] = [];
    
    if (document.treeData && document.treeData.length > 0) {
      for (const item of document.treeData) {
        hierarchy.push(buildHierarchy(item));
      }
    } else {
      // If treeData is empty, try to get root items via getChildrenExternal
      const rootItems = await document.getChildrenExternal(undefined);
      if (rootItems && rootItems.length > 0) {
        for (const item of rootItems) {
          hierarchy.push(buildHierarchy(item));
        }
      }
    }

    return {
      hierarchy: hierarchy,
      uri: document.uri.toString()
    };
  }

  private getDocumentFromParams(params: any): VaporviewDocument | undefined {
    if (params?.uri) {
      return this.viewerProvider.getDocumentFromUri(params.uri);
    }
    return this.viewerProvider.getActiveDocument() || this.viewerProvider.getLastActiveDocument();
  }

  private sendResponse(connection: WCPConnection, response: WCPResponse): void {
    try {
      const jsonResponse = JSON.stringify(response) + '\n';
      connection.socket.write(jsonResponse, 'utf8');
    } catch (error: any) {
      this.viewerProvider.log.appendLine(`WCP server error sending response to ${connection.remoteAddress}: ${error.message}`);
    }
  }
}
