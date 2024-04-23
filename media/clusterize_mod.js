// This is a purpose modified version of the Clusterize.js module
// It supports columns instead of rows, as well as dynamic resizing
// The loading and unloading of columns also has also been modified to load and
// unload dynamic content so that it doesn't have to be generated all at once.
/* Clusterize.js - v1.0.0 - 2023-01-22
 http://NeXTs.github.com/Clusterize.js/
 Copyright (c) 2015 Denis Lukov; Licensed MIT */

;(function(name, definition) {
    if      (typeof module != 'undefined') {module.exports = definition();}
    else if (typeof define == 'function' && typeof define.amd == 'object') {define(definition);}
    else    {this[name] = definition();}
}
('Clusterize', function() {
  "use strict";

  var isMac      = navigator.platform.toLowerCase().indexOf('mac') + 1;
  var Clusterize = function(data) {
    if(!(this instanceof Clusterize)) {return new Clusterize(data);}
    var self     = this;
    self.options = data;

    self.updateViewportWidth = function() {
      self.options.viewportWidth = self.scrollElement.getBoundingClientRect().width;
      self.options.callbacks.setViewerWidth(self.options.viewportWidth);
    };

    self.scrollElement    = data.scrollId  ? document.getElementById(data.scrollId)  : data.scrollElem;
    self.contentElement   = data.contentId ? document.getElementById(data.contentId) : data.contentElem;
    self.leftSpaceElement      = document.getElementById(data.leftSpaceId);
    self.rightSpaceElement     = document.getElementById(data.rightSpaceId);
    self.displayedSpaceElement = document.getElementById(data.displayedSpaceId);

    if(!self.scrollElement)  {throw new Error("Error! Could not find scroll element");}
    if(!self.contentElement) {throw new Error("Error! Could not find content element");}
    self.updateViewportWidth();

    // private parameters
    var columns          = data.columns,
        leftRightOffsets = [],
        scrollLeft       = self.scrollElement.scrollLeft,
        lastCluster      = [0, 0];

    // append initial data and restore the scroll position
    self.getChunksWidth(columns);
    self.insertToDOM(leftRightOffsets, self.getBlockNum(columns));
    self.scrollElement.scrollLeft = scrollLeft;

    // adding scroll handler
    var scrollDebounce     = 0,
        pointerEventsSet   = false,
        scrollEvInProgress = false,

    // fixes scrolling issue on Mac #3
    macWorkaround = !isMac ? () => {} : function() {
      if(!pointerEventsSet) {self.contentElement.style.pointerEvents = 'none';}
      pointerEventsSet = true;
      clearTimeout(scrollDebounce);
      scrollDebounce = setTimeout(function () {
        self.contentElement.style.pointerEvents = 'auto';
        pointerEventsSet = false;
      }, 50);
    };

    // public methods
    self.scrollEv = function() {
      if (scrollEvInProgress) {return;}
      scrollEvInProgress = true;
      console.log('clusterize scroll');
      macWorkaround();
      self.options.callbacks.scrollingProgress(self.getScrollProgress());
      let currentCluster = self.getBlockNum(columns);
      if (lastCluster[0] !== currentCluster[0] || lastCluster[1] !== currentCluster[1]) {
        self.insertToDOM(leftRightOffsets, currentCluster);
      }
      lastCluster        = currentCluster;
      scrollEvInProgress = false;
    };
    self.refresh = function(columnWidth) {
      console.log('clusterize refresh');

      if (columnWidth && self.options.columnWidth !== columnWidth) {
        const scrollProgress     = self.getScrollProgress();
        self.options.columnWidth = columnWidth;
        self.update(columns);
        self.getChunksWidth(columns);
        self.updateViewportWidth();
        self.scrollElement.scrollLeft = scrollProgress * ((columns.length * self.options.columnWidth) - self.options.viewportWidth);
      } else {
        self.updateViewportWidth();
      }
    };
    self.update = function(newColumns, columnWidth) {
      if(!newColumns.length) {return;}
      columns        = newColumns;
      var scrollLeft = self.scrollElement.scrollLeft;
      // fixes #39
      if (columns.length * self.options.columnWidth < scrollLeft) {
        self.scrollElement.scrollLeft = 0;
        lastCluster = [0, 0];
      }
      self.insertToDOM(leftRightOffsets, self.getBlockNum(columns));
      self.scrollElement.scrollLeft = scrollLeft;
    };
    self.getScrollProgress = function() {
      return self.scrollElement.scrollLeft / ((columns.length * self.options.columnWidth) - self.options.viewportWidth) || 0;
    };
    self.render  = function()           {self.insertToDOM(leftRightOffsets, self.getBlockNum(columns));};
    self.setChunkHeight = function(height) {self.options.chunkHeight = `${height} + px`;};
  };

  Clusterize.prototype = {
    constructor: Clusterize,

    getChunksWidth: function(columns) {
      var opts          = this.options;
      opts.clusterWidth = 0;
      if (!columns.length) {return;}

      opts.blockWidth       = opts.columnWidth     * opts.columnsInBlock;
      opts.blocksInCluster  = Math.max(Math.ceil((opts.viewportWidth / opts.blockWidth) * 2), 2);
      opts.columnsInCluster = opts.blocksInCluster * opts.columnsInBlock;
      opts.clusterWidth     = opts.blocksInCluster * opts.blockWidth;
    },
    getBlockNum: function () {
      const opts         = this.options;
      const scrollCenter = this.scrollElement.scrollLeft + opts.viewportWidth / 2;
      const blockNum     = scrollCenter / opts.blockWidth;
      const minColumnNum = Math.max(Math.round(blockNum - (opts.blocksInCluster / 2)), 0) * opts.columnsInBlock;
      const maxColumnNum = Math.min(Math.round(blockNum + (opts.blocksInCluster / 2)) * opts.columnsInBlock, opts.columnCount);
      return [minColumnNum, maxColumnNum];
    },
    // if necessary verify data changed and insert to DOM
    insertToDOM: function(leftRightOffsets, cluster) {
      const opts                  = this.options;
      const callbacks             = this.options.callbacks;
      const itemsStart            = Math.max(Math.min(cluster[0], (opts.columnCount - opts.columnsInCluster) + (opts.columnsInBlock % opts.columnCount)), 0);
      const itemsEnd              = Math.min(Math.max(cluster[1], opts.columnsInCluster), opts.columnCount);
      const leftOffset            = opts.columnWidth * itemsStart;
      const rightOffset           = opts.columnWidth * (opts.columnCount - itemsEnd);
      const newColumns            = callbacks.fetchColumns(itemsStart, itemsEnd);
      const thisClusterColumns    = newColumns.join('');
      const clusterContentChanged = callbacks.checkUpdatePending();
      const leftOffsetChanged     = leftOffset  !== leftRightOffsets[0];
      const rightOffsetChanged    = rightOffset !== leftRightOffsets[1];
      leftRightOffsets            = [leftOffset, rightOffset];

      if (clusterContentChanged || leftOffsetChanged) {
        callbacks.clusterWillChange(itemsStart, itemsEnd);
        this.leftSpaceElement.style.width    = leftOffset + 'px';
        this.leftSpaceElement.style.height   = this.options.chunkHeight;
        this.displayedSpaceElement.innerHTML = thisClusterColumns;
        this.rightSpaceElement.style.width   = rightOffset + 'px';
        this.rightSpaceElement.style.height  = this.options.chunkHeight;
        callbacks.clusterChanged(itemsStart, itemsEnd);
      } else if (rightOffsetChanged) {
        this.rightSpaceElement.style.width = rightOffset + 'px';
      }
      callbacks.clearUpdatePending();
    },
  };
  return Clusterize;
}));