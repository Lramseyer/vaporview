import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import { VaporviewDocument, NetlistIdTable } from './document';
import { SignalId, NetlistId, VaporviewDocumentDelegate } from './viewer_provider';
import { filehandler } from './filehandler';
import { NetlistItem, createScope, createVar, getInstancePath } from './tree_view';
import { loadRemoteStatus, loadRemoteHierarchy, loadRemoteTimeTable, loadRemoteSignals } from './surfer';

export class SurferDocument extends VaporviewDocument implements vscode.CustomDocument {
  private serverUrl: string;
  private bearerToken?: string;
  public _wasmWorker: Worker;
  public wasmApi: any;

  static async create(
    uri: vscode.Uri,
    serverUrl: string,
    wasmWorker: Worker,
    wasmModule: WebAssembly.Module,
    delegate: VaporviewDocumentDelegate,
    bearerToken?: string,
  ): Promise<SurferDocument | PromiseLike<SurferDocument>> {
    const document = new SurferDocument(uri, serverUrl, wasmWorker, delegate, bearerToken);
    await document.createWasmApi(wasmModule);
    document.load();
    return document;
  }

  constructor(
    uri: vscode.Uri,
    serverUrl: string,
    _wasmWorker: Worker,
    delegate: VaporviewDocumentDelegate,
    bearerToken?: string,
  ) {
    super(uri, delegate);
    this.serverUrl = serverUrl;
    this.bearerToken = bearerToken;
    this._wasmWorker = _wasmWorker;
  }

  protected async load() {
    this._delegate.logOutputChannel("Connecting to remote server: " + this.serverUrl);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Connecting to remote server " + this.serverUrl,
      cancellable: false
    }, async () => {
      try {
        await loadRemoteHierarchy(this.serverUrl, this.wasmApi, this.bearerToken);
        await loadRemoteTimeTable(this.serverUrl, this.wasmApi, this.bearerToken);
        
      } catch (error) {
        this._delegate.logOutputChannel("Failed to connect to remote server: " + error);
        throw error;
      }
    });

    this._delegate.updateViews(this.uri);
    this.setTerminalLinkProvider();
  }

  public readonly service: filehandler.Imports.Promisified = {
    log: (msg: string) => { console.log(msg); },
    outputlog: (msg: string) => { this._delegate.logOutputChannel(msg); },
    fsread: (fd: number, offset: bigint, length: number): Uint8Array => {
      // Remote server doesn't use direct file reads, return empty buffer
      return new Uint8Array(Math.max(0, length));
    },
    getsize: (fd: number): bigint => {
      // Remote server doesn't use direct file access
      return BigInt(0);
    },
    setscopetop: (name: string, id: number, tpe: string) => {
      const scope = createScope(name, tpe, "", id, -1);
      this.treeData.push(scope);
      this._netlistIdTable[id] = { netlistItem: scope, displayedItem: undefined, signalId: 0 };
    },
    setvartop: (name: string, id: number, signalid: number, tpe: string, encoding: string, width: number, msb: number, lsb: number) => {
      const varItem = createVar(name, tpe, encoding, "", id, signalid, width, msb, lsb, false /*isFsdb*/);
      this.treeData.push(varItem);
      this._netlistIdTable[id] = { netlistItem: varItem, displayedItem: undefined, signalId: signalid };
    },
    setmetadata: (scopecount: number, varcount: number, timescale: number, timeunit: string) => {
      this.setMetadata(scopecount, varcount, timescale, timeunit);
    },
    setchunksize: (chunksize: bigint, timeend: bigint, timetablelength: bigint) => {
      this.setChunkSize(chunksize, timeend, timetablelength);
    },
    sendtransitiondatachunk: (signalid: number, totalchunks: number, chunknum: number, min: number, max: number, transitionData: string) => {
      this.webviewPanel?.webview.postMessage({
        command: 'update-waveform-chunk',
        signalId: signalid,
        transitionDataChunk: transitionData,
        totalChunks: totalchunks,
        chunkNum: chunknum,
        min: min,
        max: max
      });
    }
  };

  public async createWasmApi(wasmModule: WebAssembly.Module) {
    this.wasmApi = await filehandler._.bind(this.service, wasmModule, this._wasmWorker);
  }

  async getChildrenExternal(element: NetlistItem | undefined) {
    if (!element) { return Promise.resolve(this.treeData); } // Return the top-level netlist items
    if (!this.wasmApi) { return Promise.resolve([]); }
    if (element.children.length > 0) { return Promise.resolve(element.children); }

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

      childItems.scopes.forEach((child: any) => {
        result.push(createScope(child.name, child.type, scopePath, child.id, -1));
      });
      childItems.vars.forEach((child: any) => {
        const encoding = child.encoding.split('(')[0];
        const varItem = createVar(child.name, child.type, encoding, scopePath, child.netlistId, child.signalId, child.width, child.msb, child.lsb, false /*isFsdb*/);
        if (varTable[child.name] === undefined) {
          varTable[child.name] = [varItem];
        } else {
          varTable[child.name].push(varItem);
        }
        this.netlistIdTable[child.netlistId] = { netlistItem: varItem, displayedItem: undefined, signalId: child.signalId };
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

    element.children = result;
    return Promise.resolve(element.children);
  }

  public async getSignalData(signalIdList: SignalId[]) {
    try {
      await loadRemoteSignals(this.serverUrl, this.wasmApi, this.bearerToken, signalIdList);
    } catch (error) {
      this._delegate.logOutputChannel("Failed to get signal data from remote server: " + error);
      // Send empty signal data for failed signals
      signalIdList.forEach(signalId => {
        this.webviewPanel?.webview.postMessage({
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

  public async getValuesAtTime(e: any): Promise<any> {
    if (!this.wasmApi) { return []; }
    let time = e.time;
    if (!e.time) {
      time = this.webviewContext.markerTime;
    }
    try {
      const result = await this.wasmApi.getvaluesattime(BigInt(time), e.instancePaths.join(" "));
      return JSON.parse(result);
    } catch (error) {
      this._delegate.logOutputChannel("Failed to get values at time from remote server: " + error);
      return [];
    }
  }

  public async unload() {
    this.unloadTreeData();
    
    if (this.wasmApi) {
      await this.wasmApi.unload();
    }

    this.metadata.timeTableLoaded = false;
    this.unloadWebview();
  }

  dispose(): void {
    this.unload();
    this._wasmWorker.terminate();
    this._delegate.updateViews(this.uri);
    this._delegate.removeFromCollection(this.uri, this);
    this.disposables.forEach((disposable) => { disposable.dispose(); });
    this.disposables = [];
  }
}