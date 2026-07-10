import * as vscode from 'vscode';
import { promisify } from 'util';
import * as fs from 'fs';

import type { EnumQueueEntry, SignalId, ValueChangeDataChunk, CompressedValueChangeDataChunk, EnumDataChunk, WaveformDumpMetadata } from '../common/types';
import type { VaporviewDocumentDelegate } from './viewer_provider';
import { type NetlistItem, createScope, createVar } from './tree_view';
import type { WaveformFileParser, NetlistSearchResult } from './document';
import type { ValuesAtTimeResult } from '../../packages/vaporview-api/types';

// #region fsWrapper
interface fsWrapper {
  type: 'nodeFs' | 'workspace';
  loadStatic: boolean;
  fd: number;
  fileSize: number;
  bufferSize: number;
  fileData?: Uint8Array;
  loadFile: (uri: vscode.Uri, fileType: string) => Promise<void>;
  close: (fd: number) => void;
}

const nodeFsWrapper: fsWrapper = {
  type: 'nodeFs',
  loadStatic: false,
  fd: 0,
  fileSize: 0,
  bufferSize: 60 * 1024,
  loadFile: async (uri: vscode.Uri, fileType: string) => {
    const open                 = promisify(fs.open);
    const stats                = fs.statSync(uri.fsPath);
    nodeFsWrapper.fd           = await open(uri.fsPath, 'r');
    nodeFsWrapper.fileSize     = stats.size;
    const fstMaxStaticLoadSize = vscode.workspace.getConfiguration('vaporview').get('fstMaxStaticLoadSize');
    const maxStaticSize        = Number(fstMaxStaticLoadSize) * 1048576;
    nodeFsWrapper.loadStatic   = (stats.size < maxStaticSize);

    if (fileType === 'fst' && nodeFsWrapper.loadStatic === false) {
      nodeFsWrapper.bufferSize = 8192;
    }
  },
  close: promisify(fs.close) as unknown as (fd: number) => void,
};

const workspaceFsWrapper: fsWrapper = {
  type: 'workspace',
  loadStatic: true,
  fd: 0,
  fileSize: 0,
  bufferSize: 60 * 1024,
  loadFile: async (uri: vscode.Uri, _fileType: string) => {
    const stats                  = await vscode.workspace.fs.stat(uri);
    workspaceFsWrapper.fileData  = await vscode.workspace.fs.readFile(uri);
    workspaceFsWrapper.fileSize  = stats.size;
  },
  close: (_fd: number) => { /* no-op for workspace files */ },
};

export const getFsWrapper = async (uri: vscode.Uri): Promise<fsWrapper> => {
  if (uri.scheme === 'file') {
    try {
      const fileStats = await fs.promises.stat(uri.fsPath);
      if (fileStats.isFile()) {
        return nodeFsWrapper;
      }
    } catch { /* probably not node.js, or file does not exist */ }
  }
  return workspaceFsWrapper;
};

// #region Worker infrastructure

export interface WorkerLike {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export function createWorker(workerFile: string): {
  worker: WorkerLike;
  onMessage: (handler: (data: unknown) => void) => void;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wt = require('worker_threads') as typeof import('worker_threads');
    const w = new wt.Worker(workerFile);
    const worker: WorkerLike = {
      postMessage(data: unknown, transfer?: Transferable[]): void {
        // Only ArrayBuffer is passed as a transferable, which satisfies both
        // the browser Transferable and the Node.js worker_threads Transferable types.
        w.postMessage(data, (transfer ?? []) as ArrayBuffer[]);
      },
      terminate(): void { w.terminate(); },
    };
    return { worker, onMessage: (handler) => w.on('message', handler) };
  } catch { /* not Node.js – fall through to browser Worker */ }

  // Browser Worker (VSCode web extension host)
  const w = new Worker(workerFile);
  const worker: WorkerLike = {
    postMessage(data: unknown, transfer?: Transferable[]): void {
      w.postMessage(data, transfer ?? []);
    },
    terminate(): void { w.terminate(); },
  };
  return {
    worker,
    onMessage: (handler) =>
      w.addEventListener('message', (e: MessageEvent) => handler(e.data)),
  };
}

// #region WasmWorkerBase

export abstract class WasmWorkerBase implements WaveformFileParser {
  protected readonly providerDelegate: VaporviewDocumentDelegate;
  protected readonly uri: vscode.Uri;
  protected readonly wasmWorker: WorkerLike;

  private _reqId = 0;
  private readonly _pending = new Map<number, {
    resolve: (data: Record<string, unknown>) => void;
    reject:  (err: Error) => void;
  }>();

  protected netlistTop: NetlistItem[] = [];
  public netlistSearchable = false;
  protected parametersLoaded = false;

  public postMessageToWebview = (_message: Record<string, unknown>) => {};
  public metadata: WaveformDumpMetadata = {
    timeTableLoaded: false,
    scopeCount:      0,
    netlistIdCount:  0,
    signalIdCount:   0,
    timeTableCount:  0,
    timeEnd:         0,
    minTimeStep:     1,
    timeScale:       1,
    timeUnit:        'ns',
  };

  constructor(
    providerDelegate: VaporviewDocumentDelegate,
    uri: vscode.Uri,
    wasmWorker: WorkerLike,
    onMessage: (handler: (data: unknown) => void) => void,
  ) {
    this.providerDelegate = providerDelegate;
    this.uri              = uri;
    this.wasmWorker       = wasmWorker;
    onMessage((data: unknown) => this._handleMessage(data as Record<string, unknown>));
  }

  protected async init(wasmModule: WebAssembly.Module): Promise<void> {
    // Module is structured-cloned (not transferred) so the main thread retains
    // its copy for subsequent document opens.
    await this.sendCommand('init', { wasmModule });
  }

  protected sendCommand(
    type:     string,
    payload:  Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<Record<string, unknown>> {
    const requestId = this._reqId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      this.wasmWorker.postMessage({ type, requestId, ...payload }, transfer);
    });
  }

  private _handleMessage(data: Record<string, unknown>): void {
    const type      = data.type as string;
    const requestId = data.requestId as number | undefined;

    // Messages with a requestId are done/error responses for sendCommand calls
    if (requestId !== undefined) {
      const pending = this._pending.get(requestId);
      if (pending) {
        this._pending.delete(requestId);
        if (type === 'error') {
          pending.reject(new Error(data.error as string));
        } else {
          pending.resolve(data);
        }
      }
      return;
    }

    // Fire-and-forward callbacks – arrive before the corresponding done message
    switch (type) {
      case 'log':
        console.log(data.msg as string);
        break;
      case 'outputlog':
        this.providerDelegate.logOutputChannel(data.msg as string);
        break;
      case 'setscopetop':
        this.netlistTop.push(createScope(
          data.name as string, data.tpe as string, [], data.id as number, -1, this.uri));
        break;
      case 'setvartop':
        this.netlistTop.push(createVar(
          data.name as string, '', data.tpe as string, data.encoding as string, [],
          data.id as number, data.signalid as number,
          data.width as number, data.msb as number, data.lsb as number,
          data.enumtype as string, false /*isFsdb*/, this.uri,
        ));
        break;
      case 'setmetadata':
        this.metadata.scopeCount     = data.scopecount as number;
        this.metadata.netlistIdCount = data.varcount as number;
        this.metadata.timeScale      = data.timescale as number;
        this.metadata.timeUnit       = data.timeunit as string;
        break;
      case 'setchunksize':
        this.metadata.timeEnd         = data.timeend as number;
        this.metadata.timeTableCount  = data.timetablelength as number;
        this.metadata.minTimeStep     = data.chunksize as number;
        this.metadata.timeTableLoaded = true;
        break;
      case 'sendtransitiondatachunk':
        this.postMessageToWebview({
          command:             'update-waveform-chunk',
          signalId:            data.signalid as number,
          transitionDataChunk: data.data as string,
          totalChunks:         data.totalchunks as number,
          chunkNum:            data.chunknum as number,
          min:                 data.min as number,
          max:                 data.max as number,
        } as ValueChangeDataChunk);
        break;
      case 'sendenumdata':
        this.postMessageToWebview({
          command:       'update-enum-chunk',
          enumName:      data.name as string,
          enumDataChunk: data.data as string,
          totalChunks:   data.totalchunks as number,
          chunkNum:      data.chunknum as number,
        } as EnumDataChunk);
        break;
      case 'sendcompressedtransitiondata':
        this.postMessageToWebview({
          command:             'update-waveform-chunk-compressed',
          signalId:            data.signalid as number,
          signalWidth:         data.signalwidth as number,
          compressedDataChunk: Array.from(data.compresseddata as Uint8Array),
          totalChunks:         data.totalchunks as number,
          chunkNum:            data.chunknum as number,
          min:                 data.min as number,
          max:                 data.max as number,
          originalSize:        data.originalsize as number,
        } as CompressedValueChangeDataChunk);
        break;
    }
  }

  private _getParametersInTreeData(treeData: NetlistItem[]): NetlistItem[] {
    const result: NetlistItem[] = [];
    treeData.forEach((item) => {
      if (item.type === 'Parameter') { result.push(item); }
      if (item.children.length > 0) {
        result.push(...this._getParametersInTreeData(item.children as NetlistItem[]));
      }
    });
    return result;
  }

  protected async loadTopLevelParameters(): Promise<void> {
    if (this.parametersLoaded) { return; }
    const parameterItems = this._getParametersInTreeData(this.netlistTop);
    const signalIdList   = parameterItems.map((p) => p.signalId);
    const response       = await this.sendCommand('getparametervalues', { signalIdList });
    const parameterValues: [number, string][] = JSON.parse(response.result as string);
    parameterItems.forEach((param) => {
      const pv = parameterValues.find((entry) => entry[0] === param.signalId);
      if (pv) { param.setParamAndTooltip(pv[1]); }
    });
    this.providerDelegate.updateViews(this.uri);
    this.parametersLoaded = true;
  }

  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) { return this.netlistTop; }
    if (element.children.length > 0) { return element.children; }

    const scopePath    = element.scopePath.concat([element.name]);
    let itemsRemaining = Infinity;
    let startIndex     = 0;
    let callLimit      = 255;
    const result: NetlistItem[] = [];

    while (itemsRemaining > 0) {
      const response = await this.sendCommand('getchildren', {
        netlistId: element.netlistId, startIndex,
      });
      const childItems = JSON.parse(response.result as string);
      itemsRemaining   = childItems.remainingItems;
      startIndex      += childItems.totalReturned;

      childItems.scopes?.forEach((child: { name: string; type: string; id: number }) => {
        result.push(createScope(child.name, child.type, scopePath, child.id, -1, this.uri));
      });
      childItems.vars?.forEach((child: {
        name: string; paramValue: string; type: string; encoding: string;
        netlistId: number; signalId: number; width: number;
        msb: number; lsb: number; enumType: string;
      }) => {
        result.push(createVar(
          child.name, child.paramValue, child.type, child.encoding.split('(')[0],
          scopePath, child.netlistId, child.signalId,
          child.width, child.msb, child.lsb, child.enumType, false /*isFsdb*/, this.uri,
        ));
      });

      callLimit--;
      if (callLimit <= 0) { break; }
    }

    return result;
  }

  async getEnumData(enumList: EnumQueueEntry[]): Promise<void> {
    const netlistIdList = enumList.map((e) => e.netlistId);
    await this.sendCommand('getenumdata', { netlistIdList });
  }

  async getValuesAtTime(time: number, instancePaths: string[]): Promise<ValuesAtTimeResult[]> {
    const response = await this.sendCommand('getvaluesattime', {
      time, paths: instancePaths.join(' '),
    });
    return JSON.parse(response.result as string);
  }

  public async searchNetlist(searchString: string, scopeId: number): Promise<NetlistSearchResult> {
    const response = await this.sendCommand('searchnetlist', {
      searchQuery: searchString, scopeId,
    });
    try {
      return JSON.parse(response.result as string) as NetlistSearchResult;
    } catch {
      return { totalResults: 0, searchResults: [] };
    }
  }

  async unload(): Promise<void> {
    await this.sendCommand('unload');
    this.parametersLoaded = false;
    this.netlistTop = [];
  }

  dispose(): void {
    this.unload();
    this.wasmWorker.terminate();
  }

  abstract loadNetlist(): Promise<void>;
  abstract loadBody(): Promise<void>;
  abstract getSignalData(signalIdList: SignalId[]): Promise<void>;
}

// #region WasmFormatHandler

export class WasmFormatHandler extends WasmWorkerBase {
  private readonly fileType:  string;
  private readonly fileReader: fsWrapper;

  private constructor(
    providerDelegate: VaporviewDocumentDelegate,
    uri:         vscode.Uri,
    fileType:    string,
    fileReader:  fsWrapper,
    wasmWorker:  WorkerLike,
    onMessage:   (handler: (data: unknown) => void) => void,
  ) {
    super(providerDelegate, uri, wasmWorker, onMessage);
    this.fileType   = fileType;
    this.fileReader = fileReader;
  }

  static async create(
    providerDelegate: VaporviewDocumentDelegate,
    uri:            vscode.Uri,
    fileType:       string,
    wasmWorkerFile: string,
    wasmModule:     WebAssembly.Module,
  ): Promise<WasmFormatHandler> {
    const fileReader        = await getFsWrapper(uri);
    const { worker, onMessage } = createWorker(wasmWorkerFile);
    const handler           = new WasmFormatHandler(
      providerDelegate, uri, fileType, fileReader, worker, onMessage);
    await handler.init(wasmModule);
    return handler;
  }

  async loadNetlist(): Promise<void> {
    this.providerDelegate.logOutputChannel(
      'Using ' + this.fileReader.type + ' - Loading ' + this.fileType + ' file: ' + this.uri.fsPath);
    await this.fileReader.loadFile(this.uri, this.fileType);

    if (this.fileType === 'fst' && this.fileReader.loadStatic === false) {
      const fstMaxStaticLoadSize = vscode.workspace.getConfiguration('vaporview').get('fstMaxStaticLoadSize');
      this.providerDelegate.logOutputChannel(
        this.uri.fsPath + ' is larger than the max static load size of ' + fstMaxStaticLoadSize +
        ' MB. File will be loaded dynamically. Configure max load size in the settings menu');
    }

    await vscode.window.withProgress({
      location:    vscode.ProgressLocation.Notification,
      title:       'Parsing Netlist for ' + this.uri.fsPath,
      cancellable: false,
    }, async () => {
      if (this.fileReader.type === 'nodeFs') {
        // Pass the already-opened OS file descriptor; the worker thread shares
        // the same process fd table so it can call fs.readSync with this fd.
        await this.sendCommand('setNodeFd', { fd: this.fileReader.fd });
      } else {
        // Transfer the in-memory buffer to the worker (zero-copy).
        const buf = this.fileReader.fileData!;
        await this.sendCommand('setFileBuffer', { fileBuffer: buf }, [buf.buffer]);
      }
      await this.sendCommand('loadfile', {
        size:       this.fileReader.fileSize,
        fd:         this.fileReader.fd,
        loadStatic: this.fileReader.loadStatic,
        bufferSize: this.fileReader.bufferSize,
      });
    });
    this.netlistSearchable = true;
  }

  async loadBody(): Promise<void> {
    if (this.fileType === 'vcd') {
      await vscode.window.withProgress({
        location:    vscode.ProgressLocation.Notification,
        title:       'Parsing Waveforms for ' + this.uri.fsPath,
        cancellable: false,
      }, async () => {
        await this.sendCommand('readbody');
      });
    } else {
      await this.sendCommand('readbody');
    }

    if (this.fileType !== 'fst') {
      await this.loadTopLevelParameters();
    }
  }

  async getSignalData(signalIdList: SignalId[]): Promise<void> {
    await this.sendCommand('getsignaldata', { signalIdList: Array.from(signalIdList) });
    // Sequenced after getsignaldata so parameters are available once signal data arrives
    await this.loadTopLevelParameters();
  }

  async unload(): Promise<void> {
    await super.unload();
    this.fileReader.close(this.fileReader.fd);
    await this.sendCommand('clearFile');
  }
}
