import { SignalId, NetlistId, WaveformData, ValueChange, EnumEntry, EnumData, EventHandler, viewerState, ActionType, vscode, viewport, sendWebviewContext, DataType, dataManager, RowId, updateDisplayedSignalsFlat, getChildrenByGroupId, getParentGroupId, arrayMove, labelsPanel, outputLog, getIndexInGroup, CollapseState } from './vaporview';
import { formatBinary, formatHex, ValueFormat, formatString, valueFormatList } from './value_format';
import { WaveformRenderer, multiBitWaveformRenderer, binaryWaveformRenderer, linearWaveformRenderer, steppedrWaveformRenderer, signedLinearWaveformRenderer, signedSteppedrWaveformRenderer } from './renderer';
import { SignalGroup, VariableItem, RowItem } from './signal_item';
// @ts-ignore
import * as LZ4 from 'lz4js';

// This will be populated when a custom color is set
export let customColorKey = [];

type SignalQueueEntry = {
  type: 'signal',
  id: SignalId
}

type EnumQueueEntry = {
  type: 'enum',
  name: string,
  netlistId: NetlistId
}

type QueueEntry = SignalQueueEntry | EnumQueueEntry;

export class WaveformDataManager {
  requested: QueueEntry[] = [];
  queued:    QueueEntry[] = [];
  requestActive: boolean = false;
  requestStart: number = 0;

  valueChangeData: WaveformData[] = []; // signalId is the key/index, WaveformData is the value
  rowItems: RowItem[]             = []; // rowId is the key/index, RowItem is the value
  netlistIdTable: RowId[]         = []; // netlist ID is the key/index, rowId is the value
  groupIdTable: RowId[]           = []; // group ID is the key/index, rowId is the value
  enumTable: Record<string, EnumData> = {}; // enum type is the key/index, array of enum values is the value
  valueChangeDataTemp: any        = [];
  emumTableTemp: any              = [];
  private nextRowId: number       = 0;
  private nextGroupId: number     = 1;

  contentArea: HTMLElement = document.getElementById('contentArea')!;

  waveDromClock = {
    netlistId: null,
    edge: '1',
  };

  constructor(private events: EventHandler) {
    this.contentArea = document.getElementById('contentArea')!;

    if (this.contentArea === null) {throw new Error("Could not find contentArea");}

    this.handleColorChange = this.handleColorChange.bind(this);
    this.handleReorderSignals = this.handleReorderSignals.bind(this);
    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);

    this.events.subscribe(ActionType.UpdateColorTheme, this.handleColorChange);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
  }

  unload() {
    this.valueChangeData     = [];
    this.rowItems            = [];
    this.valueChangeDataTemp = [];
    this.netlistIdTable      = [];
    this.groupIdTable        = [];
    this.nextRowId           = 0;
    this.nextGroupId         = 1;
    this.waveDromClock       = {netlistId: null, edge: ""};
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

    // Prevent Enum requests from holding up signal requests, since emums are cached along with the netlist hierarchy
    this.requested = this.requested.filter(entry => entry.type === 'signal');
  }

  getGroupByIdOrName(groupPath: string[] | undefined, parentGroupId: number | undefined): SignalGroup | null {
    let groupId = 0;
    let groupIsValid = false;

    if (parentGroupId !== undefined && this.groupIdTable[parentGroupId] !== undefined) {
      groupId = parentGroupId;
    } else if (groupPath !== undefined && groupPath.length > 0) {
      groupId = this.findGroupIdByNamePath(groupPath);
    }

    if (groupId > 0) {
      const parentGroupRowId = this.groupIdTable[groupId];
      if (parentGroupId !== undefined) {return null;}
      const parentGroupItem = this.rowItems[parentGroupRowId];

      if (parentGroupItem instanceof SignalGroup) {
        return parentGroupItem;
      } else {
        return null;
      }
    }
    return null;
  }

  addVariable(signalList: any, groupPath: string[] | undefined, parentGroupId: number | undefined, index: number | undefined) {
    // Handle rendering a signal, e.g., render the signal based on message content

    if (signalList.length === 0) {return;}

    let updateFlag     = false;
    //let selectedSignal = viewerState.selectedSignal;
    const signalIdList: any  = [];
    const enumTableList: any = [];
    const netlistIdList: any = [];
    const rowIdList: any     = [];
    const moveList: any      = [];
    let lastRowId: number | null = null;

    signalList.forEach((signal: any) => {

      const netlistId = signal.netlistId;
      const signalId  = signal.signalId;
      const enumType  = signal.enumType;
      let rowId       = this.nextRowId;
      lastRowId       = rowId;

      if (this.netlistIdTable[netlistId] === undefined) {
        this.netlistIdTable[netlistId] = rowId;
        this.nextRowId++;
      } else {
        rowId = this.netlistIdTable[netlistId];
      }

      moveList.push(rowId);

      if (viewerState.displayedSignalsFlat.includes(rowId)) {
        return; // Signal already displayed, skip it
      }

      rowIdList.push(rowId);

      const varItem = new VariableItem(
        netlistId,
        signalId,
        signal.signalName,
        signal.scopePath,
        signal.signalWidth,
        signal.type,
        signal.encoding,
        signal.signalWidth === 1 ? binaryWaveformRenderer : multiBitWaveformRenderer,
        enumType
      );

      this.rowItems[rowId] = varItem;
      netlistIdList.push(netlistId);

      // Check for value change data
      if (this.valueChangeData[signalId] !== undefined) {
        //selectedSignal = [rowId];
        updateFlag     = true;
        varItem.cacheValueFormat();
      } else if (this.valueChangeDataTemp[signalId] !== undefined) {
        this.valueChangeDataTemp[signalId].netlistIdList.push(netlistId);
      } else if (this.valueChangeDataTemp[signalId] === undefined) {
        signalIdList.push(signalId);
        this.valueChangeDataTemp[signalId] = {
          netlistIdList: [netlistId],
          totalChunks: 0,
        };
      }

      // Check for enum type
      if (enumType !== undefined && enumType !== "" ) {
        if (this.enumTable[enumType] === undefined) {
          enumTableList.push({type: 'enum', name: enumType, netlistId: netlistId} as EnumQueueEntry);
        }
      }

    });

    this.requestData(signalIdList, enumTableList);

    viewerState.displayedSignals = viewerState.displayedSignals.concat(rowIdList);

    updateDisplayedSignalsFlat();
    this.events.dispatch(ActionType.AddVariable, rowIdList, updateFlag);

    let reorder = false;
    let groupId = 0;
    let moveIndex = 0;
    let groupItem = this.getGroupByIdOrName(groupPath, parentGroupId);
    if (groupItem !== null) {
      groupId = groupItem.groupId;
      moveIndex = groupItem.children.length;
      reorder = true;
    }

    if (index !== undefined) {
      moveIndex = Math.max(index, 0);
      reorder = true;
    }

    if (reorder) {
      //moveList.forEach((rowId: RowId) => {
      //  this.events.dispatch(ActionType.ReorderSignals, [rowId], groupId, moveIndex);
      //});
      this.events.dispatch(ActionType.ReorderSignals, moveList, groupId, moveIndex);
    }

    this.events.dispatch(ActionType.SignalSelect, rowIdList, lastRowId);
    sendWebviewContext();
  }

  addSignalGroup(name: string, groupPath: string[] | undefined, inputParentGroupId: number | undefined, eventRowId: number | undefined, moveSelected: boolean) {
    const groupId = this.nextGroupId;
    const rowId = this.nextRowId;

    let parentGroupId = 0;
    let reorder = false;
    let index = viewerState.displayedSignalsFlat.length;
    let parentGroup = this.getGroupByIdOrName(groupPath, inputParentGroupId);
    if (eventRowId !== undefined) {
      parentGroupId = getParentGroupId(eventRowId) || 0;
      const parentGroupChildren = getChildrenByGroupId(parentGroupId);
      index = parentGroupChildren.indexOf(eventRowId) + 1;
      reorder = true;
    } else if (parentGroup !== null) {
      parentGroupId = parentGroup.groupId;
      index = parentGroup.children.length;
      reorder = true;
    }

    let groupName = "Group " + groupId;
    if (name === undefined || name === "") {
      let n = 1;
      while (this.findGroupIdByName(groupName, parentGroupId) !== -1) {
        groupName = "Group " + groupId + ` (${n})`;
        n++;
      }
    } else {
      groupName = name;
      const isTaken = this.groupNameExists(groupName, parentGroupId);
      if (isTaken) {return;}
    }

    viewerState.displayedSignals = viewerState.displayedSignals.concat(rowId);
    const groupItem = new SignalGroup(rowId, groupName, groupId);
    this.groupIdTable[groupId] = rowId;
    this.rowItems[rowId] = groupItem;

    updateDisplayedSignalsFlat();
    this.events.dispatch(ActionType.AddVariable, [rowId], false);

    let moveValid = true
    if (moveSelected && viewerState.selectedSignal.length > 0) {
      this.events.dispatch(ActionType.ReorderSignals, viewerState.selectedSignal, groupId, 0);

      const filteredRowIdList = this.removeChildrenFromSignalList(viewerState.selectedSignal);
      const parentGroupRowId = this.groupIdTable[parentGroupId];
      filteredRowIdList.forEach((id) => {
        const item = this.rowItems[id];
        const childItems = item.getFlattenedRowIdList(false, -1);
        if (childItems.includes(parentGroupRowId)) {moveValid = false;}
      });
    }

    if (reorder && moveValid) {
      this.events.dispatch(ActionType.ReorderSignals, [rowId], parentGroupId, index);
    }

    this.nextGroupId++;
    this.nextRowId++;
  }

  renameSignalGroup(groupId: number | undefined, name: string | undefined) {
    let rowId: number
    if (groupId) {
      rowId = this.groupIdTable[groupId];
      if (rowId === undefined) {return;}
    }
    else {
      if (viewerState.selectedSignal.length === 1 && viewerState.selectedSignal[0] >= 0) {
        rowId = viewerState.selectedSignal[0];
      } else {
        return;
      }
    }
    const groupItem = this.rowItems[rowId];
    if (groupItem instanceof SignalGroup === false) {return;}
    if (name !== undefined && name !== "") {
      groupItem.label = name;
      labelsPanel.renderLabelsPanels();
    } else {
      labelsPanel.showRenameInput(rowId);
    }
  }

  handleRemoveVariable(rowId: any, recursive: boolean) {

    const signalItem = this.rowItems[rowId];
    if (!signalItem) {return;}
    let rowIdList: RowId[] = [rowId];
    let children: number[] = []
    const parentGroupId = getParentGroupId(rowId);
    const indexInGroup = getIndexInGroup(rowId, parentGroupId);

    if (recursive) {
      rowIdList = signalItem.getFlattenedRowIdList(false, -1)
    } else if (signalItem instanceof SignalGroup) {
      signalItem.collapseState = CollapseState.Expanded;
      signalItem.showHideViewportRows()
      children = signalItem.children;
    }
    if (parentGroupId === 0) {
      viewerState.displayedSignals.splice(indexInGroup, 1, ...children);
    } else if (parentGroupId && parentGroupId > 0) {
      const parentGroupitem = this.rowItems[this.groupIdTable[parentGroupId]];
      if (parentGroupitem instanceof SignalGroup) {
        parentGroupitem.children.splice(indexInGroup, 1, ...children);
      }
    }

    rowIdList.forEach((id: RowId) => {
      this.rowItems[id].dispose();
      delete this.rowItems[id];
    });

    updateDisplayedSignalsFlat();
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
    if (this.emumTableTemp[enumName] === undefined || this.emumTableTemp[enumName].totalChunks === 0) {
      this.emumTableTemp[enumName] = {
        totalChunks: message.totalChunks,
        chunkLoaded: new Array(message.totalChunks).fill(false),
        chunkData:   new Array(message.totalChunks).fill(""),
      };
    }

    this.emumTableTemp[enumName].chunkData[message.chunkNum]   = message.enumDataChunk;
    this.emumTableTemp[enumName].chunkLoaded[message.chunkNum] = true;
    const allChunksLoaded = this.emumTableTemp[enumName].chunkLoaded.every((chunk: any) => {return chunk;});

    if (!allChunksLoaded) {return;}

    const enumData = JSON.parse(this.emumTableTemp[enumName].chunkData.join(""));

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

  updateWaveform(signalId: SignalId, transitionData: any[], min: number, max: number) {
    const netlistIdList = this.valueChangeDataTemp[signalId].netlistIdList;
    const netlistId     = netlistIdList[0];
    if (netlistId ===  undefined) {console.log('netlistId not found for signalId ' + signalId); return;}
    const rowId        = this.netlistIdTable[netlistId];
    const netlistData  = this.rowItems[rowId];
    if (netlistData === undefined || netlistData instanceof VariableItem === false) {return;}
    const signalWidth  = netlistData.signalWidth;
    const nullValue = "x".repeat(signalWidth);
    if (transitionData[0][0] !== 0) {
      transitionData.unshift([0, nullValue]);
    }
    if (transitionData[transitionData.length - 1][0] !== viewport.timeStop) {
      transitionData.push([viewport.timeStop, nullValue]);
    }
    this.valueChangeData[signalId] = {
      transitionData: transitionData,
      signalWidth:    signalWidth,
      min:            min,
      max:            max,
    };

    this.valueChangeDataTemp[signalId] = undefined;

    netlistIdList.forEach((netlistId: NetlistId) => {
      const rowId = this.netlistIdTable[netlistId];
      const netlistData = this.rowItems[rowId];
      if (netlistData === undefined || netlistData instanceof VariableItem === false) {return;}
      this.events.dispatch(ActionType.RedrawVariable, rowId);
      netlistData.cacheValueFormat();
    });
  }

  updateEnum(enumName: string, enumData: EnumEntry[]) {
    this.enumTable[enumName] = enumData;
    this.emumTableTemp[enumName] = undefined;

  }

  groupNameExists(name: string, parentGroupId: number): boolean {
    const groupId = this.findGroupIdByName(name, parentGroupId);
    return groupId !== -1;
  }


  findGroupIdByName(name: string, parentGroupId: number): number {
    let result = -1;
    const children = getChildrenByGroupId(parentGroupId);
    children.forEach((rowId) => {
      const rowItem = this.rowItems[rowId];
      if (rowItem instanceof SignalGroup && rowItem.label === name) {result = rowItem.groupId;}
    });
    return result;
  }

  findGroupIdByNamePath(namePath: string[]): number {
    let breakLoop = false;
    let parentGroupId = 0;

    namePath.forEach((name) => {
      if (breakLoop) {return;}
      parentGroupId = this.findGroupIdByName(name, parentGroupId);
      if (parentGroupId === -1) {
        breakLoop = true;
      }
    });
    return parentGroupId;
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
    const netlistData = this.rowItems[rowId];
    if (netlistData instanceof VariableItem === false) {return result;}
    const signalId = netlistData.signalId;
    if (this.valueChangeData[signalId] === undefined) {return result;}
    const vcData = this.valueChangeData[signalId].transitionData;
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

  handleColorChange() {
    viewport.getThemeColors();
    this.rowItems.forEach((data) => {
      if (data instanceof VariableItem === false) {return;}
      data.setColorFromColorIndex();
    });
  }

  removeChildrenFromSignalList(rowIdList: RowId[]) {
    let groupChildren: number[] = [];
    rowIdList.forEach((rowId) => {
      const rowItem = this.rowItems[rowId];
      if (rowItem instanceof SignalGroup) {
        const children = rowItem.getFlattenedRowIdList(false, -1);
        children.shift(); // Remove the group itself from the list
        groupChildren = groupChildren.concat(children);
      }
    });
    const filteredRowIdList = rowIdList.filter((rowId) => {
      return !groupChildren.includes(rowId);
    });
    return filteredRowIdList;
  }

  handleReorderSignals(rowIdList: number[], newGroupId: number, newIndex: number) {

    let dropIndex = newIndex;
    const groupRowId = this.groupIdTable[newGroupId];
    const filteredRowIdList = this.removeChildrenFromSignalList(rowIdList);
    const newGroupChildren = getChildrenByGroupId(newGroupId);

    // Prevent moving a group into itself or one of its children
    let abort = false;
    if (groupRowId === undefined && newGroupId > 0) {return;}
    filteredRowIdList.forEach((rowId) => {
      if (rowId === groupRowId) {abort = true;}
      const item = this.rowItems[rowId];
      const childItems = item.getFlattenedRowIdList(false, -1);
      if (childItems.includes(groupRowId)) {abort = true;}
    });
    if (abort) {return;}

    filteredRowIdList.forEach((rowId, i) => {

      const oldGroupId = getParentGroupId(rowId) || 0;
      const oldGroupChildren = getChildrenByGroupId(oldGroupId);
      const oldIndex = oldGroupChildren.indexOf(rowId);
      oldGroupChildren.splice(oldIndex, 1);

      if (oldGroupId === newGroupId && newIndex > oldIndex) {
        dropIndex -= 1;
      }
    });
    
    dropIndex = Math.min(Math.max(dropIndex, 0), newGroupChildren.length);
    filteredRowIdList.forEach((rowId, i) => {
      newGroupChildren.splice(dropIndex + i, 0, rowId);
    });

    updateDisplayedSignalsFlat();
    console.log(filteredRowIdList);
  }

  setDisplayFormat(message: any) {

    const netlistId = message.netlistId;
    if (message.netlistId === undefined) {return;}
    const rowId = this.netlistIdTable[netlistId];
    if (this.rowItems[rowId] === undefined) {return;}
    const netlistData = this.rowItems[rowId];
    if (netlistData instanceof VariableItem === false) {return;}
    const signalWidth = netlistData.signalWidth;

    let updateAllSelected = false;
    let rowIdList = [rowId];
    let redrawList = [rowId];
    if (viewerState.selectedSignal.includes(rowId)) {
      rowIdList = viewerState.selectedSignal;
    }
    
    // Color - this is applied to all selected signals if the selected signal is being updated
    rowIdList.forEach((rId) => {
      const data = this.rowItems[rId];
      if (data instanceof VariableItem === false) {return;}
      if (message.color !== undefined) {
        customColorKey = message.customColors;
        data.colorIndex = message.color;
        data.setColorFromColorIndex();
        updateAllSelected = true;
      }
    });

    // Number format
    if (message.numberFormat !== undefined) {
      let valueFormat = valueFormatList.find((format) => format.id === message.numberFormat);
      if (valueFormat === undefined) {valueFormat = formatBinary;}
      netlistData.formatCached = false;
      netlistData.formattedValues = [];
      netlistData.valueFormat = valueFormat;
      netlistData.cacheValueFormat();
    }

    // Rendering type
    if (message.renderType !== undefined) {
      switch (message.renderType) {
        case "binary":        netlistData.renderType = binaryWaveformRenderer; break;
        case "multiBit":      netlistData.renderType = multiBitWaveformRenderer; break;
        case "linear":        netlistData.renderType = linearWaveformRenderer; break;
        case "stepped":       netlistData.renderType = steppedrWaveformRenderer; break;
        case "linearSigned":  netlistData.renderType = signedLinearWaveformRenderer; break;
        case "steppedSigned": netlistData.renderType = signedSteppedrWaveformRenderer; break;
        default:              netlistData.renderType = multiBitWaveformRenderer; break;
      }

      if (netlistData.renderType.id === "multiBit") {
        netlistData.cacheValueFormat();
      }
      netlistData.setSignalContextAttribute();
    }

    // Row height
    if (message.rowHeight !== undefined) {
      netlistData.rowHeight = message.rowHeight;
      viewport.updateElementHeight(rowId);
    }

    // Vertical scale
    if (message.verticalScale !== undefined) {
      netlistData.verticalScale = message.verticalScale;
    }

    // Value link command
    if (message.valueLinkCommand !== undefined) {

      if (netlistData.valueLinkCommand === "" && message.valueLinkCommand !== "") {
        netlistData.canvas?.addEventListener("pointermove", netlistData.handleValueLinkMouseOver, true);
        netlistData.canvas?.addEventListener("pointerleave", netlistData.handleValueLinkMouseExit, true);
      } else if (message.valueLinkCommand === "") {
        netlistData.canvas?.removeEventListener("pointermove", netlistData.handleValueLinkMouseOver, true);
        netlistData.canvas?.removeEventListener("pointerleave", netlistData.handleValueLinkMouseExit, true);
      }

      netlistData.valueLinkCommand = message.valueLinkCommand;
      netlistData.valueLinkIndex   = -1;
    }

    // Edge guides
    if (message.annotateValue !== undefined) {
      viewport.annotateWaveform(rowId, message.annotateValue);
      viewport.updateBackgroundCanvas(false);
    }

    sendWebviewContext();
    netlistData.setSignalContextAttribute();

    if (updateAllSelected) {redrawList = viewerState.selectedSignal;}
    redrawList.forEach((rId) => {
      this.events.dispatch(ActionType.RedrawVariable, rId);
    });
  }

  getNearestTransitionIndex(signalId: SignalId, time: number) {

    if (time === null) {return -1;}
  
    const data            = this.valueChangeData[signalId].transitionData;
    const transitionIndex = this.binarySearch(data, time);
  
    if (transitionIndex >= data.length) {
      return -1;
    }
  
    return transitionIndex;
  }
}
