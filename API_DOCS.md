# Vaporview API

This document is work in progress, and may be subject to change. Please visit github for API discussions.

## Overview

Vaporview is designed with the VSCode IDE expereince in mind, and as such, I want to allow for extension interoperability as much as possible. This document outlines vaporview command subscriptions, and commands that are emitted.

# Context menus

Custom context menu commands can be added to vaporview componets such as the netlist viewer and and waveform viewer, and those context menu items can call commands to other extensions.

## Waveform Viewer Document (document webview)

Custom context menu items can be added to the waveform viewer webview. All attributes listed below are usable by [when clause](https://code.visualstudio.com/api/references/when-clause-contexts) statements

- **viewType:** vaporview.waveformViewer
- **package.json path:** contributes.menus.webview/context
- **when:** activeCustomEditorId == 'vaporview.waveformViewer'

### Attributes

- **webviewSection** - "signal"
- **modulePath** - Instance path (delimited by "." characters) without the variable name
- **signalName** - Variable or Scope Name
- **type** - this.netlistData[netlistId].variableType,
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
- **modulePath** - Instance path (delimited by "." characters) without the variable name
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

# Commands

In an attempt to future proof and maintain compatibility with any potential future waveform viewers, all public commands will be prefixed with the "waveformViewer" prefix instead of "vapoview". All commands in this API take in one argument, which is an object with all arguments named. This is to maintain compatibility with any context menu items

## vaporview.openFile

Opens a file with vaporview

### Argument: uri

This command takes the URI to a waveform dump file.

## waveformViewer.addVariable

Add a variable to the viewer

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **netlistId** - (Optional*) Waveform Dump File Variable ID
- **instancePath** - (Optional*) Full instance path for variable
- **modulePath** - (Optional*) - Variable module math without variable name
- **name** - (Optional*) - Variable name
- **msb** - (Optional) - Most Significant Bit
- **lsb** - (Optional) - Least Significant Bit

Note that a variable must be specified with at least of the following set of keys, and priority is as follows:

1. netlistId
2. instancePath
3. modulePath AND name

## waveformViewer.removeVariable

Remove a variable from the viewer

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **netlistId** - (Optional*) Waveform Dump File Variable ID
- **instancePath** - (Optional*) Full instance path for variable
- **modulePath** - (Optional*) - Variable module math without variable name
- **name** - (Optional*) - Variable name
- **msb** - (Optional) - Most Significant Bit
- **lsb** - (Optional) - Least Significant Bit

Note that a variable must be specified with at least of the following set of keys, and priority is as follows:

1. netlistId
2. instancePath
3. modulePath AND name

## waveformViewer.revealVariableInNetlistView

Reveal a variable or scope in the netlist view

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **netlistId** - (Optional*) Waveform Dump File Variable ID
- **instancePath** - (Optional*) Full instance path for variable or scope
- **modulePath** - (Optional*) - Variable module math without target variable or scope name
- **name** - (Optional*) - Variable or Scope name

Note that a variable or scope must be specified with at least of the following set of keys, and priority is as follows:

1. netlistId
2. instancePath
3. modulePath AND name

## waveformViewer.setMarker

Set the marker or alt marker to a time in the viewer

### Arguments: object

- **uri** - (Optional) Document URI - if not defined, this function will use the currently active, or last active document
- **time** - Target Time
- **units** - (Optional) Time Unit - If not specified, will default to waveform dump format time units "fs" | "ps" | "ns" | "us" | "µs" | "ms" | "s" | "ks"
- **markerType** - (Optional) Marker Type - 0: Main Marker, 1: Alt Marker
