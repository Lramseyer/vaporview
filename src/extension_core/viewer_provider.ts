import * as vscode from 'vscode';
import { DocumentId, NetlistId, SignalId, StateChangeType, markerSetEvent, signalEvent, viewerDropEvent } from '../common/types';
import { scaleFromUnits, logScaleFromUnits } from '../common/functions';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import { getTokenColorsForTheme } from './extension';
import { VaporviewDocument, WaveformFileParser } from './document';
import { WasmFormatHandler } from './wasm_handler';
import { FsdbFormatHandler } from './fsdb_handler';
import { SurferFormatHandler } from './surfer_handler';
import { NetlistTreeDataProvider, NetlistItem, netlistItemDragAndDropController, VaporviewStatusBar } from './tree_view';
import { getInstancePath } from './tree_view';


export interface VaporviewDocumentDelegate {
  addSignalByNameToDocument(signalName: string): void;
  logOutputChannel(message: string): void;
  updateViews(uri: vscode.Uri): void;
  emitEvent(e: any): void;
  removeFromCollection(uri: vscode.Uri, document: VaporviewDocument): void;
  createFileParser(uri: vscode.Uri): Promise<WaveformFileParser>;
  applySettings(settings: any, document: VaporviewDocument, stateChangeType: StateChangeType): void;
}

class VaporviewDocumentBackup implements vscode.CustomDocumentBackup {
  constructor(public readonly id: string) {}
  delete(): void {return;}
}

export class VaporviewDocumentCollection {

  private readonly _documents: Record<DocumentId, VaporviewDocument> = {};
  private _numDocuments = 0;
  public get numDocuments() {return this._numDocuments;}

  private randomString() {return Math.random().toString(36).substring(2, 15);}

  public createUniqueDocumentId(): DocumentId {
    let documentId = this.randomString();
    while (this._documents[documentId]) {
      documentId = this.randomString();
    }
    return documentId;
  }

  public add(documentId: DocumentId, document: VaporviewDocument) {
    this._documents[documentId] = document;
    this._numDocuments++;
  }

  public get(documentId: DocumentId): VaporviewDocument | undefined {
    return this._documents[documentId];
  }

  public remove(documentId: DocumentId) {
    delete this._documents[documentId];
    this._numDocuments--;
  }

  public getDocumentFromUri(uri: string): VaporviewDocument | undefined {
    for (const documentId in this._documents) {
      if (this._documents[documentId].uri.toString() === uri) {
        return this._documents[documentId];
      }
    }
    return undefined;
  }

  public getAllDocuments() {
    return Object.keys(this._documents).map(documentId => {
      return {
        documentId: documentId,
        uri: this._documents[documentId].uri
      };
    });
  }

  public broadcast(callback: (document: VaporviewDocument) => void) {
    for (const documentId in this._documents) {
      const document = this._documents[documentId];
      if (document) {
        callback(document);
      }
    }
  }
}

// #region WaveformViewerProvider
export class WaveformViewerProvider implements vscode.CustomEditorProvider<VaporviewDocument> {

  private static readonly viewType = 'vaporview.waveformViewer';
  public themeColors = new Map<string, string>();
  private wasmWorkerFile: string;

  private readonly documentCollection = new VaporviewDocumentCollection();
  public getDocumentFromUri(uri: string): VaporviewDocument | undefined {
    return this.documentCollection.getDocumentFromUri(uri);
  }
  private readonly remoteConnections = new Map<string, {
    serverUrl: string;
    bearerToken?: string;
  }>();

  private activeWebview: vscode.WebviewPanel | undefined;
  private activeDocument: VaporviewDocument | undefined;
  private lastActiveWebview: vscode.WebviewPanel | undefined;
  private lastActiveDocument: VaporviewDocument | undefined;
  public get getActiveDocument(): VaporviewDocument | undefined {return this.activeDocument;}
  public get getLastActiveDocument(): VaporviewDocument | undefined {return this.lastActiveDocument;}

  // API endpoints
  public netlistTreeDataProvider: NetlistTreeDataProvider;
  public netlistView: vscode.TreeView<NetlistItem>;
  public statusBar: VaporviewStatusBar;
  public log: vscode.OutputChannel;

  // Event emitters
  public static readonly markerSetEventEmitter = new vscode.EventEmitter<markerSetEvent>();
  public static readonly signalSelectEventEmitter = new vscode.EventEmitter<signalEvent>();
  public static readonly addVariableEventEmitter = new vscode.EventEmitter<signalEvent>();
  public static readonly removeVariableEventEmitter = new vscode.EventEmitter<signalEvent>();
  public static readonly externalDropEventEmitter = new vscode.EventEmitter<viewerDropEvent>();
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<VaporviewDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

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

    this.statusBar = new VaporviewStatusBar(this._context);

    // Subscribe to the View events. We need to subscribe to expand and collapse events
    // because the collapsible state would not otherwise be preserved when the tree view is refreshed
    this.netlistView.onDidExpandElement(this.handleNetlistExpandElement);
    this.netlistView.onDidCollapseElement(this.handleNetlistCollapseElement);
    this.netlistView.onDidChangeSelection(this.handleNetlistViewSelectionChanged, this, this._context.subscriptions);

    this.wasmWorkerFile = vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'worker.js').fsPath;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: { backupId?: string },
    _token: vscode.CancellationToken,
  ): Promise<VaporviewDocument> {

    // Declare document first so delegate closures can reference it
    let document: VaporviewDocument;

    const delegate: VaporviewDocumentDelegate = {
      addSignalByNameToDocument: this.addSignalByNameToDocument.bind(this),
      logOutputChannel: (message: string) => {this.log.appendLine(message);},
      updateViews: (uri: vscode.Uri) => {
        if (this.activeDocument?.uri !== uri) {return;}
        this.netlistTreeDataProvider.loadDocument(document);
      },
      emitEvent: (e: any) => {this.emitEvent(e);},
      removeFromCollection: (uri: vscode.Uri, doc: VaporviewDocument) => {
        this.documentCollection.remove(doc.documentId);
        // Clean up remote connection info if this is a vaporview-remote:// URI
        if (uri.scheme === 'vaporview-remote') {
          this.remoteConnections.delete(uri.toString());
          // Also clean up persisted state
          this._context.globalState.update(`remote-connection-${uri.toString()}`, undefined);
        }
      },
      createFileParser: async (uri: vscode.Uri) => {
        // Create the handler first, then create the document with it
        let handler: WaveformFileParser;

        if (uri.scheme === 'vaporview-remote') {
          const connectionInfo = await this.getRemoteConnectionInfo(uri);
          // Create Surfer handler
          handler = await SurferFormatHandler.create(delegate, uri, connectionInfo.serverUrl, this.wasmWorkerFile, this.wasmModule, connectionInfo.bearerToken);
        } else {
          const fileType = uri.fsPath.split('.').pop()?.toLocaleLowerCase() || '';
          if (fileType === 'fsdb') {
            handler = new FsdbFormatHandler(delegate, uri, async () => null);
          } else {
            handler = await WasmFormatHandler.create(delegate, uri, fileType, this.wasmWorkerFile, this.wasmModule);
          }
        }
        return handler;
      },
      applySettings: this.applySettings.bind(this),
    };

    // Create the document and load it using its handler
    document = await VaporviewDocument.create(uri, delegate, this.documentCollection);
    await document.load();
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
        case 'executeCommand':      {vscode.commands.executeCommand(e.commandName, ...(e.args || [])); break;}
        case 'updateConfiguration': {vscode.workspace.getConfiguration('vaporview').update(e.property, e.value, vscode.ConfigurationTarget.Global); break;}
        case 'ready':               {document.onWebviewReady(webviewPanel); break;}
        case 'restoreState':        {this.restoreState(e.state, e.uri); break;}
        case 'contextUpdate':       {this.handleUpdateWebviewContext(document, e); break;}
        case 'emitEvent':           {this.emitEvent(e); break;}
        case 'fetchDataFromFile':   {document.fetchData(e.requestList); break;}
        case 'close-webview':       {webviewPanel.dispose(); break;}
        case 'handleDrop':          {this.handleWebviewDrop(e); break;}
        default: {this.log.appendLine('Unknown message type from webview: ' + JSON.stringify(e)); break;}
      }

      if (e.type === 'response')    {this.onMessage(e);}
    }, this, this._context.subscriptions);

    // Handle switching tab events
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        this.onDidChangeViewStateActive(document, webviewPanel);
        webviewPanel.webview.postMessage({command: 'getContext'});
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

    // Setup initial content for the webview
    webviewPanel.webview.options = { enableScripts: true, };
    webviewPanel.webview.html    = this.getHtmlContent(webviewPanel.webview);

    this.onDidChangeViewStateActive(document, webviewPanel);
  }

  backupCustomDocument(document: VaporviewDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
    return Promise.resolve(new VaporviewDocumentBackup(document.uri.toString()));
  }

  revertCustomDocument(document: VaporviewDocument, cancellation: vscode.CancellationToken): Thenable<void> {
    if (document.saveFileUri) {
      this.loadSettingsFromFileUri(document, document.saveFileUri);
    }
    return Promise.resolve();
  }

  async saveCustomDocument(document: VaporviewDocument, cancellation: vscode.CancellationToken): Promise<void> {
    // When a user loads a document, the document may be dirty, so it sets this flag and calls a dummy save
    if (document.clearDirtyStatus) {
      document.clearDirtyStatus = false;
    } else {
      await this.saveSettingsToFile(document, document.saveFileUri, cancellation);
    }
  }

  async saveCustomDocumentAs(document: VaporviewDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    await this.saveSettingsToFile(document, destination, cancellation);
  }

  public getDocumentFromOptionalUri(uri: string | undefined): VaporviewDocument | undefined {
    if (!uri) {return this.activeDocument;}
    else {return this.documentCollection.getDocumentFromUri(uri);}
  }

  public getAllDocumentUris() {
    return this.documentCollection.getAllDocuments().map(entry => entry.uri.toString());
  }

  public getViewerState(uri: any) {
    const document = this.getDocumentFromOptionalUri(uri);
    if (!document) {return;}
    return document.getSettings();
  }

  public async getRemoteConnectionInfo(uri: vscode.Uri) {

    let connectionInfo = this.remoteConnections.get(uri.toString());
    if (connectionInfo) {return connectionInfo;}

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
    return connectionInfo;
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

  public async saveSettingsToFile(specifiedDocument: VaporviewDocument | undefined, saveFileUri: vscode.Uri | undefined, cancellation?: vscode.CancellationToken) {
    let document: VaporviewDocument | undefined = specifiedDocument;
    if (!document) {
      document = this.activeDocument;
    }

    if (!document) {
      vscode.window.showErrorMessage('No viewer is active. Please select the viewer you wish to save settings.');
      throw new Error('No active document to save');
    }

    const saveData       = document.getSettings();
    const saveDataString = JSON.stringify(saveData, null, 2);

    let uri = saveFileUri;
    if (!saveFileUri) {
      uri = await vscode.window.showSaveDialog({
        saveLabel: 'Save settings',
        filters: {JSON: ['json']}
      });
    }

    // User cancelled the save dialog
    if (!uri || cancellation?.isCancellationRequested) {
      throw new Error('Save cancelled, or location was not provided');
    }

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(saveDataString));
    document.saveFileUri = uri;
  }

  public async loadSettingsFromFile() {

    if (!this.activeDocument) {
      vscode.window.showErrorMessage('No viewer is active. Please select the viewer you wish to load settings.');
      return;
    }

    //let version  = vscode.extensions.getExtension('Lramseyer.vaporview')?.packageJSON.version;
    // show open file dialog
    const uri = await new Promise<any>((resolve, reject) => {
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Load settings',
        filters: { JSON: ['json'] }
      }).then((uri) => {
        if (uri) {
          resolve(uri[0]);
        } else {
          reject("No file selected"); // Reject if no file is selected
        }
      }, (error: any) => {
        reject(error); // Reject if showOpenDialog fails
      });
    });

    if (!uri) {return;}

    this.activeDocument.clearDirtyStatus = true;
    const readSuccess = await this.loadSettingsFromFileUri(this.activeDocument, uri);

    // We have to trick VScode in to thinking that the file was saved so that it clears the dirty status
    if (readSuccess) {
      await vscode.commands.executeCommand('workbench.action.files.save');
    } else {
      this.activeDocument.clearDirtyStatus = false;
    }
  }

  public async loadSettingsFromFileUri(document: VaporviewDocument, saveFileUri: vscode.Uri): Promise<boolean> {
    const fileData = await vscode.workspace.fs.readFile(saveFileUri).then((data) => {
      return JSON.parse(new TextDecoder().decode(data));
    })

    if (!fileData) {return false;}
    if (fileData.fileName && fileData.fileName !== document.uri.fsPath) {
      vscode.window.showWarningMessage('The settings file may not match the active viewer');
    }

    this.log.appendLine('Loading settings from file: ' + fileData.fileName);
    document.saveFileUri = saveFileUri;
    this.applySettings(fileData, document, StateChangeType.File);
    return true;
  }

  public async convertSignalListToSettings(signalList: any, document: VaporviewDocument): Promise<any> {
    const missingSignals: string[] = [];
    const settings: any = [];
    for (const signalInfo of signalList) {
      if (signalInfo.dataType && signalInfo.dataType === 'signal-group') {
        const childrenSettings = await this.convertSignalListToSettings(signalInfo.children, document);
        const groupData = Object.assign({}, signalInfo, {children: childrenSettings.signalList});
        settings.push(groupData);
        missingSignals.push(...childrenSettings.missingSignals);
      } else if (signalInfo.dataType && signalInfo.dataType === 'signal-separator') {
        settings.push(signalInfo);
      } else if (signalInfo.dataType && signalInfo.dataType === 'netlist-variable') {
        const signal   = signalInfo.name;
        const metadata = await document.findTreeItem(signal, signalInfo.msb, signalInfo.lsb);
        if (metadata !== null) {
          const signalData = Object.assign(signalInfo, {
            netlistId:  metadata.netlistId,
            signalId:   metadata.signalId,
            signalName: metadata.name,
            scopePath:  metadata.scopePath,
            signalWidth: metadata.width,
            type:       metadata.type,
            encoding:   metadata.encoding,
            enumType:   metadata.enumType,
            msb:        metadata.msb,
            lsb:        metadata.lsb,
          });
          settings.push(signalData);
        } else {
          missingSignals.push(signal);
        }
      }
    }

    return {
      missingSignals: missingSignals,
      signalList: settings,
    };
  }

  public async applySettings(settings: any, document: VaporviewDocument | undefined, stateChangeType: StateChangeType) {

    if (!settings.displayedSignals) {return;}
    if (!document) {
      if (!this.activeDocument) {return;}
      document = this.activeDocument;
    }

    //this.netlistTreeDataProvider.loadDocument(document);
    const signalListSettings = await this.convertSignalListToSettings(settings.displayedSignals, document);
    const documentSettings: any = {
      displayedSignals: signalListSettings.signalList,
      markerTime: settings.markerTime,
      altMarkerTime: settings.altMarkerTime,
      selectedSignal: settings.selectedSignal,
      zoomRatio: settings.zoomRatio,
      scrollLeft: settings.scrollLeft,
      autoReload: settings.autoReload,
    };

    console.log(stateChangeType);
      
    const color1 = vscode.workspace.getConfiguration('vaporview').get('customColor1');
    const color2 = vscode.workspace.getConfiguration('vaporview').get('customColor2');
    const color3 = vscode.workspace.getConfiguration('vaporview').get('customColor3');
    const color4 = vscode.workspace.getConfiguration('vaporview').get('customColor4');

    document.webviewPanel?.webview.postMessage({
      command: 'apply-state',
      settings: documentSettings,
      customColors: [color1, color2, color3, color4],
      stateChangeType: stateChangeType,
    });

    if (signalListSettings.missingSignals.length > 0) {
      this.log.appendLine('Missing signals: '+ signalListSettings.missingSignals.join(', '));
    }
  }

  public restoreState(state: any, uri: vscode.Uri) {
    const document = this.documentCollection.getDocumentFromUri(uri.toString());
    if (state) {
      this.applySettings(state, document, StateChangeType.Restore);
    } else {
      // check the directory for a file with the same name as the document, but with the extension .vaporview.json
      const filePath = uri.fsPath.match(/^(.*)\.[^.]+$/)?.[1] + '.json';
      if (fs.existsSync(filePath)) {

        // ask the user if they want to restore the state from the file
        vscode.window.showInformationMessage(
          'Restore state from file: ' + filePath + '?',
          'Yes', 'No'
        ).then((action) => {
          if (action === 'Yes') {
            const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            this.applySettings(state, document, StateChangeType.File);
          }
        });
      }
    }
  }

  async reloadFile(e: any) {

    let document: VaporviewDocument | undefined;
    if (e.fsPath) {
      document = this.documentCollection.getDocumentFromUri(e.toString());
    } else {
      document = this.activeDocument;
    }
    if (!this.activeDocument) {return;}
    if (!document) {return;}
    if (document.uri.fsPath !== this.activeDocument.uri.fsPath) {return;}

    //const settings = document.getSettings();
    this.netlistTreeDataProvider.hide();
    await document.reload();
  }

  copyWaveDrom() {
    this.activeWebview?.webview.postMessage({command: 'copyWaveDrom'});
  }

  setWaveDromClock(edge: string, netlistId: NetlistId | null) {
    this.activeWebview?.webview.postMessage({
      command: 'setWaveDromClock',
      edge: edge,
      netlistId: netlistId,
    });
  }

  // Send command to all webviews
  public updateColorTheme(e: any) {
    //const themeName = vscode.workspace.getConfiguration("workbench").get("colorTheme");
    this.documentCollection.broadcast((document) => {
      const webview = document.webviewPanel;
      if (webview) {
        webview.webview.postMessage({command: 'updateColorTheme'});
      }
    });
  }

  updateConfiguration(e: any) {
    this.documentCollection.broadcast((document) => {
      document.setConfigurationSettings();
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

  handleUpdateWebviewContext(document: VaporviewDocument, event: any) {
    if (!document) {return;}
    const isDirty = document.captureWebviewState(event);

    if (isDirty) {
      this._onDidChangeCustomDocument.fire({
        document,
        undo: () => {document.undo();},
        redo: () => {document.redo();}
      });
    }

    if (event.autoReload && document.fileUpdated && document.reloadPending) {
      vscode.commands.executeCommand('vaporview.reloadFile', document.uri);
    } else {
      this.statusBar.update(document, event);
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
  }

  onDidChangeViewStateInactive() {
    this.activeWebview  = undefined;
    this.activeDocument = undefined;
    this.netlistTreeDataProvider.hide();
    this.statusBar.hide();
  }

  async showInNetlistViewByName(signalName: string) {
    if (!this.lastActiveDocument) {return;}
    const document = this.lastActiveDocument;
    const metadata = await document.findTreeItem(signalName, undefined, undefined);
    if (metadata !== null) {
      this.netlistView.reveal(metadata, {select: true, focus: false, expand: 3});
    }
  }

  showInNetlistView(e: any) {

    if (!this.lastActiveDocument) {return;}
    const document = this.lastActiveDocument;
    let netlistId: NetlistId | undefined | null = undefined;

    if (e) {
      netlistId = e.netlistId
    } else {
      netlistId = document.webviewContext.selectedSignal;
    }

    if (netlistId === null || netlistId === undefined) {return;}
    const netlistItem = document.netlistIdTable[netlistId];
    if (netlistItem) {
      this.netlistView.reveal(netlistItem, {select: true, focus: false, expand: 3});
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
      const document = this.documentCollection.getDocumentFromUri(e.uri);
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
      metadata = document.netlistIdTable[e.netlistId];
      if (metadata === undefined) {
        vscode.window.showWarningMessage('Signal not found: ' + e.netlistId);
        return null;
      }
    
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
    const document = this.documentCollection.getDocumentFromUri(uri);
    if (!document) {return;}
    const netlistIdCount = document.metadata.netlistIdCount;
    if (netlistIdCount > maxSignals || netlistIdCount > 64) {return;}

    document.treeData.forEach(scope => {
      this.addChildVariablesToDocument(document, scope, true, maxSignals, true);
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
        if (metadata.contextValue === 'netlistScope') {
          const recursive = e.recursive === true;
          this.addAllInScopeToDocument(metadata, recursive, 128);
        } else {
          const isDisplayed = document.isSignalDisplayed(metadata.netlistId);
          if (e.reveal === true && isDisplayed) {
            document.revealSignalInWebview(metadata.netlistId);
          } else {
            document.renderSignals([metadata.netlistId], [], undefined);
          }
        }
        break;
      } 
      case 'remove': {
        if (metadata.contextValue !== 'netlistScope') {
          const netlistId = metadata.netlistId;
          document.removeSignalFromWebview(netlistId, undefined, false);
        }
        break;
      } 
      case 'reveal': {
        this.netlistView.reveal(metadata, {select: true, focus: false, expand: 0});
        break;
      }
      case "addLink": {
        if (metadata.contextValue !== 'netlistScope') {
          this.setValueFormat(metadata.netlistId, 0, undefined, {command: e.command});
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

    const markerType = e.markerType || 0;
    if (e.units !== undefined) {
      this.setMarkerAtTimeWithUnits(e.time, e.units, markerType);
    } else {
      this.setMarkerAtTime(e.time, markerType);
    }
  }

  public handleKeyBinding(e: any, keyCommand: string) {
    if (!this.activeWebview) {return;}
    this.activeWebview.webview.postMessage({command: 'handle-keypress', keyCommand: keyCommand, event: e});
  }

  private handleWebviewDrop(e: any) {

    const unknownUriList: vscode.Uri[] = [];
    const netlistIdList: NetlistId[] = [];
    const document = this.documentCollection.getDocumentFromUri(e.uri.external);
    if (!document) {return;}
    if (!e.resourceUriList) {return;}

    e.resourceUriList.forEach((uri: vscode.Uri) => {
      if (uri.scheme !== 'waveform') {
        unknownUriList.push(uri);
        return;
      }
      const fragment = uri.fragment;
      if (fragment === undefined || fragment === "") {return;}
      fragment.split('&').forEach((tag: string) => {
        const [key, value] = tag.split('=');
        if (key === "var") {netlistIdList.push(parseInt(value));}
      });
    });

    let groupPath: string[] = [];
    let index = undefined;
    if (e.groupPath) {groupPath = e.groupPath}
    if (e.dropIndex || e.dropIndex === 0) {index = e.dropIndex;}

    if (document !== this.activeDocument) {return;}
    document.renderSignals(netlistIdList, groupPath, index);
    // shift focus to the document if any signals were added
    if (netlistIdList.length > 0) {
      document.reveal();
    }

    // Emit an event for the unknown URIs so that other extensions can handle them if needed
    if (unknownUriList.length === 0) {return;}
    WaveformViewerProvider.externalDropEventEmitter.fire({
      uri: e.uri,
      resourceUriList: unknownUriList,
      groupPath: groupPath,
      index: index
    });
  }

  //private addSignalsToDocument(document: VaporviewDocument, netlistElements: NetlistItem[], groupPath: string[], index: number | undefined) {
  //  const netlistIdList = netlistElements.map((element) => element.netlistId);
  //  document.renderSignals(netlistIdList, groupPath, index);
  //}

  // This function is only used in WCP command handlers (specifically handleAddItems in wcp_server.ts)
  public async addItemsToDocument(document: VaporviewDocument, e: any) {
    const recursive = e.recursive === true;
    for (const item of e.items) {
      if (typeof item !== 'string') {
        vscode.window.showWarningMessage('Item is not a string: ' + item);
        return;
      }
      const metadata = await this.getNetlistItemFromSignalName(document, item);

      if (metadata === null) {
        vscode.window.showWarningMessage('Signal or scope not found: ' + item);
        continue;
      }

      if (metadata.contextValue === 'netlistScope') {
        this.addChildVariablesToDocument(document, metadata, recursive, 128, true /* noWarning */);
      } else if (metadata.contextValue === 'netlistVar') {
        document.renderSignals([metadata.netlistId], [], undefined);
      }
    }
  }

  public async getNetlistItemFromSignalName(document: VaporviewDocument, signalName: string): Promise<NetlistItem | null> {

    // remove colon or semicolon from end of signal name
    const instancePath = signalName.replace(/[:;]$/, '');
    // get msb and lsb from signal name
    const regex  = /\[(\d+:)?(\d+)\]$/;
    const field  = instancePath.match(regex);
    const lookup = instancePath.replace(regex, '');
    const msb   = field ? parseInt(field[1], 10) : undefined;
    const lsb   = field ? parseInt(field[2], 10) : msb;
    return await document.findTreeItem(lookup, msb, lsb);
  }

  public async addSignalByNameToDocument(signalName: string) {

    if (!this.lastActiveDocument) {return;}
    const document = this.lastActiveDocument;
    const metadata = await this.getNetlistItemFromSignalName(document, signalName);

    if (metadata === null) {
      // console.log('Signal not found ' + instancePath);
      vscode.window.showWarningMessage('Signal not found: ' + signalName);
      return;
    }

    // If it's a scope item, we just reveal it in the tree view
    if (metadata.contextValue === 'netlistScope') {
      this.netlistView.reveal(metadata, {select: true, focus: false, expand: 0});
      return;
    }

    //console.log('found signal ' + instancePath);
    const netlistId = metadata.netlistId;
    const displayedNetlistIds = document.getDisplayedNetlistIds();
    let isDisplayed = displayedNetlistIds.includes(netlistId);

    if (isDisplayed) {
      document.revealSignalInWebview(netlistId);
    } else {
      document.renderSignals([netlistId], [], undefined);
    }
  }

  public revealSignalInWebview(netlistId: NetlistId) {
    if (!this.activeDocument) {return;}
    const document = this.activeDocument;
    document.revealSignalInWebview(netlistId);
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

  public async addChildVariablesToDocument(document: VaporviewDocument, netlistItem: NetlistItem, recursive: boolean, maxChildren: number, noWarning: boolean = false) {

    if (netlistItem.contextValue !== 'netlistScope') {return;}

    const netlistVariables: NetlistItem[] = [];
    const netlistScopes: NetlistItem[] = [netlistItem];

    while (netlistScopes.length > 0 && netlistVariables.length < maxChildren) {

      const parentScope = netlistScopes.shift();
      const children = await document.getScopeChildren(parentScope);
      children.forEach((element) => {
        if (element.contextValue === 'netlistVar') {
          netlistVariables.push(element);
        }
        else if (element.contextValue === 'netlistScope' && recursive) {
          netlistScopes.push(element);
        }
      });
    }

    this.filterAddSignalsInNetlist(netlistVariables, noWarning);
  }

  public filterAddSignalsInNetlist(netlistElements: NetlistItem[], noWarning: boolean = false) {

    const document = this.activeDocument;
    if (!document) {return;}

    const elementList = netlistElements.filter((element) => {
      return element.contextValue === 'netlistVar';
    }).map((element) => element.netlistId);

    if ((elementList.length > 24) && !noWarning) {
      // show warning message
      vscode.window.showWarningMessage('You are about to add a large number of signals to the waveform viewer. This may cause performance issues. Do you want to continue?', 'Yes', 'No').then((response) => {
        if (response === 'Yes') {
          document.renderSignals(elementList, [], undefined);
        } 
      });
    } else {
      document.renderSignals(elementList, [], undefined);
    }
  }

  public removeSignalFromDocument(netlistId: NetlistId | undefined, rowId: number | undefined, removeAllSelected: boolean) {
    if (!this.activeDocument) {return;}
    if (!this.activeWebview?.visible) {return;}

    this.activeDocument.removeSignalFromWebview(netlistId, rowId, removeAllSelected);
  }

  public removeSignalList(signalList: NetlistItem[]) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    signalList.forEach((element) => {
      if (element.contextValue !== 'netlistVar') {return;}
      this.activeDocument?.removeSignalFromWebview(element.netlistId, undefined, false);
    });
  }

  public newSignalGroup(
    name: string | undefined,
    groupPath: string[] | undefined,
    parentGroupId: number | undefined,
    eventRowId: number | undefined,
    moveSelected: boolean,
  ) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const panel = this.activeWebview;
    panel.webview.postMessage({
      command: 'newSignalGroup',
      groupName: name,
      groupPath: groupPath,
      parentGroupId: parentGroupId,
      eventRowId: eventRowId,
      moveSelected: moveSelected,
    });
  }

  public newSeparator(
    name: string | undefined,
    groupPath: string[] | undefined,
    parentGroupId: number | undefined,
    eventRowId: number | undefined
  ) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const panel = this.activeWebview;
    panel.webview.postMessage({
      command: 'add-separator',
      name: name,
      groupPath: groupPath,
      parentGroupId: parentGroupId,
      eventRowId: eventRowId
    });
  }

  public newBitSlice(
    name: string | undefined,
    groupPath: string[] | undefined,
    parentGroupId: number | undefined,
    eventRowId: number | undefined,
    bitRangeString: string | undefined,
  ) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    // check that bitRangeString is valid
    const bitRangeRegex = /^(\d+)(:(\d+))?$/;
    if (bitRangeString === undefined || !bitRangeRegex.test(bitRangeString)) {
      vscode.window.showWarningMessage('Invalid bit range string: ' + bitRangeString);
      return;
    } else {
      const msb = parseInt(bitRangeString.split(':')[0]);
      let lsb = msb;
      if (bitRangeString.includes(':')) {
        lsb = parseInt(bitRangeString.split(':')[1]);
      }
      const panel = this.activeWebview;
      panel.webview.postMessage({
        command: 'add-bit-slice',
        name: name,
        groupPath: groupPath,
        parentGroupId: parentGroupId,
        eventRowId: eventRowId,
        msb: msb,
        lsb: lsb,
      });
    }
  }

  public renameSignalGroup(e: any | undefined) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    let groupId: number | undefined = e?.groupId;
    let groupName: string | undefined = e?.name;
    let rowId: number | undefined = e?.rowId;

    const panel = this.activeWebview;
    panel.webview.postMessage({
      command: 'renameSignalGroup',
      rowId: rowId,
      groupId: groupId,
      groupName: groupName,
    });
  }

  public editSignalGroup(groupId: number | undefined, groupPath: string[] | undefined, name: string | undefined, isExpanded: boolean | undefined) {

    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const panel = this.activeWebview;
    panel.webview.postMessage({
      command: 'editSignalGroup',
      groupId: groupId,
      groupPath: groupPath,
      name: name,
      isExpanded: isExpanded,
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

  public removeSeparator(rowId: number, removeAllSelected: boolean) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    const panel = this.activeWebview;
    panel.webview.postMessage({
      command: 'remove-separator',
      rowId: rowId,
      removeAllSelected: removeAllSelected
    });
  }

  public setValueFormat(netlistId: NetlistId | undefined, index: number | undefined, rowId: number | undefined, properties: any) {
    if (netlistId === undefined && rowId === undefined) {return;}
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    //const document    = this.activeDocument;
    //const netlistData = document.netlistIdTable[netlistId];
    //if (netlistData) {
    //  if (format !== undefined) {
    //    netlistData.numberFormat = format;
    //  }
    //}

    const panel  = this.activeWebview;
    const format = properties.valueFormat;
    const color1 = vscode.workspace.getConfiguration('vaporview').get('customColor1');
    const color2 = vscode.workspace.getConfiguration('vaporview').get('customColor2');
    const color3 = vscode.workspace.getConfiguration('vaporview').get('customColor3');
    const color4 = vscode.workspace.getConfiguration('vaporview').get('customColor4');

    panel.webview.postMessage({
      command: 'setDisplayFormat',
      netlistId: netlistId,
      index: index,
      rowId: rowId,
      numberFormat: format,
      colorIndex: properties.colorIndex,
      renderType: properties.renderType,
      customColors: [color1, color2, color3, color4],
      rowHeight: properties.rowHeight,
      verticalScale: properties.verticalScale,
      nameType: properties.nameType,
      customName: properties.customName,
      valueLinkCommand: properties.command,
      annotateValue: properties.annotateValue,
    });
  }

  copyValueAtMarker(e: any) {
    if (e.rowId === undefined) {return;}
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.visible) {return;}

    this.activeWebview.webview.postMessage({
      command: 'copyValueAtMarker',
      rowId: e.rowId,
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

  // onDidChangeSelection() event returns readonly elements
  // so we need to copy the selected elements to a new array
  // Six one way, half a dozen the other. One is just more concise...
  private handleNetlistViewSelectionChanged = (e: vscode.TreeViewSelectionChangeEvent<NetlistItem>) => {

    const uri = this.activeDocument?.uri;
    this.netlistTreeDataProvider.handleSelectionChanged(e, uri);
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