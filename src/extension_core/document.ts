import * as vscode from 'vscode';
import { SignalId, NetlistId, StateChangeType, QueueEntry, EnumQueueEntry, DocumentId } from '../common/types';
import { logScaleFromUnits } from '../common/functions';
import { NetlistLinkProvider } from './terminal_links';
import * as path from 'path';
import { VaporviewDocumentCollection, VaporviewDocumentDelegate } from './viewer_provider';
import { NetlistItem, getInstancePath } from './tree_view';

export type WaveformTopMetadata = {
  timeTableLoaded: boolean;
  scopeCount: number;
  netlistIdCount: number;
  signalIdCount: number;
  timeTableCount: number;
  timeEnd: number;
  defaultZoom: number;
  timeScale: number;
  timeUnit: string;
  chunkSize: number;
};

export type NetlistIdTable = NetlistItem[];

/* 
Interface for waveform file parsers
*/
export interface WaveformFileParser {

  // Properties
  metadata: WaveformTopMetadata;

  // Methods
  loadNetlist(): Promise<void>;
  loadBody(): Promise<void>;
  unload(): Promise<void>;
  dispose(): void;
  getChildren(element: NetlistItem | undefined): Promise<NetlistItem[]>;
  getSignalData(signalIdList: SignalId[]): Promise<void>;
  getEnumData(enumList: EnumQueueEntry[]): Promise<void>;
  getValuesAtTime(time: number, instancePaths: string[]): Promise<any>;

  // Callbacks
  postMessageToWebview(message: any): void;
}

// #region VaporviewDocument
export class VaporviewDocument extends vscode.Disposable implements vscode.CustomDocument {

  protected disposables: vscode.Disposable[] = [];
  public readonly uri: vscode.Uri;
  public readonly fileType: string = 'unknown';
  private fileWatcher: vscode.FileSystemWatcher | undefined = undefined;
  private reloadDebounce: NodeJS.Timeout | undefined = undefined;
  private _fileUpdated: boolean = false;
  private _reloadPending: boolean = false;
  public readonly documentId: DocumentId;
  // Hierarchy
  public treeData: NetlistItem[] = [];
  private _netlistIdTable: NetlistIdTable = [];
  private sortNetlist: boolean = vscode.workspace.getConfiguration('vaporview').get('sortNetlist') || false;
  private readonly _providerDelegate: VaporviewDocumentDelegate;
  // Format handler (composition) - always defined
  private readonly _handler: WaveformFileParser;
  // Webview
  public webviewPanel: vscode.WebviewPanel | undefined = undefined;
  private _webviewInitialized: boolean = false;
  public metadata: WaveformTopMetadata;
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
  // State management
  public clearDirtyStatus: boolean = false;
  public saveFileUri: vscode.Uri | undefined = undefined;
  public undoStack: any[] = [];
  public redoStack: any[] = [];

  constructor(
    uri: vscode.Uri,
    providerDelegate: VaporviewDocumentDelegate,
    handler: WaveformFileParser,
    documentId: DocumentId
  ) {
    super(() => this.dispose());
    this.uri = uri;
    this.documentId = documentId;
    this.fileType = uri.fsPath.split('.').pop()?.toLocaleLowerCase() || '';
    this._providerDelegate = providerDelegate;
    this._handler = handler;
    this.metadata = this._handler.metadata;
    this.setupFileWatcher();
  }

  static async create(uri: vscode.Uri, providerDelegate: VaporviewDocumentDelegate, documentCollection: VaporviewDocumentCollection): Promise<VaporviewDocument> {
    const handler  = await providerDelegate.createFileParser(uri);
    const fileType = uri.fsPath.split('.').pop()?.toLocaleLowerCase() || '';
    const documentId = documentCollection.createUniqueDocumentId();
    const document = new VaporviewDocument(uri, providerDelegate, handler, documentId);
    documentCollection.add(documentId, document);
    if (fileType === 'fsdb') {
      (document._handler as any).findTreeItemFn = document.findTreeItem.bind(document);
    }
    return document;
  }

  // #region Public getters
  public get netlistIdTable(): NetlistIdTable { return this._netlistIdTable; }
  public get webviewInitialized(): boolean { return this._webviewInitialized; }
  public get fileUpdated(): boolean { return this._fileUpdated; }
  public get reloadPending(): boolean { return this._reloadPending; }
  //public get handler(): WaveformFileParser { return this._handler; }
  public get providerDelegate(): VaporviewDocumentDelegate { return this._providerDelegate; }

  // #region WaveformFileParserDelegate implementation
  // These methods are called by the format handlers
  public setChunkSize() {
    const chunkSize = this.metadata.chunkSize;
    const newMinTimeStep = 10 ** (Math.round(Math.log10(Number(chunkSize) / 128)) | 0);
    this.metadata.defaultZoom = 4 / newMinTimeStep;
    this.onDoneParsingWaveforms();
  }

  public postMessageToWebview(message: any): void {
    this.webviewPanel?.webview.postMessage(message);
  }

  // #region Handler management
  
  public async load(): Promise<void> {

    // Load netlist first
    const loadTime    = Date.now();
    await this._handler.loadNetlist();
    const netlistTime = (Date.now() - loadTime) / 1000;
    this.treeData     = await this._handler.getChildren(undefined);
    this.setTerminalLinkProvider();
    this._providerDelegate.updateViews(this.uri);

    const scopeCount     = this.toStringWithCommas(this._handler.metadata.scopeCount);
    const netlistIdCount = this.toStringWithCommas(this._handler.metadata.netlistIdCount);
    this.providerDelegate.logOutputChannel("Finished parsing netlist for " + this.uri.fsPath);
    this.providerDelegate.logOutputChannel("Scope count: " + scopeCount + ", Variable count: " + netlistIdCount + ", Time: " + netlistTime + " seconds");

    // Then load body
    const bodyLoadTime = Date.now();
    await this._handler.loadBody();
    const bodyTime     = (Date.now() - bodyLoadTime) / 1000;
    this.setChunkSize();

    const timeTableCount = this.toStringWithCommas(Number(this.metadata.timeTableCount));
    this.providerDelegate.logOutputChannel("Finished parsing body for " + this.uri.fsPath);
    this._providerDelegate.logOutputChannel("Total Value Change Events: " + timeTableCount + ", Time: " + bodyTime + " seconds");
  }

  // #region Webview lifecycle
  
  public onWebviewReady(webviewPanel: vscode.WebviewPanel) {
    this.webviewPanel = webviewPanel;
    this._handler.postMessageToWebview = webviewPanel.webview.postMessage.bind(webviewPanel.webview);
    if (this._webviewInitialized) { return; }
    if (!this.metadata.timeTableLoaded) { return; }
    webviewPanel.webview.postMessage({
      command: 'initViewport',
      metadata: this.metadata,
      documentId: this.documentId,
      uri: this.uri
    });
    this.setConfigurationSettings();
    this._webviewInitialized = true;
  }

  public setConfigurationSettings() {
    const scrollingMode = vscode.workspace.getConfiguration('vaporview').get('scrollingMode');
    const rulerLines = vscode.workspace.getConfiguration('vaporview').get('showRulerLines');
    const fillMultiBitValues = vscode.workspace.getConfiguration('vaporview').get('fillMultiBitValues');

    const color1 = vscode.workspace.getConfiguration('vaporview').get('customColor1');
    const color2 = vscode.workspace.getConfiguration('vaporview').get('customColor2');
    const color3 = vscode.workspace.getConfiguration('vaporview').get('customColor3');
    const color4 = vscode.workspace.getConfiguration('vaporview').get('customColor4');

    this.webviewPanel?.webview.postMessage({
      command: 'setConfigSettings',
      scrollingMode: scrollingMode,
      rulerLines: rulerLines,
      fillMultiBitValues: fillMultiBitValues,
      customColors: [color1, color2, color3, color4],
    });
  }

  public onDoneParsingWaveforms() {
    if (this.webviewPanel) {
      this.onWebviewReady(this.webviewPanel);
    }
  }

  public captureWebviewState(event: any): boolean {

    let isDirty = false;
    console.log(event.stateChangeType);
    if (event.stateChangeType === StateChangeType.User || event.stateChangeType === StateChangeType.File) {
      this.captureStateForUndo();
      this.redoStack = [];
    }

    if (event.stateChangeType === StateChangeType.User) {
      isDirty = true;
    }

    if (event.markerTime || event.markerTime === 0) {
      this.webviewContext.markerTime = event.markerTime;
    }
    if (event.altMarkerTime || event.altMarkerTime === 0) {
      this.webviewContext.altMarkerTime = event.altMarkerTime;
    }

    this.webviewContext.selectedSignal   = event.selectedSignal;
    this.webviewContext.displayedSignals = event.displayedSignals || this.webviewContext.displayedSignals;
    this.webviewContext.zoomRatio        = event.zoomRatio        || this.webviewContext.zoomRatio;
    this.webviewContext.scrollLeft       = event.scrollLeft       || this.webviewContext.scrollLeft;
    this.webviewContext.numberFormat     = event.numberFormat     || this.webviewContext.numberFormat;
    this.webviewContext.autoReload       = event.autoReload       || this.webviewContext.autoReload;

    return isDirty;
  }

  captureStateForUndo() {
    this.undoStack.push(JSON.stringify(this.webviewContext));
    if (this.undoStack.length > 50) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo() {
    if (this.undoStack.length === 0) {return;}
    const lastState = this.undoStack.pop();
    this.redoStack.push(JSON.stringify(this.webviewContext));
    this._providerDelegate.applySettings(JSON.parse(lastState), this, StateChangeType.Undo);
  }
  
  redo() {
    if (this.redoStack.length === 0) {return;}
    const lastState = this.redoStack.pop();
    this.undoStack.push(JSON.stringify(this.webviewContext));
    this._providerDelegate.applySettings(JSON.parse(lastState), this, StateChangeType.Redo);
  }

  // #region File watching

  private setupFileWatcher() {
    if (this.uri.scheme !== 'file') { return; }

    const pattern = new vscode.RelativePattern(path.dirname(this.uri.fsPath), path.basename(this.uri.fsPath));
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
    this._providerDelegate.logOutputChannel("File changed: " + this.uri.fsPath);
    if (this.webviewContext.autoReload && this._fileUpdated) {
      this._reloadPending = true;
      if (this.webviewPanel?.active) {
        vscode.commands.executeCommand('vaporview.reloadFile', this.uri);
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
    await this.unload();
    await this.load();
    this._fileUpdated = false;
    this._reloadPending = false;
  }

  // #region Handler delegated methods

  public async getScopeChildren(element: NetlistItem | undefined): Promise<NetlistItem[]> {
    const children       = await this._handler.getChildren(element);
    const sortedChildren = this.sortNetlistScopeChildren(children);
    if (element !== undefined) { element.children = sortedChildren; }
    children.forEach((child) => {
      this._netlistIdTable[child.netlistId] = child;
    });
    return sortedChildren;
  }

  public async getSignalData(signalIdList: SignalId[]): Promise<void> {
    return this._handler.getSignalData(signalIdList);
  }

  public async getEnumData(enumNameList: EnumQueueEntry[]): Promise<void> {
    return this._handler.getEnumData(enumNameList);
  }

  public async getValuesAtTime(e: any): Promise<any> {
    const time = e.time ?? this.webviewContext.markerTime;
    return this._handler.getValuesAtTime(time, e.instancePaths);
  }

  public async unload(): Promise<void> {
    this.unloadWebview();
    this.unloadTreeData();
    await this._handler.unload();
    this.metadata.timeTableLoaded = false;
  }

  public dispose(): void {
    this._handler.dispose();
    this._providerDelegate.updateViews(this.uri);
    this._providerDelegate.removeFromCollection(this.uri, this);
    this.disposables.forEach((disposable) => { disposable.dispose(); });
    this.disposables = [];
  }
}
