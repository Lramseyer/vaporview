import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import type { EnumQueueEntry, SignalId, ValueChangeDataChunk, CompressedValueChangeDataChunk, EnumDataChunk } from '../common/types';

import type { VaporviewDocumentDelegate } from './viewer_provider';
import { filehandler } from './filehandler';
import { type NetlistItem, createScope, createVar } from './tree_view';
import type { WaveformFileParser, WaveformDumpMetadata } from './document';


export class SurferFormatHandler implements WaveformFileParser {
  private providerDelegate: VaporviewDocumentDelegate;
  private uri: vscode.Uri;
  private serverUrl: string;
  private bearerToken?: string;
  private wasmWorker: Worker;
  private wasmModule: WebAssembly.Module;
  private wasmApi: any;

  // Top level netlist items
  private netlistTop: NetlistItem[] = [];
  private parametersLoaded: boolean = false;

  public postMessageToWebview = (message: any) => {};
  public metadata: WaveformDumpMetadata = {
    timeTableLoaded: false,
    scopeCount: 0,
    netlistIdCount: 0,
    signalIdCount: 0,
    timeTableCount: 0,
    timeEnd: 0,
    defaultZoom: 1,
    timeScale: 1,
    timeUnit: "ns",
    chunkSize: 1
  };

  constructor(
    providerDelegate: VaporviewDocumentDelegate,
    uri: vscode.Uri,
    serverUrl: string,
    wasmWorker: Worker,
    wasmModule: WebAssembly.Module,
    bearerToken?: string,
  ) {
    this.providerDelegate = providerDelegate;
    this.uri = uri;
    this.serverUrl = serverUrl;
    this.wasmWorker = wasmWorker;
    this.wasmModule = wasmModule;
    this.bearerToken = bearerToken;
  }

  static async create(
    providerDelegate: VaporviewDocumentDelegate,
    uri: vscode.Uri,
    serverUrl: string,
    wasmWorkerFile: string,
    wasmModule: WebAssembly.Module,
    bearerToken?: string,
  ): Promise<SurferFormatHandler> {
    const wasmWorker = new Worker(wasmWorkerFile);
    const handler = new SurferFormatHandler(providerDelegate, uri, serverUrl, wasmWorker, wasmModule, bearerToken);
    await handler.initWasmApi();
    return handler;
  }

  private async initWasmApi() {
    this.wasmApi = await filehandler._.bind(this.service, this.wasmModule, this.wasmWorker);
  }

  // WASM service callbacks
  private readonly service: filehandler.Imports.Promisified = {
    log: (msg: string) => { console.log(msg); },
    outputlog: (msg: string) => { this.providerDelegate.logOutputChannel(msg); },
    fsread: (fd: number, offset: bigint, length: number): Uint8Array => {
      // Remote server doesn't use direct file reads, return empty buffer
      return new Uint8Array(Math.max(0, length));
    },
    getsize: (fd: number): bigint => {
      // Remote server doesn't use direct file access
      return BigInt(0);
    },
    setscopetop: (name: string, id: number, tpe: string) => {
      const scope = createScope(name, tpe, [], id, -1, this.uri);
      this.netlistTop.push(scope);
    },
    setvartop: (name: string, id: number, signalid: number, tpe: string, encoding: string, width: number, msb: number, lsb: number, enumtype: string) => {
      const varItem = createVar(name, "", tpe, encoding, [], id, signalid, width, msb, lsb, enumtype, false /*isFsdb*/, this.uri);
      this.netlistTop.push(varItem);
    },
    setmetadata: (scopecount: number, varcount: number, timescale: number, timeunit: string) => {
      this.metadata.scopeCount = scopecount;
      this.metadata.netlistIdCount = varcount;
      this.metadata.timeScale = timescale;
      this.metadata.timeUnit = timeunit;
    },
    setchunksize: (chunksize: bigint, timeend: bigint, timetablelength: bigint) => {
      this.metadata.timeEnd = Number(timeend);
      this.metadata.timeTableCount = Number(timetablelength);
      this.metadata.timeTableLoaded = true;
      this.metadata.chunkSize = Number(chunksize);
    },
    sendtransitiondatachunk: (signalid: number, totalchunks: number, chunknum: number, min: number, max: number, transitionData: string) => {
      this.postMessageToWebview({
        command: 'update-waveform-chunk',
        signalId: signalid,
        transitionDataChunk: transitionData,
        totalChunks: totalchunks,
        chunkNum: chunknum,
        min: min,
        max: max
      } as ValueChangeDataChunk);
    },
    sendenumdata: (name: string, totalchunks: number, chunknum: number, data: string) => {
      this.postMessageToWebview({
        command: 'update-enum-chunk',
        enumName: name,
        enumDataChunk: data,
        totalChunks: totalchunks,
        chunkNum: chunknum,
      } as EnumDataChunk);
    },
    sendcompressedtransitiondata: (signalid: number, signalwidth: number, totalchunks: number, chunknum: number, min: number, max: number, compresseddata: Uint8Array, originalsize: number) => {
      this.postMessageToWebview({
        command: 'update-waveform-chunk-compressed',
        signalId: signalid,
        signalWidth: signalwidth,
        compressedDataChunk: Array.from(compresseddata),
        totalChunks: totalchunks,
        chunkNum: chunknum,
        min: min,
        max: max,
        originalSize: originalsize
      } as CompressedValueChangeDataChunk);
    }
  };

  async _load(): Promise<void> {
    this.providerDelegate.logOutputChannel("Connecting to remote server: " + this.serverUrl);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Connecting to remote server " + this.serverUrl,
      cancellable: false
    }, async () => {
      try {
        await loadRemoteHierarchy(this.serverUrl, this.wasmApi, this.bearerToken);
        await loadRemoteTimeTable(this.serverUrl, this.wasmApi, this.bearerToken);
      } catch (error) {
        this.providerDelegate.logOutputChannel("Failed to connect to remote server: " + error);
        throw error;
      }
    });

    this.loadTopLevelParameters();
  }

  async loadNetlist(): Promise<void> {
    this.providerDelegate.logOutputChannel("Connecting to remote server: " + this.serverUrl);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Connecting to remote server " + this.serverUrl,
      cancellable: false
    }, async () => {
      try {
        await loadRemoteHierarchy(this.serverUrl, this.wasmApi, this.bearerToken);
      } catch (error) {
        this.providerDelegate.logOutputChannel("Failed to connect to remote server: " + error);
        throw error;
      }
    });
  }

  async loadBody(): Promise<void> {

    try {
      await loadRemoteTimeTable(this.serverUrl, this.wasmApi, this.bearerToken);
    } catch (error) {
      this.providerDelegate.logOutputChannel("Failed to connect to remote server: " + error);
      throw error;
    }

    this.loadTopLevelParameters();
  }

  private getParametersInTreeData(treeData: NetlistItem[]): NetlistItem[] {
    const result: NetlistItem[] = [];
    treeData.forEach((item) => {
      if (item.type === 'Parameter') {
        result.push(item);
      }
      if (item.children.length > 0) {
        result.push(...this.getParametersInTreeData(item.children as NetlistItem[]));
      }
    });
    return result;
  }

  private async loadTopLevelParameters() {
    if (!this.wasmApi) { return; }
    if (this.parametersLoaded) { return; }

    const parameterItems = this.getParametersInTreeData(this.netlistTop);
    const signalIdList = parameterItems.map((param) => param.signalId);
    const params = await this.wasmApi.getparametervalues(signalIdList);
    const parameterValues = JSON.parse(params);
    parameterItems.forEach((param) => {
      const paramValue = parameterValues.find((entry: any) => entry[0] === param.signalId);
      if (paramValue) {
        param.setParamAndTooltip(paramValue[1]);
      }
    });
    this.parametersLoaded = true;
  }

  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) { return this.netlistTop; }
    if (!this.wasmApi) { return []; }
    if (element.children.length > 0) { return element.children; }

    //let scopePath = "";
    //if (element.scopePath !== "") { scopePath += element.scopePath + "."; }
    //scopePath += element.name;
    const scopePath = element.scopePath.concat([element.name]); 
    let itemsRemaining = Infinity;
    let startIndex = 0;
    const result: NetlistItem[] = [];

    let callLimit = 255;
    const varTable: any = {};
    while (itemsRemaining > 0) {
      const children = await this.wasmApi.getchildren(element.netlistId, startIndex);
      const childItems = JSON.parse(children);
      itemsRemaining = childItems.remainingItems;
      startIndex += childItems.totalReturned;

      childItems.scopes.forEach((child: any) => {
        result.push(createScope(child.name, child.type, scopePath, child.id, -1, this.uri));
      });
      childItems.vars.forEach((child: any) => {
        const encoding = child.encoding.split('(')[0];
        const varItem = createVar(child.name, child.paramValue, child.type, encoding, scopePath, child.netlistId, child.signalId, child.width, child.msb, child.lsb, child.enumType, false /*isFsdb*/, this.uri);
        if (varTable[child.name] === undefined) {
          varTable[child.name] = [varItem];
        } else {
          varTable[child.name].push(varItem);
        }
      });

      callLimit--;
      if (callLimit <= 0) { break; }
    }

    for (const [key, value] of Object.entries(varTable)) {
      if ((value as NetlistItem[]).length === 1) {
        result.push((value as NetlistItem[])[0]);
      } else {
        const varList = value as NetlistItem[];
        const bitList: NetlistItem[] = [];
        const busList: NetlistItem[] = [];
        let maxWidth = 0;
        let parent: any ;
        varList.forEach((varItem) => {
          if (varItem.width === 1) { bitList.push(varItem); }
          else { busList.push(varItem); }
        });
        busList.forEach((busItem: NetlistItem) => {
          if (busItem.width > maxWidth) {
            maxWidth = busItem.width;
            parent = busItem;
          }
          result.push(busItem);
        });
        if (parent !== undefined) {
          parent.children = bitList;
          parent.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        } else {
          result.push(...bitList);
        }
      }
    }

    return result;
  }

  async getSignalData(signalIdList: SignalId[]): Promise<void> {
    try {
      await loadRemoteSignals(this.serverUrl, this.wasmApi, this.bearerToken, signalIdList);
    } catch (error) {
      this.providerDelegate.logOutputChannel("Failed to get signal data from remote server: " + error);
      // Send empty signal data for failed signals
      signalIdList.forEach(signalId => {
        this.postMessageToWebview({
          command: 'update-waveform-chunk',
          signalId: signalId,
          transitionDataChunk: '[]',
          totalChunks: 1,
          chunkNum: 0,
          min: 0,
          max: 1
        });
      });
    }
  }

  async getEnumData(enumList: EnumQueueEntry[]): Promise<void> {
    // Not implemented for Surfer
    return;
  }

  async getValuesAtTime(time: number, instancePaths: string[]): Promise<any> {
    if (!this.wasmApi) { return []; }
    try {
      const result = await this.wasmApi.getvaluesattime(BigInt(time), instancePaths.join(" "));
      return JSON.parse(result);
    } catch (error) {
      this.providerDelegate.logOutputChannel("Failed to get values at time from remote server: " + error);
      return [];
    }
  }

  async unload(): Promise<void> {
    if (this.wasmApi) {
      await this.wasmApi.unload();
    }
    this.parametersLoaded = false;
    this.netlistTop = [];
  }

  dispose(): void {
    this.unload();
    this.wasmWorker.terminate();
  }
}

// Chunk size for data transfer
// Can't be too big or the wasm will crash
const CHUNK_SIZE = 1024 * 32;

enum ChunkType {
    Hierarchy = 0,
    TimeTable = 1,
    Signals = 2,
}

async function sendDataInChunks(
    data: Uint8Array,
    sendChunkFn: (chunk: Uint8Array, chunkIndex: number, totalChunks: number) => void
): Promise<void> {
    const totalChunks = Math.ceil(data.length / CHUNK_SIZE);
    
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, data.length);
        const chunk = data.slice(start, end);
        
        sendChunkFn(chunk, i, totalChunks);
    }
}

async function httpFetch(server: string, path: string, bearerToken?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
    }
    const response = await fetch(`${server}/${path}`, { headers });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
}

// get_status does have real use in the extension but is here for completeness
export async function loadRemoteStatus(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    const status = await httpFetch(server, 'get_status', bearerToken);
    const statusText = await status.text();
    const statusBytes = new TextEncoder().encode(statusText);
    const ret = wasmApi.loadremotestatus(statusBytes);
    return ret;
}

export async function loadRemoteHierarchy(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    const hierarchy = await httpFetch(server, 'get_hierarchy', bearerToken);
    const hierarchyBytes = await hierarchy.arrayBuffer();
    const hierarchyUint8Array = new Uint8Array(hierarchyBytes);
    
    await sendDataInChunks(hierarchyUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotechunk(ChunkType.Hierarchy, chunk, chunkIndex, totalChunks);
    });
    
}

export async function loadRemoteTimeTable(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    const timeTable = await httpFetch(server, 'get_time_table', bearerToken);
    const timeTableBytes = await timeTable.arrayBuffer();
    const timeTableUint8Array = new Uint8Array(timeTableBytes);
    
    await sendDataInChunks(timeTableUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotechunk(ChunkType.TimeTable, chunk, chunkIndex, totalChunks);
    });
}

export async function loadRemoteSignals(server: string, wasmApi: filehandler.Exports, bearerToken?: string, signalIds?: number[]): Promise<any> {
    let path = 'get_signals';
    if (signalIds && signalIds.length > 0) {
        path += '/' + signalIds.join('/');
    }
    const signals = await httpFetch(server, path, bearerToken);
    const signalsBytes = await signals.arrayBuffer();
    const signalsUint8Array = new Uint8Array(signalsBytes);
    
    await sendDataInChunks(signalsUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotechunk(ChunkType.Signals, chunk, chunkIndex, totalChunks);
    });
}