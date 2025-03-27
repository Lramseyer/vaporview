import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';

import { VaporviewDocument, VaporviewDocumentFsdb, VaporviewDocumentWasm } from './document';
import { NetlistTreeDataProvider, DisplayedSignalsViewProvider, NetlistItem, WebviewCollection } from './tree_view';

export type NetlistId = number;
export type SignalId  = number;
export interface VaporviewDocumentDelegate {
  getViewerContext(): Promise<Uint8Array>;
  updateViews(uri: vscode.Uri): void;
  removeFromCollection(uri: vscode.Uri, document: VaporviewDocument): void;
}

// #region WaveformViewerProvider
export class WaveformViewerProvider implements vscode.CustomReadonlyEditorProvider<VaporviewDocument> {

  private static newViewerId = 1;
  private static readonly viewType = 'vaporview.waveformViewer';
  private readonly webviews = new WebviewCollection();
  //private readonly documentCollection = new DocumentCollection();
  private numDocuments = 0;
  private readonly documentCollection = new Set<{
    readonly resource: string;
    readonly document: VaporviewDocument;
  }>();

  private activeWebview: vscode.WebviewPanel | undefined;
  private activeDocument: VaporviewDocument | undefined;
  private lastActiveWebview: vscode.WebviewPanel | undefined;
  private lastActiveDocument: VaporviewDocument | undefined;

  public netlistTreeDataProvider: NetlistTreeDataProvider;
  public netlistView: vscode.TreeView<NetlistItem>;
  public displayedSignalsTreeDataProvider: DisplayedSignalsViewProvider;
  public displayedSignalsView: vscode.TreeView<NetlistItem>;
  public deltaTimeStatusBarItem: vscode.StatusBarItem;
  public markerTimeStatusBarItem: vscode.StatusBarItem;
  public selectedSignalStatusBarItem: vscode.StatusBarItem;

  public netlistViewSelectedSignals: NetlistItem[] = [];
  public displayedSignalsViewSelectedSignals: NetlistItem[] = [];
  public log: vscode.OutputChannel;

  constructor(
    private readonly _context: vscode.ExtensionContext, 
    private readonly wasmModule: WebAssembly.Module
  ) {

    // The channel for printing the log.
    this.log = vscode.window.createOutputChannel('Vaporview Log', { log: true });
    _context.subscriptions.push(this.log);

    // Create and register the Netlist and Displayed Signals view container
    this.netlistTreeDataProvider = new NetlistTreeDataProvider();
    this.netlistView = vscode.window.createTreeView('netlistContainer', {
      treeDataProvider: this.netlistTreeDataProvider,
      manageCheckboxStateManually: false,
      canSelectMany: true,
    });
    this._context.subscriptions.push(this.netlistView);

    this.displayedSignalsTreeDataProvider = new DisplayedSignalsViewProvider();
    this.displayedSignalsView = vscode.window.createTreeView('displaylistContainer', {
      treeDataProvider: this.displayedSignalsTreeDataProvider,
      manageCheckboxStateManually: false,
      canSelectMany: true,
    });
    this._context.subscriptions.push(this.displayedSignalsView);

    // Create a status bar item for marker time, delta time, and selected signal
    this.markerTimeStatusBarItem     = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.deltaTimeStatusBarItem      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.selectedSignalStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    // Subscribe to the View events. We need to subscribe to expand and collapse events
    // because the collapsible state would not otherwise be preserved when the tree view is refreshed
    this.netlistView.onDidExpandElement(this.handleNetlistExpandElement);
    this.netlistView.onDidCollapseElement(this.handleNetlistCollapseElement);
    this.netlistView.onDidChangeSelection(this.handleNetlistViewSelectionChanged, this, this._context.subscriptions);
    this.netlistView.onDidChangeCheckboxState(this.handleNetlistCheckboxChange, this, this._context.subscriptions);
    this.displayedSignalsView.onDidChangeSelection(this.handleDisplayedSignalsViewSelectionChanged, this, this._context.subscriptions);
    this.displayedSignalsView.onDidChangeCheckboxState(this.handleDisplayedViewSelectionChanged, this, this._context.subscriptions);
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: { backupId?: string },
    _token: vscode.CancellationToken,
  ): Promise<VaporviewDocument> {

    const delegate = {
      getViewerContext: async () => {
        const webviewsForDocument = Array.from(this.webviews.get(document.uri));
        if (!webviewsForDocument.length) {
          throw new Error('Could not find webview to save for');
        }
        const panel    = webviewsForDocument[0];
        const response = await this.postMessageWithResponse<number[]>(panel, 'getContext', {});
        return new Uint8Array(response);
      },
      updateViews: (uri: vscode.Uri) => {
        if (this.activeDocument?.uri !== uri) {return;}
        this.netlistTreeDataProvider.loadDocument(document);
        this.displayedSignalsTreeDataProvider.setTreeData(document.displayedSignals);
      },
      removeFromCollection: (uri: vscode.Uri, document: VaporviewDocument) => {
        const entry = { resource: uri.toString(), document: document };
        this.documentCollection.delete(entry);
        this.numDocuments--;
      }
    };

    let document: VaporviewDocument;
    const fileType = uri.fsPath.split('.').pop()?.toLocaleLowerCase() || '';
    if (fileType === 'fsdb') {
      document = await VaporviewDocumentFsdb.create(uri, openContext.backupId, delegate);
    } else {
      // Load the Wasm worker
      const workerFile = vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'worker.js').fsPath;
      const wasmWorker = new Worker(workerFile);
      document = await VaporviewDocumentWasm.create(uri, openContext.backupId, wasmWorker, this.wasmModule, delegate);
    }

    this.netlistTreeDataProvider.loadDocument(document);
    this.displayedSignalsTreeDataProvider.setTreeData(document.displayedSignals);

    return document;
  }

  async resolveCustomEditor(
    document: VaporviewDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {

    // Add a message handler for the webview
    webviewPanel.webview.onDidReceiveMessage(e => {

      switch (e.command) {
        case 'setTime':             {this.updateStatusBarItems(document, e); break;}
        case 'setSelectedSignal':   {this.updateStatusBarItems(document, e); break;}
        case 'contextUpdate' :      {this.updateStatusBarItems(document, e); break;}
        case 'fetchTransitionData': {document.getSignalData(e.signalIdList); break;}
        case 'copyWaveDrom':        {this.copyWaveDromToClipboard(e.waveDromJson, e.maxTransitions, e.maxTransitionsFlag); break;}
        case 'copyToClibpoard':     {vscode.env.clipboard.writeText(e.text); break;}
        case 'showMessage':         {this.handleWebviewMessage(e); break;}
        case 'close-webview':       {webviewPanel.dispose(); break;}
        case 'ready':               {document.onWebviewReady(webviewPanel); break;}
        case 'removeVariable':      {this.removeSignalFromDocument(e.netlistId); break;}
      }

      if (e.type === 'response')    {this.onMessage(e);}
    }, this, this._context.subscriptions);

    // Handle switching tabb events
    webviewPanel.onDidChangeViewState(e => {

      this.netlistViewSelectedSignals = [];
      this.displayedSignalsViewSelectedSignals = [];

      if (e.webviewPanel.active) {
        this.onDidChangeViewStateActive(document, webviewPanel);
        webviewPanel.webview.postMessage({command: 'getSelectionContext'});
      } else if (!e.webviewPanel.visible && e.webviewPanel === this.activeWebview) {
        this.onDidChangeViewStateInactive();
      }
    }, this, this._context.subscriptions);

    // Handle closing of the webview panel/document
    webviewPanel.onDidDispose(() => {

      if (this.activeWebview === webviewPanel) {
        this.onDidChangeViewStateInactive();
      }
      if (this.lastActiveWebview === webviewPanel) {
        this.lastActiveWebview = undefined;
        this.lastActiveDocument = undefined;
      }
    }, this, this._context.subscriptions);

    // Add the webview to our internal set of active webviews
    this.webviews.add(document.uri, webviewPanel);

    // Setup initial content for the webview
    webviewPanel.webview.options = { enableScripts: true, };
    webviewPanel.webview.html    = this.getHtmlContent(webviewPanel.webview);

    // Register the document in the dcoument collection
    const entry = { resource: document.uri.toString(), document };
    this.documentCollection.add(entry);
    this.numDocuments++;

    this.onDidChangeViewStateActive(document, webviewPanel);
  }

  public getDocumentFromUri(uri: vscode.Uri): VaporviewDocument | undefined {
    const key = uri.toString();
    for (const entry of this.documentCollection) {
      if (entry.resource === key) {return entry.document;}
    }
    return undefined;
  }

  public saveSettingsToFile() {
    if (!this.activeDocument) {
      vscode.window.showErrorMessage('No viewer is active. Please select the viewer you wish to save settings.');
      return;
    }

    const document       = this.activeDocument;
    const saveData       = document.getSettings();
    const saveDataString = JSON.stringify(saveData, null, 2);

    vscode.window.showSaveDialog({
      saveLabel: 'Save settings',
      filters: {JSON: ['json']}
    }).then((uri) => {
      if (uri) {
        vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(saveDataString));
      }
    });
  }

  public async loadSettingsFromFile() {

    if (!this.activeDocument) {
      vscode.window.showErrorMessage('No viewer is active. Please select the viewer you wish to load settings.');
      return;
    }

    //let version  = vscode.extensions.getExtension('Lramseyer.vaporview')?.packageJSON.version;
    // show open file diaglog
    const fileData = await new Promise<any>((resolve, reject) => {
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Load settings',
        filters: { JSON: ['json'] }
      }).then((uri) => {
        if (uri) {
          vscode.workspace.fs.readFile(uri[0]).then((data) => {
            const fileData = JSON.parse(new TextDecoder().decode(data));
            resolve(fileData);
          }, (error: any) => {
            reject(error); // Reject if readFile fails
          });
        } else {
          reject("No file selected"); // Reject if no file is selected
        }
      }, (error: any) => {
        reject(error); // Reject if showOpenDialog fails
      });
    });

    if (!fileData) {return;}
    if (fileData.fileName && fileData.fileName !== this.activeDocument.uri.fsPath) {
      vscode.window.showWarningMessage('The settings file may not match the active viewer');
    }

    this.applySettings(fileData, this.activeDocument);
  }

  public async applySettings(settings: any, document: VaporviewDocument | undefined = undefined) {

    //console.log(settings);

    if (!settings.displayedSignals) {return;}
    if (!document) {
      if (!this.activeDocument) {return;}
      document = this.activeDocument;
    }

    const missingSignals: string[] = [];
    const foundSignals: any[] = [];
    const metadataList: NetlistItem[] = [];

    for (const signalInfo of settings.displayedSignals) {
      const regex  = /\[(\d+:)?(\d+)\]$/;
      const signal   = signalInfo.name.replace(regex, '');
      const metadata = await document.findTreeItem(signal, signalInfo.msb, signalInfo.lsb, false/* findingScope */);
      if (metadata !== null) {
        metadataList.push(metadata);
        // We need to copy the netlistId from the existing wavefrom dump in case the circuit has changed
        foundSignals.push({
          netlistId: metadata.netlistId,
          numberFormat: signalInfo.numberFormat,
          colorIndex: signalInfo.colorIndex,
          renderType: signalInfo.renderType,
        });
      } else {
        missingSignals.push(signal);
      }
    }

    if (settings.markerTime || settings.markerTime === 0) {
      this.setMarkerAtTime(settings.markerTime, 0);
    }
    if (settings.altMarkerTime || settings.altMarkerTime === 0) {
      this.setMarkerAtTime(settings.altMarkerTime, 1);
    }

    console.log(missingSignals);
    this.filterAddSignalsInNetlist(metadataList, true);
    for (const signalInfo of foundSignals) {
      this.setValueFormat(signalInfo.netlistId, signalInfo.numberFormat, signalInfo.colorIndex, signalInfo.renderType);
    }

    //console.log(settings.selectedSignal);
    if (settings.selectedSignal) {
      const s = settings.selectedSignal;
      const metadata = await document.findTreeItem(s.name, s.msb, s.lsb, false/* findingScope */);
      if (metadata !== null) {
        const netlistIdSelected = metadata.netlistId;
        this.activeWebview?.webview.postMessage({
          command: 'setSelectedSignal', 
          netlistId: netlistIdSelected,
        });
      }
    }

    //this.netlistTreeDataProvider.loadDocument(document);
  }

  async reloadFile(e: any) {

    let document: VaporviewDocument | undefined;
    if (e.fsPath) {
      document = this.getDocumentFromUri(e);
    } else {
      document = this.activeDocument;
    }
    if (!this.activeDocument) {return;}
    if (!document) {return;}
    if (document.uri.fsPath !== this.activeDocument.uri.fsPath) {return;}

    const settings = document.getSettings();
    this.netlistTreeDataProvider.hide();
    this.displayedSignalsTreeDataProvider.hide();
    await document.reload();
    this.applySettings(settings, this.activeDocument);

    //console.log(settings);
  }

  copyWaveDrom() {
    this.activeWebview?.webview.postMessage({command: 'copyWaveDrom'});
  }

  copyWaveDromToClipboard(waveDromJson: string, maxTransitions: number, maxTransitionsFlag: boolean) {
    if (maxTransitionsFlag) {
      vscode.window.showWarningMessage('The number of transitions exceeds the maximum limit of ' + maxTransitions);
    }
    vscode.env.clipboard.writeText(waveDromJson);
    vscode.window.showInformationMessage('WaveDrom JSON copied to clipboard.');
  }

  // Send command to all webviews
  updateColorTheme(e: any) {
    this.documentCollection.forEach((entry) => {
      const webview = entry.document.webviewPanel;
      if (webview) {
        webview.webview.postMessage({command: 'updateColorTheme'});
      }
    });
  }

  handleWebviewMessage(event: any) {
    switch (event.messageType) {
      case 'info':    {vscode.window.showInformationMessage(event.message); break;}
      case 'warning': {vscode.window.showWarningMessage(event.message); break;}
      case 'error':   {vscode.window.showErrorMessage(event.message); break;}
    }
  }

  setWaveDromClock(edge: string, netlistId: NetlistId | null) {
    this.activeWebview?.webview.postMessage({
      command: 'setWaveDromClock',
      edge: edge,
      netlistId: netlistId,
    });
  }

  scaleFromUnits(unit: string | undefined) {
    switch (unit) {
      case 'fs': return 1e-15;
      case 'ps': return 1e-12;
      case 'ns': return 1e-9;
      case 'us': return 1e-6;
      case 'µs': return 1e-6;
      case 'ms': return 1e-3;
      case 's':  return 1;
      case 'ks': return 1000;
      default: return 1;
    }
  }

  setMarkerAtTimeWithUnits(time: number, unit: string) {

    if (!this.lastActiveDocument) {return;}
  
    const metadata  = this.lastActiveDocument.metadata;
    const timeScale = metadata.timeScale;
    const timeUnit  = this.scaleFromUnits(metadata.timeUnit);

    if (!timeScale || !timeUnit) {return;}

    const scaleFactor = this.scaleFromUnits(unit) / (timeUnit * timeScale);

    this.setMarkerAtTime(Math.round(time * scaleFactor), 0);
  }

  setMarkerAtTime(time: number, altMarker: number) {

    if (!this.lastActiveWebview) {return;}
    if (!this.lastActiveDocument) {return;}

    // Check to see that the time is not out of bounds
    const chunkCount = this.lastActiveDocument.metadata.chunkCount;
    const chunkTime  = this.lastActiveDocument.metadata.chunkTime;
    if (!chunkCount || !chunkTime) {return;}
    if (time < 0 || time > (chunkCount * chunkTime)) {return;}

    this.lastActiveWebview.webview.postMessage({command: 'setMarker', time: time, markerType: altMarker});
  }

  updateStatusBarItems(document: VaporviewDocument, event: any) {
    //this.deltaTimeStatusBarItem.hide();
    //this.markerTimeStatusBarItem.hide();
    //this.selectedSignalStatusBarItem.hide();

    if (!document) {return;}
    const w = document.webviewContext;
    //w.markerTime       = event.markerTime       || w.markerTime;
    //w.altMarkerTime    = event.altMarkerTime    || w.altMarkerTime;
    //w.selectedSignal   = event.selectedSignal   || w.selectedSignal;
    if (event.markerTime || event.markerTime === 0) {w.markerTime = event.markerTime;}
    if (event.altMarkerTime || event.altMarkerTime === 0) {w.altMarkerTime = event.altMarkerTime;}
    if (event.selectedSignal || event.selectedSignal === 0) {w.selectedSignal = event.selectedSignal;}
    w.displayedSignals = event.displayedSignals || w.displayedSignals;
    w.zoomRatio        = event.zoomRatio        || w.zoomRatio;
    w.scrollLeft       = event.scrollLeft       || w.scrollLeft;
    w.numberFormat     = event.numberFormat     || w.numberFormat;

    if (w.markerTime || w.markerTime === 0) {
      this.markerTimeStatusBarItem.text = 'time: ' + document.formatTime(w.markerTime);
      this.markerTimeStatusBarItem.show();
      if (w.altMarkerTime !== null && w.markerTime !== null) {
        const deltaT = w.markerTime - w.altMarkerTime;
        this.deltaTimeStatusBarItem.text = 'Δt: ' + document.formatTime(deltaT);
        this.deltaTimeStatusBarItem.show();
      } else {
        this.deltaTimeStatusBarItem.hide();
      }
    } else {
      this.deltaTimeStatusBarItem.hide();
      this.markerTimeStatusBarItem.hide();
    }

    if (w.selectedSignal || w.selectedSignal === 0) {
      const NetlistIdRef = document.netlistIdTable[w.selectedSignal];
      const signalName = NetlistIdRef.netlistItem.name;
      this.selectedSignalStatusBarItem.text = 'Selected signal: ' + signalName;
      this.selectedSignalStatusBarItem.show();
      //if (NetlistIdRef.displayedItem) {
      //  this.displayedSignalsView.reveal(NetlistIdRef.displayedItem, {select: true, focus: false});
      //}
    } else {
      this.selectedSignalStatusBarItem.hide();
    }
  }

  onDidChangeViewStateActive(document: VaporviewDocument, webviewPanel: vscode.WebviewPanel) {
    this.activeWebview  = webviewPanel;
    this.activeDocument = document;
    this.lastActiveWebview  = webviewPanel;
    this.lastActiveDocument = document;
    this.netlistTreeDataProvider.loadDocument(document);
    this.displayedSignalsTreeDataProvider.setTreeData(this.activeDocument.displayedSignals);
  }

  onDidChangeViewStateInactive() {
    this.activeWebview  = undefined;
    this.activeDocument = undefined;
    this.netlistTreeDataProvider.hide();
    this.displayedSignalsTreeDataProvider.hide();
    this.deltaTimeStatusBarItem.hide();
    this.markerTimeStatusBarItem.hide();
    this.selectedSignalStatusBarItem.hide();
  }

  async showInNetlistViewByName(signalName: string) {
    if (!this.lastActiveDocument) {return;}
    const document = this.lastActiveDocument;
    const metadata = await document.findTreeItem(signalName, undefined, undefined, true/* findingScope */);
    if (metadata !== null) {
      this.netlistView.reveal(metadata, {select: true, focus: false, expand: 3});
    }
  }

  showInNetlistView(netlistId: NetlistId) {
    if (!this.activeDocument) {return;}
    const NetlistIdRef = this.activeDocument.netlistIdTable[netlistId];
    if (NetlistIdRef.netlistItem) {
      this.netlistView.reveal(NetlistIdRef.netlistItem, {select: true, focus: false, expand: 3});
      if (NetlistIdRef.displayedItem) {
        this.displayedSignalsView.reveal(NetlistIdRef.displayedItem, {select: true, focus: false});
      }
    }
  }

  private _requestId = 1;
  private readonly _callbacks = new Map<number, (response: any) => void>();
  private postMessageWithResponse<R = unknown>(panel: vscode.WebviewPanel, type: string, body: any): Promise<R> {
    const requestId = this._requestId++;
    const p = new Promise<R>(resolve => this._callbacks.set(requestId, resolve));
    panel.webview.postMessage({ type, requestId, body });
    return p;
  }

  private onMessage(message: any) {
    const callback = this._callbacks.get(message.requestId);
    callback?.(message.body);
  }

  // Add or remove signals from the waveform viewer

  private addSignalsToDocument(netlistElements: NetlistItem[]) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const document = this.activeDocument;
    const netlistIdList: NetlistId[] = [];

    netlistElements.forEach((element) => {
      const metadata   = element;
      const netlistId  = metadata.netlistId;
      this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Checked);
      const displayedItem = this.displayedSignalsTreeDataProvider.addSignalToTreeData(metadata);
      document.setNetlistIdTable(netlistId, displayedItem);
      netlistIdList.push(netlistId);
    });
    document.renderSignals(netlistIdList);
  }

  public async addSignalByNameToDocument(signalName: string) {
    if (!this.lastActiveDocument) {return;}
    const document = this.lastActiveDocument;

    // get msb and lsb from signal name
    const regex  = /\[(\d+:)?(\d+)\]$/;
    const field  = signalName.match(regex);
    const lookup = signalName.replace(regex, '');
    const msb   = field ? parseInt(field[1], 10) : undefined;
    const lsb   = field ? parseInt(field[2], 10) : msb;

    //console.log('lookup: ' + lookup + ' msb: ' + msb + ' lsb: ' + lsb);
    const metadata = await document.findTreeItem(lookup, msb, lsb, false/* findingScope */);

    if (metadata === null) {
      // console.log('Signal not found ' + signalName);
      vscode.window.showWarningMessage('Signal not found: ' + signalName);
      return;
    }

    // If it's a scope item, we just reveal it in the tree view
    if (metadata.contextValue === 'netlistScope') {
      this.netlistView.reveal(metadata, {select: true, focus: false, expand: 0});
      return;
    }

    //console.log('found signal ' + signalName);
    const netlistId   = metadata.netlistId;
    const isDisplayed = document.webviewContext.displayedSignals.find((element: any) => element.netlistId === netlistId);
    if (isDisplayed !== undefined) {
      document.revealSignalInWebview(netlistId);
    } else {
      this.addSignalsToDocument([metadata]);
    }
  }

  public async addVariableByInstancePathToDocument(e: any) {
    if (e === undefined || e.instancePath === undefined) { // Executed from the command palette
      vscode.window.showInputBox({
        prompt: 'Enter variable name',
        placeHolder: 'top.mid.var'
      }).then(userInput => {
        if (userInput !== undefined && userInput !== '') {
          this.addSignalByNameToDocument(`${userInput}`);
        }
      });
      return;
    }
    this.addSignalByNameToDocument(e.instancePath);
  }

  public async addAllInScopeToDocument(e: NetlistItem, recursive: boolean, maxChildren: number) {
    if (e === undefined) { // Executed from the command palette
      vscode.window.showInputBox({
        prompt: 'Enter scope name',
        placeHolder: 'top.mid.scope'
      }).then(userInput => {
        if (userInput !== undefined && userInput !== '') {
          this.addChildVariablesToDocumentByName(`${userInput}`, recursive, maxChildren);
        }
      });
      return;
    }
    if (e.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    this.addChildVariablesToDocument(e, recursive, maxChildren);
  }

  public async addChildVariablesToDocumentByName(name: string, recursive: boolean, maxChildren: number) {
    if (!this.activeDocument) {return;}
    const document = this.activeDocument;
    const netlistItem = await document.findTreeItem(name, undefined, undefined, true/* findingScope */);
    if (netlistItem === null || netlistItem.contextValue !== 'netlistScope') {
      vscode.window.showWarningMessage('Scope not found: ' + name);
      return;
    }
    this.addChildVariablesToDocument(netlistItem, recursive, maxChildren);
  }

  public async addChildVariablesToDocument(netlistItem: NetlistItem, recursive: boolean, maxChildren: number) {

    if (!this.activeDocument) {return;}
    if (netlistItem.contextValue !== 'netlistScope') {return;}

    const document = this.activeDocument;
    const netlistVariables: NetlistItem[] = [];
    const netlistScopes: NetlistItem[] = [netlistItem];

    while (netlistScopes.length > 0 && netlistVariables.length < maxChildren) {

      const parentScope = netlistScopes.shift();
      const children = await document.getChildrenExternal(parentScope);
      children.forEach((element) => {
        if (element.contextValue === 'netlistVar' && element.checkboxState === vscode.TreeItemCheckboxState.Unchecked) {
          netlistVariables.push(element);
        }
        else if (element.contextValue === 'netlistScope' && recursive) {
          netlistScopes.push(element);
        }
      });
    }

    this.filterAddSignalsInNetlist(netlistVariables, false);
  }

  public filterAddSignalsInNetlist(netlistElements: NetlistItem[], noWarning: boolean = false) {

    const elementList = netlistElements.filter((element) => {
      return element.checkboxState === vscode.TreeItemCheckboxState.Unchecked && 
             element.contextValue === 'netlistVar';
    });

    if ((elementList.length > 24) && !noWarning) {
      // show warning message
      vscode.window.showWarningMessage('You are about to add a large number of signals to the waveform viewer. This may cause performance issues. Do you want to continue?', 'Yes', 'No').then((response) => {
        if (response === 'Yes') {
          this.addSignalsToDocument(elementList);
        } 
      });
    } else {
      this.addSignalsToDocument(elementList);
    }
  }

  public removeSignalFromDocument(netlistId: NetlistId) {

    if (!this.activeDocument) {return;}
    if (!this.activeWebview?.visible) {return;}

    const document = this.activeDocument;
    document.removeSignalFromWebview(netlistId);

    const metadataELements = document.netlistIdTable[netlistId];
    if (metadataELements) {
      const netlistItem = metadataELements.netlistItem;
      this.netlistTreeDataProvider.setCheckboxState(netlistItem, vscode.TreeItemCheckboxState.Unchecked);
      const displayedItem = metadataELements.displayedItem;
      if (displayedItem) {
        this.displayedSignalsTreeDataProvider.removeSignalFromTreeData(displayedItem);
        document.setNetlistIdTable(netlistId, undefined);
      }
    }
  }

  public removeSignalList(signalList: NetlistItem[]) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    signalList.forEach((element) => {
      const metadata  = element;
      const netlistId = metadata.netlistId;
      if (element.checkboxState === vscode.TreeItemCheckboxState.Checked) {
        this.removeSignalFromDocument(netlistId);
      }
    });
  }

  public removeSelectedSignalsFromDocument(view: string) {

    if (view === 'netlist') {
      this.removeSignalList(this.netlistViewSelectedSignals);
    } else if (view === 'displayedSignals') {
      this.removeSignalList(this.displayedSignalsViewSelectedSignals);
    }
  }

  public setValueFormat(id: NetlistId | undefined, format: string | undefined, color: number | undefined, renderType: string | undefined) {
    if (id === undefined) {return;}
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const panel      = this.activeWebview;
    const document   = this.activeDocument;
    const netlistRef = document.netlistIdTable[id];

    if (netlistRef) {
      if (format !== undefined) {
        netlistRef.netlistItem.numberFormat = format;
      }
    }

    const color1 = vscode.workspace.getConfiguration('vaporview').get('customColor1');
    const color2 = vscode.workspace.getConfiguration('vaporview').get('customColor2');
    const color3 = vscode.workspace.getConfiguration('vaporview').get('customColor3');
    const color4 = vscode.workspace.getConfiguration('vaporview').get('customColor4');

    //console.log('setting value format');

    panel.webview.postMessage({
      command: 'setDisplayFormat',
      netlistId: id,
      numberFormat: format,
      color: color,
      renderType: renderType,
      customColors: [color1, color2, color3, color4],
    });
  }

  // To do: implement nonce with this HTML:
  //<script nonce="${nonce}" src="${scriptUri}"></script>

  private getHtmlContent(webview: vscode.Webview): string {

    const extensionUri = this._context.extensionUri;
    const htmlFile     = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'body.html'));
    const svgIconsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'icons.svg'));
    const jsFileUri    = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const cssFileUri   = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'style.css'));
    const codiconsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    let htmlContent    = fs.readFileSync(htmlFile.fsPath, 'utf8');

    htmlContent = htmlContent.replace('${webAssets.svgIconsUri}', svgIconsUri.toString());
    htmlContent = htmlContent.replace('${webAssets.jsFileUri}', jsFileUri.toString());
    htmlContent = htmlContent.replace('${webAssets.cssFileUri}', cssFileUri.toString());
    htmlContent = htmlContent.replace('${webAssets.codiconsUri}', codiconsUri.toString());

    return htmlContent;
  }

  // View Container Event handlers

  private handleNetlistCheckboxChange = (e: vscode.TreeCheckboxChangeEvent<NetlistItem>) => {

    //console.log('onDidChangeCheckboxState()');
    //console.log(changedItem);
    //console.log(this.netlistView);
    const metadata = e.items[0][0];

    if (!this.activeWebview?.visible) {return;}
    if (!this.activeDocument?.webviewInitialized) {
      console.log('Webview not initialized');
      this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Unchecked);
      return;
    }

    // If the item is a parent node, uncheck it
    if (metadata.contextValue == "netlistScope") {
      this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Unchecked);
      return;
    }

    //console.log(metadata);

    if (metadata.checkboxState === vscode.TreeItemCheckboxState.Checked) {
      this.addSignalsToDocument([metadata]);
    } else if (metadata.checkboxState === vscode.TreeItemCheckboxState.Unchecked) {
      this.removeSignalFromDocument(metadata.netlistId);
    }
  };

  private handleDisplayedViewSelectionChanged = (e: vscode.TreeCheckboxChangeEvent<NetlistItem>) => {

    const metadata = e.items[0][0];

    if (!this.activeWebview?.visible) {return;}
    if (!this.activeDocument?.webviewInitialized) {return;}
    if (metadata.checkboxState !== vscode.TreeItemCheckboxState.Unchecked) {return;}

    this.removeSignalFromDocument(metadata.netlistId);
  };

  // onDidChangeSelection() event returns readonly elements
  // so we need to copy the selected elements to a new array
  // Six one way, half a dozen the other. One is just more concise...
  private handleNetlistViewSelectionChanged = (e: vscode.TreeViewSelectionChangeEvent<NetlistItem>) => {
    this.netlistViewSelectedSignals = [];
    e.selection.forEach((element) => {
      this.netlistViewSelectedSignals.push(element);
    });
  };

  private handleDisplayedSignalsViewSelectionChanged = (e: vscode.TreeViewSelectionChangeEvent<NetlistItem>) => {
    this.displayedSignalsViewSelectedSignals = [];
    e.selection.forEach((element) => {
      this.displayedSignalsViewSelectedSignals.push(element);
    });
  };

  private handleNetlistCollapseElement = (e: vscode.TreeViewExpansionEvent<NetlistItem>) => {
    if (!this.lastActiveWebview?.visible) {return;}
    if (e.element.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    e.element.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
  };

  private handleNetlistExpandElement = (e: vscode.TreeViewExpansionEvent<NetlistItem>) => {
    if (!this.lastActiveWebview?.visible) {return;}
    if (e.element.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    e.element.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  };
}