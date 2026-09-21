import * as vscode from 'vscode';
import type { EnumQueueEntry, SignalId, NetlistId, ValueChangeDataChunk, WaveformDumpMetadata } from '../common/types';
import { type ChildProcess, fork } from 'child_process';
import * as path from 'path';

import type { VaporviewDocumentDelegate } from './viewer_provider';
import { type NetlistItem, createScope, createVar } from './tree_view';
import type { WaveformFileParser, NetlistSearchResult, NetlistSearchEntry } from './document';
import type { ValuesAtTimeResult } from '../../packages/vaporview-api/types';
import type { FsdbScopeChildrenResult, FsdbScopeInfo, FsdbWaveformData, FsdbWorkerCommand } from './fsdb_types';

// Response to a callFsdbWorkerTask request (matched by id)
type FsdbWorkerResponse = {
  id: string;
  result?: unknown;
  error?: unknown;
};

// Callback messages sent by the worker (no matching id)
type FsdbRequireFailedMessage = {
  command: 'require-failed';
  error: { code?: string };
};

type FsdbSetMetadataMessage = {
  command: 'setMetadata';
  scopecount: number;
  varcount: number;
  timescale: number;
  timeunit: string;
};

type FsdbSetChunkSizeMessage = {
  command: 'setChunkSize';
  chunksize: number;
  timeend: number;
  timetablelength?: number;
};

type FsdbVarCallbackMessage = {
  command: 'fsdb-var-callback';
  name: string;
  type: string;
  encoding: string;
  path: string;
  netlistId: number;
  signalId: number;
  width: number;
  msb: number;
  lsb: number;
};

type FsdbArrayBeginCallbackMessage = {
  command: 'fsdb-array-begin-callback';
  name: string;
  path: string;
  netlistId: number;
};

type FsdbArrayEndCallbackMessage = {
  command: 'fsdb-array-end-callback';
  size: number;
};

type FsdbStructBeginCallbackMessage = {
  command: 'fsdb-struct-begin-callback';
  name: string;
  type: string;
  path: string;
  netlistId: number;
};

type FsdbStructEndCallbackMessage = {
  command: 'fsdb-struct-end-callback';
};

type FsdbWorkerCallback =
  | FsdbRequireFailedMessage
  | FsdbSetMetadataMessage
  | FsdbSetChunkSizeMessage
  | FsdbVarCallbackMessage
  | FsdbArrayBeginCallbackMessage
  | FsdbArrayEndCallbackMessage
  | FsdbStructBeginCallbackMessage
  | FsdbStructEndCallbackMessage;

type FsdbWorkerMessage = FsdbWorkerResponse | FsdbWorkerCallback;


export class FsdbFormatHandler implements WaveformFileParser {
  private providerDelegate: VaporviewDocumentDelegate;
  private uri: vscode.Uri;
  private fsdbWorker: ChildProcess | undefined = undefined;
  // Vars collected for the in-flight readVars call (avoids races on children.push).
  private fsdbVarsBuffer: NetlistItem[] = [];
  // Nest STRUCT/RECORD/array children while reading vars for a scope.
  private fsdbChildrenStack: NetlistItem[][] = [];
  private fsdbStructNameStack: string[] = [];
  // Need a reference to findTreeItem for getValuesAtTime
  public findTreeItemFn: (scopePath: string, msb: number | undefined, lsb: number | undefined) => Promise<NetlistItem | null>;

  // Top level netlist items
  public netlistSearchable: boolean = false;
  private netlistTop: NetlistItem[] = [];
  private parametersLoaded: boolean = false;
  // VS Code may call getChildren concurrently while expanding; coalesce loads
  // per element and serialize them globally, since the readVars callback state
  // (fsdbVarsBuffer/fsdbChildrenStack) is shared across the whole handler.
  private childrenLoadInFlight = new Map<NetlistItem, Promise<NetlistItem[]>>();
  private childrenLoadChain: Promise<unknown> = Promise.resolve();

  public postMessageToWebview = (_message: Record<string, unknown>) => {};
  public metadata: WaveformDumpMetadata = {
    timeTableLoaded: false,
    scopeCount: 0,
    netlistIdCount: 0,
    signalIdCount: 0,
    timeTableCount: 0,
    timeEnd: 0,
    minTimeStep: 1,
    timeScale: 1,
    timeUnit: "ns",
  };

  constructor(
    providerDelegate: VaporviewDocumentDelegate,
    uri: vscode.Uri,
    findTreeItemFn: (scopePath: string, msb: number | undefined, lsb: number | undefined) => Promise<NetlistItem | null>,
  ) {
    this.providerDelegate = providerDelegate;
    this.uri = uri;
    this.findTreeItemFn = findTreeItemFn;
  }

  async loadNetlist(): Promise<void> {
    if (process.platform !== 'linux') {
      vscode.window.showErrorMessage("FSDB support is currently available on Linux only.");
      return;
    }

    // Create FSDB worker that loads FSDB using node-addon-api
    const fsdbReaderLibsPath = vscode.workspace.getConfiguration('vaporview').get('fsdbReaderLibsPath');
    this.fsdbWorker = fork(path.resolve(__dirname, 'fsdb_worker.js'), {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : ''}${fsdbReaderLibsPath}`
      }
    });
    this.fsdbWorker.setMaxListeners(50);
    this.setupFsdbWorkerListeners();

    await this.callFsdbWorkerTask({
      command: 'openFsdb',
      fsdbPath: this.uri.fsPath
    });

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Reading Scopes for " + this.uri.fsPath,
      cancellable: false
    }, async () => {
      const response = await this.callFsdbWorkerTask({
        command: 'readScopes'
      });
      const topScopes = (response.result as FsdbScopeInfo[]) ?? [];
      this.netlistTop = topScopes.map((scope) =>
        createScope(scope.name, scope.type, [], scope.netlistId, scope.scopeOffsetIdx, this.uri)
      );
    });

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Reading Metadata for " + this.uri.fsPath,
      cancellable: false
    }, async () => {
      await this.callFsdbWorkerTask({
        command: 'readMetadata'
      });
    });
  }

  async loadBody(): Promise<void> {
    // Implement loading the body of the FSDB file here
    return;
  }

  private setupFsdbWorkerListeners(): void {
    if (!this.fsdbWorker) return;

    this.fsdbWorker.on('online', () => {
      console.log('FSDB worker is online.');
    });

    this.fsdbWorker.on('error', (err: Error) => {
      console.error('FSDB worker error:', err);
    });

    this.fsdbWorker.on('exit', (code: number | null, signal: string | null) => {
      if (code !== 0) {
        console.error(`Child process exited with error code ${code} (signal: ${signal})`);
      }
    });

    this.fsdbWorker.on('message', (msg: FsdbWorkerMessage) => {
      if ('command' in msg) {
        this.handleMessage(msg);
      }
      // Responses with 'id' are handled by callFsdbWorkerTask listeners
    });
  }

  private handleMessage(message: FsdbWorkerCallback) {
    switch (message.command) {
      case 'require-failed': {
        const errorCode = message.error?.code ?? 'unknown';
        vscode.window.showErrorMessage("Failed to load FSDB reader, is vaporview.fsdbReaderLibsPath properly set? (" + errorCode + ")");
        break;
      }
      case 'setMetadata': {
        this.metadata.scopeCount = message.scopecount;
        this.metadata.netlistIdCount = message.varcount;
        this.metadata.timeScale = message.timescale;
        this.metadata.timeUnit = message.timeunit;
        break;
      }
      case 'setChunkSize': {
        this.metadata.timeEnd = Number(message.timeend);
        this.metadata.timeTableCount = Number(message.timetablelength);
        this.metadata.timeTableLoaded = true;
        break;
      }
      case 'fsdb-var-callback': {
        this.fsdbVarCallback(
          message.name, message.type, message.encoding, message.path, message.netlistId, message.signalId, message.width, message.msb, message.lsb);
        break;
      }
      case 'fsdb-array-begin-callback': {
        this.fsdbArrayBeginCallback(message.name, message.path, message.netlistId);
        break;
      }
      case 'fsdb-array-end-callback': {
        this.fsdbArrayEndCallback(message.size);
        break;
      }
      case 'fsdb-struct-begin-callback': {
        this.fsdbStructBeginCallback(message.name, message.type, message.path, message.netlistId);
        break;
      }
      case 'fsdb-struct-end-callback': {
        this.fsdbStructEndCallback();
        break;
      }
    }
  }

  private callFsdbWorkerTask(message: FsdbWorkerCommand): Promise<FsdbWorkerResponse> {
    if (this.fsdbWorker === undefined) return Promise.resolve({ id: '' });
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substring(2, 9);
      const ipcMessage = { ...message, id };

      const responseHandler = (msg: FsdbWorkerMessage) => {
        if ('id' in msg && msg.id === id) {
          this.fsdbWorker!.off('message', responseHandler);
          if (msg.error) {
            console.log(msg.error);
            return reject(new Error(String(msg.error)));
          }
          resolve(msg as FsdbWorkerResponse);
        }
      };

      this.fsdbWorker!.on('message', responseHandler);
      this.fsdbWorker!.send(ipcMessage);
    });
  }

  private async fsdbReadVars(element: NetlistItem | undefined) {
    if (!element) return;
    this.fsdbVarsBuffer = [];
    this.fsdbChildrenStack = [this.fsdbVarsBuffer];
    this.fsdbStructNameStack = [];

    let scopePath = "";
    if (element.scopePath.length !== 0) { scopePath += element.scopePath.join(".") + "."; }
    scopePath += element.name;

    await this.callFsdbWorkerTask({
      command: 'readVars',
      scopePath: scopePath,
      scopeOffsetIdx: element.scopeOffsetIdx
    });

    // concat instead of push(...spread): spreading very large var lists can
    // overflow the argument limit on huge scopes.
    element.children = element.children.concat(this.fsdbVarsBuffer);
    this.fsdbVarsBuffer = [];
    this.fsdbChildrenStack = [];
    this.fsdbStructNameStack = [];
  }

  private fsdbCurrentChildren(): NetlistItem[] {
    return this.fsdbChildrenStack[this.fsdbChildrenStack.length - 1];
  }

  private async fsdbReadChildScopes(element: NetlistItem): Promise<NetlistItem[]> {
    // VHDL array scopes are synthetic (scopeOffsetIdx === -1) and have no FSDB children.
    if (element.scopeOffsetIdx < 0) {
      return [];
    }

    const scopePath = element.scopePath.concat([element.name]);
    const result: NetlistItem[] = [];
    let itemsRemaining = Infinity;
    let startIndex = 0;
    let callLimit = 255;

    while (itemsRemaining > 0) {
      const response = await this.callFsdbWorkerTask({
        command: 'getScopeChildren',
        scopeOffsetIdx: element.scopeOffsetIdx,
        startIndex: startIndex
      });
      const childItems = (response.result as FsdbScopeChildrenResult) ?? {
        scopes: [],
        totalReturned: 0,
        remainingItems: 0
      };
      itemsRemaining = childItems.remainingItems;
      startIndex += childItems.totalReturned;

      for (const child of childItems.scopes) {
        result.push(createScope(child.name, child.type, scopePath, child.netlistId, child.scopeOffsetIdx, this.uri));
      }

      callLimit--;
      if (callLimit <= 0) { break; }
    }

    return result;
  }

  // Group same-named bit selects under a bus parent (matches surfer/wasm netlist UX).
  private mergeDuplicateFsdbVars(children: NetlistItem[]): NetlistItem[] {
    const scopes: NetlistItem[] = [];
    const varTable: Record<string, NetlistItem[]> = {};
    const seenVars = new Set<string>();

    for (const child of children) {
      if (child.contextValue === 'netlistScope') {
        scopes.push(child);
        continue;
      }
      // Drop exact duplicates from a double readVars, but keep aliased vars
      // (different names sharing a signalId) by keying on label too.
      const varKey = child.signalId + ':' + child.label;
      if (seenVars.has(varKey)) { continue; }
      seenVars.add(varKey);

      const key = child.name;
      if (varTable[key] === undefined) {
        varTable[key] = [child];
      } else {
        varTable[key].push(child);
      }
    }

    const result: NetlistItem[] = [...scopes];
    for (const vars of Object.values(varTable)) {
      if (vars.length === 1) {
        result.push(vars[0]);
        continue;
      }

      const bitList: NetlistItem[] = [];
      const busList: NetlistItem[] = [];
      let parent: NetlistItem | undefined;
      let maxWidth = 0;
      for (const varItem of vars) {
        if (varItem.width === 1) { bitList.push(varItem); }
        else { busList.push(varItem); }
      }
      for (const busItem of busList) {
        if (busItem.width > maxWidth) {
          maxWidth = busItem.width;
          parent = busItem;
        }
        result.push(busItem);
      }
      if (parent !== undefined) {
        parent.children = bitList;
        parent.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        // Mark loaded so expanding the bus doesn't trigger a scope load that
        // would wipe the nested bits and readVars an invalid scopeOffsetIdx.
        parent.fsdbVarLoaded = true;
      } else {
        result.push(...bitList);
      }
    }

    return result;
  }

  private async loadScopeChildren(element: NetlistItem): Promise<NetlistItem[]> {
    // Load child scopes first, then vars (mirrors previous order: scopes then signals).
    const childScopes = await this.fsdbReadChildScopes(element);
    element.children = childScopes;
    await this.fsdbReadVars(element);
    element.children = this.mergeDuplicateFsdbVars(element.children);
    element.fsdbVarLoaded = true;
    return element.children;
  }

  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) { return this.netlistTop; }
    if (element.fsdbVarLoaded) { return element.children; }

    const inFlight = this.childrenLoadInFlight.get(element);
    if (inFlight) { return inFlight; }

    // Chain onto the previous load so only one readVars runs at a time.
    const loadPromise = this.childrenLoadChain
      .then(() => this.loadScopeChildren(element))
      .finally(() => {
        this.childrenLoadInFlight.delete(element);
      });
    this.childrenLoadChain = loadPromise.catch(() => {});
    this.childrenLoadInFlight.set(element, loadPromise);
    return loadPromise;
  }

  async getSignalData(signalIdList: SignalId[]): Promise<void> {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Loading signals",
      cancellable: false
    }, async () => {
      await this.callFsdbWorkerTask({
        command: 'loadSignals',
        signalIdList: signalIdList
      });
    });

    // Map each signalId to a promise for handling its task
    const tasks = signalIdList.map(async (signalId) => {
      const result = await this.callFsdbWorkerTask({
        command: 'getValueChanges',
        signalId: signalId
      });
      const message = result;
      const data = message.result as FsdbWaveformData;

      this.postMessageToWebview({
        command: 'update-waveform-chunk',
        signalId: signalId,
        transitionDataChunk: data.valueChanges,
        totalChunks: 1,
        chunkNum: 0,
        min: data.min,
        max: data.max
      } as ValueChangeDataChunk);
    });
    // Run all tasks concurrently
    await Promise.all(tasks);
  }

  async getEnumData(enumList: EnumQueueEntry[]): Promise<void> {
    // Not Implemented for FSDB
    // TODO(heyfey): Implement fetching enum data for FSDB
    return;
  }

  async getValuesAtTime(time: number, instancePaths: string[]): Promise<ValuesAtTimeResult[]> {
    const instancePath2signalId: Map<string, number> = new Map();
    const signalId2values: Map<number, string | string[]> = new Map();
    for (const instancePath of instancePaths) {
      const netlistItem = await this.findTreeItemFn(instancePath, undefined, undefined);
      if (netlistItem) {
        instancePath2signalId.set(instancePath, netlistItem.signalId);
        signalId2values.set(netlistItem.signalId, []);
      }
    }
    if (signalId2values.size === 0) {
      return [];
    }

    const signalIdList = Array.from(signalId2values.keys());
    await this.callFsdbWorkerTask({
      command: 'loadSignals',
      signalIdList: signalIdList
    });

    // Call fsdbworker task for each signalId
    await Promise.all(signalIdList.map(async (signalId) => {
      const result = await this.callFsdbWorkerTask({
        command: 'getValuesAtTime',
        signalId: signalId,
        time: time
      });
      const message = result;
      signalId2values.set(signalId, (message.result as string | string[]) ?? '');
    }));

    // Convert the map to an array of objects
    const result = [];
    for (const [instancePath, signalId] of instancePath2signalId.entries()) {
      const values = signalId2values.get(signalId);
      if (values !== undefined) {
        result.push({
          instancePath: instancePath,
          value: values
        });
      }
    }
    return result;
  }

  async unload(): Promise<void> {
    await this.callFsdbWorkerTask({ command: 'unload' });
    if (this.fsdbWorker !== undefined) {
      this.fsdbWorker.disconnect();
      this.fsdbWorker = undefined;
    }
    this.parametersLoaded = false;
    this.netlistTop = [];
    this.childrenLoadInFlight.clear();
    this.childrenLoadChain = Promise.resolve();
    this.fsdbVarsBuffer = [];
    this.fsdbChildrenStack = [];
    this.fsdbStructNameStack = [];
  }

  dispose(): void {
    this.unload();
  }

  // FSDB callback methods
  private fsdbPathToScopePath(path: string): string[] {
    return path.length === 0 ? [] : path.split('.');
  }

  private fsdbGroupScopePath(path: string): string[] {
    return this.fsdbPathToScopePath(path).concat(this.fsdbStructNameStack);
  }

  private fsdbVarCallback(name: string, type: string, encoding: string, path: string, netlistId: NetlistId, signalId: SignalId, width: number, msb: number, lsb: number) {
    const enumType = "";
    const paramValue = "";
    const scopePath = this.fsdbGroupScopePath(path);
    const varItem = createVar(name, paramValue, type, encoding, scopePath, netlistId, signalId, width, msb, lsb, enumType, true /*isFsdb*/, this.uri);
    this.fsdbCurrentChildren().push(varItem);
  }

  private fsdbArrayBeginCallback(name: string, path: string, netlistId: number) {
    const scopePath = this.fsdbGroupScopePath(path);
    const arrayScope = createScope(name, "vhdlarray", scopePath, netlistId, -1, this.uri);
    this.fsdbCurrentChildren().push(arrayScope);
    this.fsdbChildrenStack.push(arrayScope.children);
    this.fsdbStructNameStack.push(name);
  }

  private fsdbArrayEndCallback(_size: number) {
    this.fsdbChildrenStack.pop();
    this.fsdbStructNameStack.pop();
    const parentChildren = this.fsdbCurrentChildren();
    const arrayScope = parentChildren[parentChildren.length - 1];
    if (arrayScope) {
      arrayScope.fsdbVarLoaded = true;
    }
  }

  private fsdbStructBeginCallback(name: string, type: string, path: string, netlistId: number) {
    const scopePath = this.fsdbGroupScopePath(path);
    const structScope = createScope(name, type, scopePath, netlistId, -1, this.uri);
    this.fsdbCurrentChildren().push(structScope);
    this.fsdbChildrenStack.push(structScope.children);
    this.fsdbStructNameStack.push(name);
  }

  private fsdbStructEndCallback() {
    this.fsdbChildrenStack.pop();
    this.fsdbStructNameStack.pop();
    const parentChildren = this.fsdbCurrentChildren();
    const structScope = parentChildren[parentChildren.length - 1];
    if (structScope) {
      structScope.fsdbVarLoaded = true;
    }
  }

  // TODO: @heyfey - implement netlist search
  public searchNetlist(searchString: string): Promise<NetlistSearchResult> {
    return Promise.resolve({totalResults: 0, searchResults: []});
  }
}
