import * as vscode from 'vscode';
import * as path from 'path';

import { SignalGroupWebviewContext } from '../common/types';
import type {
  NetlistId,
  OpenFileArgs,
  VariableActionArgs,
  SetMarkerArgs,
  GetViewerStateArgs,
  GetValuesAtTimeArgs,
  AddVariableByPathArgs,
  NetlistVariableWebviewContext,
} from '../../packages/vaporview-api/types';
import { VaporviewDocumentCollection, WaveformViewerProvider, type RenameSignalGroupArgs } from './viewer_provider';
import type { NetlistItem } from './tree_view';
import { wcpDefaultPort, WCPServer } from './wcp_server';
import { dirname } from 'path';

// Context menu args for signal group operations (newSignalGroup, newSeparator, etc.)
interface SignalGroupCommandArgs {
  name?: string;
  groupPath?: string[];
  parentGroupId?: number;
  rowId?: number;
}

export function registerVaporviewCommands(
  context: vscode.ExtensionContext,
  outputLog: vscode.OutputChannel,
  viewerProvider: WaveformViewerProvider,
  documentCollection: VaporviewDocumentCollection,
  wcpServer: WCPServer | null
) {

  // #region External Commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openFile', async (e: OpenFileArgs) => {
    outputLog.appendLine("Command called: 'vaporview.openFile ' + " + e.uri.toString());
    if (!e.uri) {return;}
    await vscode.commands.executeCommand('vscode.openWith', e.uri, 'vaporview.waveformViewer');
    if (e.loadAll) {viewerProvider.loadAllVariablesFromFile(e.uri.toString(), e.maxSignals || 64);}
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addVariable', (e: VariableActionArgs) => {
    outputLog.appendLine("Command called: 'waveformViewer.addVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "add");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.removeVariable', (e: VariableActionArgs) => {
    outputLog.appendLine("Command called: 'waveformViewer.removeVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "remove");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.revealInNetlistView', (e: VariableActionArgs) => {
    outputLog.appendLine("Command called: 'waveformViewer.revealInNetlistView' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "reveal");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addSignalValueLink', (e: VariableActionArgs) => {
    outputLog.appendLine("Command called: 'waveformViewer.addSignalValueLink' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "addLink");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.setMarker', (e: SetMarkerArgs) => {
    outputLog.appendLine("Command called: 'waveformViewer.setMarker' " + JSON.stringify(e));
    viewerProvider.markerCommandHandler(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getOpenDocuments', () => {
    outputLog.appendLine("Command called: 'waveformViewer.getOpenDocuments'");
    return viewerProvider.getAllDocumentUris();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getViewerState', (e: GetViewerStateArgs) => {
    outputLog.appendLine("Command called: 'waveformViewer.getViewerState' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getSettings();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getValuesAtTime', (e: GetValuesAtTimeArgs) => {
    outputLog.appendLine("Command called: 'waveformViewer.getValuesAtTime' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getValuesAtTime(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.vaporView');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.clickNetlistItem', (e: { uri: vscode.Uri; netlistId: NetlistId }) => {
    viewerProvider.netlistTreeDataProvider.clickNetlistItem(e.uri, e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.searchNetlist', () => {
    viewerProvider.searchNetlist();
  }));

  // Add or remove signal commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariableByInstancePath', (e: AddVariableByPathArgs) => {
    viewerProvider.addVariableByInstancePathToDocument(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariable', async (e: NetlistItem) => {
    viewerProvider.filterAddSignalsInNetlist([e], true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSignal', (e: { rowId?: number }) => {
    if (e && e.rowId !== undefined) {
      viewerProvider.removeSignalFromDocument(undefined, e.rowId, true);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSignalGroup', (e?: SignalGroupCommandArgs) => {
    if (e) {viewerProvider.newSignalGroup(e.name, e.groupPath, e.parentGroupId, e.rowId, false);}
    else {viewerProvider.newSignalGroup(undefined, undefined, undefined, undefined, false);}
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newGroupFromSelection', (e?: SignalGroupCommandArgs) => {
    viewerProvider.newSignalGroup(e?.name, e?.groupPath, e?.parentGroupId, e?.rowId, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.ungroupSignals', (e: SignalGroupWebviewContext) => {
    viewerProvider.deleteSignalGroup(e, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.deleteGroup', (e: SignalGroupWebviewContext) => {
    viewerProvider.deleteSignalGroup(e, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSeparator', (e: SignalGroupCommandArgs) => {
    viewerProvider.newSeparator(e.name, e.groupPath, e.parentGroupId, e.rowId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSeparator', (e: { rowId: number }) => {
    viewerProvider.removeSeparator(e.rowId, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.newSignalFromBitRange', (e: SignalGroupCommandArgs) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the bit range (e.g. 7:0 for bits 0 to 7, or 7 for a single bit)',
      value: '0'
    }).then((bitRangeString) => {
      if (!bitRangeString) {return;}
      viewerProvider.newSignalFromBitRange(e.name, e.groupPath, e.parentGroupId, e.rowId, bitRangeString);
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllBits', (e: SignalGroupCommandArgs) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 1);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllNibbles', (e: SignalGroupCommandArgs) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 4);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllBytes', (e: SignalGroupCommandArgs) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 8);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllWords', (e: SignalGroupCommandArgs) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 16);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllDoubleWords', (e: SignalGroupCommandArgs) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 32);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllQuadWords', (e: SignalGroupCommandArgs) => {
    viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, 64);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.createSignalsForAllCustomLength', (e: SignalGroupCommandArgs) => {
    // Show input box for custom length
    vscode.window.showInputBox({prompt: 'Enter the custom length in bits', value: '1'
    }).then((customLength) => {
      if (!customLength) {return;}
      const length = parseInt(customLength);
      if (isNaN(length) || length <= 0) {
        vscode.window.showErrorMessage('Invalid custom length. Please enter a positive integer.');
        return;
      }
      viewerProvider.createSignalsForAllBits(e.name, e.groupPath, e.parentGroupId, e.rowId, length);
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renameSignalGroup', (e: RenameSignalGroupArgs) => {
    viewerProvider.renameSignalGroup(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addSelected', () => {
    viewerProvider.filterAddSignalsInNetlist(viewerProvider.netlistTreeDataProvider.selectedSignals, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeShallow', (e: NetlistItem) => {
    viewerProvider.addAllInScopeToDocument(e, false, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeRecursive', (e: NetlistItem) => {
    viewerProvider.addAllInScopeToDocument(e, true, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedNetlist', () => {
    viewerProvider.removeSignalList(viewerProvider.netlistTreeDataProvider.selectedSignals);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeAllInScope', (e: NetlistItem) => {
    if (e.collapsibleState === vscode.TreeItemCollapsibleState.None) {return;}
    viewerProvider.removeSignalList(e.children);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInNetlistView', (e: { netlistId?: NetlistId } | undefined) => {
      viewerProvider.showInNetlistView(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showInViewer', (e: { netlistId: NetlistId }) => {
    viewerProvider.revealSignalInWebview(e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyName', (e: { scopePath: string; name?: string; signalName?: string }) => {
    let result = "";
    if (e.scopePath !== "") {result += e.scopePath + ".";}
    if (e.name) {result += e.name;}
    if (e.signalName) {result += e.signalName;}
    vscode.env.clipboard.writeText(result);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyValueAtMarker', (e: { rowId?: number }) => {
    viewerProvider.copyValueAtMarker(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.saveViewerSettings', async (e: { documentId: string }) => {
    const document = viewerProvider.getDocumentFromId(e.documentId);
    if (!document) {return;}
    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);
    const saveFileName = fileName.replace(/\.[^/.]+$/, '') + '.json' || 'untitled.json';
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Save settings',
      filters: {JSON: ['json']},
      defaultUri: vscode.Uri.file(path.join(dirname(filePath), saveFileName)),
    });
    if (uri) {
      viewerProvider.saveSettingsToFile(document, uri);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.loadViewerSettings', () => {
    viewerProvider.loadSettingsFromFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.reloadFile', (e: vscode.Uri) => {
    viewerProvider.reloadFile(e);
  }));

  // #region Keybindings
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.nextEdge', (e: unknown) => {
    viewerProvider.handleKeyBinding(e, "nextEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.previousEdge', (e: unknown) => {
    viewerProvider.handleKeyBinding(e, "previousEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.zoomToFit', (e: unknown) => {
    viewerProvider.handleKeyBinding(e, "zoomToFit");
  }));

  // #region Marker and Timing
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnits', () => {
    viewerProvider.updateTimeUnits("");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsSeconds', () => {
    viewerProvider.updateTimeUnits("s");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMilliseconds', () => {
    viewerProvider.updateTimeUnits("ms");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMicroseconds', () => {
    viewerProvider.updateTimeUnits("µs");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsNanoseconds', () => {
    viewerProvider.updateTimeUnits("ns");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsPicoseconds', () => {
    viewerProvider.updateTimeUnits("ps");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsFemtoseconds', () => {
    viewerProvider.updateTimeUnits("fs");
  }));

  // #region WaveDrom
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyWaveDrom', () => {
    viewerProvider.copyWaveDrom();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockRising', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setWaveDromClock('1', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockFalling', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setWaveDromClock('0', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.unsetWaveDromClock', () => {
    viewerProvider.setWaveDromClock('1', null);
  }));

  // #region Value Format
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBinary', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "binary"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsHexadecimal', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "hexadecimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimal', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "decimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimalSigned', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "signed"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsOctal', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "octal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFloat', (e: NetlistVariableWebviewContext) => {
    switch (e.width) {
      case 8:  viewerProvider.setValueFormat(e, undefined, {valueFormat: "float8"}); break;
      case 16: viewerProvider.setValueFormat(e, undefined, {valueFormat: "float16"}); break;
      case 32: viewerProvider.setValueFormat(e, undefined, {valueFormat: "float32"}); break;
      case 64: viewerProvider.setValueFormat(e, undefined, {valueFormat: "float64"}); break;
      default: viewerProvider.setValueFormat(e, undefined, {valueFormat: "binary"}); break;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderMultiBit', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {renderType: "multiBit"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinear', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {renderType: "linear"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderStepped', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {renderType: "stepped"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinearSigned', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {renderType: "linearSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderSteppedSigned', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {renderType: "steppedSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBFloat', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "bfloat16"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsTFloat', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "tensorfloat32"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsAscii', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "ascii"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsEpochTimeNs', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {valueFormat: "nsepoch"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsEnum', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined,  {valueFormat: "enum"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFixedPoint', (e: NetlistVariableWebviewContext) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the fixed point offset',
      value: '0'
    }).then((offset) => {
      if (!offset) {return;}
      viewerProvider.setValueFormat(e, undefined, {valueFormat: "fixedpoint_u_" + offset.toString()});
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFixedPointSigned', (e: NetlistVariableWebviewContext) => {
    // Show input box for offset
    vscode.window.showInputBox({prompt: 'Enter the fixed point offset',
      value: '0'
    }).then((offset) => {
      if (!offset) {return;}
      viewerProvider.setValueFormat(e, undefined, {valueFormat: "fixedpoint_s_" + offset.toString()});
    });
  }));

  // #region Annotate Edges
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotatePosedge', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {annotateValue: ["1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNegedge', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {annotateValue: ["0"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateAllEdge', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {annotateValue: ["0", "1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNone', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {annotateValue: []});
  }));

  // #region Custom Color
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor1', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 0});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor2', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor3', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor4', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 3});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor5', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor6', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 5});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor7', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 6});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor8', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {colorIndex: 7});
  }));

  // #region Row Height
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight1x', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {rowHeight: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight2x', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {rowHeight: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight4x', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {rowHeight: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight8x', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {rowHeight: 8});
  }));

  // #region Vertical Scale
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.increaseVerticalScale', (e: unknown) => {
    viewerProvider.handleKeyBinding(e, "increaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.decreaseVerticalScale', (e: unknown) => {
    viewerProvider.handleKeyBinding(e, "decreaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.resetVerticalScale', (e: unknown) => {
    viewerProvider.handleKeyBinding(e, "resetVerticalScale");
  }));

  // #region Name Type
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeFullPath', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {nameType: "fullPath"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeSignalName', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {nameType: "signalName"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setNameTypeCustom', (e: NetlistVariableWebviewContext) => {
    viewerProvider.setValueFormat(e, undefined, {nameType: "custom"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showRulerLines', () => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.hideRulerLines', () => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.fillBitVector', () => {
    vscode.workspace.getConfiguration('vaporview').update('fillMultiBitValues', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.outlineBitVector', () => {
    vscode.workspace.getConfiguration('vaporview').update('fillMultiBitValues', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.enableAnimations', () => {
    vscode.workspace.getConfiguration('vaporview').update('enableAnimations', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.disableAnimations', () => {
    vscode.workspace.getConfiguration('vaporview').update('enableAnimations', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setMouseScrollingMode', () => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Mouse", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTouchpadScrollingMode', () => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Touchpad", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setAutoScrollingMode', () => {
    vscode.workspace.getConfiguration('vaporview').update('scrollingMode', "Auto", vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSettings', () => {
    // Open VScode Settings to the Vaporview Section
    vscode.commands.executeCommand('workbench.action.openSettings', "vaporview");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.dummy', (e: unknown) => {
    outputLog.appendLine("Command called: 'vaporview.dummy' " + JSON.stringify(e));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openRemoteViewer', async (e?: { url?: string; bearerToken?: string }) => {
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
    } catch (error: unknown) {
      vscode.window.showErrorMessage(`Failed to start WCP server: ${error instanceof Error ? error.message : String(error)}`);
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
}