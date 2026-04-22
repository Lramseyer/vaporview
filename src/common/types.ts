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
import type { NetlistId, SignalId, RowId, SignalSeparatorContext, SignalGroupContext, CustomVariableContext, NetlistVariableContext, ValueLinkEvent, SignalEvent, MarkerSetEvent } from '../../packages/vaporview-api/types';
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


// #region Webview Message Types
// These types define the shape of messages sent between the extension and webview via postMessage.

export type WaveformDumpMetadata = {
  timeTableLoaded: boolean;
  scopeCount: number;
  netlistIdCount: number;
  signalIdCount: number;
  timeTableCount: number;
  timeEnd: number;
  defaultZoom: number;
  timeScale: number;
  timeUnit: string;
  chunkSize: number;
};

export interface InitMessage {
  command: 'initViewport';
  documentId: string;
  uri: string;
  metadata: WaveformDumpMetadata;
  colorPalette: string[];
  errorColorPalette: string[];
  themeValid: boolean;
  autoReload: boolean;
}

// This object tracks extension settings that pertain to the webview
// Settings are registered in the following places:
// - package.json in contributes.configuration
// - extension_core/document.ts - setConfigurationSettings()
// - here - setConfigSettings()
export interface ConfigSettingsMessage {
  scrollingMode?: string;
  rulerLines?: boolean;
  fillMultiBitValues?: boolean;
  multiBitFixedHeight?: boolean;
  enableAnimations?: boolean;
  animationDuration?: number;
  overrideDevicePixelRatio?: boolean;
  userPixelRatio?: number;
  disableAnalogRendererOptimizations?: boolean;
  defaultSingleBitColor?: number;
  defaultMultiBitColor?: number;
  defaultParamColor?: number;
  defaultStringColor?: number;
  defaultEnumColor?: number;
  defaultCustomSignalColor?: number;
}

export interface ExternalKeyDownMessage {
  command: 'handle-keypress';
  keyCommand: string;
  event?: { rowId?: RowId };
}

export interface EmitEventMessage {
  command: 'emitEvent';
  eventType: 'markerSet' | 'signalSelect' | 'addVariable' | 'removeVariable' | 'valueLink';
  eventData: MarkerSetEvent | SignalEvent | ValueLinkEvent;
}

export interface AddVariableSignal {
  netlistId?: NetlistId;
  signalId?: SignalId;
  enumType?: string;
  signalName: string;
  scopePath: string[];
  signalWidth: number;
  type: string;
  encoding: string;
}

export interface SetDisplayFormatMessage {
  netlistId?: NetlistId;
  rowId?: RowId;
  index?: number;
  rowHeight?: number;
  colorIndex?: number;
  renderType?: string;
  verticalScale?: number;
  nameType?: string;
  customName?: string;
  numberFormat?: string;
  valueLinkEnable?: boolean;
  annotateValue?: string[];
}

export interface EditSignalGroupMessage {
  groupPath?: string[];
  groupId?: number;
  name?: string;
  isExpanded?: boolean;
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

export type RowItemContextMenuEvent = NetlistVariableContext | CustomVariableContext | SignalGroupContext | SignalSeparatorContext;