import { QueueEntry, WindowMessageType, StateChangeType, NetlistId, RowId } from "../common/types";
import { SignalGroup, NetlistVariable, CustomVariable } from "./signal_item";
import { viewerState, events, createWebviewContext, viewport, rowHandler, getParentGroupIdList, labelsPanel, EventHandler, ActionType, dataManager, controlBar, styles, unload, init, revealSignal } from "./vaporview";
import { copyWaveDrom } from "./wavedrom";

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
interface VsCodeApi {
  postMessage(message: any): void;
  setState(newState: any): void;
  getState(): any;
}

export class ThemeColors {

  colorKey: string[] = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];
  customColorKey: string[] = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];

  xzColor: string = 'red';
  textColor: string = 'white';
  rulerTextColor: string = 'grey';
  rulerGuideColor: string = 'grey';
  edgeGuideColor: string = 'orange';
  markerColor: string = 'white';
  backgroundColor: string = 'black';
  dropBackgroundColor: string = 'grey';
  fontSize: string = '12px';
  fontFamily: string = 'Menlo';
  fontStyle: string = '12px Menlo';
  characterWidth: number = 7.69;
  baselineOffset: number = 0;
  markerAnnotation: string = '';
  rowHeight: number = 28;
  rulerHeight: number = 36;
  fillMultiBitValues: boolean = true;

  constructor(
    private events: EventHandler
  ) {
    this.handleUpdateColorTheme = this.handleUpdateColorTheme.bind(this);
    this.events.subscribe(ActionType.UpdateColorTheme, this.handleUpdateColorTheme);
  }

  handleUpdateColorTheme() {
    this.getThemeColors();
  }

  getThemeColors() {

    const style = window.getComputedStyle(document.body);
    // Token colors
    this.colorKey[0] = style.getPropertyValue('--vscode-debugTokenExpression-number');
    this.colorKey[1] = style.getPropertyValue('--vscode-debugTokenExpression-string');
    this.colorKey[2] = style.getPropertyValue('--vscode-debugTokenExpression-type');
    this.colorKey[3] = style.getPropertyValue('--vscode-debugTokenExpression-name');

    // Non-2-State Signal Color
    this.xzColor = style.getPropertyValue('--vscode-debugTokenExpression-error');

    // Text Color
    this.textColor = style.getPropertyValue('--vscode-editor-foreground');

    // Ruler Color
    this.rulerTextColor = style.getPropertyValue('--vscode-editorLineNumber-foreground');
    this.rulerGuideColor = style.getPropertyValue('--vscode-editorIndentGuide-background');
    //this.edgeGuideColor = style.getPropertyValue('--vscode-terminal-findMatchBackground');
    this.edgeGuideColor = style.getPropertyValue('--vscode-terminalOverviewRuler-findMatchForeground');

    // Marker Color
    this.markerColor = style.getPropertyValue('--vscode-editorLineNumber-activeForeground');

    // I calculated this as 174, 176, 173 @ 10% opacity in the default theme, but there was no CSS color that matched
    this.markerAnnotation = document.documentElement.style.getPropertyValue('--vscode-editorOverviewRuler-selectionHighlightForeground');

    // Background Color
    this.backgroundColor = style.getPropertyValue('--vscode-editor-background');

    // Drop Background Color
    this.dropBackgroundColor = style.getPropertyValue('--vscode-list-dropBackground');

    // Font
    this.fontSize = style.getPropertyValue('--vscode-editor-font-size');
    this.fontFamily = style.getPropertyValue('--vscode-editor-font-family');
    this.fontStyle = this.fontSize + ' ' + this.fontFamily;

    // Look through all of the fonts in the fontFamily to see which font was used
    const fontList = this.fontFamily.split(',').map((font) => font.trim());
    let usedFont = '';
    for (let i = 0; i < fontList.length; i++) {
      const font = fontList[i];
      if (document.fonts.check('12px ' + font)) {
        usedFont = fontList[i];
        break;
      }
    }

    // Somebody help me with this, because I don't have all of these fonts
    switch (usedFont) {
      case 'Monaco':          this.characterWidth = 7.20; break;
      case 'Menlo':           this.characterWidth = 7.22; break;
      case 'Consolas':        this.characterWidth = 7.69; this.baselineOffset = 1; break;
      case 'Droid Sans Mono': this.characterWidth = 7.69; break;
      case 'Inconsolata':     this.characterWidth = 7.69; break;
      case 'Courier New':     this.characterWidth = 7.69; break;
      default:                this.characterWidth = 7.69; break;
    }

    this.rowHeight   = parseInt(style.getPropertyValue('--waveform-height'));
    this.rulerHeight = parseInt(style.getPropertyValue('--ruler-height'));
  }
}

export class VscodeWrapper {

  constructor(private events: EventHandler) {
    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);
    this.handleMarkerSet    = this.handleMarkerSet.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);

    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
  }

  webviewReady() {
    vscode.postMessage({command: 'ready'});
  }

  handleMessage(e: any) {
    const message = e.data;

    switch (message.command) {
      case 'initViewport':          {init(message.metadata, message.uri, message.documentId); break;}
      case 'unload':                {unload(); break;}
      case 'setConfigSettings':     {this.handleSetConfigSettings(message); break;}
      case 'getContext':            {this.sendWebviewContext(StateChangeType.None); break;}
      case 'apply-state':           {rowHandler.applyState(message.settings, message.stateChangeType); break;}
      case 'add-variable':          {rowHandler.addVariable(message.signalList, message.groupPath, undefined, message.index); break;}
      case 'add-separator':         {rowHandler.addSeparator(message.name, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected); break;}
      case 'add-bit-slice':         {rowHandler.addCustomVariable(message.name, message.groupPath, message.parentGroupId, message.eventRowId, undefined, message.msb, message.lsb, undefined); break;}
      case 'add-all-bit-slices':    {rowHandler.addAllBitSlices(message.name, message.groupPath, message.parentGroupId, message.eventRowId); break;}
      case 'newSignalGroup':        {rowHandler.addSignalGroup(message.groupName, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected, message.showRenameInput); break;}
      case 'setDisplayFormat':      {rowHandler.setDisplayFormat(message); break;}
      case 'renameSignalGroup':     {rowHandler.renameSignalGroup(message.rowId, message.groupName); break;}
      case 'editSignalGroup':       {rowHandler.editSignalGroup(message); break;}
      case 'remove-signal':         {rowHandler.removeVariable(message.netlistId, message.rowId, message.removeAllSelected); break;}
      case 'remove-group':          {rowHandler.removeSignalGroup(message.groupId, message.recursive); break;}
      case 'remove-separator':      {rowHandler.removeVariable(undefined, message.rowId, message.removeAllSelected); break;}
      case 'update-waveform-chunk': {dataManager.updateWaveformChunk(message); break;}
      case 'update-waveform-chunk-compressed': {dataManager.updateWaveformChunkCompressed(message); break;}
      case 'update-enum-chunk':     {dataManager.updateEnumChunk(message); break;}
      case 'handle-keypress':       {this.externalKeyDownHandler(message); break;}
      case 'setWaveDromClock':      {dataManager.waveDromClock = {netlistId: message.netlistId, edge:  message.edge,}; break;}
      case 'setMarker':             {this.setMarker(message.time, message.markerType); break;}
      case 'setViewportTo':         {viewport.moveViewToTime(message.time); break;}
      case 'setViewportRange':      {viewport.setViewportRange(message.startTime, message.endTime); break;}
      case 'setTimeUnits':          {viewport.updateUnits(message.units, true); break;}
      case 'setSelectedSignal':     {this.setSelectedSignal(message.netlistId); break;}
      case 'copyWaveDrom':          {copyWaveDrom(); break;}
      case 'copyValueAtMarker':     {labelsPanel.copyValueAtMarker(message.rowId); break;}
      case 'updateColorTheme':      {this.events.dispatch(ActionType.UpdateColorTheme); break;}
      default:                      {this.outputLog('Unknown webview message type: ' + message.command); break;}
    }
  }

  externalKeyDownHandler(e: any) {
    switch (e.keyCommand) {
      case 'nextEdge': {controlBar.goToNextTransition(1, []); break;}
      case 'previousEdge': {controlBar.goToNextTransition(-1, []); break}
      case 'zoomToFit': {this.events.dispatch(ActionType.Zoom, Infinity, 0, 0); break}
      case 'increaseVerticalScale': {this.handleUpdateVerticalScale(e.event, 2); break;}
      case 'decreaseVerticalScale': {this.handleUpdateVerticalScale(e.event, 0.5); break;}
      case 'resetVerticalScale':    {this.handleUpdateVerticalScale(e.event, 0); break;}
    }
  }

  handleSetConfigSettings(settings: any) {
    if (settings.scrollingMode !== undefined) {
      controlBar.setScrollMode(settings.scrollingMode);
    }
    if (settings.rulerLines !== undefined) {
      viewport.setRulerLines(settings.rulerLines);
    }
    if (settings.fillMultiBitValues !== undefined) {
      styles.fillMultiBitValues = settings.fillMultiBitValues;
      viewport.renderAllWaveforms(true);
      viewport.setRulerVscodeContext();
    }
    if (settings.customColors !== undefined) {
      styles.customColorKey = settings.customColors;
    }
  }

  setSelectedSignal(netlistId: NetlistId | undefined) {
    if (netlistId === undefined) {return;}
    const rowIdList = rowHandler.getRowIdsFromNetlistId(netlistId);
    if (rowIdList.length === 0) {return;}
    this.events.dispatch(ActionType.SignalSelect, rowIdList, rowIdList[0]);
    console.log('handleSetSelectedSignal');
    this.sendWebviewContext(StateChangeType.User);
  }

  setMarker(time: number, markerType: number) {
    console.log('handleMessage - setMarker');
    this.events.dispatch(ActionType.MarkerSet, time, markerType);
    this.sendWebviewContext(StateChangeType.User);
  }

  handleUpdateVerticalScale(event: any, scale: number) {
    let rowIdList: RowId[] = viewerState.selectedSignal;
    if (event && event.rowId !== undefined && !viewerState.selectedSignal.includes(event.rowId)) {
      rowIdList = [event.rowId];
    }

    rowIdList.forEach((rowId) => {
      if (rowId === null) {return;}
      const netlistData = rowHandler.rowItems[rowId];
      if (!(netlistData instanceof NetlistVariable) && !(netlistData instanceof CustomVariable)) {return;}
      const renderType = netlistData.renderType.id;
      if (renderType === "multiBit" || renderType === "binary") {return;}
      netlistData.verticalScale = Math.max(1, netlistData.verticalScale * scale);
      this.events.dispatch(ActionType.RedrawVariable, rowId);
    }); 
  }

  handleRemoveVariable(rowIdList: RowId[], recursive: boolean) {
    const instancePathList: string[] = [];
    const netlistIdList: number[] = []
    rowIdList.forEach(rowId => {
      const signalItem = rowHandler.rowItems[rowId];
      if (!(signalItem instanceof NetlistVariable)) {return;}
      netlistIdList.push(signalItem.netlistId);
      instancePathList.push(signalItem.scopePath + '.' + signalItem.signalName);
    });

    this.emitRemoveVariableEvent(instancePathList, netlistIdList);
  }

  handleMarkerSet(time: number, markerType: number) {
    if (time > viewport.timeStop || time < 0) {return;}
    this.emitMarkerSetEvent(time, viewport.timeUnit);
  }

  handleSignalSelect(rowIdList: RowId[], lastSelected: RowId | null = null) {

    const netlistIdList: number[] = [];
    const instancePathList: string[] = [];
    rowIdList.forEach(rowId => {
      const netlistData = rowHandler.rowItems[rowId];
      if (netlistData === undefined) {return;}
      if (!(netlistData instanceof NetlistVariable)) {return;}
      netlistIdList.push(netlistData.netlistId);
      let instancePath = netlistData.scopePath + '.' + netlistData.signalName;
      if (netlistData.scopePath === "") {instancePath = netlistData.signalName;}
      instancePathList.push(instancePath);
    });

    if (rowIdList.length === 1) {
      this.emitSignalSelectEvent(instancePathList, netlistIdList);
    }
  }

  sendWebviewContext(stateChangeType: number) {
    if (events.isBatchMode) {return;}
    const context: any = createWebviewContext();
    context.stateChangeType = stateChangeType;
    vscode.setState(context);
    context.command = 'contextUpdate';
    vscode.postMessage(context);
  }

  restoreState() {
    const state = vscode.getState();
    vscode.postMessage({
      command: 'restoreState',
      state: state,
      uri: viewerState.uri,
    });
  }

  executeCommand(command: string, args: any[]) {
    vscode.postMessage({
      command: 'executeCommand',
      commandName: command,
      args: args,
    });
  }

  updateConfiguration(property: string, value: any) {
    vscode.postMessage({
      command: 'updateConfiguration',
      property: property,
      value: value,
    });
  }

  showMessage(messageType: WindowMessageType, message: string) {
    vscode.postMessage({
      command: 'showMessage',
      messageType: messageType,
      message: message,
    });
  }

  copyToClipboard(text: string) {
    vscode.postMessage({
      command: 'copyToClipboard',
      text: text,
    });
  }

  fetchData(requestList: QueueEntry[]) {
    console.log('fetchData', requestList);
    vscode.postMessage({
      command: 'fetchDataFromFile',
      requestList: requestList,
    });
  }

  outputLog(message: string) {
    vscode.postMessage({
      command: 'logOutput',
      message: message,
    });
  }

  emitRemoveVariableEvent(instancePathList: string[], netlistIdList: number[]) {
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'removeVariable',
      uri: viewerState.uri,
      instancePath: instancePathList,
      netlistId: netlistIdList,
    });
  }

  emitSignalSelectEvent(instancePathList: string[], netlistIdList: number[]) {
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'signalSelect',
      uri: viewerState.uri,
      instancePath: instancePathList,
      netlistId: netlistIdList,
    });
  }

  emitMarkerSetEvent(time: number, units: string) {
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'markerSet',
      uri: viewerState.uri,
      time: time,
      units: viewport.timeUnit,
    });
  }

  handleDrop(e: DragEvent) {
    e.preventDefault();

    if (!e.dataTransfer) {return;}
    const data    = e.dataTransfer.getData('codeeditors');
    if (!data) {return;}
    const dataObj = JSON.parse(data);
    const uriList = dataObj.map((d: any) => {return d.resource;});

    const {newGroupId, newIndex} = labelsPanel.dragEndExternal(e, false);

    // get the group path for the new group id
    let groupPath: string[] = [];
    const groupRowId = rowHandler.groupIdTable[newGroupId];
    if (groupRowId || groupRowId === 0) {
      groupPath = getParentGroupIdList(groupRowId).map((id) => {
        const item = rowHandler.rowItems[rowHandler.groupIdTable[id]];
        if (item instanceof SignalGroup) {
          return item.label;
        }
        return '';
      });
      const groupItem = rowHandler.rowItems[groupRowId];
      if (groupItem instanceof SignalGroup) {
        groupPath.push(groupItem.label);
      }
    }

    vscode.postMessage({
      command: 'handleDrop',
      groupPath: groupPath,
      dropIndex: newIndex,
      resourceUriList: uriList,
      uri: viewerState.uri,
    });
  }
}