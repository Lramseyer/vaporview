import { type NetlistId, SignalId, type RowId, EnumData, EnumEntry, QueueEntry, SignalQueueEntry, type EnumQueueEntry, NameType, StateChangeType, CollapseState, type BitRangeSource } from '../common/types';
import { bitRangeString } from '../common/functions';
import { ActionType, dataManager, type EventHandler, viewerState, getParentGroupId, updateDisplayedSignalsFlat, labelsPanel, controlBar, sendWebviewContext, getIndexInGroup, getChildrenByGroupId, viewport } from './vaporview';
import { NetlistVariable, type RowItem, SignalGroup, SignalSeparator, CustomVariable, isAnalogSignal } from './signal_item';
import { BinaryWaveformRenderer, MultiBitWaveformRenderer, LinearWaveformRenderer } from './renderer';
import type { WaveformData } from './data_manager';
import { type ValueFormat, getNumberFormatById } from './value_format';

export class RowHandler {

  rowItems: RowItem[]         = []; // rowId is the key/index, RowItem is the value
  groupIdTable: RowId[]       = []; // group ID is the key/index, rowId is the value
  private nextRowId: number   = 0;
  private nextGroupId: number = 1;

  constructor(private events: EventHandler) {

    this.handleColorChange = this.handleColorChange.bind(this);
    this.handleReorderSignals = this.handleReorderSignals.bind(this);
    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);

    this.events.subscribe(ActionType.UpdateColorTheme, this.handleColorChange);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
  }

  unload() {
    this.rowItems     = [];
    this.groupIdTable = [];
    this.nextRowId    = 0;
    this.nextGroupId  = 1;
  }

  private flushRowCache(force: boolean) {
    if (viewerState.displayedSignalsFlat.length === 0 || force) {
      this.unload();
    }
  }

  getGroupByIdOrName(groupPath: string[] | undefined, parentGroupId: number | undefined): SignalGroup | null {
    let groupId = 0;
    const groupIsValid = false;

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
      const data = this.rowItems[rowId];
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
      const rowId       = this.nextRowId;
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
      if (dataManager.valueChangeData[signalId] !== undefined) {
        //selectedSignal = [rowId];
        if (!this.events.isBatchMode) {
          updateFlag     = true;
        }
        const data = dataManager.valueChangeData[varItem.signalId];
        this.setValueFormat(data, varItem.valueFormat, false);
        labelsPanel.valueAtMarker[rowId] = varItem.getValueAtTime(viewerState.markerTime);
      } else {
        const signalQueueEntry: SignalQueueEntry = {
          type: 'signal',
          signalId: signalId,
          rowId: rowId,
        };
        signalIdList.push(signalQueueEntry);
      }

      // Check for enum type
      if (enumType !== undefined && enumType !== "" ) {
        if (dataManager.enumTable[enumType] === undefined) {
          enumTableList.push({type: 'enum', name: enumType, netlistId: netlistId} as EnumQueueEntry);
        }
      }
    });

    dataManager.requestData(signalIdList, enumTableList);
    viewerState.displayedSignals = viewerState.displayedSignals.concat(rowIdList);
    updateDisplayedSignalsFlat();
    this.events.dispatch(ActionType.AddVariable, rowIdList, updateFlag);

    let reorder = false;
    let groupId = 0;
    let moveIndex = 0;

    // If a location was specified, use it
    const groupItem = this.getGroupByIdOrName(groupPath, parentGroupId);
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
    sendWebviewContext(StateChangeType.User);
    return rowIdList;
  }

  addSignalGroup(name: string | undefined, groupPath: string[] | undefined, inputParentGroupId: number | undefined, eventRowId: number | undefined, moveSelected: boolean): number | undefined {
    if (controlBar.searchInFocus || labelsPanel.renameActive) {return;}

    const groupId = this.nextGroupId;
    const rowId = this.nextRowId;

    let parentGroupId = 0;
    let reorder = false;
    let index = viewerState.displayedSignalsFlat.length;
    const parentGroup = this.getGroupByIdOrName(groupPath, inputParentGroupId);
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
    sendWebviewContext(StateChangeType.User);

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
    const parentGroup = this.getGroupByIdOrName(groupPath, parentGroupId);
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
    sendWebviewContext(StateChangeType.User);
    return rowId;
  }

  addBitSlice(name: string | undefined, groupPath: string[] | undefined, parentGroupId: number | undefined, eventRowId: number | undefined, netlistId: NetlistId | undefined, msb: number, lsb: number) {
    console.log('addBitSlice', name, groupPath, parentGroupId, eventRowId, netlistId, msb, lsb);
    if (controlBar.searchInFocus || labelsPanel.renameActive) {return;}
    const rowId = this.nextRowId;
    this.nextRowId++;

    // get the source signal item
    let sourceSignalItem: RowItem | undefined;
    if (eventRowId !== undefined) {
      sourceSignalItem = this.rowItems[eventRowId];
    } else if (netlistId !== undefined) {
      const signalItems = this.getRowIdsFromNetlistId(netlistId);
      if (signalItems.length > 0) {
        sourceSignalItem = this.rowItems[signalItems[0]];
      }
    }
    if (!(sourceSignalItem instanceof NetlistVariable)) {return;}
    const sourceSignalId = sourceSignalItem.signalId;

    // Create custom signal
    const source: BitRangeSource = {
      netlistId: sourceSignalItem.netlistId,
      signalId: sourceSignalId,
      msb: msb,
      lsb: lsb,
    };
    const customSignalId = dataManager.newCustomSignal([source]);
    const width          = msb - lsb + 1;
    const signalName     = name || [sourceSignalItem.scopePath, sourceSignalItem.signalName].join(".") + bitRangeString(msb, lsb);
    const renderType     = width === 1 ? new BinaryWaveformRenderer() : new MultiBitWaveformRenderer();
    const customVariable = new CustomVariable(rowId, [source], customSignalId, signalName, width, renderType);
    this.rowItems[rowId] = customVariable;
    const customSignalData = dataManager.customValueChangeData[customSignalId];
    if (!customSignalData) {return;}

    let drawFlag = false;
    if (customSignalData.dataLoaded) {
      console.log('custom signal found and loaded', customSignalId);
      drawFlag = true;
    } else if (dataManager.valueChangeData[sourceSignalId] !== undefined) {
      dataManager.updateCustomSignal(customSignalId);
      drawFlag = true;
    } else {
      const signalQueueEntry: SignalQueueEntry = {
        type: 'signal',
        signalId: sourceSignalId,
        rowId: rowId,
        customSignalId: customSignalId,
      };
      dataManager.requestData([signalQueueEntry], []);
    }

    if (drawFlag) {
      this.setValueFormat(customVariable.getWaveformData(), customVariable.valueFormat, false);
      labelsPanel.valueAtMarker[rowId] = customVariable.getValueAtTime(viewerState.markerTime);
    }

    viewerState.displayedSignals = viewerState.displayedSignals.concat(rowId);
    updateDisplayedSignalsFlat();
    this.events.dispatch(ActionType.AddVariable, [rowId], false);

    let reorder = false;
    let index = viewerState.displayedSignalsFlat.length;
    const parentGroup = this.getGroupByIdOrName(groupPath, parentGroupId);
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
    sendWebviewContext(StateChangeType.User);
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
      dataManager.garbageCollectValueFormats();
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

    const groupItem = this.getGroupByIdOrName(groupPath, groupId);
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

  removeVariable(netlistId: NetlistId | undefined, rowId: RowId | undefined, removeAllSelected: boolean | undefined) {

    let removeList: RowId[] = [];
    if (rowId !== undefined) {
      removeList = [rowId];
      if (viewerState.selectedSignal.includes(rowId) && removeAllSelected) {
        removeList = viewerState.selectedSignal;
      }
    } else if (netlistId !== undefined) {
      removeList = this.getRowIdsFromNetlistId(netlistId);
    } else {
      return;
    }

    const index = viewerState.visibleSignalsFlat.indexOf(viewerState.selectedSignal[0]);

    this.events.dispatch(ActionType.RemoveVariable, removeList, true);

    if (viewerState.selectedSignal.length === 1 && removeList.includes(viewerState.selectedSignal[0])) {
      const newIndex = Math.max(0, Math.min(viewerState.visibleSignalsFlat.length - 1, index));
      const newRowId = viewerState.visibleSignalsFlat[newIndex];
      this.events.dispatch(ActionType.SignalSelect, [newRowId], newRowId);
    } else {
      const newSelected = viewerState.selectedSignal.filter((id) => removeList.includes(id) === false);
      this.events.dispatch(ActionType.SignalSelect, newSelected, viewerState.lastSelectedSignal);
    }
    console.log('removeVariable');
    sendWebviewContext(StateChangeType.User);
  }

  removeSignalGroup(groupId: number, recursive: boolean) {
    if (groupId === 0) {return;}
    const rowId = this.groupIdTable[groupId];
    if (rowId === undefined) {return;}
    const index = viewerState.visibleSignalsFlat.indexOf(rowId);

    const removeAllSelected = true;
    let rowIdList: RowId[] = [rowId];
    if (viewerState.selectedSignal.includes(rowId) && removeAllSelected) {
      rowIdList = viewerState.selectedSignal;
    }

    const newSelected = viewerState.selectedSignal;
    const removeList: RowId[] = []
    rowIdList.forEach((rId) => {
      const groupItem = this.rowItems[rId];
      if (!(groupItem instanceof SignalGroup)) {return;}
      const childRowIdList = groupItem.getFlattenedRowIdList(false, -1);
      let newSelected = viewerState.selectedSignal.map(id => id);
      childRowIdList.forEach((childRowId) => {
        if (newSelected.includes(childRowId)) {
          newSelected = newSelected.filter(id => id !== childRowId);
        }
      });
      removeList.push(rId);
    });
    this.events.dispatch(ActionType.RemoveVariable, removeList, recursive);

    if (newSelected.length === 1) {
      const newIndex = Math.max(0, Math.min(viewerState.visibleSignalsFlat.length - 1, index));
      const newRowId = viewerState.visibleSignalsFlat[newIndex];
      this.events.dispatch(ActionType.SignalSelect, [newRowId], newRowId);
    } else {
      this.events.dispatch(ActionType.SignalSelect, newSelected, viewerState.lastSelectedSignal);
    }
    console.log('removeSignalGroup');
    sendWebviewContext(StateChangeType.User);
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
        disposedRowIdList = signalItem.getFlattenedRowIdList(false, -1);
      } else if (signalItem instanceof SignalGroup) {
        signalItem.collapseState = CollapseState.Expanded;
        signalItem.showHideViewportRows();
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

    const netlistId = message.netlistId;
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
          dataManager.customColorKey = message.customColors;
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
    sendWebviewContext(StateChangeType.User);
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
        netlistData.min = Math.max(-(2 ** (netlistData.signalWidth - 1)), -32768);
        netlistData.max = Math.min(2 ** (netlistData.signalWidth - 1) - 1, 32767);
      } else {
        netlistData.min = 0;
        netlistData.max = Math.min(2 ** netlistData.signalWidth - 1, 65535);
      }
    }

    if (netlistData.renderType.id === "multiBit") {
      this.setValueFormat(netlistData.getWaveformData(), netlistData.valueFormat, false);
    }
    netlistData.setSignalContextAttribute();
  }

}
