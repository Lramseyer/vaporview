# Source Code Documentation

I wrote this in hopes that if anyone wants to help contribute to the development of VaporView, this document will help serve as a starting point. That being said, feel free to reach out to me if you have further questions. I would be more than happy to have other contributors!

I should also mention if it's not obvious; I come from a hardware background. Web programming is not my area of expertise. You're not going to offend me by crutiquing my code or my choices. You're also not going to offend me for crutiquing my life choices - especially if you use Verdi through a VDI or VNC session and you actually like it! I hope this documentation is able to provide an explaination on how everything is implemented so that we can make this project into the best it can be.

## Low hanging fruit

Since me and my gang of AI ghost writers have (up to this point) have been the biggest contributors to this project, you might imagine that it's a lot of work to make this code useful _and_ nicely organized _and_ well documented _and_ have hice asthaetics _and_ juggle all of my other priorities of life like Skiing and Rock Climbing. So I have compiled a list of things that you could easily get started on to contribute to this project.

- Improving the look of the assets, like the icons or the logo
- Organizing the code by breaking it up into multiple files or improve naming conventions
- Improving documentation

## Not so low hanging fruit

While not necissarily a priority, I have a list of things that would greatly enhance the usability of this extension, but they're kind of difficult (for me at least) and I might need some help with these:

- Rewriting performance critical components (like the renderer) in Web Assembly

## Extension overview

There are 3 main parts to this extesnion: The VScode Extension (src/web/extension.ts,) The WASM file parser, and the webview component (media/extension.js.) The Extension and wevbiew communicate via a messaging interface: `webview.postMessage()` and `vscode.postMessage()` on the extension and webview side respectively. This is mainly used for setting up the webview, and for adding and removing signals from the viewer. It's important to note that when a signal is rendered in the webview, the extension only sends over the waveform data for that signal that is being rendered. This is important for larger waveform files. If we only load into memory what is actually in the viewer, we're not going to run into memory issues.

## A few notes about WebAssembly

There were a lot of things about WASM that I learned the hard way, and I wanted to write them down so that you don't have to suffer like I did.
1. WASM is very limited in capabilities. You can't open files (that aren't compiled with the WASM code) or access other system resources that you would expect to access with HTML5. This is for obvious security reasons. Thankfully, WASM supports callbacks, so all you need to do is tie the callbacks to the HTML5 resources you need. Be careful though...
2. You are limited to 64K of shared memory for all function calls. Keep this in mind when transferring data ...like file IO, or querying data. You will need to mind this limitation, and figure out how to pass data in chunks. Be mindful of how you format the data the data because...
3. wit_bindgen still has bugs, some of them are documented, some are yet to be discovered. I had issues with passing lists of complex types. I found a bug write up on it, and they claimed it was fixed, but it was still broken for me. Thankfully, there are workarounds.

While WASM has it's quirks, it's extremely fast and memory efficient. Just make sure that when you compile it, be sure to include the "--release" tag. Otherwise, it will be slower than Javascript, and you are going to wonder why you spent all of that time banging your head against the wall!

## The extension

The extension uses several VScode API elements, which can be read up on in the [API documentation](https://code.visualstudio.com/api/references/vscode-api)

- Activity Bar/View Container
- Views
  - Tree View
  - Tree Item
- Custom Readonly Editor
- Webview

# Data Structures

The data structures of this extension really are the key to making it work as well as it does. So I have outlined a summary of the prominent data structures in this extension, and I will also go over why they're laid out the way they are.

## Extension data tree

- WaveformViewerProvider (implements vscode.CustomReadonlyEditorProvider<VaporviewDocument>)
  - netlistTreeDataProvider: NetlistTreeDataProvider (implements vscode.TreeDataProvider<NetlistItem>)
    - document: VaporviewDocument (reference)
    - treeData: NetlistItem[] (extends vscode.TreeItem)
  - netlistView: vscode.TreeView<NetlistItem>
  - displayedSignalsTreeDataProvider: DisplayedSignalsViewProvider (implements vscode.TreeDataProvider<NetlistItem>)
    - treeData: NetlistItem[] (extends vscode.TreeItem)
  - displayedSignalsView: vscode.TreeView<NetlistItem>
  - deltaTimeStatusBarItem: vscode.StatusBarItem
  - markerTimeStatusBarItem: vscode.StatusBarItem
  - selectedSignalStatusBarItem: vscode.StatusBarItem
  - activeWebview: vscode.WebviewPanel
  - activeDocument: VaporviewDocument (extends vscode.Disposable implements vscode.CustomDocument)
  - lastActiveWebview: vscode.WebviewPanel
  - lastActiveDocument: VaporviewDocument
  - netlistViewSelectedSignals: NetlistItem[]
  - displayedSignalsViewSelectedSignals: NetlistItem[]
  - webviews: webviewCollection()
    - numWebviews: number
    - resource: string
    - webviewPanel: vscode.WebviewPanel;

- VaporviewDocument extends vscode.Disposable implements vscode.CustomDocument
  - _uri: vscode.Uri
  - _delegate: VaporviewDocumentDelegate
  - _wasmWorker: Worker;
  - wasmApi: _Promisify<_Required<filehandler.Exports>>
  - webviewPanel: vscode.WebviewPanel
  - _webviewInitialized: boolean
  - treeData: NetlistItem[] (extends vscode.TreeItem)
  - displayedSignals: NetlistItem[] (extends vscode.TreeItem)
  - _netlistTable: NetlistlIdRef[]
    - netlistItem: NetlistItem
    - displayedItem: NetlistItem | undefined
    - signalId: string
  - metadata: WaveformTopMetadata
    - fileName: string
    - fileSize: number
    - fd: number
    - timeTableLoaded: boolean
    - moduleCount: number
    - netlistIdCount: number
    - signalIdCount: number
    - timeEnd: number
    - chunkTime: number
    - chunkCount: number
    - timeScale: number
    - defaultZoom: number
    - timeUnit: string

- NetlistItem (extends vscode.TreeItem)
  - numberFormat
  - label: string
  - type: string
  - width: number
  - signalId: string
  - netlistId: string
  - name: string
  - modulePath: string,
  - children: NetlistItem[]
    - ...
  - collapsibleState: vscode.TreeItemCollapsibleState
  - checkboxState: vscode.TreeItemCheckboxState
  - contextValue: string

- NetlistID: number
- SignalId: number

## Parsing a file

When The user opens a document, we spawn a worker that interfaces with a WebAssembly module. This is written in Rust, and handles all of the interfacing with the file. It uses the  [wellen](https://github.com/ekiwi/wellen/tree/new-api) library, as that provides a common interface for all of the file types it supports. Also, a huge thanks to the author, as he has gone the extra mile to support the integration work and making things work for vaporview.

Previously, VCD parsing was done in Typescript, and it was slower and consumed much more memory. It took me a lot of time to get the WASM environment set up and working, but it was well worth the effort!

Both the netlist information and the value change data is stored in the WASM memory, but thankfully, WASM supports callbacks.

I should point out that due to the nature of FST and VCD files, they are accessed very differently. For VCD files, you essentially need to load the entire file to get any meaningful data out of it. Thankfully, wellen reorganizes and compresses VCD data. FST files are block stored, so it's possible to only load in the netlist, and dynamically load any variables that users want to display. For small files, I simply load the entire file into memory, and that threshold can be set as a user setting.

For both filetypes, the WASM code parses the netlist, and then issues a callback `setscopetop()` to create the top level scopes in the document's treeData[] element. More on that later...

Once the netlist has been parsed, the value change data gets parsed. For FST files, it is much faster, since it doesn't technically load much of anything. But for VCD files, that's where it serializes and compresses the value change data.

## Document handlers

There are 2 main classes that handle the lifecycle of a document: `VaporviewDocument` and `WaveformViewerProvider`. These handle setting up and communicating with the webview, figuring out which document is in focus, and setting up and populating the view containers according to which viewer is in focus. This is important, because we don't want a signal being rendered in the wrong webview!

We have to store a copy of each treeview for each document that's open so that if a user wants to open up multiple documents, we can repopulate the treeview according to its respective document. We don't actually store a complete copy of the netlist in the treeData. At least not when the file is first loaded. I mentioned earlier that only the top level scopes are loaded. When a user expands a scope in the Netlist Treeview, a vscode.TreeDataProvider calls a function called `getChildren()` and the default implementation is to return element.children[].

My implementation is to call `getChildrenExternal()`, which calls a WASM function `getchildren()`, which returns all child scopes and child vars. They are then added to the children element, where they are cached for next time around. While it is possible to load the entire netlist, for very large waveform dumps that contain millions of elements, this is faster and more memory efficient. I should also point out that this function may take multiple iterations, because WASM has a 64K limit on data that can be passed in and out. Also, I seemed to run into some bugs with wit_bindgen, where it doesn't like to pass lists of complex types, so everything is converted to a JSON string (for now.) In every scope and variable we load, we also load the scopeRef/varRef and signalRef so that if we need to query data like child elements or value change data, it's easy to do. Note that on the WASM side, they're referred to as scopeRef, varRef, and signalRef, whereas on the Typescript side, they're referred to as netlistId, and signalId. NetlistId can either be a scopeId or VariableId depending on the type.

When a user decides to display a signal, the extension does a `webview.postMessage()` for the `add-variable` command. The viewer then checks to see if it has value change data for that specific signalId. If it does not, it still displays the signal with a blank waveform (to acknowledge user action,) and then the webview sends a `vscode.postMessage()` for the `fetchTransitionData` command, which calls the WASM `getsignaldata()` function. The WASM code then sends the value change data to the webview.

I should preface this next part by acknowledging that there is probably a better way to do things (like send ing the data compressed.) The WASM serializes the data, converts it to a string, and breaks it up into chunks tha fit through the 64K window. Now this may sound cursed, but remember that at the end of the day the `postMessage()` routines do a `JSON.stringify()` and `JSON.parse()` under the hood. I'm just making it easier for the middle man. But since we're limited to 64K, this is sent via a series of callbacks to `sendtransitiondatachunk()`, which then calls `webview.postMessage()` with a `update-waveform-chunk` command. In this command, it contains the total number of chunks, the chunk number, and the chunk data. When the viewer processes an `update-waveform-chunk` command, it checks to see if all of the chunks are loaded If they are, it parses the data and displays the waveform data.

The signal data has some metadata elements such as the `signalWidth`. But all of the `transitionData` is stored as a flat array of transitions. Each transition is essentially a time and a value. The value is stored as a binary string (this could be improved, but remember that 4 state logic exists, and signals can be arbitrarily wide.) Now you might cringe at the idea of a flat array for this, but before coming to me with your whizbang idea of how to re-implement this, first consider how javascript implements large arrays under the hood! To assist in all of this, we also have an array called `chunkStart`. This is a lookup table of the start index of each time chunk so that we can slice the array as necessary to get the initial state and transitions of a particular chunk.

# Webview

As you might imagine, a waveform viewer requires a lot of custom UI elements that do not come standard with VScode. Hence the webview. When designing the webview, I had the following priorities in mind:

1. It needs to work
2. It needs to look nice
3. It needs to follow suit with the VScode design language where posible
4. It needs look and feel familiar to both VScode and other waveform viewers (like Verdi or GTKwave)

for pretty much everything, I used the same colors and fonts as per the VScode theme so that it adapts to changing color themes. Since some themes have colors for things that other themes don't (like high contrast themes) it was actually surprisingly difficult to find the right color for everything. Annoyingly enough, the color thme token colors are not defined in the CSS, and I wasn't able to find out how to grab them. I know how to use an `onDIdChangeActiveColorTheme()` event, but not how to actually get the token colors. If anyone knows how to get them, let me know! I wanted to use the numerical value color (that pastel green on the default theme) as the color of the waveforms. It looks good, but I want it to follow the color theme (which it doesn't quite do.)

## How it all gets rendered

The webview is split up into 4 main panes that are part of a CSS grid. There's a `control-bar`, the `waveform-labels-container`, the `transition-display-container`, and the `scrollArea` (where all of the waveforms are displayed)

The `control-bar` is more or less static content. Sure there are button event handlers with hover effects and a text entry, but it's largely uninteresting

The `waveform-labels-container` is also more or less static content, except that the labels can be rearranged. For that, I have click and drag handlers: `dragStart()`, `dragMove()`, and `dragEnd()`. And when a user rearranges signals, we have to call a function called `reorderSignals()` which triggers a whole bunch of DOM accesses across the webview.

The `transition-display-container` really just updates to the signal values every time the marker is updated.

The `scrollArea` is where most of the complexity lies, and will have it's own section...

## How waveforms are rendered

As alluded to earlier in the data structures overview, the waveforms are rendered in chunks. In fact the entire `scrollArea` is rendered in chunks. Since it didn't make sense to store all of the rendered (svg versions) of the waveform data in memory for all zoom levels, I used [clusterize.js](https://clusterize.js.org/). What this essentially does, is allow you to have a lot of rows in a scrollable element without the need for the DOM to track all of them (because otherwise you get a really laggy page) It does this by dynamically swapping rows in and out and inserting dummy spacer elements on the top and bottom. Since it was designed for rows, I modified it to use columns instead. It also assumes that all of the content is stored in memory, so I modified it to dynamically build the element as it is rendered. It also has a weird way of discerning which chunk needs to be rendered. So I modified that to fit my needs. Then I removed all of the code that did all of the unnecissary safety checks that I wouldn't be needing for my specific application. Since it shared a lot of state variables with the main vaporview.js file, I moved the code into the main file, merged state variables, and callback syntax to be cleaner and more concise.

As I got further along, I realized that Chromium limits scrollable elements to 16,777,216 pixels, which is (conveniently enough) the maximum integer size of a 32 bit floating point number. This is a problem when you have a large waveform and you zoom in really far. Chromium literally clips the element. So instead of using a scrollable element and inserting left and right spacer elements, I created a fake scrollbar that looks and acts just like a real one, ditched the spacer elements and calculate the `left:` property of the `contentArea` to behave as if it's inside a scrollable area. It still swaps columns in and out, but instead of calculating and inserting the spacer elements, it sets the `contentArea.style.left` property.

At this point, it's down to about 45 lines of code (from originally 330 lines) and it's hardly recognizable. But I do want to give a shout out to Denis Lukov (the author) for his work that ultimately made this project possible.

Since it can take longer than 1 frame's worth of time to generate the HTML and parse it, I render the waveform content asyncronously. This was more challenging than I had initially imagined, and it might still have a few bugs. But in essence, the basic chunk element (the chunk with the ruler) is dynamically fetched and rendered, and everything else is asynchronously rendered, yeilding to a `requestAnimationFrame()` so that the scrolling is smooth, but the content can be rendered a few frames later.

There's a mutationObserver that checks the rendered content for changed chunks, and then calls `renderWaveformsAsync()` to insert the waveforms into their respective elements. The hard part in all of this, was when updates were done before a chunk finished rendering. For this, I had to add an `abortFlag` to each chunk, that when set, the `renderWaveformsAsync()` function knows to stop, and a garbage collection function to remove all chunks that are not in the cache.

### The anatomy of a chunk

- .column-chunk
  - .ruler-chunk
  - .waveform-column
    - .waveform-chunk
    - .waveform-chunk
    - ...
  - #main-marker (if applicable)
  - #alt-marker (if applicable)

Chunks are rendered with the functions:

- `shallowFetchColumns()`
- `renderWaveformsAsync()`
- `updateChunkInCache()`
- `createTimeMarker()`
- `renderWaveformChunk()`
- `createWaveformSVG()`

### binary waveform elements

binary waveform elements are SVG lines that are drawn and scaled to fit in the chunk. 4 state values are red boxes drawn around. These are created with the following 2 functions:

- `binaryElementFromTransitionData()`
- `polylinePathFromTransitionData()`

Unfortunately, there seems to be a bug in chromium, where the SVG polylines aren't scaled properly at some display zoom levels. This causes gaps in the line between chunks when zoomed in really far. This is probably due to weird floating point math errors, but the workaround I have proposed is to change to a different zoom level.

### bus waveform elements

The implementation of bus waveforms is a bit cursed in my opinion. But then again, the way everyone draws them always seemed a bit strange to me. It seems simple enough, draw an elongated hexagon, and put the value inside. But The edge cases were an absolute pain! What happens when it's too short and becomes a diamond? How do you reliably draw that? What happens when it spans a chunk? How do you draw that? What happens when it's really short AND spans a chunk? Is my cunking method even a smart idea? How do I render the text when it's too short, too long, off screen, spanning a chunk boundary...? All this to say, I am open to a better implementation, but it's important to understand the scope of corner cases before jumping to conclusions.

I ultimately settled on drawing a solid hexagon/diamond shape rather than an outline. The text is rendered in the negative space. Not only is this visually cleaner, it's also way easier to implement. I created a base element which draws the diamonds as filled in SVG polylines, and is truncated on the top and bottom. This makes that nice hexagon/diamond shape that we want without. Unfortunately, to get the text to render how I want, each text element is a flexbox. However, I made it slightly less cursed by saving on DOM calls: I don't render text on states that are too small to read anyways, and grouping all adjacent states without text into one flex element. There might be a better way to render the text, but nothing I tried (SVG text and absolute positioned paragraph elements) was really any faster.

The 4 functions are used to draw bus elements

- `busElementsfromTransitionData()`
- `busElement()`
- `parseValue()`
- `valueIs4State()`

I should also point out that both the single bit and multi bit renderers have a way of discerning when there are too many transitions in a given area, and does a lazy draw. Chunk rendering times didn't improve as much as I would have expected, but it greatly improves performance when scrolling! It turns out Chromium's rendering algorithms don't like having to process that many lines. I can now zoom in and out freely on waveform dumps with hundreds of thousands of value changes and draw them all on screen, and have it feel smooth. Chunk render times aren't bad either.

### Markers and other annotation

Markers are essentially an SVG line that's drawn in the .column-chunk. This was a little tricky to implement, and may be due for a rewrite, as I plan to support a feature to highlight all transitions of a signal (or highlight all posedge or negedge transitions) You could say that I should just throw it in an SVG that I overlay over the chunk and be done with it, but that becomes problematic when I have event handlers in place for signal selection. `handleScrollAreaClick()` uses `event.target.closest()` to discern which  signal was selected. There might be a better way of doing this, and if there is, I'm all ears!

- `createTimeMarker()`

## Local state

I'm going to be honest, I was lazy in my implementation of this, and there are a bunch of global variables just lying around. I could probably put them into an object to make it a little safer.

Here are some of the important structures for the viewer:

- displayedSignals: netlistId[]

- waveformData: Map<signalId, transitionData>
  - transitionData: TransitionData[]
    - [time: number, value: number | string]
  - chunkStart[]
    - startIndex: number
  - signalWidth: number
  - chunkCount: number
  - textWidth: number

- netlistData: Map<netlistId, netlistData>
  - signalId: string
  - signalWidth: number
  - signalName: string
  - modulePath: string

- dataCache: object
  - valueAtMarker: Map<signalID, string>
  - startIndex: number
  - endIndex: number
  - updatesPending: number
  - valueAtMarker: Map<SignalId, string>
  - columns: object[]
    - rulerChunk: html string
    - marker: html string
    - altMarker: html string
    - waveformChunk: Map<netlistId, object>
      - html: html string

## Event Handlers

### Top 
- document: DOMContentLoaded

### Handle messages from the extension
- window: message

### Scroll position management
- #waveform-labels-container: scroll
- #transition-display-container: scroll
- #scrollArea: scroll
- #scrollArea: wheel
- window: resize

### Handle selection of markers and signals
- #scrollArea: click
- #scrollArea: mousedown

### Key bindings
- window: keydown

### resize handler to handle column resizing
- #resize-1: mousedown
  - document: mousemove
  - document: mouseup
- #resize-2: mousedown
  - document: mousemove
  - document: mouseup

### Control bar button event handlers
- #zoom-in-button: click
- #zoom-out-button: click
- #previous-negedge-button: click
- #previous-posedge-button: click
- #next-negedge-button: click
- #next-posedge-button: click
- #previous-edge-button: click
- #next-edge-button: click

### Search bar event handlers
- #search-bar: focus
- #search-bar: blur
- #search-bar: keydown
- #search-bar: keyup
- #time-equals-button: click
- #value-equals-button: click
- #previous-button: click
- #next-button: click
- #touchpad-scroll-button: click

### format button event handlers
- #format-binary-button: click
- #format-hex-button: click
- #format-decimal-button: click
- #format-enum-button: click

### click and drag handlers to rearrange the order of waveform signals
- #waveform-labels: mousedown
  - document: mousemove
- document: mouseup

### Event handlers to handle clicking on a waveform label to select a signal
- #waveform-labels: click
- #transition-display: click



