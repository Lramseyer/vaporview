import * as vscode from 'vscode';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import * as fs from 'fs';

import { SignalId } from './viewer_provider';
import { filehandler } from './filehandler';
import { NetlistItem, createScope, createVar } from './tree_view';
import { IWaveformFormatHandler, IWaveformFormatHandlerDelegate, EnumQueueEntry } from './document';

// #region fsWrapper
interface fsWrapper {
  type: 'nodeFs' | 'workspace';
  loadStatic: boolean;
  fd: number;
  fileSize: number;
  bufferSize: number;
  fileData?: Uint8Array;
  loadFile: (uri: vscode.Uri, fileType: string) => void;
  readSlice: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => number;
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

    // For VCD files, we stream the file, so we want to use a larger buffer size
    // For FST files, we want to use Rust's default buffer size of 8192 bytes,
    // but we don't care about buffer size if we statically load the file
    if (fileType === 'fst' && nodeFsWrapper.loadStatic === false) {
      nodeFsWrapper.bufferSize = 8192;
    }
  },
  readSlice: fs.readSync,
  close: promisify(fs.close)
};

const workspaceFsWrapper: fsWrapper = {
  type: "workspace",
  loadStatic: true,
  fd: 0,
  fileSize: 0,
  bufferSize: 60 * 1024,
  loadFile: async (uri: vscode.Uri, fileType: string) => {
    const stats                 = await vscode.workspace.fs.stat(uri);
    workspaceFsWrapper.fileData = await vscode.workspace.fs.readFile(uri);
    workspaceFsWrapper.fileSize = stats.size;
  },
  readSlice: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
    buffer.set(workspaceFsWrapper.fileData!.subarray(position, position + length), offset);
    return length;
  },
  close: (fd: number) => {}
};

// Adapted from the VScode hex editor extension source
export const getFsWrapper = async (uri: vscode.Uri): Promise<fsWrapper> => {
  if (uri.scheme === "file") {
    try {
      const fileStats = await fs.promises.stat(uri.fsPath);
      if (fileStats.isFile()) {
        return nodeFsWrapper;
      }
    } catch { /* probably not node.js, or file does not exist */  }
  }
  return workspaceFsWrapper;
};

// #region WasmFormatHandler
export class WasmFormatHandler implements IWaveformFormatHandler {
  private delegate: IWaveformFormatHandlerDelegate;
  private fileReader: fsWrapper;
  private wasmWorker: Worker;
  private wasmModule: WebAssembly.Module;
  private wasmApi: any;
  private fileBuffer: Uint8Array = new Uint8Array(65536);

  constructor(
    delegate: IWaveformFormatHandlerDelegate,
    fileReader: fsWrapper,
    wasmWorker: Worker,
    wasmModule: WebAssembly.Module,
  ) {
    this.delegate = delegate;
    this.fileReader = fileReader;
    this.wasmWorker = wasmWorker;
    this.wasmModule = wasmModule;
  }

  static async create(
    delegate: IWaveformFormatHandlerDelegate,
    wasmWorker: Worker,
    wasmModule: WebAssembly.Module,
  ): Promise<WasmFormatHandler> {
    const fsWrapper = await getFsWrapper(delegate.uri);
    const handler = new WasmFormatHandler(delegate, fsWrapper, wasmWorker, wasmModule);
    await handler.initWasmApi();
    return handler;
  }

  private async initWasmApi() {
    this.wasmApi = await filehandler._.bind(this.service, this.wasmModule, this.wasmWorker);
  }

  // WASM service callbacks
  private readonly service: filehandler.Imports.Promisified = {
    log: (msg: string) => { console.log(msg); },
    outputlog: (msg: string) => { this.delegate.logOutputChannel(msg); },
    fsread: (fd: number, offset: bigint, length: number): Uint8Array => {
      const bytesRead = this.fileReader.readSlice(fd, this.fileBuffer, 0, length, Number(offset));
      return this.fileBuffer.subarray(0, bytesRead);
    },
    getsize: (fd: number): bigint => {
      return BigInt(this.fileReader.fileSize);
    },
    setscopetop: (name: string, id: number, tpe: string) => {
      const scope = createScope(name, tpe, "", id, -1, this.delegate.uri);
      this.delegate.treeData.push(scope);
      this.delegate.netlistIdTable[id] = scope;
    },
    setvartop: (name: string, id: number, signalid: number, tpe: string, encoding: string, width: number, msb: number, lsb: number, enumtype: string) => {
      const varItem = createVar(name, "", tpe, encoding, "", id, signalid, width, msb, lsb, enumtype, false /*isFsdb*/, this.delegate.uri);
      this.delegate.treeData.push(varItem);
      this.delegate.netlistIdTable[id] = varItem;
    },
    setmetadata: (scopecount: number, varcount: number, timescale: number, timeunit: string) => {
      this.delegate.setMetadata(scopecount, varcount, timescale, timeunit);
    },
    setchunksize: (chunksize: bigint, timeend: bigint, timetablelength: bigint) => {
      this.delegate.setChunkSize(chunksize, timeend, timetablelength);
    },
    sendtransitiondatachunk: (signalid: number, totalchunks: number, chunknum: number, min: number, max: number, transitionData: string) => {
      this.delegate.postMessageToWebview({
        command: 'update-waveform-chunk',
        signalId: signalid,
        transitionDataChunk: transitionData,
        totalChunks: totalchunks,
        chunkNum: chunknum,
        min: min,
        max: max
      });
    },
    sendenumdata: (name: string, totalchunks: number, chunknum: number, data: string) => {
      this.delegate.postMessageToWebview({
        command: 'update-enum-chunk',
        enumName: name,
        enumDataChunk: data,
        totalChunks: totalchunks,
        chunkNum: chunknum,
      });
    },
    sendcompressedtransitiondata: (signalid: number, signalwidth: number, totalchunks: number, chunknum: number, min: number, max: number, compresseddata: Uint8Array, originalsize: number) => {
      this.delegate.postMessageToWebview({
        command: 'update-waveform-chunk-compressed',
        signalId: signalid,
        signalWidth: signalwidth,
        compressedDataChunk: Array.from(compresseddata),
        totalChunks: totalchunks,
        chunkNum: chunknum,
        min: min,
        max: max,
        originalSize: originalsize
      });
    }
  };

  async load(): Promise<void> {
    const fileType = this.delegate.fileType;
    this.delegate.logOutputChannel("Using " + this.fileReader.type + " - Loading " + fileType + " file: " + this.delegate.uri.fsPath);
    const loadTime = Date.now();
    await this.fileReader.loadFile(this.delegate.uri, fileType);

    if (fileType === 'fst' && this.fileReader.loadStatic === false) {
      const fstMaxStaticLoadSize = vscode.workspace.getConfiguration('vaporview').get('fstMaxStaticLoadSize');
      this.delegate.logOutputChannel(
        this.delegate.uri.fsPath + ' is larger than the max static load size of ' + fstMaxStaticLoadSize +
        ' MB. File will be loaded dynamically. Configure max load size in the settings menu');
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Parsing Netlist for " + this.delegate.uri.fsPath,
      cancellable: false
    }, async () => {
      await this.wasmApi.loadfile(BigInt(this.fileReader.fileSize), this.fileReader.fd, this.fileReader.loadStatic, this.fileReader.bufferSize);
    });

    const netlistFinishTime = Date.now();
    const netlistTime = (netlistFinishTime - loadTime) / 1000;
    this.delegate.logOutputChannel("Finished parsing netlist for " + this.delegate.uri.fsPath);
    this.delegate.logOutputChannel(
      "Scope count: " + this.delegate.netlistIdTable.length + 
      ", Time: " + netlistTime + " seconds");

    this.delegate.updateViews();
    await this.readBody(fileType);

    this.delegate.logOutputChannel("Finished parsing waveforms for " + this.delegate.uri.fsPath);
    this.delegate.logOutputChannel("Time: " + (Date.now() - netlistFinishTime) / 1000 + " seconds");

    if (fileType !== 'fst') {
      this.loadTopLevelParameters();
    }
  }

  private async readBody(fileType: string) {
    if (fileType === 'vcd') {
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Parsing Waveforms for " + this.delegate.uri.fsPath,
        cancellable: false
      }, async () => {
        await this.wasmApi.readbody();
      });
    } else {
      await this.wasmApi.readbody();
    }
  }

  private getParametersInTreeData(treeData: NetlistItem[]): NetlistItem[] {
    let result: NetlistItem[] = [];
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

    const parameterItems = this.getParametersInTreeData(this.delegate.treeData);
    const signalIdList = parameterItems.map((param) => param.signalId);
    const params = await this.wasmApi.getparametervalues(signalIdList);
    const parameterValues = JSON.parse(params);
    parameterItems.forEach((param) => {
      const paramValue = parameterValues.find((entry: any) => entry[0] === param.signalId);
      if (paramValue) {
        param.setParamAndTooltip(paramValue[1]);
      }
    });
    this.delegate.updateViews();
  }

  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) { return this.delegate.treeData; }
    if (!this.wasmApi) { return []; }
    if (element.children.length > 0) { return element.children; }

    let scopePath = "";
    if (element.scopePath !== "") { scopePath += element.scopePath + "."; }
    scopePath += element.name;
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

      const scopes: NetlistItem[] = childItems.scopes?.map((child: any) => {
        return createScope(child.name, child.type, scopePath, child.id, -1, this.delegate.uri);
      }) || [];
      const vars: NetlistItem[] = childItems.vars?.map((child: any) => {
        return createVar(child.name, child.paramValue, child.type, child.encoding.split('(')[0], scopePath, child.netlistId, child.signalId, child.width, child.msb, child.lsb, child.enumType, false /*isFsdb*/, this.delegate.uri);
      }) || [];

      result.push(...scopes);

      vars.forEach((varItem) => {
        if (varTable[varItem.name] === undefined) {
          varTable[varItem.name] = [varItem];
        } else {
          varTable[varItem.name].push(varItem);
        }
        this.delegate.netlistIdTable[varItem.netlistId] = varItem;
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
        let parent: any = undefined;
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

    element.children = this.delegate.sortNetlistScopeChildren(result);
    return element.children;
  }

  async getSignalData(signalIdList: SignalId[]): Promise<void> {
    this.wasmApi.getsignaldata(signalIdList);
    this.loadTopLevelParameters();
  }

  async getEnumData(enumList: EnumQueueEntry[]): Promise<void> {
    const netlistIdList = enumList.map((entry) => entry.netlistId);
    this.wasmApi.getenumdata(netlistIdList);
  }

  async getValuesAtTime(time: number | null, instancePaths: string[]): Promise<any> {
    const effectiveTime = time ?? this.delegate.getMarkerTime();
    if (effectiveTime === null) { return []; }
    const result = await this.wasmApi.getvaluesattime(BigInt(effectiveTime), instancePaths.join(" "));
    return JSON.parse(result);
  }

  async unload(): Promise<void> {
    this.fileReader.close(this.fileReader.fd);
    if (this.wasmApi) {
      await this.wasmApi.unload();
    }
  }

  dispose(): void {
    this.unload();
    this.wasmWorker.terminate();
  }
}
