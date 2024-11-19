import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';

import { NetlistTreeDataProvider, DisplayedSignalsViewProvider, NetlistItem, VaporviewDocument, WebviewCollection} from './document';

export type NetlistId = number;
export type SignalId  = number;
export interface VaporviewDocumentDelegate {
  getViewerContext(): Promise<Uint8Array>;
  updateViews(uri: vscode.Uri): void;
}

// #region WaveformViewerProvider
export class WaveformViewerProvider implements vscode.CustomReadonlyEditorProvider<VaporviewDocument> {

  private static newViewerId = 1;
  private static readonly viewType = 'vaporview.waveformViewer';
  private readonly wasmModule: WebAssembly.Module;
  private readonly webviews = new WebviewCollection();
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

  constructor(private readonly _context: vscode.ExtensionContext, wasmModule: WebAssembly.Module) {

    this.wasmModule = wasmModule;

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

    // Create a status bar item for marker time and
    this.deltaTimeStatusBarItem      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.markerTimeStatusBarItem     = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.selectedSignalStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);

    // Subscribe to the expand/collapse events - For some reason we need to do
    // this because the collapsible state is not preserved when the tree view is refreshed
    this.netlistView.onDidExpandElement(this.handleNetlistExpandElement);
    this.netlistView.onDidCollapseElement(this.handleNetlistCollapseElement);
    this.netlistView.onDidChangeSelection(this.handleNetlistViewSelectionChanged, this, this._context.subscriptions);
    this.netlistView.onDidChangeCheckboxState(this.handleNetlistCheckboxChange, this, this._context.subscriptions);
    this.displayedSignalsView.onDidChangeSelection(this.handleDisplayedSignalsViewSelectionChanged, this, this._context.subscriptions);
    this.displayedSignalsView.onDidChangeCheckboxState(this.handleDisplayedViewSelectionChanged, this, this._context.subscriptions);
  }

  //#region CustomEditorProvider
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
      }
    };

    // Load the Wasm worker
    const workerFile = vscode.Uri.joinPath(this._context.extensionUri, 'out', 'worker.js').fsPath;
    const wasmWorker = new Worker(workerFile);
    const document   = await VaporviewDocument.create(uri, openContext.backupId, wasmWorker, this.wasmModule, delegate);

    this.netlistTreeDataProvider.loadDocument(document);
    this.displayedSignalsTreeDataProvider.setTreeData(document.displayedSignals);

    return document;
  }

  async resolveCustomEditor(
    document: VaporviewDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {

    webviewPanel.onDidDispose(() => {
      if (this.activeWebview === webviewPanel) {
        this.netlistTreeDataProvider.setTreeData([]);
        this.displayedSignalsTreeDataProvider.setTreeData([]);
        document.webviewContext = {
          markerTime: null,
          altMarkerTime: null,
          selectedSignal: null,
          displayedSignals: [],
          zoomRatio: 1,
          scrollLeft: 0,
          numberFormat: 16,
        };
      }
      if (this.lastActiveWebview === webviewPanel) {
        this.lastActiveWebview = undefined;
        this.lastActiveDocument = undefined;
      }
    }, this, this._context.subscriptions);

    // Wait for the webview to be properly ready before we init
    webviewPanel.webview.onDidReceiveMessage(e => {
      //console.log(e);
      //console.log(document.uri);

      if (e.type === 'ready') {
        if (document.uri.scheme === 'untitled') {
          //console.log("untitled scheme");
        }
        document.onWebviewReady(webviewPanel);
      }
      switch (e.command) {
        case 'init': {
          // Webview is initialized, send the 'init' message
          break;
        }
        case 'setTime': {
          document.webviewContext.markerTime    = e.markerTime;
          document.webviewContext.altMarkerTime = e.altMarkerTime;

          this.updateStatusBarItems(document);
          break;
        }
        case 'setSelectedSignal': {
          document.webviewContext.selectedSignal = e.netlistId;
          this.updateStatusBarItems(document);
          break;
        }
        case 'contextUpdate' : {

          document.webviewContext.markerTime       = e.markerTime;
          document.webviewContext.altMarkerTime    = e.altMarkerTime;
          document.webviewContext.selectedSignal   = e.selectedSignal;
          document.webviewContext.displayedSignals = e.displayedSignals;
          document.webviewContext.zoomRatio        = e.zoomRatio;
          document.webviewContext.scrollLeft       = e.scrollLeft;
          document.webviewContext.numberFormat     = e.numberFormat;

          this.updateStatusBarItems(document);
          break;
        }
        case 'fetchTransitionData': {
          document.wasmApi.getsignaldata(e.signalIdList);
          break;
        }
        case 'copyWaveDrom': {
          if (e.maxTransitionsFlag) {
            vscode.window.showWarningMessage('The number of transitions exceeds the maximum limit of ' + e.maxTransitions);
          }
          vscode.env.clipboard.writeText(e.waveDromJson);
          vscode.window.showInformationMessage('WaveDrom JSON copied to clipboard.');
          break;
        }
        case 'close-webview' : {
          //console.log("close-webview");
          // Close the webview
          webviewPanel.dispose();
          break;
        }
      }
      //this.onMessage(document, e);
      switch (e.type) {
        case 'response': {
          const callback = this._callbacks.get(e.requestId);
          callback?.(e.body);
          return;
        }
      }
    }, this, this._context.subscriptions);

    webviewPanel.onDidChangeViewState(e => {
      //console.log("onDidChangeViewState()");
      //console.log(vscode.window.activeTextEditor?.document);
      //console.log(e);

      this.netlistViewSelectedSignals = [];
      this.displayedSignalsViewSelectedSignals = [];

      if (e.webviewPanel.active) {
        this.activeWebview  = webviewPanel;
        this.activeDocument = document;
        this.lastActiveWebview = webviewPanel;
        this.lastActiveDocument = document;
        this.netlistTreeDataProvider.loadDocument(document);
        this.displayedSignalsTreeDataProvider.setTreeData(this.activeDocument.displayedSignals);
        webviewPanel.webview.postMessage({command: 'getSelectionContext'});
        this.deltaTimeStatusBarItem.show();
        this.markerTimeStatusBarItem.show();
        this.selectedSignalStatusBarItem.show();
      } else if (!e.webviewPanel.active && e.webviewPanel === this.activeWebview) {
        this.activeWebview  = undefined;
        this.activeDocument = undefined;
        this.netlistTreeDataProvider.hide();
        this.displayedSignalsTreeDataProvider.hide();
        this.deltaTimeStatusBarItem.hide();
        this.markerTimeStatusBarItem.hide();
        this.selectedSignalStatusBarItem.hide();
      }
    }, this, this._context.subscriptions);

    //console.log("resolveCustomEditor()");
    // Add the webview to our internal set of active webviews
    this.webviews.add(document.uri, webviewPanel);
    this.activeWebview  = webviewPanel;
    this.activeDocument = document;
    this.lastActiveWebview = webviewPanel;
    this.lastActiveDocument = document;

    // Setup initial content for the webview
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.html = this.getHtmlContent(webviewPanel.webview);

    this.netlistTreeDataProvider.loadDocument(document);
    this.displayedSignalsTreeDataProvider.setTreeData(this.activeDocument.displayedSignals);
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

    this.applySettings(fileData);
  }

  public async applySettings(settings: any) {
    const missingSignals: string[] = [];
    const foundSignals: any[] = [];

    if (!this.activeDocument) {return;}
    const document = this.activeDocument;

    if (settings.displayedSignals) {
      for (const signalInfo of settings.displayedSignals) {
        const signal = signalInfo.name;
        const numberFormat = signalInfo.numberFormat;
        const metaData = await document.findTreeItem(signal, signalInfo.msb, signalInfo.lsb);
        if (metaData !== null) {
          foundSignals.push({
            netlistId: metaData.netlistId,
            numberFormat: numberFormat,
          });
        } else {
          missingSignals.push(signal);
        }
      }
    }

    console.log(missingSignals);

    const netlistIdList: NetlistId[] = [];
    foundSignals.forEach((signalInfo: any) => {
      const netlistId    = signalInfo.netlistId;
      const numberFormat = signalInfo.numberFormat;
      const metadata     = document.netlistIdTable[netlistId]?.netlistItem;
      if (!metadata) {return;}
      if (!document.webviewContext.displayedSignals.includes(netlistId as never)) {
        netlistIdList.push(netlistId);
        this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Checked);
        const displayedItem = this.displayedSignalsTreeDataProvider.addSignalToTreeData(metadata);
        document.setNetlistIdTable(netlistId, displayedItem);
      }
      this.setValueFormat(netlistId, numberFormat);
    });
    document.renderSignals(netlistIdList);
  }

  async reloadFile() {
    if (!this.activeDocument) {return;}
    const document = this.activeDocument;
    const settings = document.getSettings();
    this.netlistTreeDataProvider.hide();
    this.displayedSignalsTreeDataProvider.hide();
    await this.activeDocument.reload();
    this.applySettings(settings);
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

    if (!this.lastActiveDocument) {
      //console.log('No active document');
      return;
    }

    const timeScale   = this.lastActiveDocument.metadata.timeScale;
    const timeUnit    = this.scaleFromUnits(this.lastActiveDocument.metadata.timeUnit);

    if (!timeScale || !timeUnit) {return;}

    const scaleFactor = this.scaleFromUnits(unit) / (timeUnit * timeScale);

    this.setMarkerAtTime(Math.round(time * scaleFactor));
  }

  setMarkerAtTime(time: number) {

    if (!this.lastActiveWebview) {return;}
    if (!this.lastActiveDocument) {return;}

    // Check to see that the time is not out of bounds
    const chunkCount = this.lastActiveDocument.metadata.chunkCount;
    const chunkTime  = this.lastActiveDocument.metadata.chunkTime;
    if (!chunkCount || !chunkTime) {return;}
    if (time < 0 || time > (chunkCount * chunkTime)) {return;}

    this.lastActiveWebview.webview.postMessage({command: 'setMarker', time: time});
  }

  updateStatusBarItems(document: VaporviewDocument) {
    //this.deltaTimeStatusBarItem.hide();
    //this.markerTimeStatusBarItem.hide();
    //this.selectedSignalStatusBarItem.hide();
    const w = document.webviewContext;

    if (!document) {return;}

    if (w.markerTime !== null) {
      this.markerTimeStatusBarItem.text = 'time: ' + document.formatTime(w.markerTime);
      this.markerTimeStatusBarItem.show();
      if (w.altMarkerTime !== null) {
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

    if (w.selectedSignal !== null) {
      const NetlistIdRef = document.netlistIdTable[w.selectedSignal];
      const signalName = NetlistIdRef.netlistItem.name;
      this.selectedSignalStatusBarItem.text = 'Selected signal: ' + signalName;
      this.selectedSignalStatusBarItem.show();
      if (NetlistIdRef.displayedItem) {
        this.displayedSignalsView.reveal(NetlistIdRef.displayedItem, {select: true, focus: false});
      }
    } else {
      this.selectedSignalStatusBarItem.hide();
    }
  }

  showInNetlistView(netlistId: NetlistId) {
    if (!this.activeDocument) {return;}
    const NetlistIdRef = this.activeDocument.netlistIdTable[netlistId];
    if (NetlistIdRef.netlistItem) {
      this.netlistView.reveal(NetlistIdRef.netlistItem, {select: true, focus: false, expand: 3});
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

  //private onMessage(document: VaporviewDocument, message: any) {
  //  switch (message.type) {
  //    case 'response':
  //      {
  //        const callback = this._callbacks.get(message.requestId);
  //        callback?.(message.body);
  //        return;
  //      }
  //  }
  //}

  // Add or remove signals from the waveform viewer
  private addSignalToDocument(netlistId: NetlistId, addToLastActive: boolean) {

    let document: VaporviewDocument;

    if (!addToLastActive) {
      if (!this.activeWebview) {return;}
      if (!this.activeDocument) {return;}
      if (!this.activeWebview.active) {return;}
      document = this.activeDocument;
    } else {
      if (!this.lastActiveWebview) {return;}
      if (!this.lastActiveDocument) {return;}
      document = this.lastActiveDocument;
    }

    const metadata = document.netlistIdTable[netlistId]?.netlistItem;
    if (!metadata) {return;}

    this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Checked);
    document.renderSignals([netlistId]);
    const displayedItem = this.displayedSignalsTreeDataProvider.addSignalToTreeData(metadata);
    document.setNetlistIdTable(netlistId, displayedItem);
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

    const metadata = await document.findTreeItem(lookup, msb, lsb);

    if (metadata === null) {
      console.log('Signal not found ' + signalName);
      return;
    }

    //console.log('found signal ' + signalName);

    const netlistId   = metadata.netlistId;
    const isDisplayed = document.webviewContext.displayedSignals.includes(netlistId as never);
    if (isDisplayed) {
      //console.log('Signal already displayed');
      if (this.lastActiveWebview) {
        this.lastActiveWebview.webview.postMessage({
          command: 'setSelectedSignal',
          netlistId: netlistId
        });
      }
    } else {
      //console.log('Adding signal to document');
      this.addSignalToDocument(metadata.netlistId, true);
    }
  }

  private renerSignalList(netlistElements: NetlistItem[]) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.active) {return;}

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

  public filterAddSignalsInNetlist(netlistElements: NetlistItem[]) {

    const elementList = netlistElements.filter((element) => {
      return element.checkboxState === vscode.TreeItemCheckboxState.Unchecked && 
             element.contextValue === 'netlistVar' && 
             element.type !== 'Real';
    });

    if (elementList.length > 10) {
      // show warning message
      vscode.window.showWarningMessage('You are about to add a large number of signals to the waveform viewer. This may cause performance issues. Do you want to continue?', 'Yes', 'No').then((response) => {
        if (response === 'Yes') {
          this.renerSignalList(elementList);
        } 
      });
    } else {
      this.renerSignalList(elementList);
    }
  }

  public removeSignalFromDocument(netlistId: NetlistId) {

    if (!this.activeDocument) {return;}
    if (!this.activeWebview?.active) {return;}

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
    if (!this.activeWebview.active) {return;}

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

  public setValueFormat(id: NetlistId, format: number) {
    if (!this.activeWebview) {return;}
    if (!this.activeDocument) {return;}
    if (!this.activeWebview.active) {return;}

    const panel    = this.activeWebview;
    const document = this.activeDocument;

    const netlistRef = document.netlistIdTable[id];
    if (netlistRef) {
      netlistRef.netlistItem.numberFormat = format;
    }

    panel.webview.postMessage({command: 'setNumberFormat', netlistId: id, numberFormat: format});
  }

  // To do: implement nonce with this HTML:
  //<script nonce="${nonce}" src="${scriptUri}"></script>

  private getHtmlContent(webview: vscode.Webview): string {

    const extensionUri = this._context.extensionUri;
    const htmlFile     = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'body.html'));
    const svgIconsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icons.svg'));
    const jsFileUri    = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vaporview.js'));
    const cssFileUri   = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
    const codiconsUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    let htmlContent    = fs.readFileSync(htmlFile.fsPath, 'utf8');

    htmlContent = htmlContent.replace('${webAssets.svgIconsUri}', svgIconsUri.toString());
    htmlContent = htmlContent.replace('${webAssets.jsFileUri}', jsFileUri.toString());
    htmlContent = htmlContent.replace('${webAssets.cssFileUri}', cssFileUri.toString());
    htmlContent = htmlContent.replace('${webAssets.codiconsUri}', codiconsUri.toString());

    return htmlContent;
  }

  // Event handlers

  private handleNetlistCheckboxChange = (e: vscode.TreeCheckboxChangeEvent<NetlistItem>) => {

    //console.log('onDidChangeCheckboxState()');
    //console.log(changedItem);
    //console.log(this.netlistView);
    const metadata = e.items[0][0];

    if (!this.activeWebview?.active) {return;}
    if (!this.activeDocument?.webviewInitialized) {
      console.log('Webview not initialized');
      this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Unchecked);
      return;
    }

    const document  = this.activeDocument;
    const netlistId = metadata.netlistId;

    // If the item is a parent node, uncheck it
    if (metadata.contextValue == "netlistScope") {
      this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Unchecked);
      return;
    }

    console.log(metadata);

    if (metadata.type === 'Real') {
      console.log('Real signals are not supported in the waveform viewer.');
      vscode.window.showWarningMessage('Real signals are not supported in the waveform viewer.');
      this.netlistTreeDataProvider.setCheckboxState(metadata, vscode.TreeItemCheckboxState.Unchecked);
      return;
    }

    if (metadata.checkboxState === vscode.TreeItemCheckboxState.Checked) {
      document.renderSignals([netlistId]);
      const displayedItem = this.displayedSignalsTreeDataProvider.addSignalToTreeData(metadata);
      document.setNetlistIdTable(netlistId, displayedItem);
    } else if (metadata.checkboxState === vscode.TreeItemCheckboxState.Unchecked) {
      const displayedItem = document.netlistIdTable[netlistId]?.displayedItem;
      if (!displayedItem) {return;}
      document.removeSignalFromWebview(netlistId);
      this.displayedSignalsTreeDataProvider.removeSignalFromTreeData(displayedItem);
      document.setNetlistIdTable(netlistId, undefined);
    }
  };

  private handleDisplayedViewSelectionChanged = (e: vscode.TreeCheckboxChangeEvent<NetlistItem>) => {
    if (!this.activeWebview?.active) {return;}
    if (!this.activeDocument?.webviewInitialized) {return;}
  
    const document   = this.activeDocument;
    const metadata   = e.items[0][0];
    const netlistId  = metadata.netlistId;
    const viewRef    = this.activeDocument.netlistIdTable[netlistId];

    if (!viewRef) {return;}

    if (metadata.checkboxState === vscode.TreeItemCheckboxState.Unchecked) {
      this.netlistTreeDataProvider.setCheckboxState(viewRef.netlistItem, vscode.TreeItemCheckboxState.Unchecked);
      this.displayedSignalsTreeDataProvider.removeSignalFromTreeData(metadata);
      document.removeSignalFromWebview(netlistId);
      this.activeDocument.setNetlistIdTable(netlistId, undefined);
    }
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
    if (!this.lastActiveWebview?.active) {return;}
    if (e.element.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    e.element.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
  };

  private handleNetlistExpandElement = (e: vscode.TreeViewExpansionEvent<NetlistItem>) => {
    if (!this.lastActiveWebview?.active) {return;}
    if (e.element.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    e.element.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  };
}