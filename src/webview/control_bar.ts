import {ActionType, EventHandler, NetlistId, viewerState, viewport, dataManager} from './vaporview';

export class ControlBar {
  private zoomInButton: HTMLElement;
  private zoomOutButton: HTMLElement;
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
  private touchScroll: HTMLElement;

  private searchContainer: any;
  private searchBar: any;
  private valueIconRef: any;

  // Search handler variables
  searchState         = 0;
  searchInFocus       = false;

  private events: EventHandler;

  parsedSearchValue: string | null = null;

  constructor(events: EventHandler) {
    this.events = events;

    this.zoomInButton  = document.getElementById('zoom-in-button')!;
    this.zoomOutButton = document.getElementById('zoom-out-button')!;
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
    this.touchScroll   = document.getElementById('touchpad-scroll-button')!;

    this.searchContainer = document.getElementById('search-container');
    this.searchBar     = document.getElementById('search-bar');
    this.valueIconRef  = document.getElementById('value-icon-reference');

    if (this.zoomInButton === null || this.zoomOutButton === null || this.prevNegedge === null ||
        this.prevPosedge === null || this.nextNegedge === null || this.nextPosedge === null ||
        this.prevEdge === null || this.nextEdge === null || this.timeEquals === null ||
        this.valueEquals === null || this.previousButton === null || this.nextButton === null ||
        this.touchScroll === null || this.searchContainer === null || this.searchBar === null || 
        this.valueIconRef === null || this.valueEqualsSymbol === null) {
      throw new Error("Could not find all required elements");
    }

    this.zoomInButton.addEventListener( 'click', (e) => {this.events.dispatch(ActionType.Zoom, -1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});
    this.zoomOutButton.addEventListener('click', (e) => {this.events.dispatch(ActionType.Zoom, 1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});


    // Control bar button event handlers
    this.prevNegedge.addEventListener(  'click', (e: any) => {this.goToNextTransition(-1, '0');});
    this.prevPosedge.addEventListener(  'click', (e: any) => {this.goToNextTransition(-1, '1');});
    this.nextNegedge.addEventListener(  'click', (e: any) => {this.goToNextTransition( 1, '0');});
    this.nextPosedge.addEventListener(  'click', (e: any) => {this.goToNextTransition( 1, '1');});
    this.prevEdge.addEventListener(     'click', (e: any) => {this.goToNextTransition(-1);});
    this.nextEdge.addEventListener(     'click', (e: any) => {this.goToNextTransition( 1);});

    // Search bar event handlers
    this.searchBar.addEventListener(    'focus', (e: any) => {this.handleSearchBarInFocus(true);});
    this.searchBar.addEventListener(     'blur', (e: any) => {this.handleSearchBarInFocus(false);});
    this.searchBar.addEventListener(  'keydown', (e: any) => {this.handleSearchBarKeyDown(e);});
    this.searchBar.addEventListener(    'keyup', (e: any) => {this.handleSearchBarEntry(e);});
    this.timeEquals.addEventListener(   'click', (e: any) => {this.handleSearchButtonSelect(0);});
    this.valueEquals.addEventListener(  'click', (e: any) => {this.handleSearchButtonSelect(1);});
    this.previousButton.addEventListener('click', (e: any) => {this.handleSearchGoTo(-1);});
    this.nextButton.addEventListener(    'click', (e: any) => {this.handleSearchGoTo(1);});
    this.touchScroll.addEventListener(   'click', (e: any) => {this.handleTouchScroll();});

    this.setButtonState(this.previousButton, 0);

    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.handleRedrawVariable = this.handleRedrawVariable.bind(this);

    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
  }

  goToNextTransition(direction: number, edge: string | undefined = undefined) {
    if (viewerState.selectedSignal === null) {
      //handleMarkerSet(markerTime + direction, 0);
      return;
    }

    if (viewerState.markerTime === null) {return;}
  
    const signalId = dataManager.netlistData[viewerState.selectedSignal].signalId;
    const data     = dataManager.valueChangeData[signalId];
    const time     = viewerState.markerTime;
    let timeIndex;
    let indexIncrement;
  
    if (edge === undefined) {
      timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= time;});
      indexIncrement = 1;
    } else {
      timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= time && v === edge;});
      indexIncrement = 2;
    }
  
    if (timeIndex === -1) {
      //console.log('search found a -1 index');
      return;
    }
  
    if ((direction === 1) && (time === data.transitionData[timeIndex][0])) {timeIndex += indexIncrement;}
    else if (direction === -1) {timeIndex -= indexIncrement;}
  
    timeIndex = Math.max(timeIndex, 0);
    timeIndex = Math.min(timeIndex, data.transitionData.length - 1);
  
    //this.handleMarkerSet(data.transitionData[timeIndex][0], 0);
    this.events.dispatch(ActionType.MarkerSet, data.transitionData[timeIndex][0], 0);
  }

  handleTouchScroll() {
    viewerState.touchpadScrolling = !viewerState.touchpadScrolling;
    this.setButtonState(this.touchScroll, viewerState.touchpadScrolling ? 2 : 1);
  }

  setButtonState(buttonId: any, state: number) {
    if (state === 0) {
      buttonId.classList.remove('selected-button');
      buttonId.classList.add('disabled-button');
    } else if (state === 1) {
      buttonId.classList.remove('disabled-button');
      buttonId.classList.remove('selected-button');
    } else if (state === 2) {
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

  updateButtonsForSelectedWaveform(width: number) {
    if (width === null) {
      this.setBinaryEdgeButtons(0);
      this.setBusEdgeButtons(0);
    } else if (width === 1) {
      this.setBinaryEdgeButtons(1);
      this.setBusEdgeButtons(1);
    } else {
      this.setBinaryEdgeButtons(0);
      this.setBusEdgeButtons(1);
    }
  }

  handleSearchButtonSelect(button: number) {
    this.handleSearchBarInFocus(true);
    this.searchState = button;
    if (this.searchState === 0) {
      this.setButtonState(this.timeEquals, 2);
      this.setButtonState(this.valueEquals, 1);
    } else if (this.searchState === 1) {
      this.setButtonState(this.timeEquals, 1);
      this.setButtonState(this.valueEquals, 2);
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
    console.log(viewerState.selectedSignal);
    console.log(this.searchState);
    if (viewerState.selectedSignal !== null) {
      const format = dataManager.netlistData[viewerState.selectedSignal].valueFormat;
      const checkValid = format.checkValid;
      const parseValue = format.parseValueForSearch;
  
      // check to see that the input is valid
      if (this.searchState === 0) {
        inputValid = this.checkValidTimeString(inputText);
      } else if (this.searchState === 1) {
        inputValid = checkValid(inputText);
        if (inputValid) {this.parsedSearchValue = parseValue(inputText);}
        console.log(inputValid);
        console.log(this.parsedSearchValue);
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
      this.setButtonState(this.nextButton, 1);
    } else {
      this.setButtonState(this.previousButton, 0);
      this.setButtonState(this.nextButton, 0);
    }
  }
  
  handleSearchGoTo(direction: number) {
    if (viewerState.selectedSignal === null) {return;}
    if (this.parsedSearchValue === null) {return;}
    let startTime = viewerState.markerTime;
    if (startTime === null) {startTime = 0;}
  
    const signalId = dataManager.netlistData[viewerState.selectedSignal].signalId;
  
    if (this.searchState === 0 && direction === 1) {
      //this.handleMarkerSet(parseInt(this.parsedSearchValue), 0);
      this.events.dispatch(ActionType.MarkerSet, parseInt(this.parsedSearchValue), 0);
    } else {
      const signalWidth      = dataManager.valueChangeData[signalId].signalWidth;
      let trimmedSearchValue = this.parsedSearchValue;
      if (this.parsedSearchValue.length > signalWidth) {trimmedSearchValue = this.parsedSearchValue.slice(-1 * signalWidth);}
      const searchRegex = new RegExp(trimmedSearchValue, 'ig');
      const data      = dataManager.valueChangeData[signalId];
      const timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= startTime;});
      let indexOffset = 0;
  
      if (direction === -1) {indexOffset = -1;}
      else if (viewerState.markerTime === data.transitionData[timeIndex][0]) {indexOffset = 1;}
  
      for (let i = timeIndex + indexOffset; i >= 0; i+=direction) {
        if (data.transitionData[i][1].match(searchRegex)) {
          //this.handleMarkerSet(data.transitionData[i][0], 0);
          this.events.dispatch(ActionType.MarkerSet, data.transitionData[i][0], 0);
          break;
        }
      }
    }
  }

  handleSearchBarInFocus(isFocused: boolean) {
    this.searchInFocus = isFocused;
    if (isFocused) {
      if (document.activeElement !== this.searchBar) {
        this.searchBar.focus();
      }
      if (this.searchContainer.classList.contains('is-focused')) {return;}
      this.searchContainer.classList.add('is-focused');
    } else {
      this.searchContainer.classList.remove('is-focused');
    }
  }

  handleSignalSelect(netlistId: NetlistId) {
    if (netlistId === null) {return;}

    this.updateButtonsForSelectedWaveform(dataManager.netlistData[netlistId].signalWidth);
    this.valueEqualsSymbol.textContent = dataManager.netlistData[netlistId]?.valueFormat.symbolText;
  }

  handleRedrawVariable(netlistId: NetlistId) {
    if (netlistId === viewerState.selectedSignal) {
      this.valueEqualsSymbol.textContent = dataManager.netlistData[netlistId]?.valueFormat.symbolText;
    }
  }
}