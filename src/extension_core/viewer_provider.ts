import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';

import { VaporviewDocument, VaporviewDocumentFsdb, VaporviewDocumentWasm } from './document';
import { SurferDocument } from './surfer_document';
import { NetlistTreeDataProvider, DisplayedSignalsViewProvider, NetlistItem, WebviewCollection, netlistItemDragAndDropController } from './tree_view';
import { getInstancePath } from './tree_view';

export type NetlistId = number;
export type SignalId  = number;
export interface VaporviewDocumentDelegate {
  addSignalByNameToDocument(signalName: string): void;
  logOutputChannel(message: string): void;
  getViewerContext(): Promise<Uint8Array>;
  updateViews(uri: vscode.Uri): void;
  emitEvent(e: any): void;
  removeFromCollection(uri: vscode.Uri, document: VaporviewDocument): void;
}

export function scaleFromUnits(unit: string | undefined) {
  switch (unit) {
    case 'zs': return 1e-21;
    case 'as': return 1e-18;
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

export function logScaleFromUnits(unit: string | undefined) {
  switch (unit) {
    case 'zs': return -21;
    case 'as': return -18;
    case 'fs': return -15;
    case 'ps': return -12;
    case 'ns': return -9;
    case 'us': return -6;
    case 'µs': return -6;
    case 'ms': return -3;
    case 's':  return 0;
    case 'ks': return 3;
    default: return 0;
  }
}

export interface markerSetEvent {
  uri: string;
  time: number;
  units: string;
}

export interface signalEvent {
  uri: string;
  instancePath: string;
  netlistId: number;
  source: string; // "viewer" or "treeview"
}

export interface viewerDropEvent {
  uri: string;
  resourceUriList: vscode.Uri[];
}

// #region WaveformViewerProvider
export class WaveformViewerProvider implements vscode.CustomReadonlyEditorProvider<VaporviewDocument> {

  private static newViewerId = 1;
  private static readonly viewType = 'vaporview.waveformViewer';
  private readonly webviews = new WebviewCollection();
  //private readonly documentCollection = new DocumentCollection();
  private _numDocuments = 0;
  private readonly documentCollection = new Set<{
    readonly resource: string;
    readonly document: VaporviewDocument;
  }>();

  // Store remote server connection info for vaporview-remote:// URIs
  private readonly remoteConnections = new Map<string, {
    serverUrl: string;
    bearerToken?: string;
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
  public get numDocuments(): number {return this.numDocuments;}

  public static readonly markerSetEventEmitter = new vscode.EventEmitter<markerSetEvent>();
  public static readonly signalSelectEventEmitter = new vscode.EventEmitter<signalEvent>();
  public static readonly addVariableEventEmitter = new vscode.EventEmitter<signalEvent>();
  public static readonly removeVariableEventEmitter = new vscode.EventEmitter<signalEvent>();
  public static readonly externalDropEventEmitter = new vscode.EventEmitter<viewerDropEvent>();

  constructor(
    private readonly _context: vscode.ExtensionContext, 
    private readonly wasmModule: WebAssembly.Module
  ) {

    // The channel for printing the log.
    this.log = vscode.window.createOutputChannel('Vaporview', { log: true });
    _context.subscriptions.push(this.log);

    this.log.appendLine('Vaporview Activated');

    // Create and register the Netlist and Displayed Signals view container
    this.netlistTreeDataProvider = new NetlistTreeDataProvider();
    this.netlistView = vscode.window.createTreeView('waveformViewerNetlistView', {
      treeDataProvider: this.netlistTreeDataProvider,
      manageCheckboxStateManually: true,
      canSelectMany: true,
      showCollapseAll: true,
      dragAndDropController: netlistItemDragAndDropController
    });
    this._context.subscriptions.push(this.netlistView);

    this.displayedSignalsTreeDataProvider = new DisplayedSignalsViewProvider();
    this.displayedSignalsView = vscode.window.createTreeView('waveformViewerDisplayedSignalsView', {
      treeDataProvider: this.displayedSignalsTreeDataProvider,
      manageCheckboxStateManually: true,
      canSelectMany: true,
    });
    this._context.subscriptions.push(this.displayedSignalsView);

    // Create a status bar item for marker time, delta time, and selected signal
    this.markerTimeStatusBarItem     = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    this.deltaTimeStatusBarItem      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.selectedSignalStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);

    this.markerTimeStatusBarItem.command = 'vaporview.setTimeUnits';
    this.markerTimeStatusBarItem.tooltip = 'Select Time Units';

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
      addSignalByNameToDocument: this.addSignalByNameToDocument.bind(this),
      logOutputChannel: (message: string) => {this.log.appendLine(message);},
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
      emitEvent: (e: any) => {this.emitEvent(e);},
      removeFromCollection: (uri: vscode.Uri, document: VaporviewDocument) => {
        for (const entry of this.documentCollection) {
          if (entry.resource === uri.toString() && entry.document === document) {
            this.documentCollection.delete(entry);
            this._numDocuments--;
            
            // Clean up remote connection info if this is a vaporview-remote:// URI
            if (uri.scheme === 'vaporview-remote') {
              this.remoteConnections.delete(uri.toString());
              // Also clean up persisted state
              this._context.globalState.update(`remote-connection-${uri.toString()}`, undefined);
            }
            return;
          }
        }
      }
    };

    let document: VaporviewDocument;
    
    if (uri.scheme === 'vaporview-remote') {
      let connectionInfo = this.remoteConnections.get(uri.toString());
      
      if (!connectionInfo) {
        // Try to restore connection info from extension state
        const persistedConnection = this._context.globalState.get<{serverUrl: string, bearerToken?: string}>(`remote-connection-${uri.toString()}`);
        if (persistedConnection) {
          connectionInfo = persistedConnection;
          this.remoteConnections.set(uri.toString(), connectionInfo);
        } else {
          // Prompt user to reconnect
          const action = await vscode.window.showErrorMessage(
            `Remote connection lost for ${uri.path}. Please reconnect.`,
            'Reconnect', 'Close Tab'
          );
          if (action === 'Reconnect') {
            // Close the current tab and show reconnection dialog
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await vscode.commands.executeCommand('vaporview.openRemoteViewer');
          }
          throw new Error(`Remote connection lost and user chose not to reconnect`);
        }
      }
      
      // Load the Wasm worker
      const workerFile = vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'worker.js').fsPath;
      const wasmWorker = new Worker(workerFile);
      document = await SurferDocument.create(uri, connectionInfo.serverUrl, wasmWorker, this.wasmModule, delegate, connectionInfo.bearerToken);
    } else {
      // Handle regular file URIs
      const fileType = uri.fsPath.split('.').pop()?.toLocaleLowerCase() || '';
      if (fileType === 'fsdb') {
        document = await VaporviewDocumentFsdb.create(uri, openContext.backupId, delegate);
      } else {
        // Load the Wasm worker
        const workerFile = vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'worker.js').fsPath;
        const wasmWorker = new Worker(workerFile);
        document = await VaporviewDocumentWasm.create(uri, openContext.backupId, wasmWorker, this.wasmModule, delegate);
      }
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
        case 'logOutput':           {this.log.appendLine(e.message); break;}
        case 'showMessage':         {this.handleWebviewMessage(e); break;}
        case 'copyToClipboard':     {vscode.env.clipboard.writeText(e.text); break;}
        case 'executeCommand':      {vscode.commands.executeCommand(e.commandName, e.args); break;}
        case 'updateConfiguration': {vscode.workspace.getConfiguration('vaporview').update(e.property, e.value, vscode.ConfigurationTarget.Global); break;}
        case 'ready':               {document.onWebviewReady(webviewPanel); break;}
        case 'restoreState':        {this.applySettings(e.state, this.getDocumentFromUri(e.uri.toString())); break;}
        case 'contextUpdate':       {this.updateStatusBarItems(document, e); break;}
        case 'emitEvent':           {this.emitEvent(e); break;}
        case 'fetchTransitionData': {document.getSignalData(e.signalIdList); break;}
        case 'removeVariable':      {this.removeSignalFromDocument(e.netlistId); break;}
        case 'close-webview':       {webviewPanel.dispose(); break;}
        case 'handleDrop':          {this.handleWebviewDrop(e); break;}
        default: {this.log.appendLine('Unknown message type from webview: ' + JSON.stringify(e.command)); break;}
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
    const entry = { resource: document.uri.toString(), document};
    this.documentCollection.add(entry);
    this._numDocuments++;

    this.onDidChangeViewStateActive(document, webviewPanel);
  }

  public getDocumentFromUri(uri: string): VaporviewDocument | undefined {
    const key = uri
    for (const entry of this.documentCollection) {
      if (entry.resource === key) {return entry.document;}
    }
    return undefined;
  }

  public getDocumentFromOptionalUri(uri: string | undefined): VaporviewDocument | undefined {
    if (!uri) {return this.activeDocument;}
    else {return this.getDocumentFromUri(uri);}
  }

  public getAllDocuments() {
    const result: any = {
      documents: [],
      lastActiveDocument: null
    };
    this.documentCollection.forEach((entry) => {
      result.documents.push(entry.document.uri.toString());
    });
    if (this.lastActiveDocument) {
      result.lastActiveDocument = this.lastActiveDocument.uri.toString();
    }
    return result;
  }

  public getViewerState(uri: any) {
    const document = this.getDocumentFromOptionalUri(uri);
    if (!document) {return;}
    return document.getSettings();
  }

  public async openRemoteViewer(serverUrl: string, bearerToken?: string) {
    try {
      // Create a URI with the custom vaporview-remote scheme
      const sanitizedUrl = serverUrl.replace(/[^a-zA-Z0-9.-]/g, '_');

      // This can be changed to the actual filename of the remote file
      // This is simpler so we avoid another http request
      const remoteUri = vscode.Uri.parse(`vaporview-remote://${sanitizedUrl}/remote-waveforms.vcd`).with({scheme: 'vaporview-remote'});
      
      // Store connection info for use in openCustomDocument
      const connectionInfo = { serverUrl, bearerToken };
      this.remoteConnections.set(remoteUri.toString(), connectionInfo);
      
      // Persist connection info to extension state for reload recovery
      await this._context.globalState.update(`remote-connection-${remoteUri.toString()}`, connectionInfo);
      
      // Use VS Code's standard document opening mechanism
      await vscode.commands.executeCommand('vscode.openWith', remoteUri, WaveformViewerProvider.viewType);
      
      this.log.appendLine(`Opened remote viewer for ${serverUrl}`);
      
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open remote viewer: ${error}`);
      this.log.appendLine(`Failed to open remote viewer: ${error}`);
    }
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

    this.log.appendLine('Loading settings from file: ' + fileData.fileName);
    this.applySettings(fileData, this.activeDocument);
  }

  public async applySettingsOld(settings: any, document: VaporviewDocument | undefined = undefined) {

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
      if (signalInfo.dataType && signalInfo.dataType !== 'netlist-variable') {continue;}
      const signal   = signalInfo.name;
      const metadata = await document.findTreeItem(signal, signalInfo.msb, signalInfo.lsb);
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

    if (missingSignals.length > 0) {
      this.log.appendLine('Missing signals: '+ missingSignals.join(', '));
    }

    this.filterAddSignalsInNetlist(metadataList, true);
    for (const signalInfo of foundSignals) {
      this.setValueFormat(signalInfo.netlistId, {
        valueFormat:   signalInfo.numberFormat,
        colorIndex:    signalInfo.colorIndex,
        renderType:    signalInfo.renderType,
        command:       signalInfo.command,
      });
    }

    //console.log(settings.selectedSignal);
    if (settings.selectedSignal) {
      const s = settings.selectedSignal;
      const metadata = await document.findTreeItem(s.name, s.msb, s.lsb);
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

  public async addSignalListToDocument(signalList: any, document: VaporviewDocument, groupPath: string[]): Promise<string[]> {

    const missingSignals: string[] = [];
    for (const signalInfo of signalList) {
      if (signalInfo.dataType && signalInfo.dataType !== 'netlist-variable') {
        const name = signalInfo.groupName;
        this.newSignalGroup(name, groupPath, undefined);
        groupPath.push(name);
        const missing = await this.addSignalListToDocument(signalInfo.children, document, groupPath);
        missingSignals.push(...missing);
        groupPath.pop();
        continue;
      }
      const signal   = signalInfo.name;
      const metadata = await document.findTreeItem(signal, signalInfo.msb, signalInfo.lsb);
      if (metadata !== null) {
        
        this.addSignalsToDocument(document, [metadata], groupPath);
        // We need to copy the netlistId from the existing wavefrom dump in case the circuit has changed
        this.setValueFormat(signalInfo.netlistId, {
          valueFormat:   signalInfo.numberFormat,
          colorIndex:    signalInfo.colorIndex,
          renderType:    signalInfo.renderType,
          command:       signalInfo.command,
        });
      } else {
        missingSignals.push(signal);
      }
    }

    return missingSignals;
  }

  public async applySettings(settings: any, document: VaporviewDocument | undefined = undefined) {
    //console.log(settings);

    if (!settings.displayedSignals) {return;}
    if (!document) {
      if (!this.activeDocument) {return;}
      document = this.activeDocument;
    }

    const missingSignals = await this.addSignalListToDocument(settings.displayedSignals, document, []);
    const foundSignals: any[] = [];
    const metadataList: NetlistItem[] = [];

    if (settings.markerTime || settings.markerTime === 0) {
      this.setMarkerAtTime(settings.markerTime, 0);
    }
    if (settings.altMarkerTime || settings.altMarkerTime === 0) {
      this.setMarkerAtTime(settings.altMarkerTime, 1);
    }

    if (missingSignals.length > 0) {
      this.log.appendLine('Missing signals: '+ missingSignals.join(', '));
    }

    //console.log(settings.selectedSignal);
    if (settings.selectedSignal) {
      const s = settings.selectedSignal;
      const metadata = await document.findTreeItem(s.name, s.msb, s.lsb);
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
      document = this.getDocumentFromUri(e.toString());
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

    // No need to call this, as it will be called in viewport.init()
    //this.applySettings(settings, this.activeDocument);
    //console.log(settings);
  }

  copyWaveDrom() {
    this.activeWebview?.webview.postMessage({command: 'copyWaveDrom'});
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

  updateConfiguration(e: any) {
    this.documentCollection.forEach((entry) => {
      entry.document.setConfigurationSettings();
    });
  }

  handleWebviewMessage(event: any) {
    switch (event.messageType) {
      case 'warning': {vscode.window.showWarningMessage(event.message); break;}
      case 'error':   {vscode.window.showErrorMessage(event.message); break;}
      case 'info':    {vscode.window.showInformationMessage(event.message); break;}
      default:        {vscode.window.showInformationMessage(event.message); break;}
    }
  }

  setWaveDromClock(edge: string, netlistId: NetlistId | null) {
    this.activeWebview?.webview.postMessage({
      command: 'setWaveDromClock',
      edge: edge,
      netlistId: netlistId,
    });
  }

  setMarkerAtTimeWithUnits(time: number, unit: string, altMarker: number) {

    if (!this.lastActiveDocument) {return;}
  
    const metadata  = this.lastActiveDocument.metadata;
    const timeScale = metadata.timeScale;
    const timeUnit  = scaleFromUnits(metadata.timeUnit);

    if (!timeScale || !timeUnit) {return;}

    const scaleFactor = scaleFromUnits(unit) / (timeUnit * timeScale);

    this.setMarkerAtTime(Math.round(time * scaleFactor), altMarker);
  }

  setMarkerAtTime(time: number, altMarker: number) {

    if (!this.lastActiveWebview) {return;}
    if (!this.lastActiveDocument) {return;}

    // Check to see that the time is not out of bounds
    const timeEnd = this.lastActiveDocument.metadata.timeEnd;
    if (time < 0 || time > timeEnd) {return;}

    this.lastActiveWebview.webview.postMessage({command: 'setMarker', time: time, markerType: altMarker});
  }

  async updateTimeUnits(newUnits: string) {

    if (!this.lastActiveWebview) {return;}
    if (!this.lastActiveDocument) {return;}

    const timeUnit  = scaleFromUnits(this.lastActiveDocument.metadata.timeUnit);
    const timeEnd   = this.lastActiveDocument.metadata.timeEnd;
    const timeScale = this.lastActiveDocument.metadata.timeScale;
    const maxTime   = timeUnit * timeScale * timeEnd;
    const unitsList = ['fs', 'ps', 'ns', 'µs', 'ms', 's'];
    const selectableUnits = unitsList.filter((unit) => {return scaleFromUnits(unit) <= maxTime;});

    let units: string | undefined = newUnits;

    if (newUnits === "") {
      await vscode.window.showQuickPick(
        selectableUnits,
        {
          placeHolder: 'Select Time Units',
          canPickMany: false,
        }
      ).then((unit) => {
        units = unit;
      });
    }

    if (units === undefined || units === "") {return;}
    this.lastActiveWebview.webview.postMessage({command: 'setTimeUnits', units: units});
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
    w.selectedSignal   = event.selectedSignal;
    w.displayedSignals = event.displayedSignals || w.displayedSignals;
    w.zoomRatio        = event.zoomRatio        || w.zoomRatio;
    w.scrollLeft       = event.scrollLeft       || w.scrollLeft;
    w.numberFormat     = event.numberFormat     || w.numberFormat;
    w.autoReload       = event.autoReload       || w.autoReload;

    if (event.autoReload && document.fileUpdated && document.reloadPending) {
      vscode.commands.executeCommand('vaporview.reloadFile', document.uri);
    }

    //console.log(event);

    if (w.markerTime || w.markerTime === 0) {
      this.markerTimeStatusBarItem.text = 'Time: ' + document.formatTime(w.markerTime, event.displayTimeUnit);
      if (w.altMarkerTime !== null && w.markerTime !== null) {
        const deltaT = w.markerTime - w.altMarkerTime;
        this.deltaTimeStatusBarItem.text = 'Δt: ' + document.formatTime(deltaT, event.displayTimeUnit);
        this.deltaTimeStatusBarItem.show();
      } else {
        this.deltaTimeStatusBarItem.hide();
      }
    } else {
      this.deltaTimeStatusBarItem.hide();
      //this.markerTimeStatusBarItem.hide();
      this.markerTimeStatusBarItem.text = 'Time Units: ' + event.displayTimeUnit;
    }
    this.markerTimeStatusBarItem.show();

    if (w.selectedSignal || w.selectedSignal === 0) {
      const NetlistIdRef = document.netlistIdTable[w.selectedSignal];
      const signalName = NetlistIdRef.netlistItem.name;
      this.selectedSignalStatusBarItem.text = 'Selected signal: ' + signalName;

      if (event.transitionCount !== null) {
        const plural = event.transitionCount === 1 ? ')' : 's)';
        this.selectedSignalStatusBarItem.text += ' (' + event.transitionCount + ' value change' + plural;
      }
      this.selectedSignalStatusBarItem.show();
      //if (NetlistIdRef.displayedItem) {
      //  this.displayedSignalsView.reveal(NetlistIdRef.displayedItem, {select: true, focus: false});
      //}
    } else {
      this.selectedSignalStatusBarItem.hide();
    }
  }

  emitEvent(e: any) {

    let markerData: markerSetEvent = {
      uri: e.uri,
      time: e.time,
      units: e.units,
    }

    let signalData: signalEvent = {
      uri: e.uri,
      instancePath: e.instancePath,
      netlistId: e.netlistId,
      source: "viewer",
    }

    //console.log(e);

    switch (e.eventType) {
      case 'markerSet':      {WaveformViewerProvider.markerSetEventEmitter.fire(markerData); break;}
      case 'signalSelect':   {WaveformViewerProvider.signalSelectEventEmitter.fire(signalData); break;}
      case 'addVariable':    {WaveformViewerProvider.addVariableEventEmitter.fire(signalData); break;}
      case 'removeVariable': {WaveformViewerProvider.removeVariableEventEmitter.fire(signalData); break;}
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
    const metadata = await document.findTreeItem(signalName, undefined, undefined);
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

  // #region Command Handlers
  private getDocumentFromCommandArgs(e: any): VaporviewDocument | undefined {
    if (e.uri !== undefined) {
      const document = this.getDocumentFromUri(e.uri);
      if (!document) {
        vscode.window.showErrorMessage('Document not found: ' + e.uri.fsPath);
        return undefined;
      } else {
        return document;
      }
    } else if (this.activeDocument) {
      return this.activeDocument;
    } else {
      return this.lastActiveDocument;
    }
  }

  private async getNetlistItemFromCommandArgs(e: any): Promise<NetlistItem | null> {
    // CHeck for URI in the event
    let path;
    let metadata: NetlistItem | null = null;
    const document = this.getDocumentFromCommandArgs(e);
    if (!document) {return null;}

    // Check for netlistId in the event
    if (e.netlistId !== undefined) {
      const metadataRef = document.netlistIdTable[e.netlistId];
      if (metadataRef === undefined) {
        vscode.window.showWarningMessage('Signal not found: ' + e.netlistId);
        return null;
      }
      metadata = metadataRef.netlistItem;
    
    } else {
      // Check for instance path
      if (e.instancePath !== undefined) {
        path = e.instancePath;
      } else {
        if (e.scopePath !== undefined) {
          path = e.scopePath + ".";
        }
        path += e.name;
      }
      metadata = await document.findTreeItem(path, e.msb, e.lsb);
    }

    return metadata;
  }

  public loadAllVariablesFromFile(uri: string, maxSignals: number) {
    const document = this.getDocumentFromUri(uri);
    if (!document) {return;}
    const netlistIdCount = document.metadata.netlistIdCount;
    if (netlistIdCount > maxSignals || netlistIdCount > 64) {return;}

    document.treeData.forEach(scope => {
      this.addChildVariablesToDocument(document, scope, true, maxSignals);
    });
  }

  // Add or remove signals from the waveform viewer
  public async variableActionCommandHandler(e: any, action: string) {
    // Check for URI in the command
    const document = this.getDocumentFromCommandArgs(e);
    if (!document) {return;}
    if (document.uri.fsPath !== this.activeDocument?.uri.fsPath) {
      document.reveal();
    }

    let metadata = await this.getNetlistItemFromCommandArgs(e);
    if (metadata === null) {
      vscode.window.showWarningMessage('Signal not found: ' + e.netlistId);
      return;
    }

    switch (action) {
      case 'add': {
        if (metadata.contextValue !== 'netlistScope') {
          this.addSignalsToDocument(document, [metadata], []);
        }
        break;
      } 
      case 'remove': {
        if (metadata.contextValue !== 'netlistScope') {
          const netlistId = metadata.netlistId;
          this.removeSignalFromDocument(netlistId);
        }
        break;
      } 
      case 'reveal': {
        this.netlistView.reveal(metadata, {select: true, focus: false, expand: 0});
        break;
      }
      case "addLink": {
        if (metadata.contextValue !== 'netlistScope') {
          this.setValueFormat(metadata.netlistId, {command: e.command});
        }
        break;
      }
    }
  }

  public markerCommandHandler(e: any) {

    if (e.time === undefined) {return;}

    const document = this.getDocumentFromCommandArgs(e);
    if (!document) {return;}
    if (document.uri.fsPath !== this.activeDocument?.uri.fsPath) {
      document.reveal();
    }

    if (e.units !== undefined) {
      this.setMarkerAtTimeWithUnits(e.time, e.units, e.markerType);
    } else {
      this.setMarkerAtTime(e.time, e.markerType);
    }
  }

  public handleKeyBinding(e: any, keyCommand: string) {
    if (!this.activeWebview) {return;}
    this.activeWebview.webview.postMessage({command: 'handle-keypress', keyCommand: keyCommand});
  }

  private handleWebviewDrop(e: any) {

    const unknwonUriList: vscode.Uri[] = [];
    const netlistIdList: NetlistId[] = [];
    const document = this.getDocumentFromUri(e.uri.external);
    if (!document) {return;}
    if (!e.resourceUriList) {return;}

    console.log(e.resourceUriList);

    e.resourceUriList.forEach((uri: vscode.Uri) => {
      if (uri.scheme !== 'waveform') {
        unknwonUriList.push(uri);
        return;
      }
      const fragment = uri.fragment;
      if (fragment === undefined || fragment === "") {return;}
      fragment.split('&').forEach((tag: string) => {
        const [key, value] = tag.split('=');
        if (key === "var") {netlistIdList.push(parseInt(value));}
      });
    });

    if (document !== this.activeDocument) {return;}
    const metadata = netlistIdList.map(id => document.netlistIdTable[id].netlistItem);
    this.addSignalsToDocument(document, metadata, []);

    // Emit an event for the unknown URIs so that other extensions can handle them if needed
    if (unknwonUriList.length === 0) {return;}
    WaveformViewerProvider.externalDropEventEmitter.fire({
      uri: e.uri,
      resourceUriList: unknwonUriList,
    });
  }

  private addSignalsToDocument(document: VaporviewDocument, netlistElements: NetlistItem[], groupPath: string[] = []) {
    //if (!this.activeWebview) {return;}
    //if (!this.activeDocument) {return;}
    //if (!this.activeWebview.visible) {return;}

    //const document = this.activeDocument;
    const netlistIdList: NetlistId[] = [];

    netlistElements.forEach((element) => {
      const metadata   = element;
      const netlistId  = metadata.netlistId;
      this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Checked);
      const displayedItem = this.displayedSignalsTreeDataProvider.addSignalToTreeData(metadata);
      document.setNetlistIdTable(netlistId, displayedItem);
      netlistIdList.push(netlistId);
    });
    document.renderSignals(netlistIdList, groupPath);
  }

  public async addSignalByNameToDocument(signalName: string) {

    if (!this.lastActiveDocument) {return;}
    const document = this.lastActiveDocument;

    // remove colon or semicolon from end of signal name
    const instancePath = signalName.replace(/[:;]$/, '');
    // get msb and lsb from signal name
    const regex  = /\[(\d+:)?(\d+)\]$/;
    const field  = instancePath.match(regex);
    const lookup = instancePath.replace(regex, '');
    const msb   = field ? parseInt(field[1], 10) : undefined;
    const lsb   = field ? parseInt(field[2], 10) : msb;
    const metadata = await document.findTreeItem(lookup, msb, lsb);

    if (metadata === null) {
      // console.log('Signal not found ' + instancePath);
      vscode.window.showWarningMessage('Signal not found: ' + instancePath);
      return;
    }

    // If it's a scope item, we just reveal it in the tree view
    if (metadata.contextValue === 'netlistScope') {
      this.netlistView.reveal(metadata, {select: true, focus: false, expand: 0});
      return;
    }

    //console.log('found signal ' + instancePath);
    const netlistId = metadata.netlistId;
    let isDisplayed = false;
    document.displayedSignals.forEach((element: NetlistItem) => {
      if (element.netlistId === netlistId) {isDisplayed = true;}
    });

    if (isDisplayed !== undefined) {
      document.revealSignalInWebview(netlistId);
    } else {
      this.addSignalsToDocument(document, [metadata], []);
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
    if (!this.activeDocument) {return;}
    const document = this.activeDocument;
    
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
    this.addChildVariablesToDocument(document, e, recursive, maxChildren);
  }

  public async addChildVariablesToDocumentByName(name: string, recursive: boolean, maxChildren: number) {
    if (!this.activeDocument) {return;}
    const document = this.activeDocument;
    const netlistItem = await document.findTreeItem(name, undefined, undefined);
    if (netlistItem === null || netlistItem.contextValue !== 'netlistScope') {
      vscode.window.showWarningMessage('Scope not found: ' + name);
      return;
    }
    this.addChildVariablesToDocument(document, netlistItem, recursive, maxChildren);
  }

  public async addChildVariablesToDocument(document: VaporviewDocument, netlistItem: NetlistItem, recursive: boolean, maxChildren: number) {

    if (netlistItem.contextValue !== 'netlistScope') {return;}

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

    const document = this.activeDocument;
    if (!document) {return;}

    const elementList = netlistElements.filter((element) => {
      return element.checkboxState === vscode.TreeItemCheckboxState.Unchecked && 
             element.contextValue === 'netlistVar';
    });

    if ((elementList.length > 24) && !noWarning) {
      // show warning message
      vscode.window.showWarningMessage('You are about to add a large number of signals to the waveform viewer. This may cause performance issues. Do you want to continue?', 'Yes', 'No').then((response) => {
        if (response === 'Yes') {
          this.addSignalsToDocument(document, elementList, []);
        } 
      });
    } else {
      this.addSignalsToDocument(document, elementList, []);
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

  public newSignalGroup(name: string, groupPath: string[] | undefined, parentGroupId: number | undefined) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const panel      = this.activeWebview;
    panel.webview.postMessage({
      command: 'newSignalGroup',
      groupName: name,
      groupPath: groupPath,
      parentGroupId: parentGroupId,
    });
  }

  public renameSignalGroup(e: any | undefined) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    let groupId: number | undefined = e?.groupId;
    let groupName: string | undefined = e?.name;

    const panel      = this.activeWebview;
    panel.webview.postMessage({
      command: 'renameSignalGroup',
      groupId: groupId,
      groupName: groupName,
    });
  }

  public deleteSignalGroup(e: any | undefined, recursive: boolean) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    let groupId: number | undefined = e?.groupId;

    const panel = this.activeWebview;
    panel.webview.postMessage({
      command: 'remove-group',
      groupId: groupId,
      recursive: recursive,
    });
  }

  public setValueFormat(id: NetlistId | undefined, properties: any) {
    if (id === undefined) {return;}
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const panel      = this.activeWebview;
    const document   = this.activeDocument;
    const netlistRef = document.netlistIdTable[id];
    const format     = properties.valueFormat;

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
      color: properties.colorIndex,
      renderType: properties.renderType,
      customColors: [color1, color2, color3, color4],
      valueLinkCommand: properties.command,
      annotateValue: properties.annotateValue,
    });
  }

  copyValueAtMarker(e: any) {
    if (e.netlistId === undefined) {return;}
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    this.activeWebview.webview.postMessage({
      command: 'copyValueAtMarker',
      netlistId: e.netlistId,
    });
  }

  // To do: implement nonce with this HTML:
  //<script nonce="${nonce}" src="${scriptUri}"></script>
  private getHtmlContent(webview: vscode.Webview): string {

    const extensionUri = this._context.extensionUri;
    const htmlFile     = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.html'));
    const svgIconsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'icons.svg'));
    const jsFileUri    = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const cssFileUri   = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
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
      this.log.appendLine('Webview not initialized');
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
      this.addSignalsToDocument(this.activeDocument, [metadata], []);
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
    if (this.netlistViewSelectedSignals.length === 1) {
      const netlistData = this.netlistViewSelectedSignals[0];
      const uri = this.activeDocument?.uri;
      if (!uri) {return;}

      WaveformViewerProvider.signalSelectEventEmitter.fire({
        uri: uri.toString(),
        instancePath: getInstancePath(netlistData),
        netlistId: netlistData.netlistId,
        source: "netlistView",
      });
    }
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