# Change Log

# 1.5.0 - 2/25/2026 - Latest Release

- Added Undo/Redo Support
- Added feature to create custom signals from bit range
- Added feature to split bit vector into individual bits
- VScode now tracks save files, and will prompt you before closing with unsaved changes
- Added Fixed Point number formats
- Updated License to AGPL-3.0
- Updated to wellen 0.20.2
- API
  - Added "reveal" option to waveformViewer.addVariable command
  - Added vaporview.enableInstancePathTerminalLinks user setting
  - Finalized onDidDropInWaveformViewer event emitter
- Fixed
  - Selecting multiple signals no longer moves the time marker
  - Dragging the scrollbar now works even if the mouse pointer is offscreen
  - Right clicking on marker no longer brings up the wrong menu
  - Highlight zooming at the edge of the viewport now works as expected
  - Scopes with blank names now save and load properly with save files

## 1.4.5 - 1/8/2026

- Added Ctrl/Cmd+R hotkey for "Show in Netlist View"
- Changed marker placement behavior - Ctrl/Alt is no longer required to move to next value change
- Fix G hotkey in cursor chat bug where it erroneously creates a new group
- G hotkey will no longer add only one signal to a group if it's selected
- Fixed file loading errors with group placement
- Fixed scroll de-sync when adding new groups
- Fixed Decimal number formats to work beyond 32 bit numbers
- Updated to wellen 0.20.1

## 1.4.4 - 12/11/2025

- Added double click handler to netlist view - double click adds variable to viewer
- Removed Netlist View Checkboxes
- Allow for multiple instances of the same signal to be displayed in the viewer
- Updated time ruler to show the marker time
- Added Signal Separators
- Updated control bar tooltips to match VScode style
- Multi signal select now batch configures number format
- Added check for saved config file and prompts user to reload saved settings
- Added Ctrl/Cmd + A keybinding to select all signals
- Variables added to the viewer default to showing up under the selected signal instead of at the end
- Added WCP support @heyfey
- Fixed Renderer glitch in Windows affecting binary and bit vector renderer
- Upgraded to wellen 0.19.2

## 1.4.3 - 11/4/2025

- Added
  - Support for Enums
  - Sort netlist View to show Parameters at the top
    - Alphabetical sorting is now a user option
  - Show Parameter values in netlist view
  - Multi signal select now batch configures row height and render type (on compatible signals)
  - Custom names for variable items
  - Settings button on the right side of the control bar
- Escape key de-selects all signals
- Fixed
  - Group expanded state is preserved on reload
  - Removed netlistId from save files and use instance paths only
  - Improved signal selection ordering
- API
  - waveformViewer.addVariable will now add all variables in a scope if it is specified

## 1.4.2 - 10/11/2025

- Added
  - Multi signal select
  - Multi signal reorder
  - Outlined multi-bit renderer - enabled in settings menu
- Fixed
  - Drag and drop from tree view places signals at the end of group
  - Files with one time table entry now show values
  - New groups now appear where right click event happened
- Removed "Displayed Signals" View
- Netlist hierarchy displays items in alphabetical order

## 1.4.1 - 9/12/2025

- Added
  - Drag and drop from netlist view to add variables into the viewer
  - Signal height can now be set to 2x, 4x, and 8x
  - Analog signals can now be vertically zoomed in and out
  - ASCII value format
  - Terminal link handler for Surfer Surver
- API
  - Added (proposed) onDidDropInWaveformViewer event
- Fixed
  - Word wrap display glitch in values display causing "->" indicator to word wrap
  - Labels panel can no longer be resized to a negative width
- Other
  - Upgraded to wellen 0.19.0
  - Updated Netlist icon colors to a more consistent set of colors

# 1.4.0 - 8/27/2025

- Added
  - Signal grouping in the viewer
  - API for interoperability with other extensions - see API_DOCS.md for details
  - Edge guides feature to highlight edges of a signal
  - Escape Key to abort some user actions
  - Ctrl/Cmd + 0 for zoom to fit
  - Drag to reorder signals now responds to scroll
  - Surfer surver support
  - Added button to reload file
  - Status Bar now shows value change count for selected signal
  - Automatically reload waveform on file updates
- Fixed
  - Renderer floating point math is much more accurate resulting in less jitter
  - Revealing signals in viewport scrolls to the signal in question
- Other Changes and Improvements
  - Upgraded to wellen 0.18.4 for miscellaneous improvements to file loading
  - Improved signal loading performance (with LZ4 compression)
  - updated .vscodeignore file to reduce build size

# 1.3.4 - 5/9/2025

- Ruler now displays time units
- Added Feature to change time units
- Scrolling Mode is now a global user setting
- Viewer reloads previous state upon closing and reopening VScode
- Added Signal Value Links functionality
- Added "Backspace" keybinding to remove variable

## 1.3.3 - 4/18/2025

- Added:
  - Beta API
  - Copy Value At Marker context menu item
  - Tooltips when hovering over viewer signal names
  - Commands for use in other extensions and API docs
  - Zoom to Fit button on control bar
- Fixed issues:
  - Context menu items now appear when right clicking on value display column
  - "Load/Save Vaporview Settings" Menus appearing where they shouldn't
  - Terminal Links only match for paths with valid top level scopes

## 1.3.2 - 3/18/2025

- Unlocked zooming to allow for smooth zooming on touchpad mode
- Limited Zoom out distance to timeend
- Added context Menu items
  - Copy Name - Copy full path to clipboard
  - Show in Viewer - Shows signal in viewer
- Added tooltips to netlist view to show details on netlist elements
- Setting a marker populates the time in the search bar
- Added Auto Touchpad Scrolling/Zooming mode

# 1.3.1 - 3/2/2025

- Port render path to HTML5 canvas (previously used SVGs)
  - Improves text placement in multi bit-waveform renderer
  - Greatly improves scrolling/zoom experience - no more async chunk loading!
  - Fixes issue where linear, stepped, and binary waveforms display a gap when zoomed in really far
- Limit how far out the viewer can be zoomed out

# 1.3.0 - 2/12/2025

- Added:
  - Linear and Stepped waveform Rendering
  - Number formats:
    - Signed Integers
    - Floats: 8, 16, 32, 64, BFloat, TensorFloat
  - Color option to waveforms
  - "Show in Netlist view" context menu item
  - Scrollbar annotation for marker position
  - File icon for waveform dump files
  - (tentative) support for VScode web
- Fixed issues:
  - Chunks disappear when adding groups of signals already displayed
  - Number format (and color) are not preserved on reload
  - Vertical scrolling issues from 1.2.5
  - Zoom gesture scaling
  - Terminal links to netlist paths pointing to scope items reveal in netlist view, and won't add anything to the viewer
  - Improved netlist view visibility

## 1.2.6 - 12/18/2024

- Added GHW file support
- Added Support for Real and String data types
- Improved 9 state rendering
- Added Octal number formatting
- Added more Netlist View icons, and colored them consistently
- Fixed Binary display formatting with 9 state values
- Fixed issue where top level variables in global scope didn't load

## 1.2.5 - 12/12/2024

- Improved performance when loading many variables in large FST dumps
- Added Feature to reload a file
- Keybindings:
  - Fixed keybindings for Mac OS users
  - Added **Home** and **End** to go to the beginning and end of a waveform dump
  - Added **Delete** to remove a variable
- Fixed 'webview is disposed' errors
- Refactored Core Extension and Webview. Converted Webview to Typescript
  - Organized functions into appropriate classes, and split into multiple files
  - Ported build process back to esbuild
  - Added .vscodeignore file to keep build size reasonable

# 1.2.0 - 11/14/2024

- File parsing uses the [wellen](https://github.com/ekiwi/wellen/tree/new-api) library compiled to wasm. Benefits include:
  - FST file support
  - Improved file parsing speed and memory efficiency (over storing everything in JS objects)
- Removed checkboxes for scope \[module\] items in netlist viewer to reduce confusion
- Variables loaded into viewer show up before waveform data is loaded as a better visual acknowledgement to user action
- Scroll Position now limited to end of trace rather than the end of the last chunk
- Save/Load viewer settings has been added as context menu item for easier access
- Fixed issues with netlists loading into the wrong view on load

# 1.1.0 - 10/8/2024

- Implemented fs.read() so that files of any size can be loaded. Maximum file size can be configured as a user setting
- Show Netlist as soon as it is done being parsed, and progress bar for waveform data
- Improve Performance of single bit renderer (which should finally remove all slowdowns when zoomed out on large waveforms)
- Many under the hood updates

## 1.0.1 - 7/25/2024

- Improved performance of multi bit renderer
- Allow for number format to be changed on a per-signal basis
- Added netlist path to context menu events in case other extension developers want to integrate with VaporView

# 1.0.0 - 6/4/2024 - First VScode Marketplace Release

- Small documentation updates in preparation for marketplace release
- Commented out debug statements

## 0.9.8 - 5/7/2024

- VCD parser fixes and improvements
  - Fixed a few parser glitches that caused some netlist elements to not be registered
  - Properly parse out module names and module types
  - Improved algorithm to set chunk size
  - Added progress bar to indicate status when loading large files
- Netlist Viewer now maintains expanded state
- Minor fixes to rendering glitches
- Improved renderer to perform a _little_ better when zooming out really far
- Added feature to click and drag on an area to zoom in on it
- Added terminal links feature
  - Timestamps in UVM logs (or other simulation logs) when Ctrl + clicked will set a marker in the viewer and jump to that timestamp
  - Netlist paths, when Ctrl + clicked will add that netlist element (if it exists) into the viewer

## 0.9.7 - 4/26/2024

- While you weren't looking, I replaced the horizontal scrollbar with a fake one to work around Chromium's 16 million pixel size limitation
- Fixed slow performance when zoomed in really far

## 0.9.6 - 4/20/2024

- Improved render performance when loading lots of multi-bit waveforms or zooming out really far
- Fix 4 state value hex conversion
- Fix display glitch of single bit waveforms
- 4 state values now display as red text

## 0.9.5 - 4/12/2024

- Added Ability to save and load displayed signals
- Added WaveDrom support for exporting selection to WaveDrom
- Miscellaneous bugfixes and improvements

## 0.9.4 - 4/3/2024

- Added Netlist View support to add or remove multiple signals to or from viewer without having to check/uncheck every single one
- Fixed signal selection glitch caused by multiple netlist entries pointing to the same signal ID
- Improved chunk sizing algorithm so that chunks aren't unnecessarily large
- fixed a performance issue seen when zooming in really far.

## 0.9.3 - 3/28/2024

- Greatly improved viewer experience with large files
- Implemented asynchronous rendering for much smoother performance
- fixed bounding box selector, so that marker placement is accurate
