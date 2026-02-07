import { NetlistId, SignalId, RowId, EnumData, EnumEntry, QueueEntry, SignalQueueEntry, EnumQueueEntry, NameType } from '../common/types';
import { EventHandler, viewerState, ActionType, vscode, viewport, sendWebviewContext, DataType, dataManager, updateDisplayedSignalsFlat, getChildrenByGroupId, getParentGroupId, labelsPanel, outputLog, getIndexInGroup, CollapseState, controlBar, rowHandler, events } from './vaporview';
import { getNumberFormatById, ValueFormat } from './value_format';
import { WaveformRenderer, MultiBitWaveformRenderer, BinaryWaveformRenderer, LinearWaveformRenderer } from './renderer';
import { SignalGroup, NetlistVariable, RowItem, SignalSeparator, isAnalogSignal, CustomVariable } from './signal_item';


// @ts-ignore
import * as LZ4 from 'lz4js';

export type FormattedValueData = {
  users: number;
  formatCached: boolean;
  values: string[];
};

export interface WaveformData {
  valueChangeData: any[];
  formattedValues: Record<string, FormattedValueData>;
  signalWidth: number;
  min: number;
  max: number;
};

export type BitRangeSource = {
  netlistId: NetlistId;
  signalId: SignalId;
  msb: number;
  lsb: number;
}

export interface CustomWaveformData extends WaveformData {
  valueChangeData: any[];
  formattedValues: Record<string, FormattedValueData>;
  signalWidth: number;
  min: number;
  max: number;
  source: BitRangeSource[];
};

export class WaveformDataManager {
  private events: EventHandler;
  requested: QueueEntry[] = [];
  queued:    QueueEntry[] = [];
  requestActive: boolean = false;
  requestStart: number = 0;

  valueChangeData: WaveformData[]     = []; // signalId is the key/index, WaveformData is the value
  valueChangeDataTemp: any            = [];
  customValueChangeData: CustomWaveformData[] = [];
  enumTable: Record<string, EnumData> = {}; // enum type is the key/index, array of enum values is the value
  enumTableTemp: any                  = {}
  customColorKey: string[]            = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];

  private nextCustomSignalId: number = 0;

  waveDromClock = {
    netlistId: null,
    edge: '1',
  };

  constructor(events: EventHandler) {

    this.events = events;
    this.handleExitBatchMode = this.handleExitBatchMode.bind(this);

    this.events.subscribe(ActionType.ExitBatchMode, this.handleExitBatchMode);
  }

  handleExitBatchMode() {this.fetch();}

  unload() {
    this.valueChangeData     = [];
    this.valueChangeDataTemp = [];
    this.enumTable           = {};
    this.enumTableTemp       = {};
    this.waveDromClock       = {netlistId: null, edge: ""};

    this.requested           = [];
    this.queued              = [];
    this.requestActive       = false;
    this.requestStart        = 0;
    rowHandler.unload();
  }

  // This is a simple queue to handle the fetching of waveform data
  // It's overkill for everything except large FST waveform dumps with lots of
  // Value Change Blocks. Batch fetching is much faster than individual fetches,
  // so this queue will ensure that fetches are grouped while waiting for any
  // previous fetches to complete.
  requestData(signalIdList: SignalId[], enumList: EnumQueueEntry[]) {
    const signalList = signalIdList.map(id => ({type: 'signal', id} as SignalQueueEntry));
    this.queued      = this.queued.concat(enumList, signalList);
    this.fetch();
  }

  receiveSignal(signalId: SignalId) {
    this.requested = this.requested.filter(entry => {
      return !(entry.type === 'signal' && entry.id === signalId);
    });
    if (this.requested.length === 0) {
      this.requestActive = false;
      this.fetch();
    }
  }

  private fetch() {
    if (events.isBatchMode) {return;}
    if (this.requestActive) {return;}
    if (this.queued.length === 0) {return;}

    this.requestActive = true;
    this.requestStart  = Date.now();
    this.requested     = this.queued;
    this.queued        = [];

    vscode.postMessage({
      command: 'fetchDataFromFile',
      requestList: this.requested,
    });

    // Prevent Enum requests from holding up signal requests, since enums are cached along with the netlist hierarchy
    this.requested = this.requested.filter(entry => entry.type === 'signal');
  }

  isRequested(signalId: SignalId): boolean {
    let isRequested = false;
    this.requested.forEach(entry => {
      if (entry.type === 'signal' && entry.id === signalId) {isRequested = true;}
    });
    this.queued.forEach(entry => {
      if (entry.type === 'signal' && entry.id === signalId) {isRequested = true;}
    });
    return isRequested;
  }

  updateWaveformChunk(message: any) {

    const signalId = message.signalId;
    if (this.valueChangeDataTemp[signalId].totalChunks === 0) {
      this.valueChangeDataTemp[signalId].totalChunks = message.totalChunks;
      this.valueChangeDataTemp[signalId].chunkLoaded = new Array(message.totalChunks).fill(false);
      this.valueChangeDataTemp[signalId].chunkData   = new Array(message.totalChunks).fill("");
    }

    this.valueChangeDataTemp[signalId].chunkData[message.chunkNum]   = message.transitionDataChunk;
    this.valueChangeDataTemp[signalId].chunkLoaded[message.chunkNum] = true;
    const allChunksLoaded = this.valueChangeDataTemp[signalId].chunkLoaded.every((chunk: any) => {return chunk;});

    if (!allChunksLoaded) {return;}

    //console.log('all chunks loaded');

    this.receiveSignal(signalId);

    // const transitionData = JSON.parse(this.valueChangeDataTemp[signalId].chunkData.join(""));
    const chunkData = this.valueChangeDataTemp[signalId].chunkData;
    const firstChunk = chunkData?.[0];
    let transitionData: any;
    if (typeof firstChunk === "string") {
      transitionData = JSON.parse(chunkData.join(""));
    } else if (Array.isArray(firstChunk)) { // We're receiving array from fsdb worker
      transitionData = chunkData.flat();
    }

    if (!this.requestActive) {
      outputLog("Request complete, time: " + (Date.now() - this.requestStart) / 1000 + " seconds");
      this.requestStart = 0;
    }

    this.updateWaveform(signalId, transitionData, message.min, message.max);
  }

  updateEnumChunk(message: any) {

    const enumName = message.enumName;
    if (this.enumTableTemp[enumName] === undefined || this.enumTableTemp[enumName].totalChunks === 0) {
      this.enumTableTemp[enumName] = {
        totalChunks: message.totalChunks,
        chunkLoaded: new Array(message.totalChunks).fill(false),
        chunkData:   new Array(message.totalChunks).fill(""),
      };
    }

    this.enumTableTemp[enumName].chunkData[message.chunkNum]   = message.enumDataChunk;
    this.enumTableTemp[enumName].chunkLoaded[message.chunkNum] = true;
    const allChunksLoaded = this.enumTableTemp[enumName].chunkLoaded.every((chunk: any) => {return chunk;});

    if (!allChunksLoaded) {return;}

    const enumData = JSON.parse(this.enumTableTemp[enumName].chunkData.join(""));

    if (!this.requestActive) {
      outputLog("Enum Request time: " + (Date.now() - this.requestStart) / 1000 + " seconds");
    }

    this.updateEnum(enumName, enumData);
  }

  updateWaveformChunkCompressed(message: any) {
    const signalId = message.signalId;
    
    if (this.valueChangeDataTemp[signalId].totalChunks === 0) {
      this.valueChangeDataTemp[signalId].totalChunks = message.totalChunks;
      this.valueChangeDataTemp[signalId].chunkLoaded = new Array(message.totalChunks).fill(false);
      this.valueChangeDataTemp[signalId].compressedChunks = new Array(message.totalChunks);
      this.valueChangeDataTemp[signalId].originalSize = message.originalSize;
    }

    // Store the compressed chunk as Uint8Array
    this.valueChangeDataTemp[signalId].compressedChunks[message.chunkNum] = new Uint8Array(message.compressedDataChunk);
    this.valueChangeDataTemp[signalId].chunkLoaded[message.chunkNum] = true;
    const allChunksLoaded = this.valueChangeDataTemp[signalId].chunkLoaded.every((chunk: any) => {return chunk;});

    if (!allChunksLoaded) {return;}

    //console.log('all compressed chunks loaded');

    this.receiveSignal(signalId);

    try {
      // Concatenate all compressed chunks
      const totalCompressedSize = this.valueChangeDataTemp[signalId].compressedChunks.reduce((total: number, chunk: Uint8Array) => total + chunk.length, 0);
      const fullCompressedData = new Uint8Array(totalCompressedSize);
      let offset = 0;
      
      for (const chunk of this.valueChangeDataTemp[signalId].compressedChunks) {
        fullCompressedData.set(chunk, offset);
        offset += chunk.length;
      }

      // Decompress the LZ4 frame data (size is included in frame header)
      const originalSize = this.valueChangeDataTemp[signalId].originalSize;
      const decompressedData = LZ4.decompress(fullCompressedData);
      const byteIncrement = 8 + message.signalWidth;
      let time = 0;
      let transitionData: any[] = [];
      
      // Create DataView once from the entire decompressed data
      const dataView = new DataView(decompressedData.buffer, decompressedData.byteOffset, decompressedData.byteLength);
      
      for (let i = 0; i < decompressedData.length; i += byteIncrement) {
        const j = i + 8;
        // Read u64 directly from the DataView at offset i
        const deltaTime = dataView.getBigUint64(i, true);
        const value = String.fromCharCode(...decompressedData.slice(j, j + message.signalWidth));
        time += Number(deltaTime);
        transitionData.push([time, value]);
      }

      if (!this.requestActive) {
        outputLog("Compressed request complete, time: " + (Date.now() - this.requestStart) / 1000 + " seconds");
        this.requestStart = 0;
      }

      this.updateWaveform(signalId, transitionData, message.min, message.max);

    } catch (error) {
      console.error('Failed to decompress waveform data for signal', signalId + ':', error);
      console.error('Compressed data size:', this.valueChangeDataTemp[signalId].compressedChunks?.length, 'chunks');
      console.error('Expected original size:', this.valueChangeDataTemp[signalId].originalSize);
      
      // Clean up the failed attempt
      this.valueChangeDataTemp[signalId] = undefined;
      
      // Could potentially request the data again using the fallback method here
      // For now, just log the error and let the user know something went wrong
      console.error('Signal data loading failed for signal ID', signalId, '- you may need to reload the file');
    }
  }

  updateWaveform(signalId: SignalId, valueChangeData: any[], min: number, max: number) {
    const rowIdList    = this.valueChangeDataTemp[signalId].rowIdList;
    if (rowIdList ===  undefined) {console.log('rowId not found for signalId ' + signalId); return;}
    const netlistData  = rowHandler.rowItems[rowIdList[0]];
    if (netlistData === undefined || netlistData instanceof NetlistVariable === false) {return;}
    const signalWidth  = netlistData.signalWidth;
    const nullValue = "x".repeat(signalWidth);
    if (valueChangeData[0][0] !== 0) {
      valueChangeData.unshift([0, nullValue]);
    }
    if (valueChangeData[valueChangeData.length - 1][0] !== viewport.timeStop) {
      valueChangeData.push([viewport.timeStop, nullValue]);
    }
    this.valueChangeData[signalId] = {
      valueChangeData: valueChangeData,
      formattedValues: {},
      signalWidth:    signalWidth,
      min:            min,
      max:            max,
    };

    this.valueChangeDataTemp[signalId] = undefined;

    rowIdList.forEach((rowId: RowId) => {
      const netlistData = rowHandler.rowItems[rowId];
      if (netlistData === undefined || netlistData instanceof NetlistVariable === false) {return;}
      labelsPanel.valueAtMarker[rowId] = netlistData.getValueAtTime(viewerState.markerTime);
      events.dispatch(ActionType.RedrawVariable, rowId);
      if (netlistData.encoding === "Real") {
        netlistData.min = min;
        netlistData.max = max;
      }
      const data = this.valueChangeData[netlistData.signalId];
      if (data === undefined) {return;}
      rowHandler.setValueFormat(data, netlistData.valueFormat, false);
    });
  }

  createCustomSignalData(source: BitRangeSource) {
    const result: any[] = [];
    const signalId = source.signalId;
    if (this.valueChangeData[signalId] === undefined) {
      return undefined;
    }
    const signalWidth = this.valueChangeData[signalId].signalWidth;
    const valueChangeData = this.valueChangeData[signalId].valueChangeData;
    let sliceStart = signalWidth - source.msb - 1;
    let sliceEnd = signalWidth - source.lsb;
    let nullValue   = "";
    if (sliceStart < 0) {
      nullValue = "x".repeat(-sliceStart);
      sliceStart = 0;
    }
    if (valueChangeData === undefined) {
      return undefined;
    }
    let previousValue = nullValue;
    valueChangeData.forEach((valueChange) => {
      const time = valueChange[0];
      const value = nullValue + valueChange[1].slice(sliceStart, sliceEnd);
      if (value !== previousValue) {
        result.push([time, value]);
        previousValue = value;
      }
    });
    return result;
  }

  createCustomSignal(source: BitRangeSource[]) {
    // check custom signal with the same source
    for (let customSignalId = 0; customSignalId < this.customValueChangeData.length; customSignalId++) {
      const customSignal = this.customValueChangeData[customSignalId];
      if (customSignal.source.length !== source.length) {continue;}
      for (let i = 0; i < customSignal.source.length; i++) {
        if (customSignal.source[i].signalId === source[i].signalId && 
            customSignal.source[i].msb === source[i].msb && 
            customSignal.source[i].lsb === source[i].lsb) {
          console.log('custom signal found', customSignalId);
          return customSignalId;
        }
      }
    }

    // create new custom signal
    let signalWidth = 0;
    let signalIdList: SignalId[] = [];
    source.forEach((s) => {
      signalWidth += s.msb - s.lsb + 1;
      if (this.valueChangeData[s.signalId] === undefined) {
        signalIdList.push(s.signalId);
      }
    });
    this.requestData(signalIdList, []);
    const customSignalId = this.nextCustomSignalId;
    this.nextCustomSignalId++;

    const valueChangeData = this.createCustomSignalData(source[0]);
    if (valueChangeData === undefined) {return;}

    this.customValueChangeData.push({
      source: source,
      valueChangeData: valueChangeData,
      formattedValues: {},
      signalWidth: signalWidth,
      min: 0,
      max: 0,
    });
    return customSignalId;
  }

  updateEnum(enumName: string, enumData: EnumEntry[]) {
    this.enumTable[enumName] = enumData;
    this.enumTableTemp[enumName] = undefined;

    viewerState.displayedSignalsFlat.forEach((rowId) => {
      const netlistData = rowHandler.rowItems[rowId];
      if (netlistData instanceof NetlistVariable === false) {return;}
      if (netlistData.enumType !== enumName) {return;}
      const data = this.valueChangeData[netlistData.signalId];
      if (data === undefined) {return;}
      rowHandler.setValueFormat(data, netlistData.valueFormat, true);
      events.dispatch(ActionType.RedrawVariable, rowId);
    });
  }

  public garbageCollectValueFormats() {
    // zero out all users
    this.valueChangeData.forEach((data) => {
      Object.values(data.formattedValues).forEach((formatData) => {
        formatData.users = 0;
      });
    });

    // count users again
    viewerState.displayedSignalsFlat.forEach((rowId) => {
      const netlistData = rowHandler.rowItems[rowId];
      if (netlistData instanceof NetlistVariable === false) {return;}
      const signalId = netlistData.signalId;
      const valueFormat = netlistData.valueFormat;
      const data = this.valueChangeData[signalId];
      if (data === undefined) {return;}
      const formatData = data.formattedValues[valueFormat.id];
      if (formatData === undefined) {return;}
      formatData.users++;
    });

    // delete unused formats
    this.valueChangeData.forEach((data) => {
      Object.entries(data.formattedValues).forEach(([key, formatData]) => {
        if (formatData.users <= 0) {
          delete data.formattedValues[Number(key)];
        }
      });
    });
  }

  // binary searches for a value in an array. Will return the index of the value if it exists, or the lower bound if it doesn't
  binarySearch(array: any[], target: number) {
    let low  = 0;
    let high = array.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (array[mid][0] < target) {low = mid + 1;}
      else {high = mid;}
    }
    return low;
  }

  binarySearchTime(array: any[], target: number) {
    let low  = 0;
    let high = array.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (array[mid] < target) {low = mid + 1;}
      else {high = mid;}
    }
    return low;
  }

  getTransitionCount(): number | null {
    let result = null;
    if (viewerState.selectedSignal.length !== 1) {return result;}
    if (viewerState.markerTime === null || viewerState.altMarkerTime === null) {return result;}
    const rowId = viewerState.selectedSignal[0];
    const netlistData = rowHandler.rowItems[rowId];
    if (netlistData instanceof NetlistVariable === false) {return result;}
    const signalId = netlistData.signalId;
    if (this.valueChangeData[signalId] === undefined) {return result;}
    const vcData = this.valueChangeData[signalId].valueChangeData;
    if (vcData === undefined || vcData.length === 0) {return result;}

    const startTime = Math.min(viewerState.markerTime, viewerState.altMarkerTime);
    const endTime   = Math.max(viewerState.markerTime, viewerState.altMarkerTime);
    let startIndex = this.binarySearch(vcData, startTime);
    let endIndex   = this.binarySearch(vcData, endTime);
    let additional = 0;

    if (vcData[endIndex][0] === endTime) {additional = 1;}
    while (vcData[startIndex][0] < startTime && vcData[startIndex][0] < endTime) {
      startIndex++;
    }
    while (vcData[endIndex][0] < endTime && endIndex < vcData.length) {
      endIndex++;
    }

    const r = Math.max(0, (endIndex - startIndex) + additional);
    return r;
  }

  public getValueAtTime(data: WaveformData, time: number | null) {

    const result: string[] = [];

    if (time === null) {return result;}
    if (!data) {return result;}

    const valueChangeData  = data.valueChangeData;
    const transitionIndex = this.getNearestTransitionIndex(data, time);

    if (transitionIndex === -1) {return result;}
    if (transitionIndex > 0) {
      result.push(valueChangeData[transitionIndex - 1][1]);
    }
  
    if (valueChangeData[transitionIndex][0] === time) {
      result.push(valueChangeData[transitionIndex][1]);
    }
  
    return result;
  }

  public getNextEdge(data: WaveformData, time: number, direction: number, valueList: string[]): number | null {
    if (!data) {return null;}
    const valueChangeData  = data.valueChangeData;
    const valueChangeIndex = this.getNearestTransitionIndex(data, time);
    let nextEdge           = null;

    if (valueChangeIndex === -1) {return null;}

    const anyEdge = valueList.length === 0;
    if (direction === 1) {
      for (let i = valueChangeIndex; i < valueChangeData.length; i++) {
        const valueMatch = anyEdge || valueList.includes(valueChangeData[i][1]);
        if (valueMatch && valueChangeData[i][0] > time) {
          nextEdge = valueChangeData[i][0];
          break;
        }
      }
    } else {
      for (let i = valueChangeIndex; i >= 0; i--) {
        const valueMatch = anyEdge || valueList.includes(valueChangeData[i][1]);
        if (valueMatch && valueChangeData[i][0] < time) {
          nextEdge = valueChangeData[i][0];
          break;
        }
      }
    }

    return nextEdge;
  }

  public getAllEdges(valueList: string[], data: WaveformData, signalWidth: number): number[] {

    if (!data) {return [];}
    const valueChangeData  = data.valueChangeData;
    const result: number[] = [];

    if (valueList.length > 0) {
      if (signalWidth === 1) {
        valueChangeData.forEach((valueChange) => {
          valueList.forEach((value) => {
            if (valueChange[1] === value) {
              result.push(valueChange[0]);
            }
          });
        });
      } else {
        valueChangeData.forEach(([time, _value]) => {result.push(time);});
      }
    }
    return result;
  }

  public getNearestTransition(waveforms: WaveformData, time: number | null) {

    const result = null;

    if (time === null) {return result;}
    if (!waveforms) {return result;}

    const data   = waveforms.valueChangeData;
    const index  = this.getNearestTransitionIndex(waveforms, time);

    if (index === -1) {return result;}
    if (data[index][0] === time) {
      return data[index];
    }
  
    const timeBefore = time - data[index - 1][0];
    const timeAfter  = data[index][0] - time;
  
    if (timeBefore < timeAfter) {
      return data[index - 1];
    } else {
      return data[index];
    }
  }

  getNearestTransitionIndex(waveforms: WaveformData, time: number) {

    if (time === null) {return -1;}
  
    const data            = waveforms.valueChangeData;
    const transitionIndex = this.binarySearch(data, time);
  
    if (transitionIndex >= data.length) {
      return -1;
    }
  
    return transitionIndex;
  }
}
