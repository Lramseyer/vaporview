import * as fs from 'fs';
import * as vscode from 'vscode';

import { scaleFromUnits } from '../common/functions';
import type { VaporviewDocument } from './document';
import type { NetlistItem } from './tree_view';
import { NodeTcpWcpServer } from './wcp/node_tcp_server';
import { WcpServer } from './wcp/generated/wcp_server';
import type {
  AckResponse,
  AddItemsParams,
  AddItemsResponse,
  DisplayedItemRef,
  FocusItemParams,
  GetItemInfoParams,
  GetItemInfoResponse,
  GetItemListResponse,
  LoadParams,
  RemoveItemsParams,
  SetCursorParams,
  SetItemColorParams,
  SetViewportRangeParams,
  SetViewportToParams,
  WcpEvent,
} from './wcp/generated/wcp_types';
import { WaveformViewerProvider } from './viewer_provider';

const ACK_RESPONSE: AckResponse = { type: 'response', command: 'ack' };

export interface WcpEndpoint {
  host: string;
  port: number;
}

interface WcpSession {
  documentUri?: string;
  sendEvent(event: WcpEvent): void;
  shutdown(): Promise<void>;
}

interface WcpListener {
  server: NodeTcpWcpServer;
  session: WcpSession;
}

async function waitForDocument(
  viewerProvider: WaveformViewerProvider,
  uri: string,
): Promise<VaporviewDocument> {
  const timeoutAt = Date.now() + 600_000;
  while (Date.now() < timeoutAt) {
    const document = viewerProvider.getDocumentFromUri(uri);
    if (document?.webviewInitialized) {
      return document;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for waveform viewer: ${uri}`);
}

class VaporviewWcpServer extends WcpServer {
  public constructor(
    private readonly viewerProvider: WaveformViewerProvider,
    private readonly session: WcpSession,
  ) {
    super();
  }

  public override getItemList(): GetItemListResponse {
    return {
      type: 'response',
      command: 'get_item_list',
      ids: this.getDocument().getDisplayedNetlistIds(),
    };
  }

  public override getItemInfo(params: GetItemInfoParams): GetItemInfoResponse {
    const document = this.getDocument();
    return {
      type: 'response',
      command: 'get_item_info',
      results: params.ids.map((id) => {
        const netlistId = this.getNetlistId(id);
        const item = document.netlistIdTable[netlistId];
        if (!item) {
          throw new Error(`Item not found: ${id}`);
        }
        return { name: item.instancePath(), type: item.type, id };
      }),
    };
  }

  public override setItemColor(params: SetItemColorParams): AckResponse {
    const document = this.getDocument();
    const netlistId = this.getNetlistId(params.id);
    const item = document.netlistIdTable[netlistId];
    if (!item) {
      throw new Error(`Item not found: ${params.id}`);
    }
    if (item.contextValue === 'netlistScope') {
      throw new Error('Cannot set color for scope items');
    }
    if (!document.isSignalDisplayed(netlistId)) {
      throw new Error(`Signal is not displayed: ${params.id}`);
    }

    const colorIndex = new Map<string, number>([
      ['green', 0],
      ['orange', 1],
      ['blue', 2],
      ['purple', 3],
      ['custom1', 4],
      ['custom2', 5],
      ['custom3', 6],
      ['custom4', 7],
    ]).get(params.color.toLowerCase());
    if (colorIndex !== undefined) {
      this.viewerProvider.setValueFormat({ netlistId }, 0, { colorIndex });
    }
    return ACK_RESPONSE;
  }

  public override async addItems(params: AddItemsParams): Promise<AddItemsResponse> {
    const document = this.getDocument();
    const ids: number[] = [];
    for (const path of params.items) {
      const item = await this.viewerProvider.getNetlistItemFromSignalName(document, path);
      if (!item) {
        continue;
      }
      if (item.contextValue === 'netlistVar') {
        ids.push(item.netlistId);
        continue;
      }

      const scopes: NetlistItem[] = [item];
      while (scopes.length > 0) {
        const scope = scopes.shift()!;
        const children = await document.getScopeChildren(scope);
        for (const child of children) {
          if (child.contextValue === 'netlistVar') {
            ids.push(child.netlistId);
          } else if (params.recursive && child.contextValue === 'netlistScope') {
            scopes.push(child);
          }
        }
      }
    }
    if (ids.length === 0) {
      throw new Error('No matching items were found');
    }
    await document.renderSignals(ids, [], undefined);
    await this.waitForItemsDisplayed(document, ids);
    document.reveal();
    return { type: 'response', command: 'add_items', ids };
  }

  public override removeItems(params: RemoveItemsParams): AckResponse {
    const document = this.getDocument();
    for (const id of params.ids) {
      const netlistId = this.getNetlistId(id);
      if (document.isSignalDisplayed(netlistId)) {
        document.removeSignalFromWebview(netlistId, undefined, false);
      }
    }
    return ACK_RESPONSE;
  }

  public override focusItem(params: FocusItemParams): AckResponse {
    const document = this.getDocument();
    const netlistId = this.getNetlistId(params.id);
    if (!document.netlistIdTable[netlistId]) {
      throw new Error(`Item not found: ${params.id}`);
    }
    if (!document.isSignalDisplayed(netlistId)) {
      throw new Error(`Signal is not displayed: ${params.id}`);
    }
    document.reveal();
    document.revealSignalInWebview(netlistId);
    return ACK_RESPONSE;
  }

  public override async setViewportTo(params: SetViewportToParams): Promise<AckResponse> {
    const document = this.getDocument();
    if (params.timestamp < 0 || params.timestamp > document.metadata.timeEnd) {
      throw new Error(`Time ${params.timestamp} is out of bounds (0 to ${document.metadata.timeEnd})`);
    }
    if (!document.webviewPanel) {
      throw new Error('Webview not available');
    }
    await document.webviewPanel.webview.postMessage({
      command: 'setViewportTo',
      time: params.timestamp,
    });
    return ACK_RESPONSE;
  }

  public override async setViewportRange(params: SetViewportRangeParams): Promise<AckResponse> {
    const document = this.getDocument();
    if (params.start < 0 || params.end > document.metadata.timeEnd || params.start >= params.end) {
      throw new Error(
        `Invalid time range: ${params.start} to ${params.end} (valid range: 0 to ${document.metadata.timeEnd})`,
      );
    }
    if (!document.webviewPanel) {
      throw new Error('Webview not available');
    }
    await document.webviewPanel.webview.postMessage({
      command: 'setViewportRange',
      startTime: params.start,
      endTime: params.end,
    });
    return ACK_RESPONSE;
  }

  public override async zoomToFit(): Promise<AckResponse> {
    const document = this.getDocument();
    await vscode.commands.executeCommand('vaporview.zoomToFit', { uri: document.uri });
    return ACK_RESPONSE;
  }

  public override async setCursor(params: SetCursorParams): Promise<AckResponse> {
    const document = this.getDocument();
    if (params.timestamp < 0 || params.timestamp > document.metadata.timeEnd) {
      throw new Error(`Time ${params.timestamp} is out of bounds (0 to ${document.metadata.timeEnd})`);
    }
    if (!document.webviewPanel) {
      throw new Error('Webview not available');
    }
    await document.webviewPanel.webview.postMessage({
      command: 'setMarker',
      time: params.timestamp,
      markerType: 0,
    });
    return ACK_RESPONSE;
  }

  public override async load(params: LoadParams): Promise<AckResponse> {
    const parsed = vscode.Uri.parse(params.source);
    const uri = parsed.scheme === 'file' ? vscode.Uri.file(parsed.fsPath) : vscode.Uri.file(params.source);
    await fs.promises.access(uri.fsPath, fs.constants.F_OK);
    this.session.documentUri = uri.toString();
    void this.loadDocumentAndSendEvent(uri, params.source).catch((error: unknown) => {
      this.viewerProvider.log.appendLine(
        `WCP: Error loading document ${params.source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return ACK_RESPONSE;
  }

  public override async reload(): Promise<AckResponse> {
    const document = this.getDocument();
    await vscode.commands.executeCommand('vaporview.reloadFile', document.uri);
    void this.waitForDocumentAndSendEvent(document.uri.toString(), document.uri.toString());
    return ACK_RESPONSE;
  }

  public override clear(): AckResponse {
    const document = this.getDocument();
    for (const id of document.getDisplayedNetlistIds()) {
      document.removeSignalFromWebview(id, undefined, false);
    }
    return ACK_RESPONSE;
  }

  public override shutdown(): AckResponse {
    setImmediate(() => {
      void this.session.shutdown().catch((error: unknown) => {
        this.viewerProvider.log.appendLine(
          `WCP server error while stopping: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    return ACK_RESPONSE;
  }

  private getDocument(): VaporviewDocument {
    if (!this.session.documentUri) {
      throw new Error('No waveform is loaded');
    }
    const document = this.viewerProvider.getDocumentFromUri(this.session.documentUri);
    if (!document) {
      throw new Error(`Waveform is not open: ${this.session.documentUri}`);
    }
    return document;
  }

  private getNetlistId(id: DisplayedItemRef): number {
    if (typeof id !== 'number') {
      throw new Error(`Vaporview does not recognize displayed item reference ${id}`);
    }
    return id;
  }

  private async loadDocumentAndSendEvent(uri: vscode.Uri, source: string): Promise<void> {
    await vscode.commands.executeCommand('vaporview.openFile', {
      uri,
      loadAll: false,
      maxSignals: 64,
    });
    await this.waitForDocumentAndSendEvent(uri.toString(), source);
  }

  private async waitForDocumentAndSendEvent(uri: string, source: string): Promise<void> {
    await waitForDocument(this.viewerProvider, uri);
    this.session.sendEvent({ type: 'event', event: 'waveforms_loaded', source });
  }

  private async waitForItemsDisplayed(document: VaporviewDocument, ids: number[]): Promise<void> {
    const timeoutAt = Date.now() + 30_000;
    while (Date.now() < timeoutAt) {
      const displayedIds = new Set(document.getDisplayedNetlistIds());
      if (ids.every((id) => displayedIds.has(id))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for VaporView to display WCP items');
  }
}

export class WCPServer implements vscode.Disposable {
  private readonly documentServers = new Map<string, WcpListener>();
  private configuredListener: WcpListener | undefined;
  private configuredPort: number | undefined;
  private configurationUpdate: Promise<void> = Promise.resolve();

  public constructor(
    private readonly viewerProvider: WaveformViewerProvider,
    context: vscode.ExtensionContext,
  ) {
    context.subscriptions.push(this.subscribeToCursorEvents());
  }

  public dispose(): void {
    const servers = [
      ...this.documentServers.values(),
      ...(this.configuredListener ? [this.configuredListener] : []),
    ];
    this.documentServers.clear();
    this.configuredListener = undefined;
    this.configuredPort = undefined;
    void Promise.all(servers.map(({ server }) => server.close())).catch((error: unknown) => {
      this.viewerProvider.log.appendLine(
        `WCP server error while stopping: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  public updateConfiguration(): Promise<void> {
    this.configurationUpdate = this.configurationUpdate
      .then(() => this.applyConfiguration())
      .catch((error: unknown) => {
        this.viewerProvider.log.appendLine(
          `WCP server configuration error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return this.configurationUpdate;
  }

  public async openWaveform(uri: vscode.Uri): Promise<WcpEndpoint> {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'vaporview.waveformViewer');
    const document = await waitForDocument(this.viewerProvider, uri.toString());
    document.reveal();

    const key = uri.toString();
    let listener = this.documentServers.get(key);
    if (!listener) {
      const newListener = await this.createListener(key, 0, async () => {
        if (this.documentServers.get(key) === newListener) {
          this.documentServers.delete(key);
        }
        await newListener.server.close();
      });
      listener = newListener;
      this.documentServers.set(key, listener);
      this.viewerProvider.log.appendLine(
        `WCP endpoint for ${uri.fsPath} started on TCP port ${listener.server.port}`,
      );
    }

    return { host: '127.0.0.1', port: listener.server.port };
  }

  private async applyConfiguration(): Promise<void> {
    const config = vscode.workspace.getConfiguration('vaporview');
    const enabled = config.get<boolean>('wcp.enabled', false);
    const port = config.get<number>('wcp.port', 54322);

    if (!enabled) {
      if (this.configuredListener) {
        const listener = this.configuredListener;
        this.configuredListener = undefined;
        this.configuredPort = undefined;
        await listener.server.close();
        this.viewerProvider.log.appendLine('Configured WCP endpoint stopped');
      }
      return;
    }

    if (this.configuredListener && this.configuredPort === port) {
      return;
    }
    if (this.configuredListener) {
      await this.configuredListener.server.close();
      this.configuredListener = undefined;
      this.configuredPort = undefined;
    }

    const listener = await this.createListener(undefined, port, async () => {
      if (this.configuredListener === listener) {
        this.configuredListener = undefined;
        this.configuredPort = undefined;
      }
      await listener.server.close();
    });
    this.configuredListener = listener;
    this.configuredPort = port;
    this.viewerProvider.log.appendLine(
      `Configured WCP endpoint started on 127.0.0.1:${listener.server.port}`,
    );
  }

  private async createListener(
    documentUri: string | undefined,
    port: number,
    shutdown: () => Promise<void>,
  ): Promise<WcpListener> {
    const session: WcpSession = {
      documentUri,
      sendEvent: () => undefined,
      shutdown,
    };
    const server = await NodeTcpWcpServer.listen(
      {
        port,
        onError: (error) => this.viewerProvider.log.appendLine(`WCP server error: ${error.message}`),
      },
      new VaporviewWcpServer(this.viewerProvider, session),
    );
    session.sendEvent = (event) => {
      server.broadcast(event);
    };
    return { server, session };
  }

  private subscribeToCursorEvents(): vscode.Disposable {
    return WaveformViewerProvider.markerSetEventEmitter.event((event) => {
      const document = this.viewerProvider.getDocumentFromUri(event.uri);
      if (!document) {
        return;
      }
      const timeUnit = scaleFromUnits(document.metadata.timeUnit);
      const eventUnit = scaleFromUnits(event.units);
      if (!timeUnit || !eventUnit || !document.metadata.timeScale) {
        return;
      }
      const timestamp = Math.round(event.time * eventUnit / (timeUnit * document.metadata.timeScale));
      for (const listener of [
        ...this.documentServers.values(),
        ...(this.configuredListener ? [this.configuredListener] : []),
      ]) {
        if (listener.session.documentUri === event.uri) {
          listener.server.broadcast({ type: 'event', event: 'cursor_set', timestamp });
        }
      }
    });
  }
}
