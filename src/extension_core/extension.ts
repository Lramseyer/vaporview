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
  vscode.window.onDidChangeActiveColorTheme((e) => {
    viewerProvider.updateColorTheme(e);
  });

  // #region External Commands
  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.addVariable'");
    viewerProvider.variableActionCommandHandler(e, "add");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.removeVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.removeVariable'");
    viewerProvider.variableActionCommandHandler(e, "remove");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.revealInNetlistView', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.revealInNetlistView'");
    viewerProvider.variableActionCommandHandler(e, "reveal");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.setMarker', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.setMarker'");
    viewerProvider.markerCommandHandler(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.vaporView');
  }));

  // Add or remove signal commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariableByInstancePath', (e) => {
    viewerProvider.addVariableByInstancePathToDocument(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSignal', (e) => {
    if (e.netlistId !== undefined) {
      viewerProvider.removeSignalFromDocument(e.netlistId);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addSelected', (e) => {
    console.log(e);
    viewerProvider.filterAddSignalsInNetlist(viewerProvider.netlistViewSelectedSignals, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeShallow', (e) => {
    viewerProvider.addAllInScopeToDocument(e, false, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeRecursive', (e) => {
    viewerProvider.addAllInScopeToDocument(e, true, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedNetlist', (e) => {
    viewerProvider.removeSelectedSignalsFromDocument('netlist');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedDisplayedSignals', (e) => {
    viewerProvider.removeSelectedSignalsFromDocument('displayedSignals');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeAllInScope', (e) => {
    if (e.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    viewerProvider.removeSignalList(e.children);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInNetlistView', (e) => {
    console.log(e);
    if (e.netlistId !== undefined) {
      viewerProvider.showInNetlistView(e.netlistId);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInViewer', (e) => {
    console.log(e);
    viewerProvider.addSignalByNameToDocument(e.modulePath + '.' + e.name);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyName', (e) => {
    let result = "";
    if (e.modulePath !== "") {result += e.modulePath + ".";}
    if (e.name) {result += e.name;}
    if (e.signalName) {result += e.signalName;}
    vscode.env.clipboard.writeText(result);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyValueAtMarker', (e) => {
    viewerProvider.copyValueAtMarker(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.saveViewerSettings', (e) => {
    viewerProvider.saveSettingsToFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.loadViewerSettings', (e) => {
    viewerProvider.loadSettingsFromFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.reloadFile', (e) => {
    viewerProvider.reloadFile(e);
  }));

  // #region WaveDrom
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

  // #region Value Format
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBinary', (e) => {
    viewerProvider.setValueFormat(e.netlistId, "binary", undefined, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsHexadecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, "hexadecimal", undefined, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, "decimal", undefined, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimalSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, "signed", undefined, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsOctal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, "octal", undefined, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFloat', (e) => {
    switch (e.width) {
      case 8:  viewerProvider.setValueFormat(e.netlistId, "float8",  undefined, undefined); break;
      case 16: viewerProvider.setValueFormat(e.netlistId, "float16", undefined, undefined); break;
      case 32: viewerProvider.setValueFormat(e.netlistId, "float32", undefined, undefined); break;
      case 64: viewerProvider.setValueFormat(e.netlistId, "float64", undefined, undefined); break;
      default: viewerProvider.setValueFormat(e.netlistId, "binary",  undefined, undefined); break;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderMultiBit', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, undefined, "multiBit");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinear', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, undefined, "linear");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderStepped', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, undefined, "stepped");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinearSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, undefined, "linearSigned");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderSteppedSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, undefined, "steppedSigned");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId, "bfloat16", undefined, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsTFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId, "tensorfloat32", undefined, undefined);
  }));

  // #region Custom Color
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 0, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 1, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 2, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 3, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 4, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 5, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 6, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, 7, undefined);
  }));
}

export default WaveformViewerProvider;

export function deactivate() {}
