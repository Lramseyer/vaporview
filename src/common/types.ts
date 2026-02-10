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
  id: SignalId;
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

export enum NameType {
  fullPath = 'fullPath',
  signalName = 'signalName',
  custom = 'custom',
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

export enum CollapseState {
  None      = 0,
  Collapsed = 1,
  Expanded  = 2,
}

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

export type SavedCustomVariable = {

}