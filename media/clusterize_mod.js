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
        scrollLeft       = self.scrollElement.scrollLeft;

    // append initial data and restore the scroll position
    self.getChunksWidth(columns);
    self.insertToDOM(columns, leftRightOffsets);
    self.scrollElement.scrollLeft = scrollLeft;

    // adding scroll handler
    var lastCluster        = [0, 0],
        scrollDebounce     = 0,
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
    },

    scrollEv = function() {
      if (scrollEvInProgress) {return;}
      scrollEvInProgress = true;
      console.log('clusterize scroll');
      macWorkaround();
      self.options.callbacks.scrollingProgress(self.getScrollProgress());
      let currentCluster = self.getBlockNum(columns);
      if (lastCluster[0] !== currentCluster[0] || lastCluster[1] !== currentCluster[1]) {
        self.insertToDOM(columns, leftRightOffsets, currentCluster);
      }
      lastCluster = currentCluster;
      scrollEvInProgress = false;
    },
    resizeDebounce = 0,
    resizeEv = function() {
      console.log('resize');
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(self.refresh, 100);
    };
    self.scrollElement.addEventListener('scroll', scrollEv, false);
    window.addEventListener('resize', resizeEv, false);

    // public methods
    self.refresh = function(columnWidth) {
      const prevColumnWidth    = self.options.columnWidth;
      if (columnWidth) {self.options.columnWidth = columnWidth;}
      const scrollProgress     = self.getScrollProgress();
      const columnWidthChanged = prevColumnWidth !== self.options.columnWidth;

      if (columnWidthChanged) {
        self.update(columns);
        self.getChunksWidth(columns);
      }

      if (self.scrollElement) {
        self.updateViewportWidth();
        if (columnWidthChanged) {
          self.scrollElement.scrollLeft = scrollProgress * ((columns.length * self.options.columnWidth) - self.options.viewportWidth);
        }
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
      self.insertToDOM(columns, leftRightOffsets);
      self.scrollElement.scrollLeft = scrollLeft;
    };
    self.clear             = function() {self.update([]);};
    self.getScrollProgress = function() {
      return self.options.scrollLeft / ((columns.length * self.options.columnWidth) - self.options.viewportWidth) || 0;
    };
    self.append  = function(newColumns) {self.insertToDOM(columns.concat(newColumns), leftRightOffsets);};
    self.prepend = function(newColumns) {self.insertToDOM(newColumns.concat(columns), leftRightOffsets);};
    self.render  = function()           {self.insertToDOM(columns,                    leftRightOffsets);};
    self.setChunkHeight = function(height) {self.options.chunkHeight = `${height} + px`;};
  };

  Clusterize.prototype = {
    constructor: Clusterize,

    getChunksWidth: function(columns) {
      console.log("getChunksWidth()");
      console.log(this.options);
      var opts          = this.options;
      opts.clusterWidth = 0;
      if (!columns.length) {return;}

      opts.blockWidth       = opts.columnWidth     * opts.columnsInBlock;
      opts.blocksInCluster  = Math.max(Math.ceil((opts.viewportWidth / opts.blockWidth) * 2), 2);
      opts.columnsInCluster = opts.blocksInCluster * opts.columnsInBlock;
      opts.clusterWidth     = opts.blocksInCluster * opts.blockWidth;
    },
    getBlockNum: function () {
      var opts           = this.options;
      opts.scrollLeft    = this.scrollElement.scrollLeft;
      const leftOffset   = opts.scrollLeft + opts.viewportWidth / 2;
      const blockNum     = leftOffset / opts.blockWidth;
      const minColumnNum = Math.max(Math.round(blockNum - (opts.blocksInCluster / 2)), 0) * opts.columnsInBlock;
      const maxColumnNum = Math.min(Math.round(blockNum + (opts.blocksInCluster / 2)) * opts.columnsInBlock, opts.columnCount);
      return [minColumnNum, maxColumnNum];
    },
    // if necessary verify data changed and insert to DOM
    insertToDOM: function(columns, leftRightOffsets, cluster) {
      if (!this.options.clusterWidth) {throw new Error("Error! Cluster width is not defined, exploreEnvironment() is deprecated.");}
      var opts          = this.options,
          columnsLength = columns.length,
          leftOffset    = 0,
          rightOffset   = 0,
          columnsBefore = 0,
          itemsStart    = 0,
          itemsEnd      = columnsLength,
          newColumns    =   columnsLength ? columns : opts.emptyColumn;
      if (columnsLength <= opts.columnsInCluster) {
        newColumns = this.options.callbacks.fetchColumns(itemsStart, itemsEnd);
      } else {
        if (!cluster) { cluster = this.getBlockNum();}
        itemsStart    = Math.min(cluster[0], (opts.columnCount - opts.columnsInCluster) + (opts.columnsInBlock % opts.columnCount));
        itemsEnd      = Math.max(cluster[1], opts.columnsInCluster);
        leftOffset    = Math.max(itemsStart * opts.columnWidth, 0);
        rightOffset   = Math.max((columnsLength - itemsEnd) * opts.columnWidth, 0);
        newColumns    = this.options.callbacks.fetchColumns(itemsStart, itemsEnd);
        columnsBefore = itemsStart;
        if (leftOffset < 1) {columnsBefore++;}
      }
      const thisClusterColumns        = newColumns.join('');
      const callbacks                 = this.options.callbacks;
      //var thisClusterContentChanged = this.checkChanges('data',  thisClusterColumns, leftRightOffsets);
      const thisClusterContentChanged = callbacks.checkUpdatePending();
      const leftOffsetChanged         = leftOffset  !== leftRightOffsets[0];
      const onlyRightOffsetChanged    = rightOffset !== leftRightOffsets[1];
      leftRightOffsets                = [leftOffset, rightOffset];

      if (thisClusterContentChanged || leftOffsetChanged) {
        callbacks.clusterWillChange(itemsStart, itemsEnd);
        this.leftSpaceElement.style.width    = leftOffset + 'px';
        this.leftSpaceElement.style.height   = this.options.chunkHeight;
        this.displayedSpaceElement.innerHTML = thisClusterColumns;
        this.rightSpaceElement.style.width   = rightOffset + 'px';
        this.rightSpaceElement.style.height  = this.options.chunkHeight;
        this.contentElement.style['counter-increment'] = 'clusterize-counter ' + (columnsBefore - 1);
        callbacks.clusterChanged(itemsStart, itemsEnd);
      } else if(onlyRightOffsetChanged) {
        this.rightSpaceElement.style.width = rightOffset + 'px';
      }
      callbacks.clearUpdatePending();
    },
  };
  return Clusterize;
}));