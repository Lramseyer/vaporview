// Description: This file contains the extension logic for the VaporView extension
import * as vscode from 'vscode';

import { TimestampLinkProvider, NetlistLinkProvider } from './terminal_links';
import { WaveformViewerProvider } from './viewer_provider';
import { updateWCPServerFromConfiguration, WCPServer, wcpDefaultPort } from './wcp_server';
import * as path from 'path';
import { SignalGroupContextMenuEvent } from '../common/types';

// #region activate()
export async function activate(context: vscode.ExtensionContext) {

  // Load the Wasm module
  const binaryFile = vscode.Uri.joinPath(context.extensionUri, 'target', 'wasm32-unknown-unknown', 'release', 'filehandler.wasm');
  const binaryData = await vscode.workspace.fs.readFile(binaryFile);
  const wasmModule = await WebAssembly.compile(new Uint8Array(binaryData));

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

    // TODO: Check if configuration changes affect vaporview
    viewerProvider.updateConfiguration(e);
  }));

  vscode.window.registerTerminalLinkProvider(new TimestampLinkProvider(viewerProvider));

  // I want to get semantic tokens for the current theme
  // The API is not available yet, so I'm just going to log the theme
  vscode.window.onDidChangeActiveColorTheme((e) => {viewerProvider.updateColorTheme(e);});
  //vscode.workspace.onDidChangeConfiguration((e) => {viewerProvider.updateConfiguration(e);});

  const markerSetEvent = WaveformViewerProvider.markerSetEventEmitter.event;
  const signalSelectEvent = WaveformViewerProvider.signalSelectEventEmitter.event;
  const addVariableEvent = WaveformViewerProvider.addVariableEventEmitter.event;
  const removeVariableEvent = WaveformViewerProvider.removeVariableEventEmitter.event;
  const externalDropEvent = WaveformViewerProvider.externalDropEventEmitter.event;

  // #region External Commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openFile', async (e) => {
    viewerProvider.log.appendLine("Command called: 'vaporview.openFile ' + " + e.uri.toString());
    if (!e.uri) {return;}
    await vscode.commands.executeCommand('vscode.openWith', e.uri, 'vaporview.waveformViewer');
    if (e.loadAll) {viewerProvider.loadAllVariablesFromFile(e.uri.toString(), e.maxSignals || 64);}
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.addVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "add");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.removeVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.removeVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "remove");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.revealInNetlistView', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.revealInNetlistView' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "reveal");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addSignalValueLink', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.addSignalValueLink' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "addLink");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.setMarker', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.setMarker' " + JSON.stringify(e));
    viewerProvider.markerCommandHandler(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getOpenDocuments', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getOpenDocuments' " + JSON.stringify(e));
    return viewerProvider.getAllDocumentUris();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getViewerState', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getViewerState' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getSettings();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getValuesAtTime', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getValuesAtTime' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getValuesAtTime(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.vaporView');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.clickNetlistItem', (e) => {
    viewerProvider.netlistTreeDataProvider.clickNetlistItem(e.uri, e.netlistId);
  }));

  // Add or remove signal commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariableByInstancePath', (e) => {
    viewerProvider.addVariableByInstancePathToDocument(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariable', async (e) => {
    viewerProvider.filterAddSignalsInNetlist([e], true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSignal', (e) => {
    if (e && e.rowId !== undefined) {
      viewerProvider.removeSignalFromDocument(undefined, e.rowId, true);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSignalGroup', (e) => {
    if (e) {viewerProvider.newSignalGroup(e.name, e.groupPath, e.parentGroupId, e.rowId, false);}
    else {viewerProvider.newSignalGroup(undefined, undefined, undefined, undefined, false);}
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newGroupFromSelection', (e) => {
    viewerProvider.newSignalGroup(e?.name, e?.groupPath, e?.parentGroupId, e?.rowId, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.ungroupSignals', (e: SignalGroupContextMenuEvent) => {
    viewerProvider.deleteSignalGroup(e, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.deleteGroup', (e: SignalGroupContextMenuEvent) => {
    viewerProvider.deleteSignalGroup(e, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSeparator', (e) => {
    viewerProvider.newSeparator(e.name, e.groupPath, e.parentGroupId, e.rowId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSeparator', (e) => {
    viewerProvider.removeSeparator(e.rowId, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSignalFromBitRange', (e) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the bit range (e.g. 7:0 for bits 0 to 7, or 7 for a single bit)',
      value: '0'
    }).then((bitRangeString) => {
      if (!bitRangeString) {return;}
      viewerProvider.newSignalFromBitRange(e.name, e.groupPath, e.parentGroupId, e.rowId, bitRangeString);
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllBits', (e) => {
    // Show input box for offset
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renameSignalGroup', (e) => {
    viewerProvider.renameSignalGroup(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addSelected', (e) => {
    viewerProvider.filterAddSignalsInNetlist(viewerProvider.netlistTreeDataProvider.selectedSignals, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeShallow', (e) => {
    viewerProvider.addAllInScopeToDocument(e, false, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeRecursive', (e) => {
    viewerProvider.addAllInScopeToDocument(e, true, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedNetlist', (e) => {
    viewerProvider.removeSignalList(viewerProvider.netlistTreeDataProvider.selectedSignals);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeAllInScope', (e) => {
    if (e.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    viewerProvider.removeSignalList(e.children);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInNetlistView', (e) => {
      viewerProvider.showInNetlistView(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInViewer', (e) => {
    viewerProvider.revealSignalInWebview(e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyName', (e) => {
    let result = "";
    if (e.scopePath !== "") {result += e.scopePath + ".";}
    if (e.name) {result += e.name;}
    if (e.signalName) {result += e.signalName;}
    vscode.env.clipboard.writeText(result);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyValueAtMarker', (e) => {
    viewerProvider.copyValueAtMarker(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.saveViewerSettings', (e) => {
    viewerProvider.saveSettingsToFile(undefined, undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.loadViewerSettings', (e) => {
    viewerProvider.loadSettingsFromFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.reloadFile', (e) => {
    viewerProvider.reloadFile(e);
  }));

  // #region Keybindings
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.nextEdge', (e) => {
    viewerProvider.handleKeyBinding(e, "nextEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.previousEdge', (e) => {
    viewerProvider.handleKeyBinding(e, "previousEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.zoomToFit', (e) => {
    viewerProvider.handleKeyBinding(e, "zoomToFit");
  }));

  // #region Marker and Timing
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnits', (e) => {
    viewerProvider.updateTimeUnits("");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsSeconds', (e) => {
    viewerProvider.updateTimeUnits("s");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMilliseconds', (e) => {
    viewerProvider.updateTimeUnits("ms");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMicroseconds', (e) => {
    viewerProvider.updateTimeUnits("µs");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsNanoseconds', (e) => {
    viewerProvider.updateTimeUnits("ns");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsPicoseconds', (e) => {
    viewerProvider.updateTimeUnits("ps");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsFemtoseconds', (e) => {
    viewerProvider.updateTimeUnits("fs");
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
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "binary"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsHexadecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "hexadecimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "decimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimalSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "signed"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsOctal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "octal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFloat', (e) => {
    switch (e.width) {
      case 8:  viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float8"}); break;
      case 16: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float16"}); break;
      case 32: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float32"}); break;
      case 64: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "float64"}); break;
      default: viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "binary"}); break;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderMultiBit', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "multiBit"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinear', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "linear"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderStepped', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "stepped"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinearSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "linearSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderSteppedSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {renderType: "steppedSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "bfloat16"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsTFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "tensorfloat32"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsAscii', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "ascii"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsEnum', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId,  {valueFormat: "enum"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFixedPoint', (e) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the fixed point offset',
      value: '0'
    }).then((offset) => {
      if (!offset) {return;}
      viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "fixedpoint_u_" + offset.toString()});
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFixedPointSigned', (e) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the fixed point offset',
      value: '0'
    }).then((offset) => {
      if (!offset) {return;}
      viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {valueFormat: "fixedpoint_s_" + offset.toString()});
    });
  }));

  // #region Annotate Edges
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotatePosedge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: ["1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNegedge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: ["0"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateAllEdge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: ["0", "1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNone', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {annotateValue: []});
  }));

  // #region Custom Color
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 0});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 3});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 5});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 6});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {colorIndex: 7});
  }));

  // #region Row Height
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight1x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight2x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight4x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight8x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {rowHeight: 8});
  }));

  // #region Vertical Scale
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.increaseVerticalScale', (e) => {
    viewerProvider.handleKeyBinding(e, "increaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.decreaseVerticalScale', (e) => {
    viewerProvider.handleKeyBinding(e, "decreaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.resetVerticalScale', (e) => {
    viewerProvider.handleKeyBinding(e, "resetVerticalScale");
  }));

  // #region Name Type
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeFullPath', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {nameType: "fullPath"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeSignalName', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {nameType: "signalName"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeCustom', (e) => {
    viewerProvider.setValueFormat(e.netlistId, undefined, e.rowId, {nameType: "custom"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showRulerLines', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.hideRulerLines', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.fillBitVector', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('fillMultiBitValues', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.outlineBitVector', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('fillMultiBitValues', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setMouseScrollingMode', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Mouse", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTouchpadScrollingMode', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Touchpad", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setAutoScrollingMode', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Auto", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSettings', (e) => {
    // Open VScode Settings to the Vaporview Section
    vscode.commands.executeCommand('workbench.action.openSettings', "vaporview");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.dummy', (e) => {
    viewerProvider.log.appendLine("Command called: 'vaporview.dummy' " + JSON.stringify(e));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openRemoteViewer', async (e) => {
    if (e && e.url) {
      viewerProvider.openRemoteViewer(e.url, e.bearerToken);
      return;
    }
    const serverUrl = await vscode.window.showInputBox({
      prompt: 'Enter the Surfer server URL',
      value: ''
    });
    
    if (!serverUrl) {
      return;
    }
    
    const bearerToken = await vscode.window.showInputBox({
      prompt: 'Enter bearer token (optional)',
      password: true,
      value: ''
    });
    
    viewerProvider.openRemoteViewer(serverUrl, bearerToken);
  }));

  // WCP Server commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.wcp.start', async () => {
    if (wcpServer && wcpServer.getIsRunning()) {
      vscode.window.showInformationMessage(`WCP server is already running on port ${wcpServer.getPort()}`);
      return;
    }
    
    const port = vscode.workspace.getConfiguration('vaporview').get<number>('wcp.port', wcpDefaultPort);
    wcpServer = new WCPServer(viewerProvider, context, port);
    try {
      const actualPort = await wcpServer.start();
      vscode.window.showInformationMessage(`WCP server started on port ${actualPort}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to start WCP server: ${error.message}`);
      wcpServer = null;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.wcp.stop', async () => {
    if (!wcpServer || !wcpServer.getIsRunning()) {
      vscode.window.showInformationMessage('WCP server is not running');
      return;
    }
    
    wcpServer.stop();
    wcpServer = null;
    await vscode.workspace.getConfiguration('vaporview').update('wcp.enabled', false, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('WCP server stopped');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.wcp.status', () => {
    if (wcpServer && wcpServer.getIsRunning()) {
      const connectionCount = wcpServer.getConnectionCount();
      const message = `WCP server is running on TCP port ${wcpServer.getPort()} (${connectionCount} connection${connectionCount !== 1 ? 's' : ''})`;
      vscode.window.showInformationMessage(message);
    } else {
      vscode.window.showInformationMessage('WCP server is not running');
    }
  }));

  return {
    onDidSetMarker: markerSetEvent,
    onDidSelectSignal: signalSelectEvent,
    onDidAddVariable: addVariableEvent,
    onDidRemoveVariable: removeVariableEvent,
    onDidDropInWaveformViewer: externalDropEvent
  };
}

export default WaveformViewerProvider;

export function deactivate() {
  // WCP server cleanup is handled by context subscriptions
  // All resources registered with context.subscriptions are automatically disposed
}

export function getTokenColorsForTheme(themeName: string) {
  const tokenColors = new Map();
  let currentThemePath;
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON.contributes && extension.packageJSON.contributes.themes;
    const currentTheme = themes && themes.find((theme: any) => theme.id === themeName);
    if (currentTheme) {
      currentThemePath = path.join(extension.extensionPath, currentTheme.path);
      break;
    }
  }
  const themePaths = [];
  if (currentThemePath) { themePaths.push(currentThemePath); }
  while (themePaths.length > 0) {
    const themePath: any = themePaths.pop();
    const theme: any = require(themePath);
    if (theme) {
      if (theme.include) {
        themePaths.push(path.join(path.dirname(themePath), theme.include));
      }
      if (theme.tokenColors) {
        theme.tokenColors.forEach((rule: any) => {
          if (typeof rule.scope === "string" && !tokenColors.has(rule.scope)) {
            tokenColors.set(rule.scope, rule.settings);
          } else if (rule.scope instanceof Array) {
            rule.scope.forEach((scope: any) => {
              if (!tokenColors.has(rule.scope)) {
                tokenColors.set(scope, rule.settings);
              }
            });
          }
        });
      }
    }
  }
  return tokenColors;
}
