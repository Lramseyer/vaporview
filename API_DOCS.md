# Vaporview API

This is the official API for Vaporview. This will remain stable for all future releases. Anything listed as a proposed API is subject to change. If you would like to see anything added to the API, please file an [issue](https://github.com/Lramseyer/vaporview/issues), or add it to the github [discussions](https://github.com/Lramseyer/vaporview/discussions/63).

Planned upodates to the API

- More commands
- Custom name translations
- Custom transactions
- URI schema for netlist elements

One point of caution is that the instance pathcan vary depending on tools used to elaborate the RTL, so there may be small changes made to how instance paths are listed. Please let me know if you run into any issues reconciling instance paths!

## Overview

Vaporview is designed with the VSCode IDE expereince in mind, so this document serves to help enable extension interoperability. This document outlines vaporview command subscriptions, and commands that are emitted.

- Custom context [right click] menu items
- Adding, removing, and selecting variables
- Placing markers
- Signal Value Links
- Drag and drop into viewer (proposed API)

# Context Menus

Custom context [right click] menu commands can be added to vaporview componets such as the netlist viewer and and waveform viewer, and those context menu items can call commands to other extensions.

## Waveform Viewer Document (document webview)

Custom context menu items can be added to the waveform viewer webview. All attributes listed below are usable by [when clause](https://code.visualstudio.com/api/references/when-clause-contexts) statements

- **viewType:** vaporview.waveformViewer
- **package.json path:** contributes.menus.webview/context
- **when:** activeCustomEditorId == 'vaporview.waveformViewer'

### Menu Groups

- 1_default
  - **Submenu vaporview.timeUnit**
  - Show Ruler Lines
  - Hide Ruler Lines
- 1_waveform_settings
  - **Submenu vaporview.valueFormat** - Value Format
  - **Submenu vaporview.valueColor** - Render Type
  - **Submenu vaporview.renderType** - Color
- 2_variables
  - Show In Netlist View
  - Remove Variable
  - Copy Name
  - Copy Value
- 3_groups
  - New Group
  - Rename Group
- 4_saveLoad
  - Save Viewer Settings
  - Load Viewer Settings
- 5_waveDrom
  - **Submenu vaporview.waveDrom** -  WaveDrom

### Signal Item Attributes - data-vscode-context

All signals in the webview will emit the following attributes when right clicked on

- **webviewSection** - "signal"
- **scopePath** - Instance path (delimited by "." characters) without the variable name
- **signalName** - Variable or Scope Name
- **type** - this.rowItems[netlistId].variableType,
- **width** - BitVector Bit Width of Variable, will be 0 for Strings and Reals
- **preventDefaultContextMenuItems** - always true
- **netlistId** -  Variable ID in waveform dump file

## Netlist View and Displayed Signals View

Context menu items can be added to the netlist view and displayed signals view. View IDs are listed below. Tree Item [netlist element] attributes are also outlined. However, keep in mind that for constructing a conditional menu, keep in mind that only the **contextValue** can be used for [when clause](https://code.visualstudio.com/api/references/when-clause-contexts) statements. However, when a command is called, all attributes are visible in an event object if passend into the first argument of the command handler function.

See [Tree Item API docs](https://code.visualstudio.com/api/references/vscode-api#TreeItem) for details

### Netlist View

- **ID:** waveformViewerNetlistView
- **package.json path:** contributes.menus.view/item/context
- **when:** view == 'waveformViewerNetlistView'

### Displayed Signals View

- **ID:** waveformViewerDisplayedSignalsView
- **package.json path:** contributes.menus.view/item/context
- **when:** view == 'waveformViewerDisplayedSignalsView'

### Menu Groups

- 1_default
  - Add Selected
  - Remove Selected
  - Add all in Scope
  - Add all in Scope (Recursive)
  - Remove all in Scope
  - Show in Viewer
  - Copy Name
- 2_addVariable
  - Add Variable By Name
- 3_saveLoad
  - Save Viewer Settings
  - Load Viewer Settings
- 4_reload
  - Reload File

### Attributes:

Note: Tree items in both the Netlist View and the Displayed Signals View have the same set of attributes.

- **contextValue** - "netlistVar" | "netlistScope" - see [Tree Item API docs](https://code.visualstudio.com/api/references/vscode-api#TreeItem) and scroll down to the contextValue section.
- **checkboxState** - [VScode Tree Item Checkbox State](https://code.visualstudio.com/api/references/vscode-api#TreeItemCheckboxState)
- **collapsibleState** - [VScode Tree Item Collapsible State](https://code.visualstudio.com/api/references/vscode-api#TreeItemCollapsibleState)
- **children** - Child Netlist Elements
- **iconPath** - [VScode Tree Item Icon Path](https://code.visualstudio.com/api/references/vscode-api#IconPath)
- **tooltip** - Tooltip Text
- **label** - [VScode Tree Item Label](https://code.visualstudio.com/api/references/vscode-api#TreeItemLabel)
- **name** - Variable or Scope Name
- **scopePath** - Instance path without the variable name (delimited by "." characters)
- **type** - [Variable Type](https://docs.rs/wellen/0.14.5/wellen/enum.VarType.html) or [Scope Type](https://docs.rs/wellen/0.14.5/wellen/enum.ScopeType.html).
- **encoding** - "BitVector" | "Real" | "String" | "none"
- **width** - (BitVector only) Bit Width of Variable
- **msb** - (BitVector only) Most Significant Bit
- **lsb** - (BitVector only) Least Significant Bit
- **numberFormat** - (BitVector only) Bit Vector Number format
- **netlistId** - Variable ID in waveform dump file
- **signalId** - Value Change Data index in waveform dump file
- **fsdbVarLoaded** - FSDB only attribute
- **scopeOffsetIdx** - FSDB only attribute

# Command Inputs

In an attempt to future proof and maintain compatibility with any potential future waveform viewers, most public commands will be prefixed with the "waveformViewer" prefix instead of "vapoview". Commands listed in this API may take in arguments, which will usually be an object with the arguments named. This is to maintain compatibility with any context menu items.

Note that this is not an exhaustive list of input commands in Vaporview, however once the API is finalized for 1.4, these commands come with a gaurantee that nothing will be removed from the schema. In other words, there will be no changes to these commands that might otherwise break another extension.

## vaporview.openFile

Opens a file with vaporview

### Arguments: object

- **uri** - Document URI
- **loadAll** - true | false - if set to true, will load all variables into the viewport
- **maxSignals** - abort loading all variables if netlist contains more than this number of variables. This value will be limited to 64

This command takes the URI to a waveform dump file.

## waveformViewer.addVariable

Add a variable to the viewer

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **netlistId** - (Optional*) Waveform Dump File Variable ID
- **instancePath** - (Optional*) Full instance path for variable
- **scopePath** - (Optional*) - Variable module math without variable name
- **name** - (Optional*) - Variable name
- **msb** - (Optional) - Most Significant Bit
- **lsb** - (Optional) - Least Significant Bit

Note that a variable must be specified with at least of the following set of keys, and priority is as follows:

1. netlistId
2. instancePath
3. scopePath AND name

## waveformViewer.removeVariable

Remove a variable from the viewer

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **netlistId** - (Optional*) Waveform Dump File Variable ID
- **instancePath** - (Optional*) Full instance path for variable
- **scopePath** - (Optional*) - Variable module math without variable name
- **name** - (Optional*) - Variable name
- **msb** - (Optional) - Most Significant Bit
- **lsb** - (Optional) - Least Significant Bit

Note that a variable must be specified with at least of the following set of keys, and priority is as follows:

1. netlistId
2. instancePath
3. scopePath AND name

## waveformViewer.revealVariableInNetlistView

Reveal a variable or scope in the netlist view

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **netlistId** - (Optional*) Waveform Dump File Variable ID
- **instancePath** - (Optional*) Full instance path for variable or scope
- **scopePath** - (Optional*) - Variable module math without target variable or scope name
- **name** - (Optional*) - Variable or Scope name

Note that a variable or scope must be specified with at least of the following set of keys, and priority is as follows:

1. netlistId
2. instancePath
3. scopePath AND name

## waveformViewer.setMarker

Set the marker or alt marker to a time in the viewer

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **time** - Target Time
- **units** - (Optional) Time Unit - If not specified, will default to waveform dump format time units "fs" | "ps" | "ns" | "us" | "µs" | "ms" | "s" | "ks"
- **markerType** - (Optional) Marker Type - 0: Main Marker, 1: Alt Marker

## waveformViewer.getOpenDocuments

Returns a list of open waveform viewer documents

### Arguments: none

### Return: object

Remember that to get a valid return value, all vscode commands must be called with an await keyword!

- **documents** - List of URIs corresponding to open documents
- **lastActiveDocument** - URI of last active or currently active wavefrom viewer document

## waveformViewer.getViewerState

### Return: object

Returns the viewer settings in the same schema as the save file

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document

## waveformViewer.getValuesAtTime

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **time** - (optional) if not defined, will use marker time for the document
- **instancePaths** - Array of instance path strings

### Return: Array of objects

- **instancePath** - Instance path string
- **value** - Array of values length 1 or 2 [current value] or [previous value, current value]

Note that if an instance path input is not found in the netlist, the result will not return a value for it.

# Event Emitters

Vaporview emits events when users perform actions in the viewer. If there's anything you wish to see added to this list, please comment on the [github issues](https://github.com/Lramseyer/vaporview/issues) page.

All events are emitted regaurdless of their source action - click, key press, or external action.

## onDidSetMarker

Emitted when the marker changes value in the viewer. 

- **uri** - uri
- **time** - number
- **units** - string

## onDidSelectSignal

Emitted when a signal is selected by either the user, or externally

- **uri** - uri
- **instancePath** - string
- **netlistId** - number
- **source** - "netlistView" | "viewer"

## onDidAddVariable

Emitted when a variable is added to the viewer

- **uri** - uri
- **instancePath** - string
- **netlistId** - number

## onDidRemoveVariable

Emitted when a variable is removed from the viewer

- **uri** - uri
- **instancePath** - string
- **netlistId** - number

## onDidDropInWaveformViewer (proposed)

Emitted when an unknown tree item is dragged into the viewer. The resourceUriList will contain all unknown URIs of tree items. This event is only emitted if the dataTransfer contains more than one unknown URI, and all known URIs (netlist items, and eventually config files) will be filtered out of the resourceUriList to prevent erroneous events from being emitted. The event also emits the location (group path and index) of where in the viewport the item was dropped, so that if the dropped item refers to a variable item, it can be places accordingly.

- **uri** - string
- **resourceUriList** - uri[]
- **groupPath** - string[]
- **index** - number

## Sample code for subscribing to event emitters

This would likely go in your `activate()` function
```typescript
// Check if Vaporview extension is installed
const vaporviewExtension = vscode.extensions.getExtension('lramseyer.vaporview');
if (!vaporviewExtension) {
  console.log('Vaporview extension not found - integration disabled');
  return;
}

// Wait for Vaporview to activate (if not already)
if (!vaporviewExtension.isActive) {
  await vaporviewExtension.activate();
}

// Get the Vaporview API
const vaporviewApi = vaporviewExtension.exports;
if (!vaporviewApi) {
  console.log('Vaporview API not available - onDidSelectSignal not found');
  return;
}

// Event handler subscription
const subscription = vaporviewApi.onDidSelectSignal(async (event: any) => {
  const uri          = event.uri
  const instancePath = event.instancePath;
  const source       = event.source;

  // Your handler code would go here
});

context.subscriptions.push(subscription);

```

# Signal Value Links

Something that has been in my roadmap for a while is the ability to "Allow users to link .objdump files to a program counter value for a more integrated debug experience" This was something I wanted when I first created vaporview (because I was debugging a CPU with no GDB or ETM tracing.) How cool would it be to debug a CPU with a waveform dump and actually connect it back to the line of code it's running? In brainstorming how to implelent it, I have a proposed solution, but it's actually a more general solution.

## How to Use

Signals will have the ability to have links added to them such that when a user clicks on a value, it will emit a custom command that other extension developers can call. Any command can be attached to a Signal. When that command is emitted, it will include an argument, which will be an object with the attributes listed below.

A submenu or menu group will be added for Signal Item context menu, and it will be up to the extension developer to contribute a menu item to add their custom command

### Attributes

- **netlistId** -  Variable ID in waveform dump file
- **scopePath** - Instance path (delimited by "." characters) without the variable name
- **signalName** - Variable or Scope Name
- **type** - this.rowItems[netlistId].variableType,
- **width** - BitVector Bit Width of Variable, will be 0 for Strings and Reals
- **encoding** - "BitVector" | "Real" | "String" | "none"
- **numberFormat** - Number format
- **value** - Value as Bit Vector
- **formattedValue** - Encoded value
- **time** - Time of value change

## waveformViewer.addSignalValueLink

### Arguments: object
  - **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
  - **command** - custom command that will be called when clicked
  - **netlistId** - (Optional*) Waveform Dump File Variable ID - note that this will be emitted by the context menu command, so developers will have this value
  - **instancePath** - (Optional*) Full instance path for variable
  - **scopePath** - (Optional*) - Variable module math without variable name
  - **name** - (Optional*) - Variable name
  - **msb** - (Optional) - Most Significant Bit
  - **lsb** - (Optional) - Least Significant Bit

Note that a variable must be specified with at least of the following set of keys, and priority is as follows:

1. netlistId
2. instancePath
3. scopePath AND name

## Sample code

package.json
```json
"contributes": {
  "menus": {
    ...
    "webview/context": [
      ...
      {
        "command": "myExtension.addLinkForValues",
        "when": "viewItem == 'netlistVar'",
        "group": "0_links"
      },
      ...
    ]
  },
  ...
  {
    "commands": [
      {
        "command": "myExtension.addLinkForValues",
        "Title": "Link Signal Values"
      }
    ]
  }
}
```

extension.ts
```TypeScript
// Register command for the context menu item
const disposable_1 = vscode.commands.registerCommand(
  'myExtension.addLinkForValues', 
  (e) => {
    const args = {
      netlistId: e.netlistId
      e.command: 'myExtension.clickSignalValueLink'
    }
    vscode.commands.executeCommand('waveformViewer.addSignalValueLink', args);
  }
);

// Register custom command that will be emitted by Signal Value Link
const disposable_2 = vscode.commands.registerCommand(
  'myExtension.clickSignalValueLink', 
  (e) => {onDidClickSignalValueLink(e)}
)
```

# Vaporview URI schema (proposal)

Vaporview will start supporting URIs to navigate within the viewer. It will use the scheme **waveform** to denote that it is a waveform document. Much like how VScode supports fragments to select lines and ranges of lines, vaporview schemes will support time values, time ranges, and instance paths of signals. All tree itmes in the netlist view will contain their respective URIs as the resourceUri field, and support drag and drop. This way, if you want your extension to support dragging and dropping netlist items, you can.

The **fragment** of the URI can contain an instance path, time value, or time range, and will be delimeted by an "&"

**Time** and **Time ranges** will be encoded as **t:5000** or **t:4000ns** (units are optional) for a time range, use a dash to delimit

**Instance Path** is encoded as **net:top.scope.signal**

# Save File Format (Proposal)

Note tha this is a proposal, which does not reflect the actual file format. I plan to coordinate with the Surfer team to standardize on a format, and this oultlines the things I would want for vaporview.

## Window Configuration

- Nested set of dividers

## Marker placement

- Main Marker
- Alt Marker

## Displayed signals

- Item type - Signal | Group | Transaction | Other?

## Item Type: Signal
- Type - Signal
- Instance Path
- Number Format - ie hex, decimal, binary
- Text justify - Left | right | center
- Render type - binary | multi-bit | linear | stepped | etc
- Pin location - top | bottom
- Color (preferably an index to adapt to color themes)
- Background Color
- Value Link Command

## Item Type: Group
- Type - Group
- Array of items

## Item Type Transaction
- Type - Transaction
- Transaction Type
- Arguments - Array of Signals