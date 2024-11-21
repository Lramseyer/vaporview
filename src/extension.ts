// Description: This file contains the extension logic for the VaporView extension
import * as vscode from 'vscode';

import { TimestampLinkProvider, NetlistLinkProvider } from './terminal_links';
import { WaveformViewerProvider } from './viewer_provider';

const wasmDebug   = 'debug';
const wasmRelease = 'release';
const wasmBuild   = wasmRelease;

// #region activate()
export async function activate(context: vscode.ExtensionContext) {

  // Load the Wasm module
  const binaryFile = vscode.Uri.joinPath(context.extensionUri, 'target', 'wasm32-unknown-unknown', wasmBuild, 'filehandler.wasm');
  const binaryData = await vscode.workspace.fs.readFile(binaryFile);
  const wasmModule = await WebAssembly.compile(binaryData);

  // Register Custom Editor Provider (The viewer window)
  // See package.json for more details
  const viewerProvider = new WaveformViewerProvider(context, wasmModule);

  vscode.window.registerCustomEditorProvider(
    'vaporview.waveformViewer',
    viewerProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    });

  vscode.window.registerTerminalLinkProvider(new TimestampLinkProvider(viewerProvider));

  // I need to move this to the document provider class...
  vscode.window.registerTerminalLinkProvider(new NetlistLinkProvider(viewerProvider));

  // I want to get semantic tokens for the current theme
  // The API is not available yet, so I'm just going to log the theme
  //vscode.window.onDidChangeActiveColorTheme((e) => {});

  // Commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.vaporView');
  }));

  // Add or remove signal commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSignal', (e) => {
    if (e.netlistId !== undefined) {
      viewerProvider.removeSignalFromDocument(e.netlistId);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addSelected', (e) => {
    viewerProvider.filterAddSignalsInNetlist(viewerProvider.netlistViewSelectedSignals, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInModule', (e) => {
    if (e.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    viewerProvider.filterAddSignalsInNetlist(e.children, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedNetlist', (e) => {
    viewerProvider.removeSelectedSignalsFromDocument('netlist');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedDisplayedSignals', (e) => {
    viewerProvider.removeSelectedSignalsFromDocument('displayedSignals');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeAllInModule', (e) => {
    if (e.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    viewerProvider.removeSignalList(e.children);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInNetlistView', (e) => {
    if (e.netlistId !== undefined) {
      viewerProvider.showInNetlistView(e.netlistId);
    }
  }));

  // Value Format commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBinary', (e) => {
    if (e.netlistId) {
      viewerProvider.setValueFormat(e.netlistId, 2);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsHexadecimal', (e) => {
    if (e.netlistId) {
      viewerProvider.setValueFormat(e.netlistId, 16);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimal', (e) => {
    if (e.netlistId) {
      viewerProvider.setValueFormat(e.netlistId, 10);
    }
  }));

  // WaveDrom commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyWaveDrom', (e) => {
    viewerProvider.copyWaveDrom();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockRising', (e) => {
    viewerProvider.setWaveDromClock('1', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockFalling', (e) => {
    viewerProvider.setWaveDromClock('0', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.unsetWaveDromClock', (e) => {
    viewerProvider.setWaveDromClock('1', null);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.saveViewerSettings', (e) => {
    viewerProvider.saveSettingsToFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.loadViewerSettings', (e) => {
    viewerProvider.loadSettingsFromFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.reloadFile', (e) => {
    viewerProvider.reloadFile();
  }));
}

export default WaveformViewerProvider;

export function deactivate() {}
