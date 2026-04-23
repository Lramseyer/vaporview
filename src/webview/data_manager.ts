import { type NetlistId, type SignalId, type RowId, type ValueChange, type EnumData, type EnumEntry, type QueueEntry, type SignalQueueEntry, type EnumQueueEntry, NameType, CollapseState, type BitRangeSource, type ValueChangeDataChunk, type CompressedValueChangeDataChunk, type EnumDataChunk } from '../common/types';
import { ActionType, type EventHandler } from './event_handler';
import { viewerState, viewport, DataType, dataManager, updateDisplayedSignalsFlat, getChildrenByGroupId, getParentGroupId, labelsPanel, getIndexInGroup, controlBar, rowHandler, events, vscodeWrapper } from './vaporview';
import { SignalGroup, NetlistVariable, RowItem, SignalSeparator, isAnalogSignal, CustomVariable } from './signal_item';

import * as LZ4 from 'lz4js';

export type FormattedValueData = {
  users: number;
  formatCached: boolean;
  values: string[];
};

export interface WaveformData {
  valueChangeData: ValueChange[];
  formattedValues: Record<string, FormattedValueData>;
  signalWidth: number;
  min: number;
  max: number;
}

export class TempWaveformData {
  constructor(public signalWidth: number) {}
  totalChunks: number = 0;
  chunkLoaded: boolean[] = [];
  chunkData: (string | ValueChange[])[] = [];
  rowIdList: RowId[] = [];
  customSignalIdList: number[] = [];
  compressedChunks: Uint8Array[] = [];
  originalSize: number = 0;
}

export interface CustomWaveformData extends WaveformData {
  valueChangeData: ValueChange[];
  formattedValues: Record<string, FormattedValueData>;
  signalWidth: number;
  min: number;
  max: number;
  source: BitRangeSource[];
  dataLoaded: boolean;
}

export class WaveformDataManager {
  private events: EventHandler;
  requested: QueueEntry[] = [];
  queued:    QueueEntry[] = [];
  requestActive: boolean = false;
  requestStart: number = 0;

  valueChangeData: WaveformData[]         = []; // signalId is the key/index, WaveformData is the value
  valueChangeDataTemp: TempWaveformData[] = [];
  customValueChangeData: CustomWaveformData[] = [];
  enumTable: Record<string, EnumData> = {}; // enum type is the key/index, array of enum values is the value
  enumTableTemp: Record<string, { totalChunks: number; chunkLoaded: boolean[]; chunkData: string[] } | undefined> = {};

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
  requestData(signalIdList: SignalQueueEntry[], enumList: EnumQueueEntry[]) {
    signalIdList.forEach(entry => {
      const signalId = entry.signalId;
      let tempData = this.valueChangeDataTemp[signalId];
      if (tempData === undefined) {
        tempData = new TempWaveformData(entry.signalWidth);
      }
      if (entry.rowId !== undefined) {
        tempData.rowIdList.push(entry.rowId);
      }
      if (entry.customSignalId !== undefined) {
        tempData.customSignalIdList.push(entry.customSignalId);
      }
      this.valueChangeDataTemp[signalId] = tempData;
    });
    this.queued = this.queued.concat(enumList, signalIdList);
    this.fetch();
  }

  receiveSignal(signalId: SignalId) {
    this.requested = this.requested.filter(entry => {
      return !(entry.type === 'signal' && entry.signalId === signalId);
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

    vscodeWrapper.fetchData(this.requested);

    // Prevent Enum requests from holding up signal requests, since enums are cached along with the netlist hierarchy
    this.requested = this.requested.filter(entry => entry.type === 'signal');
  }

  clearTempWaveformData(signalId: SignalId) {
    this.valueChangeDataTemp[signalId] = {
      signalWidth: 0,
      totalChunks: 0,
      chunkLoaded: [],
      chunkData: [],
      rowIdList: [],
      customSignalIdList: [],
      compressedChunks: [],
      originalSize: 0,
    };
  }

  updateWaveformChunk(message: ValueChangeDataChunk) {

    const signalId = message.signalId;
    if (this.valueChangeDataTemp[signalId].totalChunks === 0) {
      this.valueChangeDataTemp[signalId].totalChunks = message.totalChunks;
      this.valueChangeDataTemp[signalId].chunkLoaded = new Array(message.totalChunks).fill(false);
      this.valueChangeDataTemp[signalId].chunkData   = new Array(message.totalChunks).fill("");
    }

    this.valueChangeDataTemp[signalId].chunkData[message.chunkNum]   = message.transitionDataChunk;
    this.valueChangeDataTemp[signalId].chunkLoaded[message.chunkNum] = true;
    const allChunksLoaded = this.valueChangeDataTemp[signalId].chunkLoaded.every((chunk: boolean) => {return chunk;});

    if (!allChunksLoaded) {return;}

    //console.log('all chunks loaded');

    this.receiveSignal(signalId);

    // const transitionData = JSON.parse(this.valueChangeDataTemp[signalId].chunkData.join(""));
    const chunkData = this.valueChangeDataTemp[signalId].chunkData;
    const firstChunk = chunkData?.[0];
    let transitionData: ValueChange[];
    if (typeof firstChunk === "string") {
      transitionData = JSON.parse((chunkData as string[]).join(""));
    } else if (Array.isArray(firstChunk)) { // We're receiving array from fsdb worker
      transitionData = (chunkData as ValueChange[][]).flat();
    } else {
      return;
    }

    if (!this.requestActive) {
      vscodeWrapper.outputLog("Request complete, time: " + (Date.now() - this.requestStart) / 1000 + " seconds");
      this.requestStart = 0;
    }

    this.updateWaveform(signalId, transitionData, message.min, message.max);
  }

  updateEnumChunk(message: EnumDataChunk) {

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
    const allChunksLoaded = this.enumTableTemp[enumName].chunkLoaded.every((chunk: boolean) => {return chunk;});

    if (!allChunksLoaded) {return;}

    const enumData = JSON.parse(this.enumTableTemp[enumName].chunkData.join(""));

    if (!this.requestActive) {
      vscodeWrapper.outputLog("Enum Request time: " + (Date.now() - this.requestStart) / 1000 + " seconds");
    }

    this.updateEnum(enumName, enumData);
  }

  updateWaveformChunkCompressed(message: CompressedValueChangeDataChunk) {
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
    const allChunksLoaded = this.valueChangeDataTemp[signalId].chunkLoaded.every((chunk: boolean) => {return chunk;});

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
      const transitionData: ValueChange[] = [];
      
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
        vscodeWrapper.outputLog("Compressed request complete, time: " + (Date.now() - this.requestStart) / 1000 + " seconds");
        this.requestStart = 0;
      }

      this.updateWaveform(signalId, transitionData, message.min, message.max);

    } catch (error) {
      console.error('Failed to decompress waveform data for signal', signalId + ':', error);
      console.error('Compressed data size:', this.valueChangeDataTemp[signalId].compressedChunks?.length, 'chunks');
      console.error('Expected original size:', this.valueChangeDataTemp[signalId].originalSize);
      // Could potentially request the data again using the fallback method here
      // For now, just log the error and let the user know something went wrong
      console.error('Signal data loading failed for signal ID', signalId, '- you may need to reload the file');
    }

    this.clearTempWaveformData(signalId);
  }

  updateWaveform(signalId: SignalId, valueChangeData: ValueChange[], min: number, max: number) {

    const rowIdList    = this.valueChangeDataTemp[signalId].rowIdList;
    const customSignalIdList = this.valueChangeDataTemp[signalId].customSignalIdList;
    const signalWidth = this.valueChangeDataTemp[signalId].signalWidth;

    const nullValue = "x".repeat(signalWidth);
    if (valueChangeData[0][0] !== 0) {
      valueChangeData.unshift([0, nullValue]);
    }

    this.valueChangeData[signalId] = {
      valueChangeData: valueChangeData,
      formattedValues: {},
      signalWidth:    signalWidth,
      min:            min,
      max:            max,
    };

    customSignalIdList.forEach((customSignalId: number) => {
      this.updateCustomSignal(customSignalId);
    });

    this.clearTempWaveformData(signalId);

    if (rowIdList ===  undefined) {console.log('rowId not found for signalId ' + signalId); return;}

    rowIdList.forEach((rowId: RowId) => {
      const netlistData = rowHandler.rowItems[rowId];
      if (!(netlistData instanceof NetlistVariable) && !(netlistData instanceof CustomVariable)) {return;}
      labelsPanel.valueAtMarker[rowId] = netlistData.getValueAtTime(viewerState.markerTime);
      events.redrawVariable(rowId);
      if (netlistData.encoding === "Real") {
        netlistData.min = min;
        netlistData.max = max;
      }
      const data = netlistData.getWaveformData();
      rowHandler.setValueFormat(data, netlistData.valueFormat, false);
    });
  }

  newCustomSignal(source: BitRangeSource[]): number | undefined {
    if (source.some((s) => s.signalId === undefined || s.netlistId === undefined)) {
      return undefined;
    }
    for (let customSignalId = 0; customSignalId < this.customValueChangeData.length; customSignalId++) {
      const customSignal = this.customValueChangeData[customSignalId];
      if (customSignal.source.length !== source.length) {continue;}
      for (let i = 0; i < customSignal.source.length; i++) {
        if (customSignal.source[i].signalId === source[i].signalId && 
            customSignal.source[i].msb === source[i].msb && 
            customSignal.source[i].lsb === source[i].lsb) {
          //console.log('custom signal found', customSignalId);
          return customSignalId;
        }
      }
    }

    //console.log('new custom signal', source);
    const customSignalId = this.nextCustomSignalId;
    this.nextCustomSignalId++;
    const customSignal: CustomWaveformData = {
      source: source,
      dataLoaded: false,
      valueChangeData: [],
      formattedValues: {},
      signalWidth: 0,
      min: 0,
      max: 0,
    };
    this.customValueChangeData[customSignalId] = customSignal;
    return customSignalId;
  }

  updateCustomSignal(customSignalId: number): void {
    const data = this.customValueChangeData[customSignalId];
    if (data === undefined) {return;}

    const source = data.source;

    // Only assemble once ALL sources have their data loaded.
    // Note: data requests are always made by the caller (addCustomVariable /
    // addMergedVariable), never from here, to avoid duplicate requests.
    const allLoaded = source.every(s => s.signalId === undefined || this.valueChangeData[s.signalId] !== undefined);
    if (!allLoaded) {return;}

    let signalWidth = 0;
    source.forEach((s) => {
      if (s.signalId === undefined) {return;}
      signalWidth += s.msb - s.lsb + 1;
    });

    const valueChangeData = this.createCustomSignalData(source);
    if (valueChangeData === undefined) {return;}
    data.valueChangeData = valueChangeData;
    data.signalWidth = signalWidth;
    // Clear stale formatted-value caches so they are recomputed with the
    // newly assembled data instead of the empty placeholder.
    data.formattedValues = {};
    data.dataLoaded = true;
  }

  createCustomSignalData(sources: BitRangeSource[]): ValueChange[] | undefined {
    if (sources.length === 1) {
      return this.createSingleSourceData(sources[0]);
    }
    return this.createMultiSourceData(sources);
  }

  private createSingleSourceData(source: BitRangeSource): ValueChange[] | undefined {
    const result: ValueChange[] = [];
    const signalId = source.signalId;
    if (signalId === undefined) {return undefined;}
    if (this.valueChangeData[signalId] === undefined) {
      return undefined;
    }
    const signalWidth = this.valueChangeData[signalId].signalWidth;
    const valueChangeData = this.valueChangeData[signalId].valueChangeData;
    const upperBit = Math.max(source.msb, source.lsb);
    const lowerBit = Math.min(source.msb, source.lsb);
    const reverse  = source.msb < source.lsb;
    let sliceStart = signalWidth - upperBit - 1;
    const sliceEnd = signalWidth - lowerBit;
    let nullValue  = "";
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
      let value  = nullValue + valueChange[1].slice(sliceStart, sliceEnd);
      if (reverse) {
        value = value.split("").reverse().join("");
      }
      if (value !== previousValue) {
        result.push([time, value]);
        previousValue = value;
      }
    });
    return result;
  }

  private createMultiSourceData(sources: BitRangeSource[]): ValueChange[] | undefined {
    // Extract per-source value change arrays
    const sourceDatas: ValueChange[][] = [];
    for (const source of sources) {
      const extracted = this.createSingleSourceData(source);
      if (extracted === undefined) {return undefined;}
      sourceDatas.push(extracted);
    }

    const n = sourceDatas.length;
    const pointers = new Array<number>(n).fill(0);
    const currentValues = new Array<string>(n).fill('x');
    const result: ValueChange[] = [];
    let prevCombined = '';
    let minTime = 0;

    while (minTime < Infinity) {
      // Find the minimum timestamp among all active pointers
      minTime = Infinity;
      for (let i = 0; i < n; i++) {
        if (pointers[i] < sourceDatas[i].length) {
          const t = sourceDatas[i][pointers[i]][0];
          if (t < minTime) {minTime = t;}
        }
      }
      if (minTime === Infinity) {break;}

      // Advance all sources that have a change at minTime
      for (let i = 0; i < n; i++) {
        if (pointers[i] < sourceDatas[i].length && sourceDatas[i][pointers[i]][0] === minTime) {
          currentValues[i] = sourceDatas[i][pointers[i]][1];
          pointers[i]++;
        }
      }

      const combined = currentValues.join('');
      if (combined !== prevCombined) {
        result.push([minTime, combined]);
        prevCombined = combined;
      }
    }

    return result;
  }

  updateEnum(enumName: string, enumData: EnumEntry[]) {
    this.enumTable[enumName] = enumData;
    this.enumTableTemp[enumName] = undefined;

    viewerState.displayedSignalsFlat.forEach((rowId) => {
      const netlistData = rowHandler.rowItems[rowId];
      if (netlistData instanceof NetlistVariable === false) {return;}
      if (netlistData.enumType !== enumName) {return;}
      if (netlistData.signalId === undefined) {return;}
      const data = this.valueChangeData[netlistData.signalId];
      if (data === undefined) {return;}
      rowHandler.setValueFormat(data, netlistData.valueFormat, true);
      events.redrawVariable(rowId);
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
      if (signalId === undefined) {return;}
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
  binarySearch(array: ValueChange[], target: number) {
    let low  = 0;
    let high = array.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (array[mid][0] < target) {low = mid + 1;}
      else {high = mid;}
    }
    return low;
  }

  binarySearchTime(array: number[], target: number) {
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
    const result = null;
    if (viewerState.selectedSignal.length !== 1) {return result;}
    if (viewerState.markerTime === null || viewerState.altMarkerTime === null) {return result;}
    const rowId = viewerState.selectedSignal[0];
    const netlistData = rowHandler.rowItems[rowId];
    if (netlistData instanceof NetlistVariable === false) {return result;}
    const signalId = netlistData.signalId;
    if (signalId === undefined) {return result;}
    if (this.valueChangeData[signalId] === undefined) {return result;}
    const vcData = this.valueChangeData[signalId].valueChangeData;
    if (vcData === undefined || vcData.length === 0) {return result;}

    const maxIndex  = vcData.length - 1;
    const maxTime   = vcData[maxIndex][0];
    const startTime = Math.min(viewerState.markerTime, viewerState.altMarkerTime);
    const endTime   = Math.max(viewerState.markerTime, viewerState.altMarkerTime);
    const startIndex  = this.binarySearch(vcData, startTime);
    const endIndex    = this.binarySearch(vcData, endTime);
    let additional  = 0;

    if (endTime === maxTime) {
      additional = 1;
    } else if (endTime > maxTime) {
      additional = 0;
    } else if (endTime === vcData[endIndex][0]) {
      additional = 1;
    }

    const r = Math.max(0, (endIndex - startIndex) + additional);
    return r;
  }

  public getValueAtTime(waveforms: WaveformData | undefined, time: number | null) {

    const result: string[] = [];

    if (time === null) {return result;}
    if (!waveforms) {return result;}

    const data = waveforms.valueChangeData;
    let index  = this.binarySearch(data, time);

    if (data.length === 0) {return result;}

    if (index < data.length && time === data[index][0]) {
      while (index > 0 && data[index][0] === time) {
        index--;
      }
      while (index < data.length && data[index][0] <= time) {
        result.push(data[index][1]);
        index++;
      }

    } else {
      const newIndex = Math.max(0, index - 1);
      result.push(data[newIndex][1]);
    }

    return result;
  }

  public getNextEdge(waveforms: WaveformData, time: number, direction: number, valueList: string[]): number | null {
    if (!waveforms) {return null;}
    const data  = waveforms.valueChangeData;
    const index = this.binarySearch(data, time);
    let nextEdge: number | null = null;

    if (index === -1) {return null;}

    const anyEdge = valueList.length === 0;
    if (direction === 1) {
      for (let i = index; i < data.length; i++) {
        const valueMatch = anyEdge || valueList.includes(data[i][1]);
        if (valueMatch && data[i][0] > time) {
          nextEdge = data[i][0];
          break;
        }
      }
    } else {
      const indexStart = Math.min(Math.max(0, index), data.length - 1);
      for (let i = indexStart; i >= 0; i--) {
        const valueMatch = anyEdge || valueList.includes(data[i][1]);
        if (valueMatch && data[i][0] < time) {
          nextEdge = data[i][0];
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

  public getNearestTransition(waveforms: WaveformData, time: number | null): ValueChange | null {

    const result = null;

    if (time === null) {return result;}
    if (!waveforms) {return result;}

    const data  = waveforms.valueChangeData;
    const index = this.binarySearch(data, time);

    if (index >= data.length) {
      return data[data.length - 1];
    } else if (data[index][0] === time) {
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
}
