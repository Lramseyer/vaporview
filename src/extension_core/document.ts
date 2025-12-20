import * as vscode from 'vscode';
import { NetlistLinkProvider } from './terminal_links';
import * as path from 'path';

import { SignalId, NetlistId, VaporviewDocumentDelegate, logScaleFromUnits } from './viewer_provider';
import { NetlistItem, getInstancePath } from './tree_view';


type WaveformTopMetadata = {
  timeTableLoaded: boolean;
  moduleCount: number;
  netlistIdCount: number;
  signalIdCount: number;
  timeTableCount: number;
  timeEnd: number;
  defaultZoom: number;
  timeScale: number;
  timeUnit: string;
};

// Re-export queue entry types for handlers
export type SignalQueueEntry = {
  type: 'signal';
  id: SignalId;
};

export type EnumQueueEntry = {
  type: 'enum';
  name: string;
  netlistId: NetlistId;
};

export type QueueEntry = SignalQueueEntry | EnumQueueEntry;

export type NetlistIdTable = NetlistItem[];

/**
 * Delegate interface for format handlers to communicate back to the document.
 * This provides handlers access to shared state and functionality.
 */
export interface IWaveformFormatHandlerDelegate {
  // File information
  readonly uri: vscode.Uri;
  readonly fileType: string;

  // Tree data access (handlers populate these)
  treeData: NetlistItem[];
  netlistIdTable: NetlistIdTable;

  setMetadata(scopecount: number, varcount: number, timescale: number, timeunit: string): void;
  setChunkSize(chunksize: bigint, timeend: bigint, timetablelength: bigint): void;
  postMessageToWebview(message: any): void;
  logOutputChannel(message: string): void;
  sortNetlistScopeChildren(netlistItems: NetlistItem[]): NetlistItem[];
  updateViews(): void;
  getMarkerTime(): number | null;
}

export interface IWaveformFormatHandler {

  load(): Promise<void>;
  unload(): Promise<void>;
  dispose(): void;
  getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]>;
  getSignalData(signalIdList: SignalId[]): Promise<void>;
  getEnumData(enumList: EnumQueueEntry[]): Promise<void>;
  getValuesAtTime(time: number | null, instancePaths: string[]): Promise<any>;
}


// #region VaporviewDocument
export class VaporviewDocument extends vscode.Disposable implements vscode.CustomDocument, IWaveformFormatHandlerDelegate {

  protected disposables: vscode.Disposable[] = [];
  private readonly _uri: vscode.Uri;
  private readonly _fileType: string = 'unknown';
  private fileWatcher: vscode.FileSystemWatcher | undefined = undefined;
  private reloadDebounce: NodeJS.Timeout | undefined = undefined;
  private _fileUpdated: boolean = false;
  private _reloadPending: boolean = false;
  // Hierarchy
  public treeData: NetlistItem[] = [];
  private _netlistIdTable: NetlistIdTable = [];
  private sortNetlist: boolean = vscode.workspace.getConfiguration('vaporview').get('sortNetlist') || false;
  public parametersLoaded: boolean = false;
  private readonly _providerDelegate: VaporviewDocumentDelegate;
  // Format handler (composition)
  private _handler: IWaveformFormatHandler | undefined = undefined;
  // Webview
  public webviewPanel: vscode.WebviewPanel | undefined = undefined;
  private _webviewInitialized: boolean = false;
  public metadata: WaveformTopMetadata = {
    timeTableLoaded: false,
    moduleCount: 0,
    netlistIdCount: 0,
    signalIdCount: 0,
    timeTableCount: 0,
    timeEnd: 0,
    defaultZoom: 1,
    timeScale: 1,
    timeUnit: "ns",
  };
  public webviewContext = {
    markerTime: null as number | null,
    altMarkerTime: null as number | null,
    selectedSignal: null as NetlistId | null,
    displayedSignals: [] as any[],
    zoomRatio: 1,
    scrollLeft: 0,
    numberFormat: "hexadecimal",
    autoReload: false,
  };

  constructor(uri: vscode.Uri, providerDelegate: VaporviewDocumentDelegate) {
    super(() => this.dispose());
    this._uri = uri;
    this._fileType = uri.fsPath.split('.').pop()?.toLocaleLowerCase() || '';
    this._providerDelegate = providerDelegate;
    this.setupFileWatcher();
  }

  // #region Public getters
  public get uri() { return this._uri; }
  public get fileType() { return this._fileType; }
  public get netlistIdTable(): NetlistIdTable { return this._netlistIdTable; }
  public get webviewInitialized(): boolean { return this._webviewInitialized; }
  public get fileUpdated(): boolean { return this._fileUpdated; }
  public get reloadPending(): boolean { return this._reloadPending; }
  public get handler(): IWaveformFormatHandler | undefined { return this._handler; }

  // #region IWaveformFormatHandlerDelegate implementation
  // These methods are called by the format handlers
  
  public setMetadata(scopecount: number, varcount: number, timescale: number, timeunit: string) {
    this.metadata.moduleCount = scopecount;
    this.metadata.netlistIdCount = varcount;
    this.metadata.timeScale = timescale;
    this.metadata.timeUnit = timeunit;
    this._netlistIdTable = new Array(varcount);
  }

  public setChunkSize(chunksize: bigint, timeend: bigint, timetablelength: bigint) {
    const newMinTimeStemp = 10 ** (Math.round(Math.log10(Number(chunksize) / 128)) | 0);
    this.metadata.defaultZoom = 4 / newMinTimeStemp;
    this.metadata.timeEnd = Number(timeend);
    this.metadata.timeTableLoaded = true;
    this.metadata.timeTableCount = Number(timetablelength);
    this._providerDelegate.logOutputChannel("Total Value Change Events: " + this.toStringWithCommas(Number(timetablelength)));
    this.onDoneParsingWaveforms();
  }

  public postMessageToWebview(message: any): void {
    this.webviewPanel?.webview.postMessage(message);
  }

  public logOutputChannel(message: string): void {
    this._providerDelegate.logOutputChannel(message);
  }

  public updateViews(): void {
    this._providerDelegate.updateViews(this._uri);
  }

  public getMarkerTime(): number | null {
    return this.webviewContext.markerTime;
  }

  // #region Handler management
  
  public setHandler(handler: IWaveformFormatHandler) {
    this._handler = handler;
  }

  public async loadWithHandler(): Promise<void> {
    if (!this._handler) {
      throw new Error("No handler set for document");
    }
    await this._handler.load();
    this.setTerminalLinkProvider();
  }

  // #region Webview lifecycle
  
  public onWebviewReady(webviewPanel: vscode.WebviewPanel) {
    this.webviewPanel = webviewPanel;
    if (this._webviewInitialized) { return; }
    if (!this.metadata.timeTableLoaded) { return; }
    webviewPanel.webview.postMessage({
      command: 'initViewport',
      metadata: this.metadata,
      uri: this.uri
    });
    this.setConfigurationSettings();
    this._webviewInitialized = true;
  }

  public setConfigurationSettings() {
    const scrollingMode = vscode.workspace.getConfiguration('vaporview').get('scrollingMode');
    const rulerLines = vscode.workspace.getConfiguration('vaporview').get('showRulerLines');
    const fillMultiBitValues = vscode.workspace.getConfiguration('vaporview').get('fillMultiBitValues');
    this.webviewPanel?.webview.postMessage({
      command: 'setConfigSettings',
      scrollingMode: scrollingMode,
      rulerLines: rulerLines,
      fillMultiBitValues: fillMultiBitValues
    });
  }

  public onDoneParsingWaveforms() {
    if (this.webviewPanel) {
      this.onWebviewReady(this.webviewPanel);
    }
  }

  // #region File watching

  private setupFileWatcher() {
    if (this._uri.scheme !== 'file') { return; }

    const pattern = new vscode.RelativePattern(path.dirname(this._uri.fsPath), path.basename(this._uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const scheduleReload = () => {
      if (this.reloadDebounce) { clearTimeout(this.reloadDebounce); }
      this.reloadDebounce = setTimeout(() => this.handleUpdateFile(), 500);
      this._fileUpdated = true;
    };

    watcher.onDidChange(scheduleReload, this, this.disposables);
    this.disposables.push(watcher);
    this.fileWatcher = watcher;
  }

  private handleUpdateFile() {
    this._providerDelegate.logOutputChannel("File changed: " + this._uri.fsPath);
    if (this.webviewContext.autoReload && this._fileUpdated) {
      this._reloadPending = true;
      if (this.webviewPanel?.active) {
        vscode.commands.executeCommand('vaporview.reloadFile', this._uri);
      }
    }
  }

  // #region Netlist helpers

  public sortNetlistScopeChildren(netlistItems: NetlistItem[]) {
    let result = [];
    const scopes = netlistItems.filter(item => item.contextValue === 'netlistScope');
    const variables = netlistItems.filter(item => item.contextValue !== 'netlistScope');
    const parameters = variables.filter(item => item.type === 'Parameter');
    const signals = variables.filter(item => item.type !== 'Parameter');

    if (this.sortNetlist) {
      result.push(...(scopes.sort((a, b) => a.name.localeCompare(b.name))));
      result.push(...(parameters.sort((a, b) => a.name.localeCompare(b.name))));
      result.push(...(signals.sort((a, b) => a.name.localeCompare(b.name))));
    } else {
      result.push(...scopes);
      result.push(...parameters);
      result.push(...signals);
    }

    return result;
  }

  protected setTerminalLinkProvider() {
    const scopeTopNames = this.treeData.filter(item => item.contextValue === 'netlistScope').map((item) => item.name);
    const terminalLinkProvider = new NetlistLinkProvider(this._providerDelegate, scopeTopNames);
    const disposable = vscode.window.registerTerminalLinkProvider(terminalLinkProvider);
    this.disposables.push(disposable);
  }

  // #region Public API

  public reveal() {
    if (!this.webviewPanel) { return; }
    this.webviewPanel.reveal(vscode.ViewColumn.Active);
  }

  public getSettings() {
    return {
      extensionVersion: vscode.extensions.getExtension('Lramseyer.vaporview')?.packageJSON.version,
      fileName: this.uri.fsPath,
      markerTime: this.webviewContext.markerTime,
      altMarkerTime: this.webviewContext.altMarkerTime,
      selectedSignal: this.getNameFromNetlistId(this.webviewContext.selectedSignal),
      zoomRatio: this.webviewContext.zoomRatio,
      scrollLeft: this.webviewContext.scrollLeft,
      displayedSignals: this.webviewContext.displayedSignals
    };
  }

  public toStringWithCommas(n: number) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  public formatTime(time: number, unit: string) {
    const timescaleOffset = logScaleFromUnits(this.metadata.timeUnit) - logScaleFromUnits(unit);
    const timeScaleOffsetInverse = logScaleFromUnits(unit) - logScaleFromUnits(this.metadata.timeUnit);
    let timeValue;
    if (timescaleOffset > 0) {
      timeValue = time * this.metadata.timeScale * (10 ** timescaleOffset);
    } else {
      timeValue = time * this.metadata.timeScale / (10 ** timeScaleOffsetInverse);
    }
    const strings = timeValue.toString().split('.');
    strings[0] = strings[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return strings.join('.') + ' ' + unit;
  }

  public async findTreeItem(scopePath: string, msb: number | undefined, lsb: number | undefined): Promise<NetlistItem | null> {
    if (!scopePath || scopePath === '') { return null; }
    const module = this.treeData.find((element) => element.label === scopePath.split('.')[0]);
    if (!module) { return null; }
    return await module.findChild(scopePath.split('.').slice(1).join('.'), this, msb, lsb);
  }

  public getNameFromNetlistId(netlistId: NetlistId | null) {
    if (netlistId === null) { return null; }
    const netlistData = this.netlistIdTable[netlistId];
    const scopePath = netlistData?.scopePath;
    const signalName = netlistData?.name;
    const msb = netlistData?.msb;
    const lsb = netlistData?.lsb;
    return {
      name: scopePath + '.' + signalName,
      msb: msb,
      lsb: lsb,
    };
  }

  public getDisplayedNetlistIds(): NetlistId[] {
    return this.getNetlistIdsFromDisplayedSignals(this.webviewContext.displayedSignals);
  }

  public getNetlistIdsFromDisplayedSignals(displayedSignals: any[]): NetlistId[] {
    const result: NetlistId[] = [];
    displayedSignals.forEach((element: any) => {
      if (element.dataType === 'netlist-variable') {
        result.push(element.netlistId);
      } else if (element.dataType === 'signal-group') {
        result.push(...this.getNetlistIdsFromDisplayedSignals(element.children));
      }
    });
    return result;
  }

  public isSignalDisplayed(netlistId: NetlistId | null | undefined): boolean {
    if (netlistId === null || netlistId === undefined) { return false; }
    const displayed = this.getDisplayedNetlistIds();
    return displayed.includes(netlistId);
  }

  public async renderSignals(netlistIdList: NetlistId[], moveToGroup: string[] | undefined, index: number | undefined) {
    const signalList: any = [];
    if (!this.webviewPanel) { return; }

    netlistIdList.forEach((netlistId) => {
      const metadata = this.netlistIdTable[netlistId];
      if (!metadata) { return; }

      signalList.push({
        signalId: metadata.signalId,
        signalWidth: metadata.width,
        signalName: metadata.name,
        scopePath: metadata.scopePath,
        netlistId: metadata.netlistId,
        type: metadata.type,
        encoding: metadata.encoding,
        enumType: metadata.enumType,
      });

      this._providerDelegate.emitEvent({
        eventType: 'addVariable',
        uri: this.uri,
        instancePath: getInstancePath(metadata),
        netlistId: metadata.netlistId,
      });
    });
    this.webviewPanel.webview.postMessage({
      command: 'add-variable',
      signalList: signalList,
      groupPath: moveToGroup,
      index: index
    });
  }

  public fetchData(requestList: QueueEntry[]) {
    const signalIdList: SignalId[] = [];
    const enumList: EnumQueueEntry[] = [];
    requestList.forEach((entry) => {
      if (entry.type === 'signal') {
        signalIdList.push(entry.id);
      } else if (entry.type === 'enum') {
        enumList.push(entry);
      }
    });
    if (enumList.length > 0) {
      this.getEnumData(enumList);
    }
    if (signalIdList.length === 0) { return; }
    this.getSignalData(signalIdList);
  }

  public revealSignalInWebview(netlistId: NetlistId) {
    if (!this.webviewPanel) { return; }

    this.webviewPanel.webview.postMessage({
      command: 'setSelectedSignal',
      netlistId: netlistId
    });
  }

  public removeSignalFromWebview(netlistId: NetlistId | undefined, rowId: number | undefined, removeAllSelected: boolean) {
    if (!this.webviewPanel) { return; }

    this.webviewPanel.webview.postMessage({
      command: 'remove-signal',
      netlistId: netlistId,
      rowId: rowId,
      removeAllSelected: removeAllSelected
    });
  }

  public async unloadTreeData() {
    this.treeData = [];
    this._netlistIdTable = [];
  }

  public async unloadWebview() {
    this._webviewInitialized = false;
    if (!this.webviewPanel) { return; }
    try {
      this.webviewPanel?.webview.postMessage({ command: 'unload' });
    } catch (e) {
      // This can happen if the webview has already been disposed of
    }
  }

  public async reload() {
    this.sortNetlist = vscode.workspace.getConfiguration('vaporview').get('sortNetlist') || false;
    this.parametersLoaded = false;
    await this.unload();
    await this.loadWithHandler();
    this._fileUpdated = false;
    this._reloadPending = false;
  }

  // #region Handler delegated methods

  public async getChildrenExternal(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    if (!this._handler) { return []; }
    return this._handler.getChildren(element);
  }

  public async getSignalData(signalIdList: SignalId[]): Promise<void> {
    if (!this._handler) { return; }
    return this._handler.getSignalData(signalIdList);
  }

  public async getEnumData(enumNameList: EnumQueueEntry[]): Promise<void> {
    if (!this._handler) { return; }
    return this._handler.getEnumData(enumNameList);
  }

  public async getValuesAtTime(e: any): Promise<any> {
    if (!this._handler) { return []; }
    return this._handler.getValuesAtTime(e.time, e.instancePaths);
  }

  public async unload(): Promise<void> {
    this.unloadWebview();
    this.unloadTreeData();
    if (this._handler) {
      await this._handler.unload();
    }
    this.metadata.timeTableLoaded = false;
  }

  public dispose(): void {
    if (this._handler) {
      this._handler.dispose();
    }
    this._providerDelegate.updateViews(this.uri);
    this._providerDelegate.removeFromCollection(this.uri, this);
    this.disposables.forEach((disposable) => { disposable.dispose(); });
    this.disposables = [];
  }
}
