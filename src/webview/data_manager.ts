import { SignalId, NetlistId, ValueChange, EnumEntry, EnumData, EventHandler, viewerState, ActionType, vscode, viewport, sendWebviewContext, DataType, dataManager, RowId, updateDisplayedSignalsFlat, getChildrenByGroupId, getParentGroupId, arrayMove, labelsPanel, outputLog, getIndexInGroup, CollapseState, controlBar } from './vaporview';
import { getNumberFormatById, ValueFormat } from './value_format';
import { WaveformRenderer, MultiBitWaveformRenderer, BinaryWaveformRenderer, LinearWaveformRenderer } from './renderer';
import { SignalGroup, NetlistVariable, RowItem, NameType, SignalSeparator, isAnalogSignal, CustomVariable } from './signal_item';
// @ts-ignore
import * as LZ4 from 'lz4js';

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
  requested: QueueEntry[] = [];
  queued:    QueueEntry[] = [];
  requestActive: boolean = false;
  requestStart: number = 0;

  valueChangeData: WaveformData[]     = []; // signalId is the key/index, WaveformData is the value
  valueChangeDataTemp: any            = [];
  customValueChangeData: CustomWaveformData[] = [];
  enumTable: Record<string, EnumData> = {}; // enum type is the key/index, array of enum values is the value
  enumTableTemp: any                  = {}
  rowItems: RowItem[]                 = []; // rowId is the key/index, RowItem is the value
  groupIdTable: RowId[]               = []; // group ID is the key/index, rowId is the value
  customColorKey: string[]            = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];
  private nextRowId: number           = 0;
  private nextGroupId: number         = 1;
  private nextCustomSignalId: number = 0;

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
    this.fetch = this.fetch.bind(this);

    this.events.subscribe(ActionType.UpdateColorTheme, this.handleColorChange);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.ExitBatchMode, this.fetch);
  }

  unload() {
    this.valueChangeData     = [];
    this.valueChangeDataTemp = [];
    this.enumTable           = {};
    this.enumTableTemp       = {};
    this.rowItems            = [];
    this.groupIdTable        = [];
    this.nextRowId           = 0;
    this.nextGroupId         = 1;
    this.waveDromClock       = {netlistId: null, edge: ""};

    this.requested           = [];
    this.queued              = [];
    this.requestActive       = false;
    this.requestStart        = 0;
  }

  private flushRowCache(force: boolean) {
    if (viewerState.displayedSignalsFlat.length === 0 || force) {return;}
    this.rowItems     = [];
    this.groupIdTable = [];
    this.nextRowId    = 0;
    this.nextGroupId  = 1;
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
    if (this.events.isBatchMode) {return;}
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

  getGroupByIdOrName(groupPath: string[] | undefined, parentGroupId: number | undefined): SignalGroup | null {
    let groupId = 0;
    let groupIsValid = false;

    if (parentGroupId !== undefined) {
      groupId = parentGroupId;
    } else if (groupPath !== undefined && groupPath.length > 0) {
      groupId = this.findGroupIdByNamePath(groupPath);
    }

    if (groupId > 0) {
      const parentGroupRowId = this.groupIdTable[groupId];
      if (parentGroupRowId === undefined) {return null;}
      const parentGroupItem = this.rowItems[parentGroupRowId];

      if (parentGroupItem instanceof SignalGroup) {
        return parentGroupItem;
      } else {
        return null;
      }
    }
    return null;
  }

  getRowIdsFromNetlistId(netlistId: NetlistId): RowId[] {
    return viewerState.displayedSignalsFlat.filter((rowId) => {
      const data = dataManager.rowItems[rowId];
      if (!(data instanceof NetlistVariable)) {return false;}
      return data.netlistId === netlistId;
    });
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
      this.nextRowId++;

      moveList.push(rowId);

      if (viewerState.displayedSignalsFlat.includes(rowId)) {
        return; // Signal already displayed, skip it
      }

      rowIdList.push(rowId);

      const varItem = new NetlistVariable(
        rowId,
        netlistId,
        signalId,
        signal.signalName,
        signal.scopePath,
        signal.signalWidth,
        signal.type,
        signal.encoding,
        signal.signalWidth === 1 ? new BinaryWaveformRenderer() : new MultiBitWaveformRenderer(),
        enumType
      );

      this.rowItems[rowId] = varItem;
      netlistIdList.push(netlistId);

      // Check for value change data
      if (this.valueChangeData[signalId] !== undefined) {
        //selectedSignal = [rowId];
        if (!this.events.isBatchMode) {
          updateFlag     = true;
        }
        const data = this.valueChangeData[varItem.signalId];
        this.setValueFormat(data, varItem.valueFormat, false);
        labelsPanel.valueAtMarker[rowId] = varItem.getValueAtTime(viewerState.markerTime);
      } else if (this.valueChangeDataTemp[signalId] !== undefined) {
        this.valueChangeDataTemp[signalId].rowIdList.push(rowId);
      } else if (this.valueChangeDataTemp[signalId] === undefined) {
        signalIdList.push(signalId);
        this.valueChangeDataTemp[signalId] = {
          rowIdList: [rowId],
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

    // If a location was specified, use it
    let groupItem = this.getGroupByIdOrName(groupPath, parentGroupId);
    if (groupItem !== null) {
      groupId = groupItem.groupId;
      moveIndex = groupItem.children.length;
      reorder = true;
    } else if (parentGroupId === 0) {
      moveIndex = viewerState.displayedSignalsFlat.length;
      groupId = 0;
      reorder = true;
    }

    if (index !== undefined) {
      moveIndex = Math.max(index, 0);
      reorder = true;
    }

    // If no location was specified, move the signal to below the selected signal
    if (!reorder && viewerState.selectedSignal.length === 1) {
      const selectedRowId = viewerState.selectedSignal[0];
      groupId = getParentGroupId(selectedRowId) || 0;
      moveIndex = (getIndexInGroup(selectedRowId, groupId) || 0) + 1;
      reorder = true;
    }

    if (reorder) {
      this.events.dispatch(ActionType.ReorderSignals, moveList, groupId, moveIndex);
    }

    this.events.dispatch(ActionType.SignalSelect, rowIdList, lastRowId);

    console.log('addVariable');
    sendWebviewContext(5);
    return rowIdList;
  }

  addSignalGroup(name: string | undefined, groupPath: string[] | undefined, inputParentGroupId: number | undefined, eventRowId: number | undefined, moveSelected: boolean): number | undefined {
    if (controlBar.searchInFocus || labelsPanel.renameActive) {return;}

    const groupId = this.nextGroupId;
    const rowId = this.nextRowId;

    let parentGroupId = 0;
    let reorder = false;
    let index = viewerState.displayedSignalsFlat.length;
    let parentGroup = this.getGroupByIdOrName(groupPath, inputParentGroupId);
    if (eventRowId !== undefined || moveSelected) {
      // Command was sent via keybinding, or right clicking on an empty area
      let targetRowId = eventRowId;
      if (targetRowId === undefined) {
        targetRowId = viewerState.selectedSignal[0];
      }
      parentGroupId = getParentGroupId(targetRowId) || 0;
      const parentGroupChildren = getChildrenByGroupId(parentGroupId);
      if (targetRowId !== undefined) {
        index = parentGroupChildren.indexOf(targetRowId);
      }
      reorder = true;
    } else if (parentGroup !== null) {
      // Command was sent to reload settings
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
      //this.events.dispatch(ActionType.ReorderSignals, viewerState.selectedSignal, groupId, 0);
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

    if (moveSelected && viewerState.selectedSignal.length > 1) {
      this.events.dispatch(ActionType.ReorderSignals, viewerState.selectedSignal, groupId, 0);
    } else {
      this.events.dispatch(ActionType.SignalSelect, [rowId], rowId);
    }

    labelsPanel.showRenameInput(rowId);
    console.log('addSignalGroup');
    sendWebviewContext(5);

    this.nextGroupId++;
    this.nextRowId++;
    return rowId;
  }

  addSeparator(name: string | undefined, groupPath: string[] | undefined, parentGroupId: number | undefined, eventRowId: number | undefined, moveSelected: boolean) {
    if (controlBar.searchInFocus || labelsPanel.renameActive) {return;}
    const rowId = this.nextRowId;
    this.nextRowId++;

    viewerState.displayedSignals = viewerState.displayedSignals.concat(rowId);
    const separatorItem = new SignalSeparator(rowId, name || "---");
    this.rowItems[rowId] = separatorItem;
    updateDisplayedSignalsFlat();
    this.events.dispatch(ActionType.AddVariable, [rowId], false);

    let reorder = false;
    let index = viewerState.displayedSignalsFlat.length;
    let parentGroup = this.getGroupByIdOrName(groupPath, parentGroupId);
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

    if (reorder) {
      this.events.dispatch(ActionType.ReorderSignals, [rowId], parentGroupId, index);
    }

    this.events.dispatch(ActionType.SignalSelect, [rowId], rowId);
    console.log('addSeparator');
    sendWebviewContext(5);
    return rowId;
  }

  addBitSlice(name: string | undefined, groupPath: string[] | undefined, parentGroupId: number | undefined, eventRowId: number | undefined, netlistId: NetlistId | undefined, msb: number, lsb: number) {
    console.log('addBitSlice', name, groupPath, parentGroupId, eventRowId, netlistId, msb, lsb);
    if (controlBar.searchInFocus || labelsPanel.renameActive) {return;}
    const rowId = this.nextRowId;
    this.nextRowId++;

    // get the source signal item
    let sourceSignalItem: RowItem | undefined = undefined;
    if (eventRowId !== undefined) {
      sourceSignalItem = this.rowItems[eventRowId];
    } else if (netlistId !== undefined) {
      const signalItems = this.getRowIdsFromNetlistId(netlistId);
      if (signalItems.length > 0) {
        sourceSignalItem = this.rowItems[signalItems[0]];
      }
    }
    if (!(sourceSignalItem instanceof NetlistVariable)) {return;}

    // Create custom signal
    const source: BitRangeSource = {
      netlistId: sourceSignalItem.netlistId,
      signalId: sourceSignalItem.signalId,
      msb: msb,
      lsb: lsb,
    };
    const customSignalId = this.createCustomSignal([source]);
    if (customSignalId === undefined) {return;}
    const width          = msb - lsb + 1;
    const signalName     = name || [sourceSignalItem.scopePath, sourceSignalItem.signalName].join(".") + "[" + msb + ":" + lsb + "]";
    const renderType     = width === 1 ? new BinaryWaveformRenderer() : new MultiBitWaveformRenderer();
    const customVariable = new CustomVariable(rowId, [source], customSignalId, signalName, width, renderType);
    this.rowItems[rowId] = customVariable;
    this.setValueFormat(customVariable.getWaveformData(), customVariable.valueFormat, false);
    labelsPanel.valueAtMarker[rowId] = customVariable.getValueAtTime(viewerState.markerTime);
    viewerState.displayedSignals     = viewerState.displayedSignals.concat(rowId);
    updateDisplayedSignalsFlat();
    this.events.dispatch(ActionType.AddVariable, [rowId], false);

    let reorder = false;
    let index = viewerState.displayedSignalsFlat.length;
    let parentGroup = this.getGroupByIdOrName(groupPath, parentGroupId);
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

    if (reorder) {
      this.events.dispatch(ActionType.ReorderSignals, [rowId], parentGroupId, index);
    }

    this.events.dispatch(ActionType.SignalSelect, [rowId], rowId);
    console.log('addBitSlice');
    sendWebviewContext(5);
    return rowId;
  }

  addSignalList(signalList: any, parentGroupId: number | undefined) {
    signalList.forEach((signal: any) => {
      if (signal.dataType === 'signal-group') {
        const groupRowId = this.addSignalGroup(signal.groupName, undefined, parentGroupId, undefined, false);
        let groupId = parentGroupId;
        if (groupRowId === undefined) {return;}
        const groupItem = this.rowItems[groupRowId];
        if (groupItem instanceof SignalGroup) {
          groupId = groupItem.groupId;
        }
        labelsPanel.cancelRename();
        this.addSignalList(signal.children, groupId);
        if (signal.collapseState === CollapseState.Collapsed && groupItem instanceof SignalGroup) {
          groupItem.collapse();
        }
      } else if (signal.dataType === 'signal-separator') {
        this.addSeparator(signal.label, undefined, parentGroupId, undefined, false);
      } else if (signal.dataType === 'netlist-variable') {
        const rowIdList = this.addVariable([signal], undefined, parentGroupId, undefined);
        const rowId     = rowIdList[0];
        const displayFormat = Object.assign({rowId: rowId}, signal);
        this.setDisplayFormat(displayFormat);
      }
    });
  }

  applyState(settings: any, stateChangeType: number) {
    //this.flushRowCache(true);
    //console.log('applyState()', settings);

    this.events.enterBatchMode();
    try {
      if (viewerState.displayedSignals.length > 0) {
        this.handleRemoveVariable(viewerState.displayedSignalsFlat, true);
      }
      this.addSignalList(settings.displayedSignals, 0);
      this.garbageCollectValueFormats();
    } catch (error) {console.error(error);}

    if (settings.markerTime !== undefined) {
      this.events.dispatch(ActionType.MarkerSet, settings.markerTime, 0);
    }
    if (settings.altMarkerTime !== undefined) {
      this.events.dispatch(ActionType.MarkerSet, settings.altMarkerTime, 1);
    }
    if (settings.selectedSignal) {
      const rowIdList = this.getRowIdsFromNetlistId(settings.selectedSignal);
      let lastSelectedSignal: RowId | null = rowIdList[0];
      if (rowIdList.length === 0) {lastSelectedSignal = null;}
      this.events.dispatch(ActionType.SignalSelect, rowIdList, lastSelectedSignal);
    }
    if (settings.zoomRatio !== undefined && settings.scrollLeft !== undefined) {
      if (viewport.updatePending) {return;}
      const endTime = settings.scrollLeft + (viewport.viewerWidth / settings.zoomRatio);
      viewport.setViewportRange(settings.scrollLeft, endTime);
    }

    this.events.exitBatchMode();
    console.log('applyState', stateChangeType);
    sendWebviewContext(stateChangeType);
  }

  renameSignalGroup(rowId: RowId | undefined, name: string | undefined) {

    if (rowId === undefined) {
      if (viewerState.selectedSignal.length === 1 && viewerState.selectedSignal[0] >= 0) {
        rowId = viewerState.selectedSignal[0];
      } else {
        return;
      }
    }
    const signalItem = this.rowItems[rowId];

    const trimmedName = name?.trim() || "";
    if (trimmedName !== "") {
      signalItem.setLabelText(trimmedName);
      labelsPanel.renderLabelsPanels();
    } else {
      labelsPanel.showRenameInput(rowId);
    }
  }

  editSignalGroup(message: any) {

    const groupPath = message.groupPath;
    const groupId = message.groupId;
    const name = message.name;
    const isExpanded = message.isExpanded;

    let groupItem = this.getGroupByIdOrName(groupPath, groupId);
    if (groupItem === null) {return;}

    if (name !== undefined) {
      groupItem.setLabelText(name);
      labelsPanel.renderLabelsPanels();
    }

    if (isExpanded !== undefined) {
      if (isExpanded) {
        groupItem.expand();
      } else {
        groupItem.collapse();
      }
    }
  }

  handleRemoveVariable(rowIdList: RowId[], recursive: boolean) {

    let disposedRowIdList: RowId[] = [];
    rowIdList.forEach(rowId => {
      const signalItem = this.rowItems[rowId];
      if (!signalItem) {return;}
      let children: number[] = []
      disposedRowIdList.push(rowId);
      const parentGroupId = getParentGroupId(rowId);
      const indexInGroup = getIndexInGroup(rowId, parentGroupId);

      if (recursive) {
        disposedRowIdList = signalItem.getFlattenedRowIdList(false, -1)
      } else if (signalItem instanceof SignalGroup) {
        signalItem.collapseState = CollapseState.Expanded;
        signalItem.showHideViewportRows()
        children = signalItem.children;
      }
      if (parentGroupId === 0) {
        viewerState.displayedSignals.splice(indexInGroup, 1, ...children);
      } else if (parentGroupId && parentGroupId > 0) {
        const parentGroupItem = this.rowItems[this.groupIdTable[parentGroupId]];
        if (parentGroupItem instanceof SignalGroup) {
          parentGroupItem.children.splice(indexInGroup, 1, ...children);
        }
      }
    });

    disposedRowIdList.forEach((id: RowId) => {
      const rowItem = this.rowItems[id];
      if (rowItem instanceof NetlistVariable || rowItem instanceof CustomVariable) {
        this.unsetValueFormat(rowItem.getWaveformData(), rowItem.valueFormat);
      }
      this.rowItems[id].dispose();
      delete this.rowItems[id];
    });

    updateDisplayedSignalsFlat();
    if (viewerState.displayedSignalsFlat.length === 0) {
      this.flushRowCache(false);
    }
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
    const netlistData  = this.rowItems[rowIdList[0]];
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
      const netlistData = this.rowItems[rowId];
      if (netlistData === undefined || netlistData instanceof NetlistVariable === false) {return;}
      labelsPanel.valueAtMarker[rowId] = netlistData.getValueAtTime(viewerState.markerTime);
      this.events.dispatch(ActionType.RedrawVariable, rowId);
      if (netlistData.encoding === "Real") {
        netlistData.min = min;
        netlistData.max = max;
      }
      const data = this.valueChangeData[netlistData.signalId];
      if (data === undefined) {return;}
      this.setValueFormat(data, netlistData.valueFormat, false);
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
      const netlistData = this.rowItems[rowId];
      if (netlistData instanceof NetlistVariable === false) {return;}
      if (netlistData.enumType !== enumName) {return;}
      const data = this.valueChangeData[netlistData.signalId];
      if (data === undefined) {return;}
      this.setValueFormat(data, netlistData.valueFormat, true);
      this.events.dispatch(ActionType.RedrawVariable, rowId);
    });
  }

  public setValueFormat(data: WaveformData | undefined, valueFormat: ValueFormat, force: boolean) {
    if (data === undefined) {return;}
    if (data.signalWidth <= 1) {return;}

    if (data.formattedValues[valueFormat.id] === undefined) {
      data.formattedValues[valueFormat.id] = {
        formatCached: false,
        values: [] as string[],
        users: 0,
      }
      this.updateValueFormatCache(data, valueFormat, force);
    }
    console.log(data.formattedValues[valueFormat.id]);

    data.formattedValues[valueFormat.id].users++;
  }

  unsetValueFormat(data: WaveformData | undefined, valueFormat: ValueFormat) {

    if (data === undefined) {return;}
    const formatData = data.formattedValues[valueFormat.id];
    if (formatData === undefined) {return;}

    formatData.users--;
    if (formatData.users <= 0 && !this.events.isBatchMode) {
      delete data.formattedValues[valueFormat.id];
    }
  }

  public async updateValueFormatCache(data: WaveformData, valueFormat: ValueFormat, force: boolean) {
    if (data === undefined) {return;}

    const formatData = data.formattedValues[valueFormat.id];

    if (force) {
      formatData.formatCached = false;
      formatData.values       = [];
    }

    return new Promise<void>((resolve) => {
      const valueChangeData = data.valueChangeData;
      if (valueChangeData === undefined) {resolve(); return;}
      if (formatData.formatCached)       {resolve(); return;}
      //if (this.renderType.id !== "multiBit") {resolve(); return;}

      formatData.values = valueChangeData.map(([, value]) => {
        const is9State = valueFormat.is9State(value);
        return valueFormat.formatString(value, data.signalWidth, !is9State);
      });
      formatData.formatCached = true;
      resolve();
      return;
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
      const netlistData = this.rowItems[rowId];
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

  handleColorChange() {
    viewport.getThemeColors();
    this.rowItems.forEach((data) => {
      if (data instanceof NetlistVariable === false) {return;}
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
    //console.log(filteredRowIdList);
  }

  setDisplayFormat(message: any) {


    let netlistId = message.netlistId;
    let rowId = message.rowId;
    if (netlistId === undefined && rowId === undefined) {return;}
    if (rowId === undefined) {
      const matchingRows = this.getRowIdsFromNetlistId(netlistId);
      if (matchingRows.length === 0) {return;}
      const index = message.index || 0;
      rowId = matchingRows[index];
    }
    if (this.rowItems[rowId] === undefined) {return;}
    const netlistData = this.rowItems[rowId];
    if (!(netlistData instanceof NetlistVariable) && !(netlistData instanceof CustomVariable)) {return;}

    let updateAllSelected = false;
    let updateSelected = false;
    let rowIdList = [rowId];
    let redrawList = [rowId];
    if (viewerState.selectedSignal.includes(rowId)) {
      rowIdList = viewerState.selectedSignal;
      updateSelected = true;
    }

    rowIdList.forEach((rId) => {
      const data = this.rowItems[rId];

      // Row height
      if (message.rowHeight !== undefined) {
        data.rowHeight = message.rowHeight;
        viewport.updateElementHeight(rId);
        updateAllSelected = true;
      }

      if (!(data instanceof NetlistVariable) && !(data instanceof CustomVariable)) {return;}

      // Color - this is applied to all selected signals if the selected signal is being updated
      if (message.colorIndex !== undefined) {
        if (message.customColors) {
          this.customColorKey = message.customColors;
        }
        data.colorIndex = message.colorIndex;
        data.setColorFromColorIndex();
        updateAllSelected = true;
      }

      // Rendering type
      if (message.renderType !== undefined) {
        this.setRenderType(data, message.renderType);
        updateAllSelected = true;
      }

      // Vertical scale
      const isAnalog = isAnalogSignal(data.renderType);
      if (message.verticalScale !== undefined && isAnalog) {
        data.verticalScale = message.verticalScale;
      }

      // Name Type
      if (message.nameType !== undefined) {
        if (message.nameType === NameType.fullPath || 
            message.nameType === NameType.signalName || 
            message.nameType === NameType.custom) {
          data.nameType = message.nameType;
          if (message.nameType === NameType.custom && message.customName !== undefined) {
            data.customName = message.customName;
          }
          updateAllSelected = true;
        }
      }

      // Number format
      if (message.numberFormat !== undefined) {
        const valueFormat = getNumberFormatById(data, message.numberFormat);
        if (valueFormat.checkWidth(data.signalWidth)) {
          const forceUpdateValueFormat = !this.events.isBatchMode;
          this.unsetValueFormat(data.getWaveformData(), data.valueFormat);
          data.valueFormat = valueFormat;
          this.setValueFormat(data.getWaveformData(), valueFormat, forceUpdateValueFormat);
          updateAllSelected = true;
        }
      }
    });

    if (netlistData instanceof NetlistVariable) {

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
    }

    // Edge guides
    if (message.annotateValue !== undefined) {
      viewport.annotateWaveform(rowId, message.annotateValue);
      viewport.updateBackgroundCanvas(false);
      viewport.updateOverlayCanvas();
    }

    console.log('setDisplayFormat');
    sendWebviewContext(5);
    netlistData.setSignalContextAttribute();

    if (updateAllSelected && updateSelected) {redrawList = viewerState.selectedSignal;}
    redrawList.forEach((rId) => {
      this.events.dispatch(ActionType.RedrawVariable, rId);
    });
  }

  setRenderType(netlistData: NetlistVariable | CustomVariable, renderType: string) {
    if (!(netlistData instanceof NetlistVariable) && !(netlistData instanceof CustomVariable)) {return;}
    if (netlistData.signalWidth !== 1) {
      switch (renderType) {
        case "multiBit":      netlistData.renderType = new MultiBitWaveformRenderer(); break;
        case "linear":        netlistData.renderType = new LinearWaveformRenderer("linear",        netlistData.encoding, netlistData.signalWidth, false, false); break;
        case "stepped":       netlistData.renderType = new LinearWaveformRenderer("stepped",       netlistData.encoding, netlistData.signalWidth, false, true); break;
        case "linearSigned":  netlistData.renderType = new LinearWaveformRenderer("linearSigned",  netlistData.encoding, netlistData.signalWidth, true, false); break;
        case "steppedSigned": netlistData.renderType = new LinearWaveformRenderer("steppedSigned", netlistData.encoding, netlistData.signalWidth, true, true); break;
        default:              netlistData.renderType = new MultiBitWaveformRenderer(); break;
      }
    } else if (netlistData.signalWidth === 1 && renderType === "binary") {
      netlistData.renderType = new BinaryWaveformRenderer();
    }

    if (netlistData.encoding !== "Real") {
      if (renderType === 'steppedSigned' || renderType === 'linearSigned') {
        netlistData.min = Math.max(-Math.pow(2, netlistData.signalWidth - 1), -32768);
        netlistData.max = Math.min(Math.pow(2, netlistData.signalWidth - 1) - 1, 32767);
      } else {
        netlistData.min = 0;
        netlistData.max = Math.min(Math.pow(2, netlistData.signalWidth) - 1, 65535);
      }
    }

    if (netlistData.renderType.id === "multiBit") {
      this.setValueFormat(netlistData.getWaveformData(), netlistData.valueFormat, false);
    }
    netlistData.setSignalContextAttribute();
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
