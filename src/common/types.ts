// Re-export shared API types from the canonical source
export type {
  DocumentId,
  NetlistId,
  SignalId,
  RowId,
  SavedRowItem,
  SavedNetlistVariable,
  SavedCustomVariable,
  SavedSignalGroup,
  SavedSignalSeparator,
  BitRangeSource,
  MarkerSetEvent,
  SignalEvent,
  ViewerDropEvent,
  DefaultWebviewContext,
  RulerContext,
  SignalSeparatorContext,
  NetlistVariableContext,
  CustomVariableContext,
  SignalGroupContext,
  SignalGroupWebviewContext,
} from '../../packages/vaporview-api/types';
export { NameType } from '../../packages/vaporview-api/types';
import type { NetlistId, SignalId, RowId } from '../../packages/vaporview-api/types';
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


export enum VariableEncoding {
  BitVector = 'BitVector',
  Real = 'Real',
  String = 'String',
  none = 'none',
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

export enum CollapseState {
  None      = 0,
  Collapsed = 1,
  Expanded  = 2,
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

