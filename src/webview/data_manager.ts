import { SignalId, NetlistId, WaveformData, ValueChange, EventHandler, viewerState, ActionType, vscode, viewport, sendWebviewContext, DataType, dataManager, RowId, updateDisplayedSignalsFlat, getChildrenByGroupId, getParentGroupId, arrayMove, labelsPanel, outputLog, getIndexInGroup, CollapseState } from './vaporview';
import { formatBinary, formatHex, ValueFormat, formatString, valueFormatList } from './value_format';
import { WaveformRenderer, multiBitWaveformRenderer, binaryWaveformRenderer, linearWaveformRenderer, steppedrWaveformRenderer, signedLinearWaveformRenderer, signedSteppedrWaveformRenderer } from './renderer';
import { SignalGroup, VariableItem, RowItem } from './signal_item';
// @ts-ignore
import * as LZ4 from 'lz4js';

// This will be populated when a custom color is set
export let customColorKey = [];

export class WaveformDataManager {
  requested: SignalId[] = [];
  queued:    SignalId[] = [];
  requestActive: boolean = false;
  requestStart: number = 0;

  valueChangeData: WaveformData[] = []; // signalId is the key/index, WaveformData is the value
  rowItems: RowItem[]             = []; // rowId is the key/index, RowItem is the value
  netlistIdTable: RowId[]         = []; // netlist ID is the key/index, rowId is the value
  groupIdTable: RowId[]           = []; // group ID is the key/index, rowId is the value
  valueChangeDataTemp: any        = [];
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
  request(signalIdList: SignalId[]) {
    this.queued = this.queued.concat(signalIdList);
    this.fetch();
  }

  receive(signalId: SignalId) {
    this.requested = this.requested.filter((id) => id !== signalId);
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
      command: 'fetchTransitionData',
      signalIdList: this.requested,
    });
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

  addVariable(signalList: any, groupPath: string[] | undefined, parentGroupId: number | undefined) {
    // Handle rendering a signal, e.g., render the signal based on message content

    if (signalList.length === 0) {return;}

    let updateFlag     = false;
    let selectedSignal = viewerState.selectedSignal;
    const signalIdList: any  = [];
    const netlistIdList: any = [];
    const rowIdList: any     = [];
    const moveList: any      = [];

    signalList.forEach((signal: any) => {

      const netlistId = signal.netlistId;
      const signalId  = signal.signalId;
      let rowId       = this.nextRowId;

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
      );

      this.rowItems[rowId] = varItem;
      netlistIdList.push(netlistId);

      if (this.valueChangeData[signalId] !== undefined) {
        selectedSignal = rowId;
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
    });

    this.request(signalIdList);


    viewerState.displayedSignals = viewerState.displayedSignals.concat(rowIdList);


    updateDisplayedSignalsFlat();
    this.events.dispatch(ActionType.AddVariable, rowIdList, updateFlag);

    let groupItem = this.getGroupByIdOrName(groupPath, parentGroupId);
    if (groupItem !== null) {

      const groupId = groupItem.groupId;
      const index = groupItem.children.length;
      moveList.forEach((rowId: RowId) => {
        this.events.dispatch(ActionType.ReorderSignals, rowId, groupId, index);
      });
    }

    this.events.dispatch(ActionType.SignalSelect, selectedSignal);
    sendWebviewContext();
  }

  addSignalGroup(name: string, groupPath: string[] | undefined, inputParentGroupId: number | undefined) {
    const groupId = this.nextGroupId;
    const rowId = this.nextRowId;

    let parentGroupId = 0;
    let reorder = false;
    let index = viewerState.displayedSignalsFlat.length;
    let parentGroup = this.getGroupByIdOrName(groupPath, inputParentGroupId);
    if (parentGroup !== null) {
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

    if (reorder) {
      this.events.dispatch(ActionType.ReorderSignals, rowId, parentGroupId, index);
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
      if (viewerState.selectedSignal && viewerState.selectedSignal >= 0) {
        rowId = viewerState.selectedSignal;
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

    this.receive(signalId);

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

    this.receive(signalId);

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
    if (viewerState.selectedSignal === null) {return result;}
    if (viewerState.markerTime === null || viewerState.altMarkerTime === null) {return result;}
    const rowId = viewerState.selectedSignal;
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

  handleReorderSignals(rowId: number, newGroupId: number, newIndex: number) {

    const oldGroupId = getParentGroupId(rowId) || 0;
    const oldGroupChildren = getChildrenByGroupId(oldGroupId);
    const oldIndex = oldGroupChildren.indexOf(rowId);

    if (oldIndex === -1) {return;}
    if (oldGroupId === newGroupId) {
      arrayMove(oldGroupChildren, oldIndex, newIndex);
    } else {
      oldGroupChildren.splice(oldIndex, 1);
      const newGroupChildren = getChildrenByGroupId(newGroupId);
      if (newIndex >= newGroupChildren.length) {
        newGroupChildren.push(rowId);
      } else {
        newGroupChildren.splice(newIndex, 0, rowId);
      }
    }
  }

  setDisplayFormat(message: any) {

    const netlistId = message.netlistId;
    if (message.netlistId === undefined) {return;}
    const rowId = this.netlistIdTable[netlistId];
    if (this.rowItems[rowId] === undefined) {return;}
    const netlistData = this.rowItems[rowId];
    if (netlistData instanceof VariableItem === false) {return;}

    if (message.numberFormat !== undefined) {
      let valueFormat = valueFormatList.find((format) => format.id === message.numberFormat);
      if (valueFormat === undefined) {valueFormat = formatBinary;}
      netlistData.formatValid = false;
      netlistData.formattedValues = [];
      netlistData.valueFormat = valueFormat;
      netlistData.cacheValueFormat();
    }

    if (message.color !== undefined) {
      customColorKey = message.customColors;
      netlistData.colorIndex = message.color;
      netlistData.setColorFromColorIndex();
    }

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
    }

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

    if (message.annotateValue !== undefined) {
      viewport.annotateWaveform(rowId, message.annotateValue);
      viewport.updateBackgroundCanvas(false);
    }

    sendWebviewContext();

    netlistData.setSignalContextAttribute();
    this.events.dispatch(ActionType.RedrawVariable, rowId);
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

  copyWaveDrom() {

    // Maximum number of transitions to display
    // Maybe I should make this a user setting in the future...
    const MAX_TRANSITIONS = 32;
  
    // Marker and alt marker need to be set
    if (viewerState.markerTime === null ||viewerState. altMarkerTime === null) {
      //vscode.window.showErrorMessage('Please use the marker and alt marker to set time window for waveform data.');
      return;
    }

    const timeWindow   = [viewerState.markerTime, viewerState.altMarkerTime].sort((a, b) => a - b);
    let allTransitions: any = [];
  
    // Populate the waveDrom names with the selected signals
    const waveDromData: any = {};
    viewerState.displayedSignalsFlat.forEach((rowId) => {

      const netlistItem: any = this.rowItems[rowId];
      if (netlistItem === undefined || netlistItem instanceof VariableItem === false) {return;}
      const netlistId       = netlistItem.netlistId;
      const signalName      = netlistItem.scopePath + "." + netlistItem.signalName;
      const signalId        = netlistItem.signalId;
      const transitionData  = this.valueChangeData[signalId].transitionData;
      const lowerBound      = this.binarySearch(transitionData, timeWindow[0]) - 1;
      const upperBound      = this.binarySearch(transitionData, timeWindow[1]) + 2;
      const signalDataChunk = transitionData.slice(lowerBound, upperBound);
      let   initialState = "x";
      const json: any       = {name: signalName, wave: ""};
      const signalDataTrimmed: any[] = [];
      if (netlistItem.signalWidth > 1) {json.data = [];}

      signalDataChunk.forEach((transition: any) => {
        if (transition[0] <= timeWindow[0]) {initialState = transition[1];}
        if (transition[0] >= timeWindow[0] && transition[0] <= timeWindow[1]) {signalDataTrimmed.push(transition);}
      });

      waveDromData[netlistId] = {json: json, signalData: signalDataTrimmed, signalWidth: netlistItem.signalWidth, initialState: initialState};
      const taggedTransitions: any = signalDataTrimmed.map(t => [t[0], t[1], netlistId]);
      allTransitions = allTransitions.concat(taggedTransitions);
    });
  
    let currentTime = timeWindow[0];
    let transitionCount = 0;
  
    if (this.waveDromClock.netlistId === null) {
  
      allTransitions = allTransitions.sort((a: ValueChange, b: ValueChange) => a[0] - b[0]);
  
      for (let index = 0; index < allTransitions.length; index++) {
        const time      = allTransitions[index][0];
        const state     = allTransitions[index][1];
        const netlistId = allTransitions[index][2];
        if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
        if (time !== currentTime) {
          currentTime = time;
          transitionCount++;
          viewerState.displayedSignalsFlat.forEach((rowId) => {
            const varItem = this.rowItems[rowId];
            if (varItem instanceof VariableItem === false) {return;}
            const n = this.rowItems[rowId].netlistId;
            if (n === undefined) {return;}
            const signal = waveDromData[n];
            const parseValue = varItem.valueFormat.formatString;
            const valueIs9State = varItem.valueFormat.is9State;
            if (signal.initialState === null) {signal.json.wave += '.';}
            else {
              if (signal.signalWidth > 1) {
                const is4State = valueIs9State(signal.initialState);
                signal.json.wave += is4State ? "9" : "7";
                signal.json.data.push(parseValue(signal.initialState, signal.signalWidth, !is4State));
              } else {
                signal.json.wave += signal.initialState;
              }
            }
            signal.initialState = null;
          });
        }
        waveDromData[netlistId].initialState = state;
      }
    } else {
      const clockEdges = waveDromData[this.waveDromClock.netlistId].signalData.filter((t: ValueChange) => t[1] === this.waveDromClock.edge);
      const edge       = this.waveDromClock.edge === '1' ? "p" : "n";
      let nextEdge = Infinity;
      for (let index = 0; index < clockEdges.length; index++) {
        const currentTime = clockEdges[index][0];
        if (index === clockEdges.length - 1) {nextEdge = timeWindow[1];}
        else {nextEdge    = clockEdges[index + 1][0];}
        if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
        viewerState.displayedSignalsFlat.forEach((rowId) => {

          const varItem = this.rowItems[rowId];
          if (varItem instanceof VariableItem === false) {return;}
          const n = varItem.netlistId;
          const signal = waveDromData[n];
          const signalData = signal.signalData;
          const parseValue = varItem.valueFormat.formatString;
          const valueIs9State = varItem.valueFormat.is9State;
          if (n === this.waveDromClock.netlistId) {signal.json.wave += edge;}
          else {
            let transition = signalData.find((t: ValueChange) => t[0] >= currentTime && t[0] < nextEdge);
            if (!transition && index === 0) {transition = [currentTime, signal.initialState];}
            if (!transition && index > 0) {
              signal.json.wave += '.';
            } else {
              if (signal.signalWidth > 1) {
                const is4State = valueIs9State(transition[1]);
                signal.json.wave += is4State ? "9" : "7";
                signal.json.data.push(parseValue(transition[1], signal.signalWidth, !is4State));
              } else {
                signal.json.wave += transition[1];
              }
            }
            signal.initialState = undefined;
          }
        });
        transitionCount++;
      }
    }
  
    //console.log(waveDromData);
  
    // write the waveDrom JSON to the clipboard
    let result = '{"signal": [\n';
    viewerState.displayedSignalsFlat.forEach((rowId) => {
      const netlistId = this.rowItems[rowId].netlistId;
      if (netlistId === undefined || waveDromData[netlistId] === undefined) {return;}
      const signalData = waveDromData[netlistId].json;
      result += '  ' + JSON.stringify(signalData) + ',\n';
    });
    result += ']}';

    if (transitionCount >= MAX_TRANSITIONS) {
      vscode.postMessage({
        command: 'showMessage',
        messageType: 'warning',
        message: 'The number of transitions exceeds the maximum limit of ' + MAX_TRANSITIONS,
      });
    }
    vscode.postMessage({command: 'copyToClipboard', text: result});
    vscode.postMessage({command: 'showMessage',  message: 'WaveDrom JSON copied to clipboard.'});
  }
}
