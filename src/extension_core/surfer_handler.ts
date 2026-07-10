import * as vscode from 'vscode';
import type { SignalId, ValueChangeDataChunk } from '../common/types';
import type { VaporviewDocumentDelegate } from './viewer_provider';
import { type NetlistItem, createScope, createVar } from './tree_view';
import { WasmWorkerBase, createWorker, type WorkerLike } from './wasm_handler';

const CHUNK_SIZE = 1024 * 32;

const enum ChunkType {
  Hierarchy = 0,
  TimeTable = 1,
  Signals   = 2,
}

export class SurferFormatHandler extends WasmWorkerBase {
  private readonly serverUrl:    string;
  private readonly bearerToken?: string;

  private constructor(
    providerDelegate: VaporviewDocumentDelegate,
    uri:          vscode.Uri,
    serverUrl:    string,
    wasmWorker:   WorkerLike,
    onMessage:    (handler: (data: unknown) => void) => void,
    bearerToken?: string,
  ) {
    super(providerDelegate, uri, wasmWorker, onMessage);
    this.serverUrl   = serverUrl;
    this.bearerToken = bearerToken;
  }

  static async create(
    providerDelegate: VaporviewDocumentDelegate,
    uri:            vscode.Uri,
    serverUrl:      string,
    wasmWorkerFile: string,
    wasmModule:     WebAssembly.Module,
    bearerToken?:   string,
  ): Promise<SurferFormatHandler> {
    const { worker, onMessage } = createWorker(wasmWorkerFile);
    const handler = new SurferFormatHandler(
      providerDelegate, uri, serverUrl, worker, onMessage, bearerToken);
    await handler.init(wasmModule);
    return handler;
  }

  async loadNetlist(): Promise<void> {
    this.providerDelegate.logOutputChannel('Connecting to remote server: ' + this.serverUrl);
    await vscode.window.withProgress({
      location:    vscode.ProgressLocation.Notification,
      title:       'Connecting to remote server ' + this.serverUrl,
      cancellable: false,
    }, async () => {
      try {
        await this._loadRemoteHierarchy();
      } catch (error) {
        this.providerDelegate.logOutputChannel('Failed to connect to remote server: ' + error);
        throw error;
      }
    });
    this.netlistSearchable = true;
  }

  async loadBody(): Promise<void> {
    try {
      await this._loadRemoteTimeTable();
    } catch (error) {
      this.providerDelegate.logOutputChannel('Failed to connect to remote server: ' + error);
      throw error;
    }
    await this.loadTopLevelParameters();
  }

  async getSignalData(signalIdList: SignalId[]): Promise<void> {
    try {
      await this._loadRemoteSignals(signalIdList);
    } catch (error) {
      this.providerDelegate.logOutputChannel('Failed to get signal data from remote server: ' + error);
      signalIdList.forEach(signalId => {
        this.postMessageToWebview({
          command:             'update-waveform-chunk',
          signalId:            signalId,
          transitionDataChunk: '[]',
          totalChunks:         1,
          chunkNum:            0,
          min:                 0,
          max:                 1,
        } as ValueChangeDataChunk);
      });
    }
  }

  // Override to deduplicate bits of same-name buses returned by the remote server
  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) { return this.netlistTop; }
    if (element.children.length > 0) { return element.children; }

    const scopePath    = element.scopePath.concat([element.name]);
    let itemsRemaining = Infinity;
    let startIndex     = 0;
    let callLimit      = 255;
    const result: NetlistItem[] = [];
    const varTable: Record<string, NetlistItem[]> = {};

    while (itemsRemaining > 0) {
      const response   = await this.sendCommand('getchildren', {
        netlistId: element.netlistId, startIndex,
      });
      const childItems = JSON.parse(response.result as string);
      itemsRemaining   = childItems.remainingItems;
      startIndex      += childItems.totalReturned;

      (childItems.scopes as { name: string; type: string; id: number }[])?.forEach((child) => {
        result.push(createScope(child.name, child.type, scopePath, child.id, -1, this.uri));
      });
      (childItems.vars as {
        name: string; paramValue: string; type: string; encoding: string;
        netlistId: number; signalId: number; width: number;
        msb: number; lsb: number; enumType: string;
      }[])?.forEach((child) => {
        const encoding = child.encoding.split('(')[0];
        const varItem  = createVar(
          child.name, child.paramValue, child.type, encoding,
          scopePath, child.netlistId, child.signalId,
          child.width, child.msb, child.lsb, child.enumType, false /*isFsdb*/, this.uri,
        );
        if (varTable[child.name] === undefined) {
          varTable[child.name] = [varItem];
        } else {
          varTable[child.name].push(varItem);
        }
      });

      callLimit--;
      if (callLimit <= 0) { break; }
    }

    for (const value of Object.values(varTable)) {
      if (value.length === 1) {
        result.push(value[0]);
      } else {
        const bitList:  NetlistItem[] = [];
        const busList:  NetlistItem[] = [];
        let maxWidth = 0;
        let parent: NetlistItem | undefined;
        value.forEach((varItem) => {
          if (varItem.width === 1) { bitList.push(varItem); }
          else { busList.push(varItem); }
        });
        busList.forEach((busItem) => {
          if (busItem.width > maxWidth) { maxWidth = busItem.width; parent = busItem; }
          result.push(busItem);
        });
        if (parent !== undefined) {
          parent.children       = bitList;
          parent.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        } else {
          result.push(...bitList);
        }
      }
    }

    return result;
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  private async _httpFetch(path: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }
    const response = await fetch(`${this.serverUrl}/${path}`, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
  }

  private async _sendChunks(
    data:      Uint8Array,
    chunkType: ChunkType,
  ): Promise<void> {
    const totalChunks = Math.ceil(data.length / CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const chunk = data.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, data.length));
      await this.sendCommand('loadremotechunk', {
        chunkType,
        chunkData:   chunk,
        chunkIndex:  i,
        totalChunks,
      }, [chunk.buffer]);
    }
  }

  async loadRemoteStatus(): Promise<string> {
    const response     = await this._httpFetch('get_status');
    const statusText   = await response.text();
    const statusBytes  = new TextEncoder().encode(statusText);
    const result       = await this.sendCommand('loadremotestatus', { status: statusBytes }, [statusBytes.buffer]);
    return result.result as string;
  }

  private async _loadRemoteHierarchy(): Promise<void> {
    const response = await this._httpFetch('get_hierarchy');
    const bytes    = new Uint8Array(await response.arrayBuffer());
    await this._sendChunks(bytes, ChunkType.Hierarchy);
  }

  private async _loadRemoteTimeTable(): Promise<void> {
    const response = await this._httpFetch('get_time_table');
    const bytes    = new Uint8Array(await response.arrayBuffer());
    await this._sendChunks(bytes, ChunkType.TimeTable);
  }

  private async _loadRemoteSignals(signalIds?: SignalId[]): Promise<void> {
    let path = 'get_signals';
    if (signalIds && signalIds.length > 0) {
      path += '/' + signalIds.join('/');
    }
    const response = await this._httpFetch(path);
    const bytes    = new Uint8Array(await response.arrayBuffer());
    await this._sendChunks(bytes, ChunkType.Signals);
  }
}
