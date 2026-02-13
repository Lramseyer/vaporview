import type * as vscode from 'vscode';

export type DocumentId  = string;
export type NetlistId   = number;
export type SignalId    = number;
export type RowId       = number;
export type ValueChange = [number, string];
export type EnumEntry   = [string, string];
export type EnumData    = EnumEntry[];
export type QueueEntry  = SignalQueueEntry | EnumQueueEntry;

export type SignalQueueEntry = {
  type: 'signal';
  signalWidth: number;
  signalId: SignalId;
  rowId?: RowId;
  customSignalId?: number;
};

export type EnumQueueEntry = {
  type: 'enum';
  name: string;
  netlistId: NetlistId;
};

export interface markerSetEvent {
  uri: string;
  time: number;
  units: string;
}

export interface signalEvent {
  uri: string;
  instancePath: string;
  netlistId: NetlistId;
  source: string; // "viewer" or "treeView"
}

export interface viewerDropEvent {
  uri: string;
  resourceUriList: vscode.Uri[];
  groupPath: string[];
  index: number;
}

export enum VariableEncoding {
  BitVector = 'BitVector',
  Real = 'Real',
  String = 'String',
  none = 'none',
}

export enum NameType {
  fullPath = 'fullPath',
  signalName = 'signalName',
  custom = 'custom',
}

export enum WindowMessageType {
  Warning = 'warning',
  Error   = 'error',
  Info    = 'info',
}

export enum StateChangeType {
  None    = 0,
  Restore = 1,
  File    = 2,
  Undo    = 3,
  Redo    = 4,
  User    = 5,
}

// Save file schema

export type SavedRowItem = SavedNetlistVariable | SavedSignalGroup | SavedSignalSeparator | SavedCustomVariable;

export type SavedNetlistVariable = {
  dataType: 'netlist-variable';
  netlistId: NetlistId;
  name: string;
  numberFormat: string;
  colorIndex: number;
  rowHeight: number;
  verticalScale: number;
  nameType: NameType;
  customName: string;
  renderType: string;
  valueLinkCommand: string;
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
  valueLinkCommand: string;
  source: BitRangeSource[];
};

export enum CollapseState {
  None      = 0,
  Collapsed = 1,
  Expanded  = 2,
}

export type BitRangeSource = {
  name: string;
  netlistId: NetlistId;
  signalId: SignalId;
  signalWidth: number;
  msb: number;
  lsb: number;
};

export type SavedSignalGroup = {
  dataType: 'signal-group';
  groupName: string;
  collapseState: CollapseState;
  children: SavedRowItem[];
}

export type SavedSignalSeparator = {
  dataType: 'signal-separator';
  label: string;
  rowHeight: number;
}

// Webview Value Change Data Structure

export type EnumDataChunk = {
  command: 'update-enum-chunk';
  enumName: string;
  enumDataChunk: string;
  totalChunks: number;
  chunkNum: number;
};

export type ValueChangeDataChunk = {
  command: 'update-waveform-chunk';
  signalId: SignalId;
  transitionDataChunk: string | ValueChange[]; // note that the string should parse to an array of ValueChange objects
  totalChunks: number;
  chunkNum: number;
  min: number;
  max: number;
};

export type CompressedValueChangeDataChunk = {
  command: 'update-waveform-chunk-compressed';
  signalId: SignalId;
  signalWidth: number;
  compressedDataChunk: number[];
  totalChunks: number;
  chunkNum: number;
  min: number;
  max: number;
  originalSize: number;
};

// Webview Context

export type DefaultWebviewContext = {
  preventDefaultContextMenuItems: boolean;
  webviewSelection: boolean;
  documentId: DocumentId;
  uri: string;
}

export type RulerContext = {
  webviewSection: 'ruler';
  preventDefaultContextMenuItems: boolean;
  rulerLines: boolean;
  fillBitVector: boolean;
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
  webviewSection: "signal",
  scopePath: string;
  signalName: string;
  type: string;
  width: number;
  preventDefaultContextMenuItems: boolean;
  commandValid: boolean;
  netlistId: NetlistId;
  rowId: RowId;
  isAnalog: boolean;
  enum: boolean;
}

export type CustomVariableContext = {
  webviewSection: "signal";
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

export type RulerContextMenuEvent = RulerContext & DefaultWebviewContext;
export type SignalSeparatorContextMenuEvent = SignalSeparatorContext & DefaultWebviewContext;
export type SignalGroupContextMenuEvent = SignalGroupContext & DefaultWebviewContext;
export type NetlistVariableContextMenuEvent = NetlistVariableContext & DefaultWebviewContext;
export type CustomVariableContextMenuEvent = CustomVariableContext & DefaultWebviewContext;
export type RowItemContextMenuEvent = NetlistVariableContext | CustomVariableContext | SignalGroupContext | SignalSeparatorContext;