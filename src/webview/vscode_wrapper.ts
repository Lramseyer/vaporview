import { createInstancePath } from "../common/functions";
import { QueueEntry, WindowMessageType, StateChangeType, NetlistId, RowId } from "../common/types";
import { SignalGroup, NetlistVariable, CustomVariable } from "./signal_item";
import { viewerState, events, createWebviewContext, viewport, rowHandler, getParentGroupIdList, labelsPanel, EventHandler, ActionType, dataManager, controlBar, styles, unload, init, revealSignal, config } from "./vaporview";
import { copyWaveDrom } from "./wavedrom";

import { differenceCiede2000, rgb } from "culori";

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(newState: unknown): void;
  getState(): unknown;
}

export enum OS {
  Mac,
  Windows,
  Linux,
  Unknown
}

// This object tracks extension settings that pertain to the webview
// Settings are registered in the following places:
// - package.json in contributes.configuration
// - extension_core/document.ts - setConfigurationSettings()
// - here - setConfigSettings()
interface ConfigSettingsMessage {
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

export class Configuration {
  touchpadScrolling: boolean        = false;
  autoTouchpadScrolling: boolean    = false;
  rulerLines: boolean               = true;
  fillMultiBitValues: boolean       = false;
  multiBitFixedHeight: boolean      = true;
  enableAnimations: boolean         = true;
  animationDuration: number         = 50;
  overrideDevicePixelRatio: boolean = false;
  userPixelRatio: number            = 1;
  disableAnalogRendererOptimizations: boolean = false;

  defaultSingleBitColor: number     = 0;
  defaultMultiBitColor: number      = 0;
  defaultParamColor: number         = 0;
  defaultStringColor: number        = 0;
  defaultEnumColor: number          = 0;
  defaultCustomSignalColor: number  = 0;

  os: OS                            = OS.Unknown;

  constructor() {
    this.os = this.getOS();
  }

  setConfigSettings(settings: ConfigSettingsMessage) {
    if (settings.scrollingMode !== undefined) {
      controlBar.setScrollMode(settings.scrollingMode);
    }
    if (settings.rulerLines !== undefined) {
      if (this.rulerLines !== settings.rulerLines) {
        this.rulerLines = settings.rulerLines;
        viewport.updateBackgroundCanvas(false);
      }
    }

    // Renderer Settings
    if (settings.fillMultiBitValues !== undefined) {
      this.fillMultiBitValues = settings.fillMultiBitValues;
      viewport.renderAllWaveforms(true);
    }

    if (settings.multiBitFixedHeight !== undefined) {
      this.multiBitFixedHeight = settings.multiBitFixedHeight;
      viewport.renderAllWaveforms(true);
    }

    if (settings.disableAnalogRendererOptimizations !== undefined) {
      this.disableAnalogRendererOptimizations = settings.disableAnalogRendererOptimizations;
    }

    // Animation Settings
    if (settings.enableAnimations !== undefined) {
      this.enableAnimations = settings.enableAnimations;
    }
    if (settings.animationDuration !== undefined) {
      this.animationDuration = settings.animationDuration;
    }

    // Default Colors
    if (settings.defaultSingleBitColor !== undefined) {
      this.defaultSingleBitColor = Math.floor(settings.defaultSingleBitColor - 1);
    }
    if (settings.defaultMultiBitColor !== undefined) {
      this.defaultMultiBitColor = Math.floor(settings.defaultMultiBitColor - 1);
    }
    if (settings.defaultParamColor !== undefined) {
      this.defaultParamColor = Math.floor(settings.defaultParamColor - 1);
    }
    if (settings.defaultStringColor !== undefined) {
      this.defaultStringColor = Math.floor(settings.defaultStringColor - 1);
    }
    if (settings.defaultEnumColor !== undefined) {
      this.defaultEnumColor = Math.floor(settings.defaultEnumColor - 1);
    }
    if (settings.defaultCustomSignalColor !== undefined) {
      this.defaultCustomSignalColor = Math.floor(settings.defaultCustomSignalColor - 1);
    }

    // Pixel Ratio
    const oldPixelRatio = viewport.pixelRatio;
    if (settings.overrideDevicePixelRatio !== undefined) {
      config.overrideDevicePixelRatio = settings.overrideDevicePixelRatio;
      viewport.setPixelRatio();
    }
    if (settings.userPixelRatio !== undefined) {
      config.userPixelRatio = settings.userPixelRatio;
      viewport.setPixelRatio();
    }
    if (oldPixelRatio !== viewport.pixelRatio) {
      // this is an expensive operation, so only do it if the pixel ratio changed
      viewport.updateViewportWidth();
    }
    viewport.setRulerVscodeContext();
  }

  getOS(): OS {
    const platform = navigator.userAgent ?? "";
    //console.log('platform', platform);
    if (/mac/i.test(platform))     return OS.Mac;
    if (/win/i.test(platform))     return OS.Windows;
    if (/linux/i.test(platform))   return OS.Linux;
    return OS.Unknown;
  }
}

interface ColorProfile {
  index: number;
  color: string;
  rgbColor: ReturnType<typeof rgb>;
  deltaBackground: number | undefined;
  deltaXZ: number | undefined;
  tier: number;
}

export class ThemeColors {

  colorKey: string[] = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];
  xzColor: string = 'red';
  textColor: string = 'white';
  rulerTextColor: string = 'grey';
  rulerGuideColor: string = 'grey';
  edgeGuideColor: string = 'orange';
  markerColor: string = 'white';
  highlightColor: string = 'blue';
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
    //this.colorKey[0] = style.getPropertyValue('--vscode-debugTokenExpression-number');
    //this.colorKey[1] = style.getPropertyValue('--vscode-debugTokenExpression-string');
    //this.colorKey[2] = style.getPropertyValue('--vscode-debugTokenExpression-type');
    //this.colorKey[3] = style.getPropertyValue('--vscode-debugTokenExpression-name');

    // Non-2-State Signal Color
    this.xzColor = style.getPropertyValue('--vscode-debugTokenExpression-error');
    //this.xzColor = style.getPropertyValue('--vscode-list-errorForeground');

    // Text Color
    this.textColor = style.getPropertyValue('--vscode-editor-foreground');

    // Ruler Color
    this.rulerTextColor = style.getPropertyValue('--vscode-editorLineNumber-foreground');
    this.rulerGuideColor = style.getPropertyValue('--vscode-editorIndentGuide-background');
    //this.edgeGuideColor = style.getPropertyValue('--vscode-terminal-findMatchBackground');
    this.edgeGuideColor = style.getPropertyValue('--vscode-terminalOverviewRuler-findMatchForeground');

    // Marker Color
    this.markerColor = style.getPropertyValue('--vscode-editorLineNumber-activeForeground');

    this.highlightColor = style.getPropertyValue('--vscode-editor-selectionBackground');

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

  // We're not done selecting a color palette here! We need to filter out
  // colors that are too close to the background color or the non-2-state color
  // Step 5: Compare the colors in the palette to the background color and the
  //         non-2-state color, and bin them based on how close they are
  // Step 6: Select from all of our top tier colors, and if we don't have
  //         enough colors, then select from the next tier, etc.
  updateColorPalette(colorPalette: string[], errorColorPalette: string[], themeValid: boolean) {

    const style = window.getComputedStyle(document.body);
    this.backgroundColor = style.getPropertyValue('--vscode-editor-background');
    this.xzColor = style.getPropertyValue('--vscode-debugTokenExpression-error');

    if (!themeValid) {
      console.log("Using default color palette because theme is not valid");
      this.colorKey = ['#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC', '#CCCCCC'];
      this.colorKey[0] = style.getPropertyValue('--vscode-debugTokenExpression-number');
      this.colorKey[1] = style.getPropertyValue('--vscode-debugTokenExpression-string');
      this.colorKey[2] = style.getPropertyValue('--vscode-debugTokenExpression-type');
      this.colorKey[3] = style.getPropertyValue('--vscode-debugTokenExpression-name');
      this.events.updateColorTheme();
      return;
    }

    if (this.backgroundColor === undefined) {return;}
    if (this.xzColor === undefined) {return;}
    const rgbBackground = rgb(this.backgroundColor);
    const rgbXZ = rgb(this.xzColor);
    if (rgbBackground === undefined) {return;}
    if (rgbXZ === undefined) {return;}

    console.log(`--- Background color: ${this.backgroundColor} rgb(${rgbBackground.r}, ${rgbBackground.g}, ${rgbBackground.b})`);
    console.log(`--- XZ color: ${this.xzColor} rgb(${rgbXZ.r}, ${rgbXZ.g}, ${rgbXZ.b})`);

    const deltaE = differenceCiede2000();
    let colorIndex = 1;

    const topTierColors: number[] = [];
    const midTierColors: number[] = [];
    const lowTierColors: number[] = [];
    const bottomTierColors: number[] = [];

    const colorProfiles: ColorProfile[] = [];

    // Arrange colors into tiers based on their distance from the background color
    // And similarity to the XZ color
    const colorList = colorPalette.concat(errorColorPalette);
    colorList.forEach((color, index) => {
      //if (topTierColors.length >= 8) {return;}
      const rgbColor = rgb(color);
      if (rgbColor === undefined) {
        colorProfiles.push({
          index: index,
          color: color,
          rgbColor: undefined,
          deltaBackground: undefined,
          deltaXZ: undefined,
          tier: 5,
        });
        return;
      }

      // round to 2 decimal places for logging
      const deltaBackground = Math.round(deltaE(rgbBackground, rgbColor) * 100) / 100;
      const deltaXZ         = Math.round(deltaE(rgbColor, rgbXZ) * 100) / 100;

      let tier = 0;
      if (deltaBackground >= 35 && deltaXZ >= 15) {
        topTierColors.push(index);
        tier = 1;
      } else if (deltaBackground >= 30 && deltaXZ >= 15) {
        midTierColors.push(index);
        tier = 2;
      } else if (deltaBackground >= 25 && deltaXZ >= 10) {
        lowTierColors.push(index);
        tier = 3;
      } else if (deltaBackground >= 15) {
        bottomTierColors.push(index);
        tier = 4;
      }

      colorProfiles.push({
        index: index,
        color: color,
        rgbColor: rgbColor,
        deltaBackground: deltaBackground,
        deltaXZ: deltaXZ,
        tier: tier,
      });

      console.log(`Color ${colorIndex} ${color} has deltaE of ${deltaBackground} from background color and deltaE of ${deltaXZ} from XZ color - tier: ${tier}`);
      colorIndex++;
    });

    const contrastSortedColors = topTierColors.concat(midTierColors).concat(lowTierColors).concat(bottomTierColors);
    const finalColorPalette: number[] = [];
    const secondaryColorPalette: number[] = [];
    const tertiaryColorPalette: number[] = [];

    // Next, we check to see how similar they are to each other, and bump them in to lower tiers if
    // they're too similar to other colors in the color palette
    contrastSortedColors.forEach(index => {
      if (finalColorPalette.length >= 8) {return;}
      const testColorProfile = colorProfiles[index];
      if (!testColorProfile) {return;}
      const testRgbColor = testColorProfile.rgbColor;
      if (testRgbColor === undefined) {return;}

      let minDelta = Infinity;
      finalColorPalette.forEach(index => {
        const paletteColorProfile = colorProfiles[index];
        if (!paletteColorProfile) {return;}
        const paletteRgbColor = paletteColorProfile.rgbColor;
        if (paletteRgbColor === undefined) {return;}
        const delta = Math.round(deltaE(testRgbColor, paletteRgbColor) * 100) / 100;
        minDelta = Math.min(minDelta, delta);
      });

      console.log(`Color ${testColorProfile.color} has minimum deltaE of ${minDelta} from colors in final palette`);

      if (minDelta >= 8) {
        finalColorPalette.push(index);
      } else if (minDelta >= 5) {
        secondaryColorPalette.push(index);
      } else {
        tertiaryColorPalette.push(index);
      }
    });

    // Lastly, we want to make sure that something kind of far from red is color 1
    const similaritySortedColors = finalColorPalette.concat(secondaryColorPalette).concat(tertiaryColorPalette);

    const color1Index   = similaritySortedColors[0];
    const color1Profile = colorProfiles[color1Index];
    const color1DeltaXZ = Math.min(color1Profile.deltaXZ ?? 0, 35);
    const color2Index   = similaritySortedColors[1];
    const color2Profile = colorProfiles[color2Index];
    const color2DeltaXZ = Math.min(color2Profile.deltaXZ ?? 0, 35);
    if (color1DeltaXZ < color2DeltaXZ) {
      // Swap color1 and color2
      similaritySortedColors[0] = color2Index;
      similaritySortedColors[1] = color1Index;
    }

    this.colorKey = similaritySortedColors.map(index => colorProfiles[index].color);
    this.events.updateColorTheme();
  }
}

interface ExternalKeyDownMessage {
  keyCommand: string;
  event?: { rowId?: RowId };
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

  handleMessage(e: MessageEvent) {
    const message = e.data;

    switch (message.command) {
      case 'initViewport':          {init(message); break;}
      case 'unload':                {unload(); break;}
      case 'getContext':            {this.sendWebviewContext(StateChangeType.None); break;}
      case 'setConfigSettings':     {config.setConfigSettings(message); break;}
      case 'apply-state':           {rowHandler.applyState(message.settings, message.stateChangeType); break;}
      case 'add-variable':          {rowHandler.addVariable(message.signalList, message.groupPath, undefined, message.index); break;}
      case 'add-separator':         {rowHandler.addSeparator(message.name, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected); break;}
      case 'add-bit-slice':         {rowHandler.addCustomVariable(message.name, message.groupPath, message.parentGroupId, message.eventRowId, undefined, message.msb, message.lsb, undefined); break;}
      case 'add-all-bit-slices':    {rowHandler.addAllBitSlices(message.name, message.groupPath, message.parentGroupId, message.eventRowId, message.bitWidth); break;}
      case 'newSignalGroup':        {rowHandler.addSignalGroup(message.groupName, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected, message.showRenameInput); break;}
      case 'setDisplayFormat':      {rowHandler.setDisplayFormat(message, false); break;}
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
      case 'updateColorPalette':    {styles.updateColorPalette(message.colorPalette, message.errorColorPalette, message.themeValid); break;}
      default:                      {this.outputLog('Unknown webview message type: ' + message.command); break;}
    }
  }

  externalKeyDownHandler(e: ExternalKeyDownMessage) {
    switch (e.keyCommand) {
      case 'nextEdge': {controlBar.goToNextTransition(1, []); break;}
      case 'previousEdge': {controlBar.goToNextTransition(-1, []); break;}
      case 'zoomToFit': {viewport.animateZoomRange(0, viewport.timeStop); break;}
      case 'increaseVerticalScale': {this.handleUpdateVerticalScale(e.event, 2); break;}
      case 'decreaseVerticalScale': {this.handleUpdateVerticalScale(e.event, 0.5); break;}
      case 'resetVerticalScale':    {this.handleUpdateVerticalScale(e.event, 0); break;}
    }
  }

  setSelectedSignal(netlistId: NetlistId | undefined) {
    if (netlistId === undefined) {return;}
    const rowIdList = rowHandler.getRowIdsFromNetlistId(netlistId);
    if (rowIdList.length === 0) {return;}
    this.events.signalSelect(rowIdList, rowIdList[0]);
    //console.log('handleSetSelectedSignal');
    this.sendWebviewContext(StateChangeType.User);
  }

  setMarker(time: number, markerType: number) {
    //console.log('handleMessage - setMarker');
    this.events.markerSet(time, markerType);
    this.sendWebviewContext(StateChangeType.User);
  }

  handleUpdateVerticalScale(event: { rowId?: RowId } | null | undefined, scale: number) {
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
      this.events.redrawVariable(rowId);
    }); 
  }

  handleRemoveVariable(rowIdList: RowId[], recursive: boolean) {
    const instancePathList: string[] = [];
    const netlistIdList: number[] = [];
    rowIdList.forEach(rowId => {
      const signalItem = rowHandler.rowItems[rowId];
      if (!(signalItem instanceof NetlistVariable)) {return;}
      const instancePath = createInstancePath(signalItem.scopePath, signalItem.signalName);
      if (signalItem.netlistId !== undefined) {
        netlistIdList.push(signalItem.netlistId);
      }
      instancePathList.push(instancePath);
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
      if (netlistData.netlistId !== undefined) {
        netlistIdList.push(netlistData.netlistId);
      }
      const instancePath = createInstancePath(netlistData.scopePath, netlistData.signalName);
      instancePathList.push(instancePath);
    });

    if (rowIdList.length === 1) {
      this.emitSignalSelectEvent(instancePathList, netlistIdList);
    }
  }

  sendWebviewContext(stateChangeType: number) {
    if (events.isBatchMode) {return;}
    const context = createWebviewContext() as Record<string, unknown>;
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

  executeCommand(command: string, args: unknown[]) {
    vscode.postMessage({
      command: 'executeCommand',
      commandName: command,
      args: args,
    });
  }

  updateConfiguration(property: string, value: unknown) {
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
    //console.log('fetchData', requestList);
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
    const uriList = dataObj.map((d: { resource: string }) => {return d.resource;});

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