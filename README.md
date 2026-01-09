# Vaporview

VaporView is an open source waveform viewer extension for Visual Studio Code - [download](https://marketplace.visualstudio.com/items?itemName=lramseyer.vaporview)

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/overview.png?raw=true)

# Waveform Viewer Features

- Native support for VCD, FST, and GHW files
- Smooth panning and zooming using touchpad gestures or a scroll wheel
- Add, remove, rearrange, and grouping of signals in the viewer
- Place and move markers
- Search for values within a waveform dump
- Terminal Links for timestamps and instance paths
- Remote waveform viewing via VScode SSH and surfer surver
- IDE integration with other language extensions

Vaporview Also supports FSDB files where external libraries are present (see [build FSDB addon](https://github.com/Lramseyer/vaporview/blob/main/GETTING_STARTED.md#optional-build-fsdb-addon)). For use of other waveform dump formats such as LXT, VZT, GTKwave offers conversion tools. Proprietary formats such as WLF and VPD can also be converted, but require you to compile GTKwave. See the [GTKwave Manual](https://gtkwave.sourceforge.net/gtkwave.pdf) for details - page 16, and 69 for an overview.

# VScode IDE Integration

## Terminal Links

VaporView associates timestamps and netlist paths as links in the terminal. These links are activated by **Ctrl + Clicking** on the link. Timestamp links will place the marker at the designated timestamp and move the viewer to that marker (if necessary) whereas netlist path links will add the designated signal into the viewer. The following formats are recognized by VaporView:

- UVM timestamp - ie: `@ 50000`
- Timestamp with Units - ie: `50,000 ns` (comma is optional)
- Netlist elements - ie: `top.submodule.signal`

When clicking on instance path links, paths that point to a variable will add that variable to the viewer. However, if the path points to a scope, it will instead reveal and select that scope in the netlist view.

## Interoperability With Other Extensions

List of extensions that connect to Vaporview:

- [SV Pathfinder](https://marketplace.visualstudio.com/items?itemName=heyfey.sv-pathfinder) - RTL Linking and tracing - [Github](https://github.com/heyfey/sv-pathfinder)
- [slang-server](https://marketplace.visualstudio.com/items?itemName=Hudson-River-Trading.vscode-slang) - System Verilog Language Server - [Github](https://github.com/hudson-trading/slang-server)

### API details

Vaporview has a set of commands and event emitters that allow interaction with other extensions. This allows for powerful features like RTL linking, in editor debugging, and firmware tracing while being HDL and simulator agnostic. See the [API docs](https://github.com/Lramseyer/vaporview/blob/main/API_DOCS.md) if you are interested in integrating Vaporview into your extension.

## Remote Waveform Viewing

Vaporview allows you to connect to a remote machine and open up waveforms remotely via [VScode Remote Development](https://code.visualstudio.com/docs/remote/ssh) or [Surfer surver](https://gitlab.com/surfer-project/surfer#server-mode-experimental). Remote development should work out of the box, however to connect to a Surfer surver, you will need to enter in the command "**> vaporview.openRemoteViewer**" and paste in the URL for the Surfer surver. Alternatively, if the URL is in a VScode terminal, it can be connected to automatically by clicking on the link.

# Controls

## Keyboard Shortcuts

- **Ctrl + Scroll Wheel** - Zoom in and out on waveforms
- **Ctrl + 0** - Zoom out to fit
- **Shift + Scroll Wheel** - Scroll up and down on waveforms
- **Up/Down Arrow** - Select signal above/below selected signal
- **Alt + Up/Down Arrow** - Rearrange selected signal
- **Ctrl/Cmd + A** - Select all signals
- **Left/Right Arrow** - Move marker to previous/next value change of selected signal
- **Alt + Click or Middle Click** - Set Alt-Marker
- **Home** and **End** - Scroll to the beginning and end (respectively) of the waveform
- **Delete** or **Backspace** - Remove Selected Signal
- **Escape** - Abort click and drag event (Rearranging signals, zoom, scrolling)

## Adding and Removing Signals

Signals may be added or removed through VaporView view container. Click on the VaporView Activity Bar icon, and it will show the netlist for the opened waveform file as well as the signals displayed in the tab.

### Adding Signals

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/add_signals.gif?raw=true)

To Add a signal, click the "+" icon to the right of the netlist variable in the "Netlist" view or double click on the variable. It will also show in the "Displayed Signals" view.

Signals can also be added by dragging and dropping them from the netlist view to the viewer. Make sure to hold **Shift** before dropping them into the viewer - note that this is a VScode requirement.

### Removing Signals

To remove a signal, that signal can be un-checked from either the "Netlist" view or the "Displayed Signals" view. From the viewer, you can either select the signal you would like to remove and hit **Delete**, or right click on a signal in the viewer and select **remove signal** from the menu.

### Other less common ways

Multiple signals can be added or removed by selecting the signals you would like to add or remove, and then right click and select **Add/Remove selected signals** from the menu.

Signals can be added via a terminal link, and they can be added or removed via API commands.

## Scrolling

The scroll wheel (or touchpad scroll) is used to pan in time or scroll up or down. By default, auto detect scrolling mode is enabled. To toggle between scrolling modes, click the **"Auto detect Mouse/Touchpad Scrolling"**, **"Enable Touchpad Scrolling"**, or **"Enable Mouse Scrolling"** Button on the top right.

### Mouse Scrolling

Scroll wheel scrolls sideways by default. To scroll up or down, either hold Shift and scroll, or hover the cursor over to the signal name labels on the left and scroll normally.

### Touchpad Scrolling

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/touchpad_scroll.gif?raw=true)

## Zooming

Zooming can be done one of 3 ways:

- Hold **Ctrl**, and **Scroll**, or use the pinch gesture in touchpad mode
- Use the Zoom in/out buttons on the top right
- Click and drag over the area you wish to zoom in on

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/zoom.gif?raw=true)

## Rearranging signals

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/rearrange.gif?raw=true)

To rearrange signals, simply click on the label and drag the signal to where you want it.

Alternatively, you can select a signal, hold **Alt**, and press the **Up** or **Down** Arrows to reorder (similar to how you reorder lines in the text editor)

## Marker Handling

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/marker.gif?raw=true)

There are two markers in VaporView: a normal marker, and an alt-marker. To place the marker, simply click where you want it to be placed. Keep in mind that it will snap to edge if applicable. To place the alt-marker, either **Middle Click**, or **Alt + Click** where you would like to place it. The alt-marker will also snap to an edge if applicable.

It should also be noted that signals can be selected by clicking on them, You can also use the **Up/Down** Arrow keys to move the selection.

### Next/Previous Edge

To move the marker to the nearest edge _**of the selected signal**_, you can either click the control bar buttons, or use the **Left/Right** Arrow Keys. Alternatively, VaporView also supports the Verdi bindings of using **"N"** and **"Shift + N"** to go to the next and previous edge respectively. If no signals are selected, the marker will step forward or backward 1 time unit.

To move to the next positive edge or negative edge, you will have to use the control bar buttons. This only applies to single bit waveforms.

### Placing markers as links from log files

When log files are opened in the terminal, VaporView will automatically parse out timestamps. Use **Ctrl + Click** to place a marker and move to that timestamp. Note that if multiple viewers are open, it will place a marker in the last active viewer.

### Finding values and transitions in a particular waveform

Finding a particular transition or a value in a waveform is done in relation to the selected signal and the marker (similar to how Visual Studio Code handles search in relation to the text cursor)

## Value Formatting

Vaporview can display values in different number formats. To change the value format, right click on the signal in the viewer and select **Format Values** -> and select the value format you wish to display. Note that some values have limitations when displaying values with non-2-state bits in them, and will fall back to displaying the value as Binary. For details see the table below:

| Value Format   | Non-2-state Supported | Justify Direction |
| -------------- | --------------------- | ----------------- |
| Binary         | ✅ Yes                | Right             |
| Hexadecimal    | ✅ Yes                | Right             |
| Octal          | ✅ Yes                | Right             |
| Decimal        | ❌ No                 | Left              |
| Floating Point | ❌ No                 | Left              |
| ASCII          | ❌ No                 | Left              |
| Enum           | ❌ No                 | Left              |

## Waveform Color

Vaporview supports 8 different waveform colors. The colors are based off the [semantic token colors](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide) for VScode text.* There are 4 builtin colors, and 4 custom colors that can be configured in the vaporview settings. To change the color, right click on the waveform, select **Color** -> and select the color you wish to use.

*Unfortunately, the VScode API does not make these colors visible to custom webviews yet. It is an [open issue](https://github.com/microsoft/vscode/issues/32813), so there's a hack in place. The default waveform colors will not follow suit with all color themes, but it should work broadly between light themes and dark themes.

## Waveform Render Types

Aside from the binary and multi-bit waveform renderers, Vaporview supports displaying analog signals. Any multi-bit variable or Real type supports this. Analog signals can be displayed wither as a linear or stepped line. In the case of binary values, the Y value can be evaluated as either a signed or unsigned value. To change the Render Type, right click on the signal in the viewer and select **Render Type** -> and select the render type you wish to use for the signal.

### Multi-bit display type

The multi-bit renderer defaults to shaded shapes, but the more traditional outlined shapes can be enabled in the settings by de-selecting "Fill Multi Bit Values" ("vaporview.fillMultiBitValues": false)

### Analog Waveforms

Vaporview supports analog waveforms for Real and Bit Vector data types. For Bit Vector data types, waveforms can be interpreted as signed or unsigned values. Analog waveforms support different row heights as well as vertical zooming.

To adjust the row height, right click on the signal, and select your desired row height. To vertically zoom, select the signal and press **Alt +/-** to vertically zoom

## Time Units

You can change the Time Units in one of 2 ways: clicking the Time Status Bar in the lower right hand corner of the window, or by right clicking on the time ruler and selecting units from the **Time Unit** menu.

## Saving and loading opened signals

VaporView allows you to save and load your signal list. This can be done either by right clicking anywhere in the viewer or netlist and selecting **"Save Vaporview Settings"** or **"Load Vaporview Settings"**. You can also access the command directly by pressing **Ctrl + Shift + P** and Type **">Save Vaporview Settings"** or **">Load Vaporview Settings"** and press **Enter** to select the command. A dialog box will pop up prompting which file you would like to save/load settings from.

**Note:** The settings will only load for the active viewer tab that is in focus, and will look up signals by name. If the module paths have changed, it may not load in the signals properly. The settings files however are plaintext (JSON) and can be edited if need be.

## Copying selection as WaveDrom

If you would like to export a portion of the viewer as WaveDrom, VaporView supports that ...with some limitations. Since WaveDrom is a simplified format for making waveform diagrams, not all of the precise timing detail can be captured in WaveDrom.

A maximum of 32 events can be copied as WaveDrom. To select a copy range, simply place the marker and alt-marker at the start and end of your selection range (ordering doesn't matter) Right click on the waveforms, and select **"Copy Selection as WaveDrom"** from the menu. The WaveDrom JSON text will then be copied into your clipboard.

All displayed signals will be copied in order that they are displayed in the viewer. They will be named with their full module path, and the number format for the values will copy as displayed in the viewer as well.

### Without a WaveDrom clock set

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/wavedrom_no_clk.png?raw=true)

To unset the waveDrom clock, right click on the waveforms, and select **"Unset WaveDrom Clock"**

When no WaveDrom clock is set, an "event" is classified by a value transition of any of the displayed signals. If multiple signals change value at the same time, that counts as only one event. Due to the limitations of WaveDrom, time events may not be spaced out proportionally.

### With a WaveDrom clock

![](https://github.com/Lramseyer/vaporview/blob/main/readme_assets/wavedrom_with_clk.png?raw=true)

To set which signal will be the WaveDrom Clock, right click on the signal you wish to be the clock, and select **"Set WaveDrom Clock Rising"** or **"Set WaveDrom Clock Falling"**. When a clock is set, a WaveDrom event will be counted on the edge of the selected clock. If other displayed signals do not have a value transition on the edge of the selected clock, the first (if it exists) value transition that occurs between the current and next clock edge will be logged. If multiple value transitions for a given signal (that is not the clock) occur in one clock cycle, it will only copy the first value transition. Note that because of this limitation, the WaveDrom output will not contain all of the information.

# Requirements

This extension requires VScode 1.96.0 or later

# Development Roadmap

## 1.4.5 - 1/8/2026 - Latest Release

- Added Ctrl/Cmd+R hotkey for "Show in Netlist View"
- Changed marker placement behavior - Ctrl/Alt is no longer required to move to next value change
- Fix G hotkey in cursor chat bug where it erroneously creates a new group
- G hotkey will no longer add only one signal to a group if it's selected
- Fixed file loading errors with group placement
- Fixed scroll de-sync when adding new groups
- Fixed Decimal number formats to work beyond 32 bit numbers
- Updated to wellen 0.20.1

# Upcoming Release

- VScode now tracks save files and will prompt user before closing with unsaved changes
- Added Undo/Redo Support

See the [Changelog](https://github.com/Lramseyer/vaporview/blob/main/CHANGELOG.md) for more details

# About This Extension

I originally built this extension when I worked for an FPGA company. I wanted a good _free_ waveform viewer extension, and I always thought it would be cool to make my own extension.

This is and always will be open source. It's free to use for personal and professional use. There never will be feature regression in favor of a premium tier. In other words, every feature that is currently included, or on the roadmap will be free and open source. Adaptations of the source code completely or even in part for other projects is only allowed _if_ the project is also free and open source. Adaptations of the source code completely or in part for distribution in enterprise software is not allowed _unless_ prior written permission is given by the owner of this project.

This extension was originally written by one person, with a full time job that doesn't involve anything to do with writing javascript or typescript. If you would like to see a feature added or functionality changed, or better yet, if you would like to help contribute please visit the [github repository](https://github.com/Lramseyer/VaporView) and discuss there!

# Acknowledgements

This project uses the [wellen](https://github.com/ekiwi/wellen/tree/new-api) library compiled to WASM for file parsing and back-end data management.

Also special thanks to the Surfer team for their support and encouragement and all they're doing in the open source community! This project is compatible with the surfer surver protocol.

## Contributors:

- [@lramseyer](https://github.com/Lramseyer) (Owner)
- [@heyfey](https://github.com/heyfey)
- [@marco-fr](https://github.com/marco-fr)
- [@DGGua](https://github.com/DGGua)

## Misc

Thanks to my coworkers for their encouragement, feature requests, bug reports, and contribution of VCD files that made this project possible!