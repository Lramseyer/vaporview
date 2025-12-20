import * as vscode from 'vscode';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';

import { SignalId, NetlistId } from './viewer_provider';
import { NetlistItem, createScope, createVar } from './tree_view';
import { IWaveformFormatHandler, IWaveformFormatHandlerDelegate, EnumQueueEntry } from './document';

type FsdbWorkerMessage = {
  id: string;
  result: any;
};

type FsdbWaveformData = {
  valueChanges: [number, string][];
  min: number;
  max: number;
};

export class FsdbFormatHandler implements IWaveformFormatHandler {
  private delegate: IWaveformFormatHandlerDelegate;
  private fsdbWorker: ChildProcess | undefined = undefined;
  private fsdbTopModuleCount: number = 0;
  private fsdbCurrentScope: NetlistItem | undefined = undefined;
  // Need a reference to findTreeItem for getValuesAtTime
  private findTreeItemFn: (scopePath: string, msb: number | undefined, lsb: number | undefined) => Promise<NetlistItem | null>;

  constructor(
    delegate: IWaveformFormatHandlerDelegate,
    findTreeItemFn: (scopePath: string, msb: number | undefined, lsb: number | undefined) => Promise<NetlistItem | null>,
  ) {
    this.delegate = delegate;
    this.findTreeItemFn = findTreeItemFn;
  }

  async load(): Promise<void> {
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
      fsdbPath: this.delegate.uri.fsPath
    });

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Reading Scopes for " + this.delegate.uri.fsPath,
      cancellable: false
    }, async () => {
      await this.callFsdbWorkerTask({
        command: 'readScopes'
      });
    });

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Reading Metadata for " + this.delegate.uri.fsPath,
      cancellable: false
    }, async () => {
      await this.callFsdbWorkerTask({
        command: 'readMetadata'
      });
    });

    this.delegate.updateViews();
  }

  private setupFsdbWorkerListeners(): void {
    if (!this.fsdbWorker) return;

    this.fsdbWorker.on('online', () => {
      console.log('FSDB worker is online.');
    });

    this.fsdbWorker.on('error', (err: Error) => {
      console.error('FSDB worker error:', err);
    });

    this.fsdbWorker.on('exit', (code: any, signal: any) => {
      if (code !== 0) {
        console.error(`Child process exited with error code ${code} (signal: ${signal})`);
      }
    });

    this.fsdbWorker.on('message', (msg: any) => {
      this.handleMessage(msg);
    });
  }

  private handleMessage(message: any) {
    switch (message.command) {
      case 'require-failed': {
        vscode.window.showErrorMessage("Failed to load FSDB reader, is vaporview.fsdbReaderLibsPath properly set? (" + message.error.code + ")");
        break;
      }
      case 'fsdb-scope-callback': {
        this.fsdbScopeCallback(message.name, message.type, message.path, message.netlistId, message.scopeOffsetIdx);
        break;
      }
      case 'fsdb-upscope-callback': {
        this.fsdbUpscopeCallback();
        break;
      }
      case 'setMetadata': {
        this.delegate.setMetadata(message.scopecount, message.varcount, message.timescale, message.timeunit);
        break;
      }
      case 'setChunkSize': {
        this.delegate.setChunkSize(message.chunksize, message.timeend, BigInt(0));
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
    }
  }

  private callFsdbWorkerTask(message: any): Promise<any> {
    if (this.fsdbWorker === undefined) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substring(2, 9);
      message.id = id;

      const messageHandler = (message: any) => {
        if (message.id === id) {
          this.fsdbWorker!.off('message', messageHandler);
          if (message.error) {
            console.log(message.error);
            return reject(new Error(message.error));
          }
          resolve(message);
        }
      };

      this.fsdbWorker!.on('message', messageHandler);
      this.fsdbWorker!.send(message);
    });
  }

  private async fsdbReadVars(element: NetlistItem | undefined) {
    if (!element) return;
    this.fsdbCurrentScope = element;

    let scopePath = "";
    if (element.scopePath !== "") { scopePath += element.scopePath + "."; }
    scopePath += element.name;

    await this.callFsdbWorkerTask({
      command: 'readVars',
      scopePath: scopePath,
      scopeOffsetIdx: element.scopeOffsetIdx
    });
  }

  async getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!element) { return this.delegate.treeData; }
    if (element.fsdbVarLoaded) { return element.children; }
    await this.fsdbReadVars(element);
    element.fsdbVarLoaded = true;
    return element.children;
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
      const message = result as FsdbWorkerMessage;
      const data = message.result as FsdbWaveformData;

      this.delegate.postMessageToWebview({
        command: 'update-waveform-chunk',
        signalId: signalId,
        transitionDataChunk: data.valueChanges,
        totalChunks: 1,
        chunkNum: 0,
        min: data.min,
        max: data.max
      });
    });
    // Run all tasks concurrently
    await Promise.all(tasks);
  }

  async getEnumData(enumList: EnumQueueEntry[]): Promise<void> {
    // Not Implemented for FSDB
    // TODO(heyfey): Implement fetching enum data for FSDB
    return;
  }

  async getValuesAtTime(time: number | null, instancePaths: string[]): Promise<any> {
    const effectiveTime = time ?? this.delegate.getMarkerTime();

    // No time provided nor marker time set, return empty array
    if (effectiveTime === undefined || effectiveTime === null) {
      return [];
    }

    const instancePath2signalId: Map<string, number> = new Map();
    const signalId2values: Map<number, any> = new Map();
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
        time: effectiveTime
      });
      const message = result as FsdbWorkerMessage;
      signalId2values.set(signalId, message.result);
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
    this.fsdbTopModuleCount = 0;
    this.fsdbCurrentScope = undefined;
  }

  dispose(): void {
    this.unload();
  }

  // FSDB callback methods
  private fsdbScopeCallback(name: string, type: string, path: string, netlistId: number, scopeOffsetIdx: number) {
    this.delegate.treeData.push(createScope(name, type, path, netlistId, scopeOffsetIdx, this.delegate.uri));
  }

  private fsdbUpscopeCallback() {
    const scope = this.delegate.treeData.pop()!;
    if (this.delegate.treeData.length === this.fsdbTopModuleCount) {
      this.delegate.treeData.push(scope);
      this.fsdbTopModuleCount++;
    } else {
      this.delegate.treeData[this.delegate.treeData.length - 1].children.push(scope);
    }
  }

  private fsdbVarCallback(name: string, type: string, encoding: string, path: string, netlistId: NetlistId, signalId: SignalId, width: number, msb: number, lsb: number) {
    const enumType = "";
    const paramValue = "";
    const varItem = createVar(name, paramValue, type, encoding, path, netlistId, signalId, width, msb, lsb, enumType, true /*isFsdb*/, this.delegate.uri);
    this.fsdbCurrentScope!.children.push(varItem);
    this.delegate.netlistIdTable[varItem.netlistId] = varItem;
  }

  private fsdbArrayBeginCallback(name: string, path: string, netlistId: number) {
    this.fsdbCurrentScope!.children.push(createScope(name, "vhdlarray", path, netlistId, -1, this.delegate.uri));
  }

  private fsdbArrayEndCallback(size: number) {
    const arrayElements = [];
    for (let i = 0; i < size; i++) {
      const element = this.fsdbCurrentScope!.children.pop()!;
      arrayElements.push(element);
    }
    const array = this.fsdbCurrentScope!.children.pop()!;
    array.children.push(...arrayElements.reverse());
    array.fsdbVarLoaded = true;
    this.fsdbCurrentScope!.children.unshift(array);
  }
}
