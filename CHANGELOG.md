# Change Log

## 0.9.6 - Release Candidate

Supports all the features you would expect including signal placing, rearranging, marker handling, saving/loading viewer settings, and exporting selection to WaveDrom!

## Beyond 1.0

In no particular order of priority, here's a list of features that are on my radar. If you have any preferences as to which should be priorized, or a suggestion that is not on this list, leave a comment on the [github discussions](https://github.com/Lramseyer/vaporview/discussions)!

- Rewrite compute intensive components in Web Assembly for smoother performance
- Add support for Enums
- Add support to highlight all transitions of a signal
- Add support for custom colors
- Add support for linking timestamps in UVM logs (or other simulation logs) to jump to a timestamp
- Add support for remote sessions to save on memory
- Add support for larger files
- Add support for .ghw files
- Highly unlikely
  - Link netlist to RTL so that signals can be connected back to RTL locations
  - Support for other file formats

## 1.0 - Marketplace launch

Get more coverage, from users like you. There may be bugs, so please report them on the [github discussions](https://github.com/Lramseyer/vaporview/discussions) so I can fix them before launching them to the marketplace!

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

# 0.9.3

- Greatly improved viewer experience with large files
- Implemented asynchronous rendering for much smoother performance
- fixed bounding box selector, so that marker placement is accurate
