// Waveform Control Protocol (WCP) Server Implementation
// Based on WCP specification: https://gitlab.com/waveform-control-protocol/wcp
// Reference implementation: https://gitlab.com/surfer-project/surfer/-/tree/main/libsurfer/src/wcp

import * as net from 'net';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { scaleFromUnits } from '../common/functions';
import type { WaveformViewerProvider } from './viewer_provider';
import type { VaporviewDocument } from './document';
import {  } from './tree_view';
import type { VariableActionArgs, ViewerState, SetMarkerArgs, GetValuesAtTimeArgs, SavedRowItem } from '../../packages/vaporview-api/types';

// #region WCP param interfaces
interface WCPParamsWithUri {
  uri?: string | { toString(): string };
}

interface WCPAddItemsParams extends WCPParamsWithUri {
  items: string[];
  recursive?: boolean;
}

interface WCPItemIdsParams extends WCPParamsWithUri {
  ids: number[];
}

interface WCPItemIdParams extends WCPParamsWithUri {
  id: number;
  color?: string;
}

interface WCPSetValueFormatParams extends WCPParamsWithUri {
  id: number;
  format: string;
}

interface WCPViewportToParams extends WCPParamsWithUri {
  timestamp: number;
  units?: string;
}

interface WCPViewportRangeParams extends WCPParamsWithUri {
  start: number;
  end: number;
  units?: string;
}

interface WCPLoadParams extends WCPParamsWithUri {
  uri: string | { toString(): string };
  load_all?: boolean;
  max_signals?: number;
}

interface WCPAddVariablesParams extends WCPParamsWithUri {
  variables: WCPVariableSpec[];
  recursive?: boolean;
}

interface WCPVariableSpec {
  netlist_id?: number;
  instance_path?: string;
  scope_path?: string;
  name?: string;
  msb?: number;
  lsb?: number;
  recursive?: boolean;
}

interface WCPSignalParams extends WCPParamsWithUri, WCPVariableSpec {}

interface WCPSetMarkerParams extends WCPParamsWithUri {
  time: number;
  units?: string;
  marker_type?: number;
}

interface WCPGetMarkerParams extends WCPParamsWithUri {
  marker_type?: number;
}

interface WCPGetValuesAtTimeParams extends WCPParamsWithUri {
  time?: number;
  instance_paths: string[];
}

class WCPValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WCPValidationError';
  }
}

function validateParams<T>(params: Record<string, unknown> | undefined, required: (keyof T & string)[]): asserts params is Record<string, unknown> & T {
  if (!params) {
    throw new WCPValidationError(`Missing required parameters: ${required.join(', ')}`);
  }
  for (const key of required) {
    if (params[key] === undefined) {
      throw new WCPValidationError(`Missing required parameter: ${key}`);
    }
  }
}

interface WCPAckResponse {
  type: string;
  command: string;
  uri: string;
}

interface WCPGreetingResponse {
  name: string;
  version: string;
  protocol: string;
  protocol_version: string;
  capabilities: string[];
}

interface WCPGetItemInfoResponse {
  type: string;
  command: string;
  results: { name: string; type: string; id: number }[];
}

interface WCPGetItemListResponse {
  type: string;
  command: string;
  ids: number[];
}

interface WCPGetViewerStateResponse {
  uri: string;
  marker_time: number | null;
  alt_marker_time: number | null;
  time_unit: string;
  zoom_ratio: number;
  scroll_left: number;
  displayed_signals: { name: string; id: number | undefined }[];
}

interface WCPEvent {
  type: string;
  event?: string;
  uri?: string;
}

type WCPHandlerResult =
  | WCPGreetingResponse
  | WCPGetItemInfoResponse
  | WCPGetItemListResponse
  | WCPGetViewerStateResponse
  | WCPAckResponse
  | { ids: number[] }
  | { success: boolean; added_count?: number }
  | { success: boolean }
  | { capabilities: string[] }
  | { time: number | null; units: string; marker_type: number }
  | { instance_path: string; value: string | string[] }[]
  | { documents: string[]; last_active_document: string | null }
  | null;

interface WCPValueResult {
  instancePath: string;
  value: string | string[];
}

export interface WCPCommand {
  method: string;
  params?: Record<string, unknown>;
  id?: string | number;
}

export interface WCPResponse {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
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
    wcpServer.start();
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.viewerProvider.log.appendLine(`WCP server error parsing message from ${connection.remoteAddress}: ${errorMessage}`);
      this.viewerProvider.log.appendLine(`Message: ${message}`);

      // Send error response if we can parse the ID
      try {
        const parsed = JSON.parse(message);
        this.sendResponse(connection, {
          error: {
            code: -32700,
            message: 'Parse error',
            data: errorMessage
          },
          id: parsed.id
        });
      } catch {
        // If we can't even parse the message to get the ID, send a generic error
        this.sendResponse(connection, {
          error: {
            code: -32700,
            message: 'Parse error',
            data: errorMessage
          }
        });
      }
    }
  }

  // #region handleCommand
  private async handleCommand(command: WCPCommand): Promise<WCPResponse> {
    try {
      let result: WCPHandlerResult = null;

      // params comes from JSON.parse, so we cast to specific types per command.
      // Each handler validates its own params before use.
      const params = command.params;

      switch (command.method) {
        // Standard WCP commands
        case 'greeting':
          result = await this.handleGreeting();
          break;
        case 'add_items':
          validateParams<WCPAddItemsParams>(params, ['items']);
          result = await this.handleAddItems(params as WCPAddItemsParams);
          break;
        case 'get_item_info':
          validateParams<WCPItemIdsParams>(params, ['ids']);
          result = await this.handleGetItemInfo(params as WCPItemIdsParams);
          break;
        case 'get_item_list':
          result = await this.handleGetItemList(params as WCPParamsWithUri | undefined);
          break;
        case 'set_item_color':
          validateParams<WCPItemIdParams>(params, ['id', 'color']);
          result = await this.handleSetItemColor(params as WCPItemIdParams);
          break;
        case 'set_value_format':
          validateParams<WCPSetValueFormatParams>(params, ['id', 'format']);
          result = await this.handleSetValueFormat(params as WCPSetValueFormatParams);
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
          validateParams<WCPItemIdsParams>(params, ['ids']);
          result = await this.handleRemoveItems(params as WCPItemIdsParams);
          break;
        case 'focus_item':
          validateParams<WCPItemIdParams>(params, ['id']);
          result = await this.handleFocusItem(params as WCPItemIdParams);
          break;
        case 'set_viewport_to':
          validateParams<WCPViewportToParams>(params, ['timestamp']);
          result = await this.handleSetViewportTo(params as WCPViewportToParams);
          break;
        case 'set_viewport_range':
          validateParams<WCPViewportRangeParams>(params, ['start', 'end']);
          result = await this.handleSetViewportRange(params as WCPViewportRangeParams);
          break;
        case 'zoom_to_fit':
          result = await this.handleZoomToFit(params as WCPParamsWithUri | undefined);
          break;
        case 'load':
          validateParams<WCPLoadParams>(params, ['uri']);
          result = await this.handleLoad(params as WCPLoadParams);
          break;
        case 'reload':
          result = await this.handleReload(params as WCPParamsWithUri | undefined);
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
          result = await this.handleShutdown(params as WCPParamsWithUri | undefined);
          break;

        // Deprecated WCP commands
        case 'add_variables':
          validateParams<WCPAddVariablesParams>(params, ['variables']);
          result = await this.handleAddVariables(params as WCPAddVariablesParams);
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
          validateParams<WCPLoadParams>(params, ['uri']);
          result = await this.handleOpenDocument(params as WCPLoadParams);
          break;
        case 'add_signal':
          result = await this.handleAddSignal(params as WCPSignalParams | undefined);
          break;
        case 'remove_signal':
          result = await this.handleRemoveSignal(params as WCPSignalParams | undefined);
          break;
        case 'set_marker':
          validateParams<WCPSetMarkerParams>(params, ['time']);
          result = await this.handleSetMarker(params as WCPSetMarkerParams);
          break;
        case 'get_marker':
          result = await this.handleGetMarker(params as WCPGetMarkerParams | undefined);
          break;
        case 'get_viewer_state':
          result = await this.handleGetViewerState(params as WCPParamsWithUri | undefined);
          break;
        case 'get_values_at_time':
          validateParams<WCPGetValuesAtTimeParams>(params, ['instance_paths']);
          result = await this.handleGetValuesAtTime(params as WCPGetValuesAtTimeParams);
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
    } catch (error: unknown) {
      if (error instanceof WCPValidationError) {
        return {
          error: {
            code: -32602,
            message: `Invalid params: ${error.message}`
          },
          id: command.id
        };
      }
      return {
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Internal error'
        },
        id: command.id
      };
    }
  }

  // #region Standard WCP command handlers
  private async handleGreeting(): Promise<WCPGreetingResponse> {
    // Greeting command - initial handshake
    // Returns server information, protocol version, and capabilities
    return {
      name: 'Vaporview',
      version: '1.5.2',
      protocol: 'WCP',
      protocol_version: '0',
      capabilities: await this.getCapabilitiesList()
    };
  }

  private async handleAddItems(params: WCPAddItemsParams): Promise<{ ids: number[] }> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.items.length === 0) {
      return { ids: [] };
    }

    await this.viewerProvider.addItemsToDocument(document, { items: params.items, recursive: params.recursive });

    // TODO(heyfey): Return the IDs for added items
    return { ids: [] };
  }

  private async handleGetItemInfo(params: WCPItemIdsParams): Promise<WCPGetItemInfoResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    // Process each ID in order and build results array
    const results: { name: string; type: string; id: number }[] = [];

    for (const netlistId of params.ids) {
      // Get the item from netlistIdTable
      const item = document.netlistIdTable[netlistId];
      if (!item) {
        throw new Error(`Item not found: ${netlistId}`);
      }

      // Get the full instance path as the name using the helper function
      const instancePath = item.instancePath();

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

  private async handleGetItemList(params: WCPParamsWithUri | undefined): Promise<WCPGetItemListResponse> {
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

  private async handleSetItemColor(params: WCPItemIdParams): Promise<WCPAckResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
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

    const colorIndex = colorMap[params.color!.toLowerCase()];

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
    this.viewerProvider.setValueFormat({netlistId: netlistId}, 0, { colorIndex: colorIndex });

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleSetValueFormat(params: WCPSetValueFormatParams): Promise<WCPAckResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
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
    this.viewerProvider.setValueFormat({netlistId: netlistId}, 0, { valueFormat: format });

    // Return ack response with uri (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: uri.toString()
    };
  }

  private async handleRemoveItems(params: WCPItemIdsParams): Promise<WCPAckResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
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
      // Check if the signal is displayed before trying to remove it
      if (!document.isSignalDisplayed(netlistId)) {
        // Signal not displayed, skip it (don't throw error)
        continue;
      }

      // Remove the signal using the document's uri
      const args: VariableActionArgs = {
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

  private async handleFocusItem(params: WCPItemIdParams): Promise<WCPAckResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
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

  private async handleSetViewportTo(params: WCPViewportToParams): Promise<WCPAckResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
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

  private async handleSetViewportRange(params: WCPViewportRangeParams): Promise<WCPAckResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
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

  private async handleZoomToFit(params: WCPParamsWithUri | undefined): Promise<WCPAckResponse> {
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

  private async handleLoad(params: WCPLoadParams): Promise<WCPAckResponse> {
    // load is an alias for open_document - both return ack response
    return this.loadDocumentAndReturnAck(params);
  }

  private async handleReload(params: WCPParamsWithUri | undefined): Promise<WCPAckResponse> {
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
    this.waitForDocumentAndSendEvent(normalizedUriString, originalUriString).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.viewerProvider.log.appendLine(`WCP: Error waiting for reloaded document ${originalUriString}: ${errorMessage}`);
    });

    // Return ack response with original URI format (WCP spec format)
    return {
      type: "response",
      command: "ack",
      uri: originalUriString
    };
  }

  private async handleShutdown(params: WCPParamsWithUri | undefined): Promise<WCPAckResponse> {
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
          return input.uri?.toString() === uri.toString();
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
  private async handleAddVariables(params: WCPAddVariablesParams): Promise<{ success: boolean; added_count: number }> {
    // Deprecated command - maps to add_items functionality
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    if (params.variables.length === 0) {
      return { success: true, added_count: 0 };
    }

    // Add each variable - process sequentially
    let addedCount = 0;
    for (const variable of params.variables) {
      // Apply recursive flag from params if not specified in variable
      const variableWithRecursive: WCPVariableSpec = { ...variable };
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
      } catch (error: unknown) {
        // Log error but continue processing other variables
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.viewerProvider.log.appendLine(`WCP: Error adding variable: ${errorMessage}`);
      }
    }

    return { success: true, added_count: addedCount };
  }

  // #region VaporView-specific command handlers
  private async handleGetCapabilities(): Promise<{ capabilities: string[] }> {
    // Get server capabilities
    return {
      capabilities: await this.getCapabilitiesList()
    };
  }

  private async handleOpenDocument(params: WCPLoadParams): Promise<WCPAckResponse> {
    return this.loadDocumentAndReturnAck(params);
  }

  private async handleAddSignal(params: WCPSignalParams | undefined): Promise<{ success: boolean }> {
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

  private async handleRemoveSignal(params: WCPSignalParams | undefined): Promise<{ success: boolean }> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const args: VariableActionArgs = {
      uri: document.uri.toString()
    };

    if (params?.netlist_id !== undefined) {
      args.netlistId = params.netlist_id;
    } else if (params?.instance_path) {
      args.instancePath = params.instance_path;
    } else if (params?.scope_path && params?.name) {
      args.scopePath = params.scope_path;
      args.name = params.name;
    } else {
      throw new Error('Signal must be specified with netlist_id, instance_path, or scope_path+name');
    }

    await vscode.commands.executeCommand('waveformViewer.removeVariable', args);

    return { success: true };
  }

  private async handleSetMarker(params: WCPSetMarkerParams): Promise<{ success: boolean }> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const args: SetMarkerArgs = {
      uri: document.uri.toString(),
      time: params.time,
      units: params.units,
      markerType: params.marker_type || 0 // 0 = main marker, 1 = alt marker
    };

    await vscode.commands.executeCommand('waveformViewer.setMarker', args);

    return { success: true };
  }

  private async handleGetMarker(params: WCPGetMarkerParams | undefined): Promise<{ time: number | null; units: string; marker_type: number }> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const state = await vscode.commands.executeCommand<ViewerState | undefined>('waveformViewer.getViewerState', {
      uri: document.uri.toString()
    });

    if (!state) {
      throw new Error('Could not get viewer state');
    }

    const markerType = params?.marker_type || 0;
    const markerTime = markerType === 0 ? state.markerTime : state.altMarkerTime;
    const timeUnit = state.displayTimeUnit || document.metadata.timeUnit;

    return {
      time: markerTime,
      units: timeUnit,
      marker_type: markerType
    };
  }

  private async handleGetViewerState(params: WCPParamsWithUri | undefined): Promise<WCPGetViewerStateResponse> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const state = await vscode.commands.executeCommand<ViewerState | undefined>('waveformViewer.getViewerState', {
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
      displayed_signals: state.displayedSignals?.map((sig: SavedRowItem) => {
        const name = 'name' in sig ? sig.name
          : 'groupName' in sig ? sig.groupName
          : 'label' in sig ? sig.label
          : '';
        const id = 'netlistId' in sig ? sig.netlistId : undefined;
        return { name, id };
      }) || []
    };
  }

  private async handleGetValuesAtTime(params: WCPGetValuesAtTimeParams): Promise<{ instance_path: string; value: string | string[] }[]> {
    const document = this.getDocumentFromParams(params);
    if (!document) {
      throw new Error('No active document');
    }

    const args: GetValuesAtTimeArgs = {
      uri: document.uri.toString(),
      time: params.time,
      instancePaths: params.instance_paths
    };

    const values = await vscode.commands.executeCommand<WCPValueResult[] | undefined>('waveformViewer.getValuesAtTime', args);

    if (!values || !Array.isArray(values)) {
      return [];
    }

    return values.map((v: WCPValueResult) => ({
      instance_path: v.instancePath,
      value: v.value,
    }));
  }

  private async handleGetOpenDocuments(): Promise<{ documents: string[]; last_active_document: string | null }> {
    const docs = await vscode.commands.executeCommand<string[] | undefined>('waveformViewer.getOpenDocuments');

    if (!docs) {
      return { documents: [], last_active_document: null };
    }

    return {
      documents: docs,
      last_active_document: null
    };
  }

  // #region Helper functions
  private buildAddVariableArgs(variable: WCPVariableSpec | undefined, uri: string): VariableActionArgs | null {
    // Helper function to build args for addVariable command from a variable/signal object
    if (!variable) {
      return null;
    }

    const args: VariableActionArgs = {
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

  private async loadDocumentAndReturnAck(params: WCPLoadParams): Promise<WCPAckResponse> {
    // Preserve the original URI format from input
    const originalUriString = typeof params.uri === 'string' ? params.uri : params.uri.toString();
    const parsed = vscode.Uri.parse(originalUriString);
    const uri = vscode.Uri.file(parsed.fsPath);

    // Check if file exists (WCP spec: respond instantly if file is found)
    try {
      await fs.promises.access(uri.fsPath, fs.constants.F_OK);
    } catch {
      throw new Error(`File not found: ${uri.fsPath}`);
    }

    // Start loading the document asynchronously (don't wait for it)
    // Use original URI format for event, but normalized URI for document lookup
    const normalizedUriString = uri.toString();
    this.loadDocumentAndSendEvent(uri, normalizedUriString, originalUriString, params).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.viewerProvider.log.appendLine(`WCP: Error loading document ${originalUriString}: ${errorMessage}`);
    });

    // Return ack response immediately with original URI format (WCP spec: respond instantly if file is found)
    return {
      type: "response",
      command: "ack",
      uri: originalUriString
    };
  }

  private async loadDocumentAndSendEvent(uri: vscode.Uri, normalizedUriString: string, originalUriString: string, params: WCPLoadParams): Promise<void> {
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

  private getDocumentFromParams(params: WCPParamsWithUri | undefined): VaporviewDocument | undefined {
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.viewerProvider.log.appendLine(`WCP server error sending response to ${connection.remoteAddress}: ${errorMessage}`);
    }
  }

  private broadcastEvent(event: WCPEvent): void {
    // Broadcast event to all connected clients (events don't have an id)
    const eventMessage = JSON.stringify(event) + '\n';
    for (const connection of this.connections) {
      try {
        connection.socket.write(eventMessage, 'utf8');
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.viewerProvider.log.appendLine(`WCP server error broadcasting event to ${connection.remoteAddress}: ${errorMessage}`);
      }
    }
  }
}
