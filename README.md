# VaporView

VaporView is a VCD waveform viewer extension for Visual Studio Code designed for FPGA/RTL developers.

![](readme_assets/overview.png)

## Controls

### Keyboard Shortcuts

- **Ctrl + Scroll Wheel** - Zoom in and out on waveforms
- **Shift + Scroll Wheel** - Scroll up and down on waveforms
- **Up/Down Arrow** - Select signal above/below selected signal
- **Alt + Up/Down Arrow** - Rearrange selected signal
- **Ctrl + Left/Right Arrow** - Move cursor to previous/next value transition of selected signal
- **Alt + Click or Middle Click** - Set Alt cursor

### Adding and Removing Signals

Signals may be added or removed through VaporView view container. Click on the VaporView Activity Bar icon, and it will show the netlist for the opened waveform file as well as the signals displayed in the tab.

To Add a signal, simply check the box next to the netlist signal ID in the "Netlist" view. It will also show in the "Displayed Signals" view.

To remove a signal, that signal can be un-checked from either the "Netlist" view or the "Displayed Signals" view.

### Scrolling

The scroll wheel (or touchpad scroll) is used to pan in time or scroll up or down. By default, mouse mode scrolling is enabled. To toggle between scrolling modes, click the "Enable Touchpad Scrolling" Button on the top right

#### Mouse Scrolling

Scrolling behaves as you would expect except for when scrolling the actual waveforms (where it scrolls sideways by default.) To scroll up or down, either hold Shift and scroll, or move your cursor over to the signal name labels on the left and scroll normally.

#### Touchpad Scrolling

Scroll as you would on a normal touchpad to scroll up, down, and sideways.

### Zooming

To Zoom in or out, hold Ctrl, and Scroll to zoom. Or use the Zoom in/out buttons on the top right.

### Rearranging signals

![](readme_assets/rearrange.gif)

To rearrange signals, hover over the signal name, and you will see a rearrange grabber indicator. Click and drag to rearrange.

Alternatively, you can select a signal, hold Alt, and press on the Up or Down Arrows to reorder (similar to how you reorder lines in the text editor)

### Finding values and transitions in a particular waveform

Finding a particular transition or a value in a waveform is done in relation to the selected signal and the cursor (similar to how Visual Studio Code handles search in relation to the cursor)

### Next/Previous Edge

This function will move the cursor (and the scroll position if applicable) to the next or previous signal transition relative to the cursor.

This can be done either by the buttons on the top navigation bar or by holding Ctrl + Left or Right Arrow. (This is similar to the text editor shortcut to move the cursor to the nearest word boundary.)

#### Next/Previous Positive/Negative Edge

These controls only apply to single bit waveforms, and can be used by clicking their respective buttons in the navigation bar at the top.

## Requirements

This extension was designed on version 1.83.

## Known Issues

This only supports VCD files, and probably not larger than 100MB.

## Release Notes and development roadmap

### 1.0 - The Goal

Battle test with coworkers and trusted users to fix and address any oversights or bugs I may have missed during development

- When opening another vcd file, the netlist needs to load in the view properly
- Export selection as WaveDrom

#### Suggestions from coworkers:

- Save opened signals

### Beyond 1.0

- Add support for Enums
- Add support to highlight all transitions of a signal
- Add support for custom colors
- Add support for linking timestamps in UVM logs (or other simulation logs) to jump to a timestamp
- Add support for remote sessions to save on memory
- Highly unlikely
  - Link netlist to RTL so that signals can be connected back to RTL locations
  - Support for other file formats

## About The Author

I originally built this because I work for an FPGA company, doing FPGA things, and I couldn't find a good _free_ VCD viewer extension. I also hate having to use VNC for viewing waveforms. So rather than spend $15, I spent 300 hours making this extension.

This is and always will be open source. It's free to use for personal and professional use. There never will be a premium tier. Adaptations of the source code completely or even in part for other projects _is_ only allowed _if_ the project is also free and open source. Usage of the source code completely or in part for enterprise software is not allowed unless prior written permission is given by the owner of this project. And I am open to offers.

This extension was written by one person, with a full time job that doesn't involve anything to do with writing javascript or typescript. If you would like to see a feature added or functionality changed, or better yet, if you would like to help contribute please visit the github repository and discuss there!

## Acknowledgements

This extension uses a modified version of [clusterize.js](https://clusterize.js.org/)