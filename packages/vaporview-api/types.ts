/**
 * Shared type definitions for the VaporView VS Code extension API.
 *
 * These types are the single source of truth — used by both the extension
 * internally and by external consumers via the `vaporview-api` npm package.
 */

import type { Event, MarkdownString, ThemeIcon, TreeItemCollapsibleState, Uri } from 'vscode';

// #region Base Types

export type DocumentId = string;
export type NetlistId = number;
export type SignalId = number;
export type RowId = number;

// #region Saved State Types

export type SavedRowItem =
  | SavedNetlistVariable
  | SavedSignalGroup
  | SavedSignalSeparator
  | SavedCustomVariable;

export type SavedNetlistVariable = {
  dataType: 'netlist-variable';
  netlistId: NetlistId | undefined;
  name: string;
  numberFormat: string;
  colorIndex: number;
  rowHeight: number;
  verticalScale: number;
  nameType: NameType;
  customName: string;
  renderType: string;
  valueLinkEnable: boolean;
}

export type SavedCustomVariable = {
  dataType: 'custom-variable';
  numberFormat: string;
  colorIndex: number;
  rowHeight: number;
  verticalScale: number;
  nameType: NameType;
  customName: string;
  renderType: string;
  valueLinkEnable: boolean;
  source: BitRangeSource[];
};

export enum NameType {
  fullPath = 'fullPath',
  signalName = 'signalName',
  custom = 'custom',
}


export type BitRangeSource = {
  name: string;
  netlistId: NetlistId | undefined;
  signalId: SignalId | undefined;
  signalWidth: number;
  msb: number;
  lsb: number;
};


export type SavedSignalGroup = {
  dataType: 'signal-group';
  groupName: string;
  collapseState: number;
  children: SavedRowItem[];
};

export type SavedSignalSeparator = {
  dataType: 'signal-separator';
  label: string;
  rowHeight: number;
};

// #region Event Types

export interface MarkerSetEvent {
  uri: string;
  time: number;
  units: string;
}

export interface SignalEvent {
  uri: string;
  instancePath: string[];
  netlistId: NetlistId[];
  source: string;
}

export interface ValueLinkEvent {
  uri: string;
  rowId: RowId;
  netlistId: NetlistId | undefined;
  scopePath: string[];
  signalName: string;
  type: string;
  width: number;
  encoding: string;
  numberFormat: string;
  value: string;
  formattedValue: string;
  time: number;
}

export interface ViewerDropEvent {
  uri: string;
  resourceUriList: Uri[];
  groupPath: string[];
  index: number;
}

// #region Command Argument Types

/** Arguments for `vaporview.openFile` */
export interface OpenFileArgs {
  uri: Uri;
  loadAll?: boolean;
  maxSignals?: number;
}

/**
 * Arguments for variable action commands:
 * - `waveformViewer.addVariable`
 * - `waveformViewer.removeVariable`
 * - `waveformViewer.revealInNetlistView`
 * - `waveformViewer.addSignalValueLink`
 */
export interface VariableActionArgs {
  uri?: string;
  netlistId?: NetlistId;
  instancePath?: string;
  scopePath?: string;
  name?: string;
  msb?: number;
  lsb?: number;
  recursive?: boolean;
  reveal?: boolean;
  valueLinkEnable?: boolean;
}

export type VariableAction = 'add' | 'remove' | 'reveal' | 'addLink';

/** Arguments for `waveformViewer.setMarker` */
export interface SetMarkerArgs {
  time: number;
  units?: string;
  markerType?: number;
  uri?: string;
}

/** Arguments for `waveformViewer.getViewerState` */
export interface GetViewerStateArgs {
  uri?: string;
}

/** Arguments for `waveformViewer.getValuesAtTime` */
export interface GetValuesAtTimeArgs {
  uri?: string;
  time?: number;
  instancePaths: string[];
}

/** Arguments for `vaporview.addVariableByInstancePath` */
export interface AddVariableByPathArgs {
  instancePath: string;
}

// #region Return Types

/** Return type for `waveformViewer.getValuesAtTime` */
export interface ValuesAtTimeResult {
  instancePath: string;
  /// values like ["0", "1", "0", "1", "x"] or "0101x"
  value: string | string[];
}

/** Return type for `waveformViewer.getViewerState` */
export interface ViewerState {
  extensionVersion: string | undefined;
  fileName: string;
  markerTime: number | null;
  altMarkerTime: number | null;
  displayTimeUnit: string;
  selectedSignal: { name: string; msb: number; lsb: number } | null;
  zoomRatio: number;
  scrollLeft: number;
  displayedSignals: SavedRowItem[];
}

// #region Netlist URI

export interface DecodedNetlistUri {
  fsPath: string;
  path: string;
  scopeId?: string;
  id?: number;
}

// #region Netlist Tree Item

export interface NetlistTreeItemData {
  collapsibleState: TreeItemCollapsibleState;
  label: string;
  fsdbVarLoaded: boolean;
  resourceUri: Uri;
  type: string;
  encoding: string;
  width: number;
  signalId: number;
  netlistId: NetlistId;
  name: string;
  scopePath: string[];
  msb: number;
  lsb: number;
  scopeOffsetIdx: number;
  children: NetlistTreeItemData[];
  tooltip?: string | MarkdownString;
  contextValue?: string;
  iconPath?: string | Uri | ThemeIcon | { light: Uri; dark: Uri };
}

// #region Webview Context Types

export type DefaultWebviewContext = {
  preventDefaultContextMenuItems: boolean;
  webviewSelection: boolean;
  documentId: DocumentId;
  uri: Uri;
}

export type RulerContext = {
  webviewSection: 'ruler';
  preventDefaultContextMenuItems: boolean;
  rulerLines: boolean;
  fillBitVector: boolean;
  enableAnimations: boolean;
  fs: boolean;
  ps: boolean;
  ns: boolean;
  µs: boolean;
  ms: boolean;
  s: boolean;
}

export type SignalSeparatorContext = {
  webviewSection: 'signal-separator';
  preventDefaultContextMenuItems: boolean;
  rowId: RowId;
}

export type NetlistVariableContext = {
  webviewSection: 'signal';
  scopePath: string;
  signalName: string;
  type: string;
  width: number;
  preventDefaultContextMenuItems: boolean;
  valueLinkEnable: boolean;
  netlistId: NetlistId | undefined;
  rowId: RowId;
  isAnalog: boolean;
  enum: boolean;
}

export type CustomVariableContext = {
  webviewSection: 'signal';
  signalName: string;
  type: string;
  width: number;
  preventDefaultContextMenuItems: boolean;
  rowId: RowId;
  isAnalog: boolean;
}

export type SignalGroupContext = {
  webviewSection: 'signal-group';
  preventDefaultContextMenuItems: boolean;
  groupId: number;
  rowId: RowId;
}

// Full context menu types — VS Code merges DefaultWebviewContext (on document.body)
// with the per-element context, so extension-side handlers receive the combined type.
export type RulerWebviewContext = RulerContext & DefaultWebviewContext;
export type SignalSeparatorWebviewContext = SignalSeparatorContext & DefaultWebviewContext;
export type SignalGroupWebviewContext = SignalGroupContext & DefaultWebviewContext;
export type NetlistVariableWebviewContext = NetlistVariableContext & DefaultWebviewContext;
export type CustomVariableWebviewContext = CustomVariableContext & DefaultWebviewContext;
export type RowItemContextMenuEvent = NetlistVariableContext | CustomVariableContext | SignalGroupContext | SignalSeparatorContext;

// #region Extension API

/**
 * Async command interface for use via `vscode.commands.executeCommand`.
 * All methods return promises since they go through the command system.
 */
export interface VaporviewCommands {
  openFile(args: OpenFileArgs): Promise<void>;
  addVariable(args: VariableActionArgs): Promise<void>;
  removeVariable(args: VariableActionArgs): Promise<void>;
  revealInNetlistView(args: VariableActionArgs): Promise<void>;
  addSignalValueLink(args: VariableActionArgs): Promise<void>;
  setMarker(args: SetMarkerArgs): void;
  getOpenDocuments(): Promise<string[]>;
  getViewerState(args?: GetViewerStateArgs): Promise<ViewerState | undefined>;
  getValuesAtTime(args: GetValuesAtTimeArgs): Promise<ValuesAtTimeResult[]>;
  addVariableByInstancePath(args: AddVariableByPathArgs): Promise<void>;
}

/**
 * The public API returned by the VaporView extension's `activate()`.
 *
 * Obtain it via:
 * ```ts
 * const ext = vscode.extensions.getExtension<VaporviewApi>('Lramseyer.vaporview');
 * const api = await ext?.activate();
 * ```
 */
export interface VaporviewApi extends VaporviewCommands {
  // Events
  onDidSetMarker: Event<MarkerSetEvent>;
  onDidSelectSignal: Event<SignalEvent>;
  onDidAddVariable: Event<SignalEvent>;
  onDidRemoveVariable: Event<SignalEvent>;
  onDidClickSignalValueLink: Event<ValueLinkEvent>;
  onDidDropInWaveformViewer: Event<ViewerDropEvent>;
}
