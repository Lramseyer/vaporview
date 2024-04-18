# Source Code Documentation

I wrote this in hopes that if anyone wants to help contribute to the development of VaporView, this document will help serve as a starting point. That being said, feel free to reach out to me if you have further questions. I would be more than happy to have other contributors!

I should also mention if it's not obvious; I come from a hardware background. Web programming is not my area of expertise. You're not going to offend me by crutiquing my code or my choices. You're also not going to offend me for crutiquing my life choices - especially if you use Verdi through a VDI or VNC session and you actually like it! I hope this documentation is able to provide an explaination on how everything is implemented so that we can make this project into the best it can be.

## Low hanging fruit

Since me and my gang of AI ghost writers have (up to this point) have been the sole contributors to this project, you might imagine that it's a lot of work to make this code useful _and_ nicely organized _and_ well documented _and_ have hice asthaetics _and_ juggle all of my other priorities of life like Skiing and Rock Climbing. So I have compiled a list of things that you could easily get started on to contribute to this project.

- Improving the look of the assets, like the icons or the logo
- Organizing the code by breaking it up into multiple files or improve naming conventions
- Improving documentation

## Not so low hanging fruit

While not necissarily a priority, I have a list of things that would greatly enhance the usability of this extension, but they're kind of difficult (for me at least) and I might need some help with these:

- Rewriting performance critical components (like the renderer) in Web Assembly
- Supporting other file formats besides .vcd files
- Support for large files with `fs.read()`

You know what, if you can just get the build flow working so that I can use native node modules instead of the vscode version of `fs` _or_ get the [fsChunks API proposal](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.fsChunks.d.ts) in place, that would be a huge help. I could honestly do the rest.

## Extension overview

There are 2 main parts to this extesnion: The VScode Extension (src/web/extension.ts) and the webview component (media/extension.js and media/clusterize_mod.js) They communicate via a messaging interface: `webview.postMessage()` and `vscode.postMessage()` on the extension and webview side respectively. This is mainly used for setting up the webview, and for adding and removing signals from the viewer. It's important to note that when a signal is rendered in the webview, the extension only sends over the waveform data for that signal that is being rendered. This is important for my future plans in supporting larger waveform files. If we only load into memory what is actually in the viewer, we're not going to run into memory issues.

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

I'll state the obvious first, and say that VCD is good for really only one thing; and that is being easy enough to understand at first glance, so that fools like myself can take a look at it and think "I could write a waveform viewer. How hard can it be?" Everything else, it's pretty terrible at. It's not memory efficient since it's plaintext, and it's not easily searchable or easily queryable. At the end of the day, a waveform dump is a sparsely populated data set. It is written in time, but accessed on a per signal basis.

This means that for VCD files, I have to parse the whole document to extract the waveform data. I take a very naiive approach to parsing VCD files, and there is definitely some obvious room for improvement here if anyone wants to give it a shot. I wouldn't call it a low hanging fruit, but it's not like you're rewriting LLVM either.

## Extension data tree

- WaveformViewerProvider (implements vscode.CustomReadonlyEditorProvider<VaporviewDocument>)
  - netlistTreeDataProvider: NetlistTreeDataProvider (implements vscode.TreeDataProvider<NetlistItem>)
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
  - netlistViewSelectedSignals: NetlistItem[]
  - displayedSignalsViewSelectedSignals: NetlistItem[]
  - webviews: webviewCollection()
    - numWebviews: number
    - resource: string
    - webviewPanel: vscode.WebviewPanel;

- VaporviewDocument extends vscode.Disposable implements vscode.CustomDocument
  - _uri: vscode.Uri
  - _netlistTreeDataProvider: NetlistTreeDataProvider
    - treeData: NetlistItem[] (extends vscode.TreeItem)
  - _displayedSignalsTreeDataProvider: DisplayedSignalsViewProvider
    - treeData: NetlistItem[] (extends vscode.TreeItem)
  - _netlistTable: Map<NetlistId, NetlistlIdRef>
    - netlistItem: NetlistItem
    - displayedItem: NetlistItem
    - signalId: string
  - _delegate: VaporviewDocumentDelegate
  - _documentData: WaveformTop
    - metadata:   WaveformTopMetadata
      - timeEnd: number
      - filename: string
      - chunkTime: number
      - chunkCount: number
      - timeScale: number
      - defaultZoom: number
      - timeUnit: string
    - netlistElements: Map<SignalId, SignalWaveform>
      - signalWidth: number
      - chunkStart: number[]
      - transitionData: TransitionData[]
        - [time: number, value: number | string]

- NetlistItem (extends vscode.TreeItem)
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

## Parsing a VCD file

When parsing a VCD file, the data is stored in a `WaveformTop` class (which stores the metadata and a `SignalWaveform` hash table,) and in a `NetlistTreeDataProvider` class, which maintains netlist topology. This might seem weird at first, but we really only need to know the netlist topology for the `TreeView`. But since multiple `TreeItem` elements can reference the same `SignalWaveform` data, they are stored as separate structures.

We have to store a copy of each treeview for each document that's open so that if a user wants to open up multiple documents, we can repopulate the treeview according to its respective document. In the future, I plan to add support for larger files that can't necissarily be completely loaded into memory _whenever the vscode team decides to support fs.read()_. When this feature gets added, I will read the file in chunks, but I will stil need to load in the full netlist. But that doesn't consume a ton of memory, so it won't be a problem. Then this way, it can reference back to which signal data to load into memory when reading the file.

To tie these structures together, I should probably explain what a `SignalId` and a `NetlistId` are. A SignalId is essentially a hash of the signal name and module path, and it refers back to the `NetlistItems` in the `NetlistTreeDataProvider` as well as the `SignalId` The `SignalId` is what's actually used in the .vcd file. I create the `netlistId` with a low budget hashing algorithm. Unfortunately, multiple `netlistId`'s can point to the same `signalId` so we need to have 2 sets of keys. I learned this the hard way, because I originally used just a `signalId`, and it caused some really weird and annoying bugs!

Once the metadata and netlist are parsed, we start parsing the transition data. This is where things get a little weird. See, for ease of rendering, I made it such that everything is in chunks. This way, we don't actually have to render the entire waveform. Since the actual HTML components of a waveform consume a non-trivial amount of memory, we can dynamically render as we scroll. This isn't a big deal for smaller waveforms, but it is for larger waveforms. Maybe it's premature optimization, I don't know.

The signal data has some metadata elements such as the `signalWidth`. But all of the `transitionData` is stored as a flat array of transitions. Each transition is essentially a time and a value. The value is stored as a binary string (this could be improved, but remember that 4 state logic exists, and signals can be arbitrarily wide.) Now you might cringe at the idea of a flat array for this, but before coming to me with your whizbang idea of how to re-implement this, first consider how javascript implements large arrays under the hood! To assist in all of this, we also have an array called `chunkStart`. This is a lookup table of the start index of each time chunk so that we can slice the array as necessary to get the initial state and transitions of a particular chunk.

## Document handlers

There are 2 main classes that handle the lifecycle of a document: `VaporviewDocument` and `WaveformViewerProvider`. These handle setting up and communicating with the webview, figuring out which document is in focus, and setting up and populating the view containers according to which viewer is in focus. This is important, because we don't want a signal being rendered in the wrong webview!

# Webview

As you might imagine, a waveform viewer requires a lot of custom UI elements that do not con standard with VScode. Hence the webview. When designing the webview, I had the following priorities in mind:

1. It needs to work
2. It needs to look nice
3. It needs to follow suit with the VScode design language where posible
4. It needs look and feel familiar to both VScode and other waveform viewers (like Verdi or GTKwave)

for pretty much everything, I used the same colors and fonts as per the VScode theme so that it adapts to changing color themes. Since some themes have colors for things that other themes don't (like high contrast themes) it was actually surprisingly difficult to find the right color for everything. Annoyingly enough, the color thme token colors are not defined in the CSS, and I wasn't able to find out how to grab them. I know how to use an `onDIdChangeActiveColorTheme()` event, but not how to actually get the token colors. If anyone knows how to get them, let me know! I wanted to use the numerical value color (that pastel green on the default theme) as the color of the waveforms. It looks good, but I want it to follow the color theme (which it doesn't quite do.)

## How it all gets rendered

The webview is split up into 4 panes that are part of a CSS grid. There's a `control-bar`, the `waveform-labels-container`, the `transition-display-container`, and the `scrollArea` (where all of the waveforms are displayed)

The `control-bar` is more or less static content. Sure there are button event handlers with hover effects and a text entry, but it's largely uninteresting

The `waveform-labels-container` is also more or less static content, except that the labels can be rearranged. For that, I have click and drag handlers: `dragStart()`, `dragMove()`, and `dragEnd()`. And when a user rearranges signals, we have to call a function called `reorderSignals()` which triggers a whole bunch of DOM accesses across the webview.

The `transition-display-container` really just updates to the signal values every time the marker is updated.

The `scrollArea` is where most of the complexity lies, and will have it's own section...

## How waveforms are rendered

As alluded to earlier in the data structures overview, the waveforms are rendered in chunks. In fact the entire `scrollArea` is rendered in chunks. I originally used [clusterize.js](https://clusterize.js.org/), however that was designed for rows instead of columns, and does not support dynamically fetching content. It also has a weird way of discerning which chunk needs to be rendered. So I modified it to fit my needs. While it's barely recognizable, Denis Lukov (the author) deserves a shout out for his work that ultimately made this project possible. In summary, we create dummy elements to the left and right, and only render the chunks that are on the screen. We dynamically render the chunks as they're loaded in. And I use the term "render" loosely here, because we're really just creating the HTML for these chunks and inserting it to the DOM.

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

I ultimately settled on drawing a solid hexagon/diamond shape rather than an outline. The text is rendered in the negative space. Not only is this visually cleaner, it's also way easier to implement. I created a base element which is an SVG diamond (found in media/diamond.svg) and it is scaled width wise, has text drawn on it, and is truncated on the top and bottom. This makes that nice hexagon/diamond shape that we want without having to draw all of these lines in javascript. Unfortunately, to get the text to render how I want, each element is a flexbox. This might be able to be converted to an SVG, but text positioning and truncation will still be a bit of a challenge.

The 4 functions are used to draw bus elements

- `busElementsfromTransitionData()`
- `busElement()`
- `parseValue()`
- `valueIs4State()`

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