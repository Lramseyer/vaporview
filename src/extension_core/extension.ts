// Description: This file contains the extension logic for the VaporView extension
import * as vscode from 'vscode';

import { TimestampLinkProvider, NetlistLinkProvider } from './terminal_links';
import { registerVaporviewCommands } from './commands';
import { WaveformViewerProvider, VaporviewDocumentCollection } from './viewer_provider';
import { updateWCPServerFromConfiguration, WCPServer } from './wcp_server';
import type {
  VaporviewApi,
  OpenFileArgs,
  VariableActionArgs,
  SetMarkerArgs,
  GetViewerStateArgs,
  GetValuesAtTimeArgs,
  AddVariableByPathArgs,
} from '../../packages/vaporview-api/types';

// #region activate()
export async function activate(context: vscode.ExtensionContext): Promise<VaporviewApi> {

  // Load the Wasm module
  const binaryFile = vscode.Uri.joinPath(context.extensionUri, 'target', 'wasm32-unknown-unknown', 'release', 'filehandler.wasm');
  const binaryData = await vscode.workspace.fs.readFile(binaryFile);
  const wasmModule = await WebAssembly.compile(new Uint8Array(binaryData));

  // create an output channel for logging
  const outputLog = vscode.window.createOutputChannel('Vaporview', { log: true });
  context.subscriptions.push(outputLog);

  // Register Custom Editor Provider (The viewer window)
  // See package.json for more details
  const documentCollection = new VaporviewDocumentCollection(outputLog);
  const viewerProvider     = new WaveformViewerProvider(context, outputLog, wasmModule, documentCollection);

  vscode.window.registerCustomEditorProvider(
    'vaporview.waveformViewer',
    viewerProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    }
  );

  // Initialize WCP Server
  let wcpServer: WCPServer | null = null;
  updateWCPServerFromConfiguration(wcpServer, viewerProvider, context);

  // Store wcpServer reference for cleanup
  context.subscriptions.push({
    dispose: () => {
      if (wcpServer) {
        wcpServer.stop();
        wcpServer = null;
      }
    }
  });

  // Listen for configuration changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('vaporview.wcp.enabled') || e.affectsConfiguration('vaporview.wcp.port')) {
      updateWCPServerFromConfiguration(wcpServer, viewerProvider, context);
    }

    if (e.affectsConfiguration('workbench.colorTheme')) {
      documentCollection.getTokenColorsForTheme();
    }

    // TODO: Check if configuration changes affect vaporview
    documentCollection.updateConfiguration(e);
  }));

  vscode.window.registerTerminalLinkProvider(new TimestampLinkProvider(viewerProvider));

  //vscode.workspace.onDidChangeConfiguration((e) => {viewerProvider.updateConfiguration(e);});
  const markerSetEvent = WaveformViewerProvider.markerSetEventEmitter.event;
  const signalSelectEvent = WaveformViewerProvider.signalSelectEventEmitter.event;
  const addVariableEvent = WaveformViewerProvider.addVariableEventEmitter.event;
  const removeVariableEvent = WaveformViewerProvider.removeVariableEventEmitter.event;
  const externalDropEvent = WaveformViewerProvider.externalDropEventEmitter.event;

  // Register commands (there are a lot of commands, so we register them in a separate file for cleanliness)
  registerVaporviewCommands(context, outputLog, viewerProvider, documentCollection, wcpServer);

  outputLog.appendLine('Vaporview Activated');

  const api: VaporviewApi = {
    // Events
    onDidSetMarker: markerSetEvent,
    onDidSelectSignal: signalSelectEvent,
    onDidAddVariable: addVariableEvent,
    onDidRemoveVariable: removeVariableEvent,
    onDidDropInWaveformViewer: externalDropEvent,

    // Commands
    async openFile(args: OpenFileArgs) {
      if (!args.uri) {return;}
      await vscode.commands.executeCommand('vscode.openWith', args.uri, 'vaporview.waveformViewer');
      if (args.loadAll) {viewerProvider.loadAllVariablesFromFile(args.uri.toString(), args.maxSignals || 64);}
    },
    async addVariable(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "add");
    },
    async removeVariable(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "remove");
    },
    async revealInNetlistView(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "reveal");
    },
    async addSignalValueLink(args: VariableActionArgs) {
      viewerProvider.variableActionCommandHandler(args, "addLink");
    },
    setMarker(args: SetMarkerArgs) {
      viewerProvider.markerCommandHandler(args);
    },
    async getOpenDocuments() {
      return viewerProvider.getAllDocumentUris();
    },
    async getViewerState(args?: GetViewerStateArgs) {
      const document = viewerProvider.getDocumentFromOptionalUri(args?.uri);
      if (!document) {return undefined;}
      return document.getSettings();
    },
    async getValuesAtTime(args: GetValuesAtTimeArgs) {
      const document = viewerProvider.getDocumentFromOptionalUri(args.uri);
      if (!document) {return [];}
      return document.getValuesAtTime(args);
    },
    async addVariableByInstancePath(args: AddVariableByPathArgs) {
      viewerProvider.addVariableByInstancePathToDocument(args);
    },
  };
  return api;
}

export default WaveformViewerProvider;

export function deactivate() {
  // WCP server cleanup is handled by context subscriptions
  // All resources registered with context.subscriptions are automatically disposed
}
