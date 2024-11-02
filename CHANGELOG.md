# Change Log

# Next release (Version TBD)

- File parsing uses the [wellen](https://github.com/ekiwi/wellen/tree/new-api) library compiled to wasm. Benefits include:
  - FST and GHW file support
  - Improves file parsing speed and memory efficiency (over storing everything in JS objects)
- Removed checkboxes for scope \[module\] items in netlist viewer to reduce confusion
- Variables loaded into viewer show up before waveform data is loaded as a better visual acknowledgement to user action

# 1.1.0

- Implemented fs.read() so that files of any size can be loaded. Maximum file size can be configured as a user setting
- Show Netlist as soon as it is done being parsed, and progress bar for waveform data
- Improve Performance of single bit renderer (which should finally remove all slowdowns when zoomed out on large waveforms)
- Many under the hood updates

## 1.0.1

- Improved performance of multi bit renderer
- Allow for number format to be changed on a per-signal basis
- Added netlist path to context menu events in case other extension developers want to integrate with VaporView

# 1.0.0

- Small documentation updates in preparation for marketplace release
- Commented out debug statements

## 0.9.8

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

## 0.9.7

- While you weren't looking, I replaced the horizontal scrollbar with a fake one to work around Chromium's 16 million pixel size limitation
- Fixed slow performance when zoomed in really far

## 0.9.6

- Improved render performance when loading lots of milti-bit waveforms or zooming out really far
- Fix 4 state value hex conversion
- Fix display glitch of single bit waveforms
- 4 state values now display as red text

## 0.9.5

- Added Ability to save and load displayed signals
- Added WaveDrom support for exporting selection to WaveDrom
- Miscellaneous bugfixes and improvements

## 0.9.4

- Added Netlist View support to add or remove multiple signals to or from viewer without having to check/uncheck every single one
- Fixed signal selection glitch caused by multiple netlist entries pointing to the same signal ID
- Improved chunk sizing algorithm so that chunks aren't unnecessarily large
- fixed a performance issue seen when zooming in really far.

## 0.9.3

- Greatly improved viewer experience with large files
- Implemented asynchronous rendering for much smoother performance
- fixed bounding box selector, so that marker placement is accurate
