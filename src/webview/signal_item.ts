import { dataManager, viewport, CollapseState, NetlistId, RowId, viewerState, updateDisplayedSignalsFlat, events, ActionType, getRowHeightCssClass, WAVE_HEIGHT } from "./vaporview";
import { EnumValueFormat, formatBinary, formatHex, formatString, ValueFormat } from "./value_format";
import { WaveformRenderer } from "./renderer";
import { customColorKey } from "./data_manager";
import { vscode, labelsPanel } from "./vaporview";
import { LabelsPanels } from "./labels";
import { group } from "console";

export function htmlSafe(string: string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlAttributeSafe(string: string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export abstract class SignalItem {

  public labelElement: HTMLElement | null = null
  public valueDisplayElement: HTMLElement | null = null
  public viewportElement: HTMLElement | null = null
  public vscodeContext: string = "";
  public wasRendered: boolean = false;
  public rowHeight: number = 1;
  public isSelected: boolean = false;

  public abstract createLabelElement(): string
  public abstract createValueDisplayElement(): string
  public abstract getValueAtTime(time: number): string[]
  public getNearestTransition(time: number) {return null}
  public formatVlaue(value: any): string {return "";}
  public renderWaveform() {return;}
  public handleValueLink(time: number, snapToTime: number) {return;}
  public getAllEdges(valueList: string[]): number[] {return [];}
  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {return null;}
  public abstract resize(): void
  public dispose() {return;}
}

export interface RowItem {
  labelElement: HTMLElement | null;
  valueDisplayElement: HTMLElement | null;
  viewportElement: HTMLElement | null;
  vscodeContext: string;
  wasRendered: boolean;
  rowHeight: number;
  isSelected: boolean;
  netlistId?: NetlistId;

  createLabelElement(): string;
  createValueDisplayElement(): string;
  createViewportElement(rowId: number): void;
  setSignalContextAttribute(): void;
  getLabelText(): string;
  getValueAtTime(time: number): string[];
  getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[];
  rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number
  findParentGroupId(rowId: RowId): number | null;
  getAllEdges(valueList: string[]): number[];
  getNextEdge(time: number, direction: number, valueList: string[]): number | null;
  getNearestTransition(time: number): [number, string] | null;
  renderWaveform(): void;
  handleValueLink(time: number, snapToTime: number): void;
  resize(): void;
  dispose(): void;
}

export class VariableItem extends SignalItem implements RowItem {

  public valueFormat: ValueFormat;
  public valueLinkCommand: string = "";
  public valueLinkBounds: [number, number][] = [];
  public valueLinkIndex: number = -1;
  public colorIndex: number = 0;
  public color: string = "";
  public rowHeight: number = 1;
  public formattedValues: string[] = [];
  public formatCached: boolean = false;
  public wasRendered: boolean = false;
  public canvas: HTMLCanvasElement | null = null
  public ctx: CanvasRenderingContext2D | null = null
  public verticalScale: number = 1;

  constructor(
    public readonly netlistId: number,
    public signalId: number,
    public signalName: string,
    public scopePath: string,
    public signalWidth: number,
    public variableType: string,
    public encoding: string,
    public renderType: WaveformRenderer,
    public enumType: string,
  ) {
    super();

    if (this.encoding === "String") {
      this.valueFormat = formatString;
      this.colorIndex  = 1;
    } else if (this.encoding === "Real") {
      this.valueFormat = formatString;
    } else if (this.enumType !== "") {
      this.valueFormat = new EnumValueFormat(this.enumType);
    } else {
      this.valueFormat = this.signalWidth === 1 ? formatBinary : formatHex;
    }
    this.setSignalContextAttribute();
    this.setColorFromColorIndex();
  }

  public createLabelElement() {

    const rowId         = dataManager.netlistIdTable[this.netlistId];
    const height        = getRowHeightCssClass(this.rowHeight);
    const signalName    = htmlSafe(this.signalName);
    const scopePath     = htmlSafe(this.scopePath + '.');
    const fullPath      = htmlAttributeSafe(scopePath + signalName);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label is-idle" id="label-${rowId}" title="${tooltip}" data-vscode-context=${this.vscodeContext}>
              <div class='waveform-row ${selectorClass} ${height}'>
                <p style="opacity:50%">${scopePath}</p><p>${signalName}</p>
              </div>
            </div>`;
    }

  public createValueDisplayElement() {
    const rowId = dataManager.netlistIdTable[this.netlistId];
    let   value = labelsPanel.valueAtMarker[rowId];
    if (value === undefined) {value = [];}
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    const height        = getRowHeightCssClass(this.rowHeight);
    const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
    const parseValue    = this.valueFormat.formatString;
    const valueIs9State = this.valueFormat.is9State;
    const pElement      = value.map((v: string) => {
      const is9State     = valueIs9State(v);
      const colorStyle   = is9State ? 'var(--vscode-debugTokenExpression-error)' : this.color;
      const displayValue = parseValue(v, this.signalWidth, !is9State);
      return `<p style="color:${colorStyle}">${displayValue}</p>`;
    }).join(joinString);

    return `<div class="value-display-item ${selectorClass} ${height}" id="value-${rowId}" data-vscode-context=${this.vscodeContext}>${pElement}</div>`;
  }

  public createViewportElement(rowId: number) {

    const canvas = document.createElement('canvas');
    canvas.setAttribute('id', 'waveform-canvas-' + rowId);
    canvas.classList.add('waveform-canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const canvasHeight = (this.rowHeight * WAVE_HEIGHT) - 8;
    if (this.ctx) {
      viewport.resizeCanvas(canvas, this.ctx, viewport.viewerWidth, canvasHeight);
    }
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    waveformContainer.appendChild(canvas);
    waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    const renderType = this.renderType.id;
    const isAnalog = renderType === 'linear' || renderType === 'linearSigned' || 
                    renderType === 'stepped' || renderType === 'steppedSigned';
    this.vscodeContext = `${JSON.stringify({
      webviewSection: "signal",
      scopePath: this.scopePath,
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      preventDefaultContextMenuItems: true,
      commandValid: this.valueLinkCommand !== "",
      netlistId: this.netlistId,
      rowId: dataManager.netlistIdTable[this.netlistId],
      isAnalog: isAnalog,
      enum: this.enumType !== "",
    }).replace(/\s/g, '%x20')}`;
  }

  public getLabelText(): string {
    return [this.scopePath, this.signalName].join('.');
  }

  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    const rowId = dataManager.netlistIdTable[this.netlistId];
    if (ignoreRowId === rowId) {return [];}
    return [rowId];
  }

  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {
    return 1;
  }

  public findParentGroupId(rowId: RowId): number | null {return null;}

  public renderWaveform() {

    const signalId = this.signalId;
    const data     = dataManager.valueChangeData[signalId];

    if (!data) {return;}
    if (!this.ctx) {return;}

    // find the closest timestampt to timeScrollLeft
    const valueChanges = data.transitionData;
    const startIndex   = Math.max(dataManager.binarySearch(valueChanges, viewport.timeScrollLeft - (2 * viewport.pixelTime)), 1);
    const endIndex     = dataManager.binarySearch(valueChanges, viewport.timeScrollRight);
    const initialState = valueChanges[startIndex - 1];
    let   postState    = valueChanges[endIndex];

    if (endIndex >= valueChanges.length) {
      postState = [viewport.viewerWidth * viewport.pixelTime, ''];
    }

    const valueChangeChunk = {
      valueChanges: valueChanges,
      startIndex: startIndex,
      endIndex: endIndex,
      initialState: initialState,
      postState: postState,
      encoding: this.encoding,
      signalWidth: this.signalWidth,
      min: data.min,
      max: data.max,
    };
  
    // I should probably move this functionally into the data manager
    if (this.encoding !== "Real") {
      if (this.renderType.id === 'steppedSigned' || this.renderType.id === 'linearSigned') {
        valueChangeChunk.min = Math.max(-Math.pow(2, this.signalWidth - 1), -32768);
        valueChangeChunk.max = Math.min(Math.pow(2, this.signalWidth - 1) - 1, 32767);
      } else {
        valueChangeChunk.min = 0;
        valueChangeChunk.max = Math.min(Math.pow(2, this.signalWidth) - 1, 65535);
      }
    }

    this.renderType.draw(valueChangeChunk, this, viewport);
    this.wasRendered = true;
  }

  public getValueAtTime(time: number) {
  
    const result: string[] = [];
    const signalId = this.signalId;
    const data     = dataManager.valueChangeData[signalId];
  
    if (!data) {return result;}
  
    const transitionData  = data.transitionData;
    const transitionIndex = dataManager.getNearestTransitionIndex(signalId, time);

    if (transitionIndex === -1) {return result;}
    if (transitionIndex > 0) {
      result.push(transitionData[transitionIndex - 1][1]);
    }
  
    if (transitionData[transitionIndex][0] === time) {
      result.push(transitionData[transitionIndex][1]);
    }
  
    return result;
  }

  public getNearestTransition(time: number) {

    const signalId = this.signalId;
    const result = null;
    if (time === null) {return result;}

    const data  = dataManager.valueChangeData[signalId].transitionData;
    const index = dataManager.getNearestTransitionIndex(signalId, time);
    
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

  public setColorFromColorIndex() {
    const colorIndex = this.colorIndex;
    if (colorIndex < 4) {
      this.color = viewport.colorKey[colorIndex];
    } else {
      this.color = customColorKey[colorIndex - 4];
    }
  }

  public async cacheValueFormat(force: boolean) {
    if (force) {
      this.formatCached = false;
      this.formattedValues = [];
    }
    return new Promise<void>((resolve) => {
      const valueChangeData = dataManager.valueChangeData[this.signalId];
      if (valueChangeData === undefined)     {resolve(); return;}
      if (this.renderType.id !== "multiBit") {resolve(); return;}
      if (this.formatCached)                 {resolve(); return;}

      this.formattedValues = valueChangeData.transitionData.map(([, value]) => {
        const is9State = this.valueFormat.is9State(value);
        return this.valueFormat.formatString(value, this.signalWidth, !is9State);
      });
      this.formatCached = true;
      resolve();
      return;
    });
  }

  public getAllEdges(valueList: string[]): number[] {
    const signalId         = this.signalId;
    const data             = dataManager.valueChangeData[signalId];
    if (!data) {return [];}
    const valueChangeData  = data.transitionData;
    const result: number[] = [];

    if (valueList.length > 0) {
      if (this.signalWidth === 1) {
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

  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {
    const signalId         = this.signalId;
    const data             = dataManager.valueChangeData[signalId];
    if (!data) {return null;}
    const valueChangeData  = data.transitionData;
    const valueChangeIndex = dataManager.getNearestTransitionIndex(signalId, time);
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

  public resize() {
    if (!this.canvas || !this.ctx) {return;}
    const canvasHeight = (this.rowHeight * WAVE_HEIGHT) - 8;
    viewport.resizeCanvas(this.canvas, this.ctx, viewport.viewerWidth, canvasHeight);
  }

  handleValueLinkMouseOver(event: MouseEvent) {
    this.mouseOverHandler(event, true);
  }

  handleValueLinkMouseExit(event: MouseEvent) {
    this.mouseOverHandler(event, false);
  }

  mouseOverHandler(event: MouseEvent, checkBounds: boolean) {
    if (!event.target) {return;}

    let redraw        = false;
    let valueIndex    = -1;

    if (checkBounds) {
      const elementX    = event.pageX - viewport.scrollAreaBounds.left;
      this.valueLinkBounds.forEach(([min, max], i) => {
        if (elementX >= min && elementX <= max) {
          valueIndex = i;
        }
      })
    }

    // store a pointer to the netlistData object for a keydown event handler
    if (valueIndex >= 0) {
      viewport.valueLinkObject = this;
    } else {
      viewport.valueLinkObject = null;
    }

    // Check to change cursor to a pointer
    if (valueIndex >= 0 && (event.ctrlKey || event.metaKey)) {
      this.canvas?.classList.add('waveform-link');
    } else {
      this.canvas?.classList.remove('waveform-link');
    }

    if (valueIndex !== this.valueLinkIndex) {redraw = true;}
    this.valueLinkIndex = valueIndex;

    if (redraw) {
      this.wasRendered = false;
      this.renderWaveform();
    }
  }

  handleValueLink(time: number, snapToTime: number): boolean {

    if (this.valueLinkCommand === "") {return false;}
    if (this.renderType.id !== 'multiBit') {return false;}
    if (this.valueLinkIndex < 0) {return false;}
    if (time !== snapToTime) {return false;}

    const command        = this.valueLinkCommand;
    const signalId       = this.signalId;
    const index          = dataManager.getNearestTransitionIndex(signalId, time) - 1;
    const valueChange    = dataManager.valueChangeData[signalId].transitionData[index];
    const timeValue      = valueChange[0];
    const value          = valueChange[1];
    const formattedValue = this.formattedValues[index];

    const event = {
      netlistId: this.netlistId,
      scopePath: this.scopePath,
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      encoding: this.encoding,
      numberFormat: this.valueFormat.id,
      value: value,
      formattedValue: formattedValue,
      time: timeValue,
    }

    vscode.postMessage({ command: 'executeCommand', commandName: command, args: event });
    return true;
  }

  public dispose() {
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
  }
}

export class SignalGroup extends SignalItem implements RowItem {

  public collapseState: CollapseState = CollapseState.Expanded;
  public children: RowId[] = [];

  constructor(
    public rowId: number,
    public label: string,
    public readonly groupId: number
  ) {
    super();
    this.setSignalContextAttribute();
  }

  public createWaveformRowContent() {
    let icon = this.collapseState === CollapseState.Expanded ? 
      'codicon-chevron-down' : 'codicon-chevron-right';
    return `<div class='codicon ${icon}'></div><p>${this.label}</p>`;
  }

  public createLabelElement() {

    let childElements = '';
    let icon = 'codicon-chevron-right';
    let groupClass = 'collapsed-group';
    if (this.collapseState === CollapseState.Expanded) {
      this.children.forEach((childRowId) => {
        const signalItem = dataManager.rowItems[childRowId];
        childElements += signalItem.createLabelElement();
      });
      icon = 'codicon-chevron-down';
      groupClass = 'expanded-group';
    }
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    //const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label waveform-group is-idle ${groupClass}" id="label-${this.rowId}" data-vscode-context=${this.vscodeContext}>
              <div class="waveform-row ${selectorClass} height1x">${this.createWaveformRowContent()}</div>
              <div class="labels-group child-group">${childElements}</div>
            </div>`;
    }

  public createValueDisplayElement() {

    let   value = labelsPanel.valueAtMarker[this.rowId];
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    let result = `<div class="value-display-item ${selectorClass} height1x" id="value-${this.rowId}" data-vscode-context=${this.vscodeContext}></div>`;
    if (value === undefined) {value = [];}
    if (this.collapseState === CollapseState.Expanded) {
      this.children.forEach((childRowId) => {
        const signalItem = dataManager.rowItems[childRowId];
        result += signalItem.createValueDisplayElement();
      });
    }
    return result;
  }

  public createViewportElement(rowId: number) {
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    this.vscodeContext = `${JSON.stringify({
      webviewSection: "signal-group",
      groupId: this.groupId,
      rowId: this.rowId,
      preventDefaultContextMenuItems: true,
    }).replace(/\s/g, '%x20')}`;
  }

  getLabelText(): string {return this.label;}

  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    let result: number[] = [this.rowId];
    if (!ignoreCollapsed || this.collapseState === CollapseState.Expanded) {
      this.children.forEach((rowId) => {
        if (rowId === ignoreRowId) {return;} // Skip the ignored rowId
        const signalItem = dataManager.rowItems[rowId];
        result = result.concat(signalItem.getFlattenedRowIdList(ignoreCollapsed, ignoreRowId));
      });
    }
    return result;
  }

  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {
    let total = 1; // Count the group row itself
    if (!ignoreCollapsed || this.collapseState === CollapseState.Expanded) {
      this.children.forEach((rowId, i) => {
        if (i >= stopIndex) {return;}
        const signalItem = dataManager.rowItems[rowId];
        total += signalItem.rowIdCount(ignoreCollapsed, Infinity);
      });
    }
    return total;
  }

  public findParentGroupId(rowId: RowId): number | null {
    if (this.children.includes(rowId)) {
      return this.groupId;
    }
    for (const childRowId of this.children) {
      const signalItem = dataManager.rowItems[childRowId];
      const parentGroupId = signalItem.findParentGroupId(rowId);
      if (parentGroupId !== null) {
        return parentGroupId;
      }
    }
    return null;
  }

  public showHideViewportRows() {
    //const childRows = this.getFlattenedRowIdList(false, -1);
    const style = this.collapseState === CollapseState.Expanded ? 'flex' : 'none';
    let childRows: number[] = [];
    this.children.forEach((rowId) => {
      const childRowItem = dataManager.rowItems[rowId];
      if (!childRowItem) {return;}
      childRows = childRows.concat(childRowItem.getFlattenedRowIdList(true, -1));
    });
    childRows.forEach((rowId) => {
      if (rowId === this.rowId) {return;} // Skip the group row itself
      const viewportRow = document.getElementById(`waveform-${rowId}`);
      if (!viewportRow) {return;}
      viewportRow.style.display = style;
      const signalItem = dataManager.rowItems[rowId];
      if (signalItem instanceof VariableItem) {
        signalItem.wasRendered = false; // Reset rendering state for child signals
      }
      viewport.updateBackgroundCanvas(true);
    });
    updateDisplayedSignalsFlat();
    viewport.renderAllWaveforms(false);
  }

  public expand() {
    this.collapseState = CollapseState.Expanded;
    labelsPanel.renderLabelsPanels();
    this.showHideViewportRows();
  }

  public collapse() {
    this.collapseState = CollapseState.Collapsed;
    const childRows = this.getFlattenedRowIdList(false, -1);
    const newSelection = viewerState.selectedSignal.filter((rowId) => !childRows.includes(rowId));
    let lastSelected = viewerState.lastSelectedSignal;
    if (viewerState.selectedSignal.length !== newSelection.length) {
      if (lastSelected !== null && childRows.includes(lastSelected)) {
        lastSelected = null;
      }
      events.dispatch(ActionType.SignalSelect, newSelection, lastSelected);
    }
    labelsPanel.renderLabelsPanels();
    this.showHideViewportRows();
  }

  public toggleCollapse() {
    if (this.collapseState === CollapseState.Expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  //public renderWaveform() {this.wasRendered = true;}
  public getValueAtTime(time: number): string[] {return [""];}
  public setColorFromColorIndex() {return;}
  public async cacheValueFormat(force: boolean) {return new Promise<void>((resolve) => {return;});}
  public resize() {return;}

  public dispose() {
    //this.canvas?.remove();
    //this.canvas = null;
    //this.ctx = null;
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
    this.label = "";
  }
}