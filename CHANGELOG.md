# Change Log

## 1.0.1

- Improved performance of multi bit renderer
- Allow for number format to be changed on a per-signal basis

# 1.0.0

- Small documentation updatesin preparation for marketplace release
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
