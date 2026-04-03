import * as vscode from 'vscode';
import type {
  VaporviewApi,
  VaporviewCommands,
  OpenFileArgs,
  VariableActionArgs,
  SetMarkerArgs,
  GetViewerStateArgs,
  GetValuesAtTimeArgs,
  AddVariableByPathArgs,
  ViewerState,
  ValuesAtTimeResult,
  DecodedNetlistUri,
} from './types';

export async function getApi(): Promise<VaporviewApi | undefined> {
  const ext = vscode.extensions.getExtension<VaporviewApi>('Lramseyer.vaporview');
  if (!ext) {
    return undefined;
  }
  return await ext.activate();
}

/**
 * A command-based implementation of VaporviewApi that delegates to
 * `vscode.commands.executeCommand`. Use this when you don't need events
 * and just want to call VaporView commands with type safety. Otherwise, you can use the api object.
 *
 * For events, use {@link getVaporviewApi} instead.
 *
 * ```ts
 * import { commands } from 'vaporview-api';
 *
 * await vaporview.openFile({ uri: fileUri, loadAll: true });
 * await vaporview.setMarker({ time: 100, units: 'ns' });
 * const state = await vaporview.getViewerState();
 * ```
 */
export const commands = {
  async openFile(args: OpenFileArgs): Promise<void> {
    await vscode.commands.executeCommand('vaporview.openFile', args);
  },
  async addVariable(args: VariableActionArgs): Promise<void> {
    await vscode.commands.executeCommand('waveformViewer.addVariable', args);
  },
  async removeVariable(args: VariableActionArgs): Promise<void> {
    await vscode.commands.executeCommand('waveformViewer.removeVariable', args);
  },
  async revealInNetlistView(args: VariableActionArgs): Promise<void> {
    await vscode.commands.executeCommand('waveformViewer.revealInNetlistView', args);
  },
  async addSignalValueLink(args: VariableActionArgs): Promise<void> {
    await vscode.commands.executeCommand('waveformViewer.addSignalValueLink', args);
  },
  setMarker(args: SetMarkerArgs): void {
    vscode.commands.executeCommand('waveformViewer.setMarker', args);
  },
  async getOpenDocuments(): Promise<string[]> {
    return await vscode.commands.executeCommand<string[]>('waveformViewer.getOpenDocuments') ?? [];
  },
  async getViewerState(args?: GetViewerStateArgs): Promise<ViewerState | undefined> {
    return await vscode.commands.executeCommand<ViewerState>('waveformViewer.getViewerState', args ?? {});
  },
  async getValuesAtTime(args: GetValuesAtTimeArgs): Promise<ValuesAtTimeResult[]> {
    return await vscode.commands.executeCommand('waveformViewer.getValuesAtTime', args);
  },
  async addVariableByInstancePath(args: AddVariableByPathArgs): Promise<void> {
    await vscode.commands.executeCommand('vaporview.addVariableByInstancePath', args);
  },
} satisfies VaporviewCommands;


/**
 * Decode a `waveform://` URI as produced by VaporView's netlist tree items.
 *
 * URI format: `waveform://<fsPath>#var=<netlistId>&net=<instancePath>`
 * or: `waveform://<fsPath>#scope=<netlistId>&net=<instancePath>`
 */
export function decodeNetlistUri(uri: vscode.Uri): DecodedNetlistUri {
  if (uri.scheme !== 'waveform') {
    throw new Error('Not a waveform URI');
  }
  const params = new URLSearchParams(uri.fragment);
  const result: DecodedNetlistUri = { fsPath: uri.path, path: '' };

  const scope = params.get('scope');
  const varId = params.get('var');
  const net = params.get('net');

  if (scope) {
    result.scopeId = decodeURIComponent(scope);
    result.id = parseInt(scope);
  }
  if (varId) {
    result.id = parseInt(varId);
  }
  if (net) {
    result.path = decodeURIComponent(net);
  }
  return result;
}