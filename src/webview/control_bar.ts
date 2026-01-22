import { commands } from 'vscode';
import {ActionType, EventHandler, viewerState, viewport, dataManager, vscode, RowId, sendWebviewContext} from './vaporview';
import { sign, Sign } from 'crypto';
import { VariableItem } from './signal_item';

enum ButtonState {
  Disabled = 0,
  Enabled  = 1,
  Selected = 2
}

enum SearchState {
  Time  = 0,
  Value = 1
}

enum SelectedSignalWidth {
  None       = 0,
  SingleBit  = 1,
  MultiBit   = 2
}

export class ControlBar {
  private zoomInButton: HTMLElement;
  private zoomOutButton: HTMLElement;
  private zoomFitButton: HTMLElement;
  private prevNegedge: HTMLElement;
  private prevPosedge: HTMLElement;
  private nextNegedge: HTMLElement;
  private nextPosedge: HTMLElement;
  private prevEdge: HTMLElement;
  private nextEdge: HTMLElement;
  private timeEquals: HTMLElement;
  private valueEquals: HTMLElement;
  private valueEqualsSymbol: HTMLElement;
  private previousButton: HTMLElement;
  private nextButton: HTMLElement;
  private autoScroll: HTMLElement;
  private touchScroll: HTMLElement;
  private mouseScroll: HTMLElement;
  private autoReload: HTMLElement;
  settings: HTMLElement;

  private searchContainer: any;
  private searchBar: any;
  private valueIconRef: any;

  // Search handler variables
  searchState         = SearchState.Time;
  searchInFocus       = false;

  private events: EventHandler;

  parsedSearchValue: string | null = null;

  constructor(events: EventHandler) {
    this.events = events;

    this.zoomInButton  = document.getElementById('zoom-in-button')!;
    this.zoomOutButton = document.getElementById('zoom-out-button')!;
    this.zoomFitButton = document.getElementById('zoom-fit-button')!;
    this.prevNegedge   = document.getElementById('previous-negedge-button')!;
    this.prevPosedge   = document.getElementById('previous-posedge-button')!;
    this.nextNegedge   = document.getElementById('next-negedge-button')!;
    this.nextPosedge   = document.getElementById('next-posedge-button')!;
    this.prevEdge      = document.getElementById('previous-edge-button')!;
    this.nextEdge      = document.getElementById('next-edge-button')!;
    this.timeEquals    = document.getElementById('time-equals-button')!;
    this.valueEquals   = document.getElementById('value-equals-button')!;
    this.valueEqualsSymbol = document.getElementById('search-symbol')!;
    this.previousButton = document.getElementById('previous-button')!;
    this.nextButton    = document.getElementById('next-button')!;
    this.autoScroll    = document.getElementById('auto-scroll-button')!;
    this.touchScroll   = document.getElementById('touchpad-scroll-button')!;
    this.mouseScroll   = document.getElementById('mouse-scroll-button')!;
    this.autoReload    = document.getElementById('autoReload')!;
    this.settings      = document.getElementById('settings-menu')!;
    this.searchContainer = document.getElementById('search-container');
    this.searchBar     = document.getElementById('search-bar');
    this.valueIconRef  = document.getElementById('value-icon-reference');

    if (this.zoomInButton === null || this.zoomOutButton === null || this.zoomFitButton === null || 
        this.prevNegedge === null || this.prevPosedge === null || this.nextNegedge === null || 
        this.nextPosedge === null || this.prevEdge === null || this.nextEdge === null || 
        this.timeEquals === null || this.valueEquals === null || this.previousButton === null || 
        this.nextButton === null || this.touchScroll === null || this.mouseScroll === null || 
        this.autoScroll === null || this.searchContainer === null || this.searchBar === null || 
        this.valueIconRef === null ||  this.valueEqualsSymbol === null || this.autoReload === null) {
      throw new Error("Could not find all required elements");
    }

    // Control bar button event handlers
    this.zoomInButton.addEventListener( 'click', (e) => {this.events.dispatch(ActionType.Zoom, -1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});
    this.zoomOutButton.addEventListener('click', (e) => {this.events.dispatch(ActionType.Zoom, 1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});
    this.zoomFitButton.addEventListener('click', (e) => {this.events.dispatch(ActionType.Zoom, Infinity, 0, 0);});
    this.prevNegedge.addEventListener(  'click', (e: any) => {this.goToNextTransition(-1, ['0']);});
    this.prevPosedge.addEventListener(  'click', (e: any) => {this.goToNextTransition(-1, ['1']);});
    this.nextNegedge.addEventListener(  'click', (e: any) => {this.goToNextTransition( 1, ['0']);});
    this.nextPosedge.addEventListener(  'click', (e: any) => {this.goToNextTransition( 1, ['1']);});
    this.prevEdge.addEventListener(     'click', (e: any) => {this.goToNextTransition(-1, []);});
    this.nextEdge.addEventListener(     'click', (e: any) => {this.goToNextTransition( 1, []);});
    this.autoReload.addEventListener(  'change', (e: any) => {this.handleAutoReloadCheckbox(e);});

    // Search bar event handlers
    this.searchBar.addEventListener(     'focus', (e: any) => {this.handleSearchBarInFocus(true);});
    this.searchBar.addEventListener(      'blur', (e: any) => {this.handleSearchBarInFocus(false);});
    this.searchBar.addEventListener(   'keydown', (e: any) => {this.handleSearchBarKeyDown(e);});
    this.searchBar.addEventListener(     'keyup', (e: any) => {this.handleSearchBarEntry(e);});
    this.timeEquals.addEventListener(    'click', (e: any) => {this.handleSearchButtonSelect(0);});
    this.valueEquals.addEventListener(   'click', (e: any) => {this.handleSearchButtonSelect(1);});
    this.previousButton.addEventListener('click', (e: any) => {this.handleSearchGoTo(-1);});
    this.nextButton.addEventListener(    'click', (e: any) => {this.handleSearchGoTo(1);});
  
    // Scroll Type settings
    this.autoScroll.addEventListener(    'click', (e: any) => {this.handleScrollModeClick("Auto");});
    this.touchScroll.addEventListener(   'click', (e: any) => {this.handleScrollModeClick("Touchpad");});
    this.mouseScroll.addEventListener(   'click', (e: any) => {this.handleScrollModeClick("Mouse");});

    // Settings menu
    this.settings.addEventListener(      'click', (e: any) => {this.clickSettings(e);});

    this.setButtonState(this.previousButton, ButtonState.Disabled);
    this.setButtonState(this.mouseScroll, ButtonState.Selected);
    this.updateNextEdgeButtons([]);

    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.handleRedrawVariable = this.handleRedrawVariable.bind(this);
    this.handleMarkerSet = this.handleMarkerSet.bind(this);

    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
  }

  goToNextTransition(direction: number, edge: string[]) {
    //console.log("Go to next transition: " + direction + ' ' + edge);
    if (viewerState.markerTime === null) {return;}

    if (viewerState.selectedSignal.length === 0) {
      this.events.dispatch(ActionType.MarkerSet, viewerState.markerTime + direction, 0);
      return;
    }

    let nearestTime: number = viewport.timeStop;
    if (direction === -1) {nearestTime = 0;}
    viewerState.selectedSignal.forEach((rowId) => {
      if (viewerState.markerTime === null) {return;}
      const data  = dataManager.rowItems[rowId];
      const time  = data.getNextEdge(viewerState.markerTime, direction, edge);
      if (time === null) {return;}
      if (direction === 1)       {nearestTime = Math.min(nearestTime, time);}
      else if (direction === -1) {nearestTime = Math.max(nearestTime, time);}
    });

    this.events.dispatch(ActionType.MarkerSet, nearestTime, 0);
    console.log('goToNextTransition');
    sendWebviewContext(5);
  }

  handleScrollModeClick(mode: string) {
    vscode.postMessage({command: 'updateConfiguration', property: "scrollingMode", value: mode});
  }

  setScrollMode(mode: string) {
    switch (mode) {
      case 'Mouse':    this.handleTouchScroll(false); break;
      case 'Touchpad': this.handleTouchScroll(true);  break;
      case 'Auto':     this.handleAutoScroll();       break;
    }
  }

  handleTouchScroll(state: boolean) {
    viewerState.touchpadScrolling = state;
    viewerState.autoTouchpadScrolling = false;
    if (state) {
      this.setButtonState(this.mouseScroll, ButtonState.Enabled);
      this.setButtonState(this.touchScroll, ButtonState.Selected);
    } else {
      this.setButtonState(this.mouseScroll, ButtonState.Selected);
      this.setButtonState(this.touchScroll, ButtonState.Enabled);
    }
    this.setButtonState(this.autoScroll, ButtonState.Enabled);
  }

  handleAutoScroll() {
    viewerState.autoTouchpadScrolling = true;
    this.setButtonState(this.mouseScroll, ButtonState.Enabled);
    this.setButtonState(this.touchScroll, ButtonState.Enabled);
    this.setButtonState(this.autoScroll, ButtonState.Selected);
  }

  clickSettings(e: any) {
    e.preventDefault();
    e.target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: e.clientX, clientY: e.clientY })
    );
    e.stopPropagation();
  }

  setButtonState(buttonId: any, state: number) {
    if (state === ButtonState.Disabled) {
      buttonId.classList.remove('selected-button');
      buttonId.classList.add('disabled-button');
    } else if (state === ButtonState.Enabled) {
      buttonId.classList.remove('disabled-button');
      buttonId.classList.remove('selected-button');
    } else if (state === ButtonState.Selected) {
      buttonId.classList.remove('disabled-button');
      buttonId.classList.add('selected-button');
    }
  }

  setBinaryEdgeButtons(selectable: number) {
    this.setButtonState(this.prevNegedge, selectable);
    this.setButtonState(this.prevPosedge, selectable);
    this.setButtonState(this.nextNegedge, selectable);
    this.setButtonState(this.nextPosedge, selectable);
  }

  setBusEdgeButtons(selectable: number) {
    this.setButtonState(this.prevEdge, selectable);
    this.setButtonState(this.nextEdge, selectable);
  }

  updateNextEdgeButtons(rowIdList: RowId[]) {

    const width = this.getSelectedSignalWidths(rowIdList);

    if (width === SelectedSignalWidth.None) {
      this.setBinaryEdgeButtons(ButtonState.Disabled);
      this.setBusEdgeButtons(ButtonState.Disabled);
    } else if (width === SelectedSignalWidth.SingleBit) {
      this.setBinaryEdgeButtons(ButtonState.Enabled);
      this.setBusEdgeButtons(ButtonState.Enabled);
    } else {
      this.setBinaryEdgeButtons(ButtonState.Disabled);
      this.setBusEdgeButtons(ButtonState.Enabled);
    }
  }

  getSelectedSignalWidths(rowIdList: RowId[]) {
    let result = SelectedSignalWidth.None;
    let isSingleBit: boolean[] = [];
    rowIdList.forEach((rowId) => {
      const signalItem = dataManager.rowItems[rowId];
      if (signalItem instanceof VariableItem === false) {return;}
      isSingleBit.push(signalItem.signalWidth === 1);
    });
    const allSingleBit = isSingleBit.reduce((prev, curr) => {return prev && curr;}, true);

    if (allSingleBit && isSingleBit.length > 0) {
      result = SelectedSignalWidth.SingleBit;
    } else if (isSingleBit.length > 0) {
      result = SelectedSignalWidth.MultiBit;
    }
    return result;
  }

  defocusSearchBar() {
    this.searchBar.selectionStart = 0;
    this.searchBar.selectionEnd   = 0;
    this.searchBar.blur();
  }

  handleSearchButtonSelect(button: number) {
    this.handleSearchBarInFocus(true);
    this.searchState = button;
    if (this.searchState === SearchState.Time) {
      this.setButtonState(this.timeEquals, ButtonState.Selected);
      this.setButtonState(this.valueEquals, ButtonState.Enabled);
    } else if (this.searchState === SearchState.Value) {
      this.setButtonState(this.timeEquals, ButtonState.Enabled);
      this.setButtonState(this.valueEquals, ButtonState.Selected);
    }
    this.handleSearchBarEntry({key: 'none'});
  }

  checkValidTimeString(inputText: string) {
    if (inputText.match(/^[0-9]+$/)) {
      this.parsedSearchValue = inputText.replace(/,/g, '');
      return true;
    }
    else {return false;}
  }

  handleSearchBarKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.handleSearchGoTo(1);
      return;
    }
  }
  
  handleSearchBarEntry(event: any) {
    const inputText  = this.searchBar.value;
    let inputValid   = true;
    //console.log(viewerState.selectedSignal);
    //console.log(this.searchState);
    if (viewerState.selectedSignal.length === 1) {
      const rowId  = viewerState.selectedSignal[0];
      if (dataManager.rowItems[rowId] instanceof VariableItem) {
        const format = dataManager.rowItems[rowId].valueFormat;
        const checkValidSearch = format.checkValidSearch;
        const parseValue = format.parseSearchValue;

        // check to see that the input is valid
        if (this.searchState === SearchState.Time) {
          inputValid = this.checkValidTimeString(inputText);
        } else if (this.searchState === SearchState.Value) {
          inputValid = checkValidSearch(inputText);
          if (inputValid) {this.parsedSearchValue = parseValue(inputText);}
          //console.log(inputValid);
          //console.log(this.parsedSearchValue);
        }
      }
    }
  
    // Update UI accordingly
    if (inputValid || inputText === '') {
      this.searchContainer.classList.remove('is-invalid');
    } else {
      this.searchContainer.classList.add('is-invalid');
    }
  
    if (inputValid && inputText !== '') {
      this.setButtonState(this.previousButton, this.searchState);
      this.setButtonState(this.nextButton, ButtonState.Enabled);
    } else {
      this.setButtonState(this.previousButton, ButtonState.Disabled);
      this.setButtonState(this.nextButton, ButtonState.Disabled);
    }
  }
  
  handleSearchGoTo(direction: number) {
    if (viewerState.selectedSignal.length !== 1) {return;}
    if (this.parsedSearchValue === null) {return;}
    let startTime = viewerState.markerTime;
    let updateState = false;
    if (startTime === null) {startTime = 0;}
  
    const rowId  = viewerState.selectedSignal[0];
    const rowItem = dataManager.rowItems[rowId];
    if (rowItem === undefined || rowItem instanceof VariableItem === false) {return;}
    const signalId = rowItem.signalId;
    const format   = rowItem.valueFormat;
    const checkSearchValue = format.checkSearchValue;
  
    if (this.searchState === SearchState.Time && direction === 1) {
      this.events.dispatch(ActionType.MarkerSet, parseInt(this.parsedSearchValue), 0);
      updateState = true;
    } else {
      const signalWidth     = dataManager.valueChangeData[signalId].signalWidth;
      //if (this.parsedSearchValue.length > signalWidth) {trimmedSearchValue = this.parsedSearchValue.slice(-1 * signalWidth);}
      const data            = dataManager.valueChangeData[signalId];
      const valueChangeData = data.valueChangeData;
      const formattedData   = data.formattedValues;
      if (!formattedData[format.id]) {return;}
      if (!formattedData[format.id].formatCached) {return;}
      if (!formattedData[format.id].values) {return;}
      const formattedValues = formattedData[format.id].values;
      const timeIndex = data.valueChangeData.findIndex(([t, v]) => {return t >= startTime;});
      let indexOffset = 0;
  
      if (direction === -1) {indexOffset = -1;}
      else if (viewerState.markerTime === valueChangeData[timeIndex][0]) {indexOffset = 1;}
  
      for (let i = timeIndex + indexOffset; i >= 0; i+=direction) {
        if (checkSearchValue(this.parsedSearchValue, valueChangeData[i][1], formattedValues[i])) {
          this.events.dispatch(ActionType.MarkerSet, valueChangeData[i][0], 0);
          updateState = true;
          break;
        }
      }
    }
    if (updateState) {
      console.log('handleSearchGoTo');
      sendWebviewContext(5);
    }
  }

  handleAutoReloadCheckbox(event: any) {
    viewerState.autoReload = event.target.checked;
    sendWebviewContext(0);
  }

  handleSearchBarInFocus(isFocused: boolean) {
    this.searchInFocus = isFocused;
    if (isFocused) {
      if (document.activeElement !== this.searchBar) {
        this.searchBar.focus();
      }
      if (this.searchContainer.classList.contains('is-focused')) {return;}
      this.searchContainer.classList.add('is-focused');
      this.handleSearchBarEntry({key: 'none'});
    } else {
      this.searchContainer.classList.remove('is-focused');
    }
  }

  handleSignalSelect(rowIdList: RowId[], lastSelected: RowId | null = null) {

    this.updateNextEdgeButtons(rowIdList);

    if (rowIdList.length !== 1) {return;}
    const signalItem = dataManager.rowItems[rowIdList[0]];
    if (signalItem && signalItem instanceof VariableItem) {
      this.valueEqualsSymbol.textContent = signalItem.valueFormat.symbolText;
    }
  }

  handleRedrawVariable(rowId: RowId) {
    const rowItem = dataManager.rowItems[rowId];
    if (rowItem === undefined || rowItem instanceof VariableItem === false) {return;}
    if (rowId === viewerState.selectedSignal[0]) {
      this.valueEqualsSymbol.textContent = rowItem.valueFormat.symbolText;
    }
  }

  handleMarkerSet(time: number, markerType: number) {
    if (this.searchState === SearchState.Time) {
      this.searchBar.value = time;
      this.searchContainer.classList.remove('is-invalid');
    }
  }

}