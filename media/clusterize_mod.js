// This is a purpose modified version of the Clusterize.js module
// It supports columns instead of columns, as well as dynamic resizing
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

  var isMac = navigator.platform.toLowerCase().indexOf('mac') + 1;
  var Clusterize = function(data) {
    if( ! (this instanceof Clusterize)) {return new Clusterize(data);}
    var self = this;

    var defaults = {
      columnsInBlock:    4,
      blocksInCluster:   4,
      tag:               null,
      showNoDataColumn:  true,
      noDataClass:       'clusterize-no-data',
      noDataText:        'No data',
      keepParity:        false,
      callbacks:         {}
    };

    // public parameters
    self.options = {};
    var options  = ['columnCount', 'columnWidth', 'columnsInBlock', 'blocksInCluster', 'showNoDataColumn', 'noDataClass', 'noDataText', 'keepParity', 'tag', 'callbacks'];
    for(var i = 0, option; option = options[i]; i++) {
      self.options[option] = typeof data[option] != 'undefined' && data[option] != null
        ? data[option]
        : defaults[option];
    }

    self.updateViewportWidth = function() {
      self.options.viewportWidth = self.scrollElement.getBoundingClientRect().width;
      if (self.options.callbacks.setViewerWidth) {
        self.options.callbacks.setViewerWidth(self.options.viewportWidth);
      }
    };

    self.scrollElement  = data.scrollId  ? document.getElementById(data.scrollId)  : data.scrollElem;
    self.contentElement = data.contentId ? document.getElementById(data.contentId) : data.contentElem;
    if(!self.scrollElement)  {throw new Error("Error! Could not find scroll element");}
    if(!self.contentElement) {throw new Error("Error! Could not find content element");}
    self.updateViewportWidth();
    //self.options.viewportWidth = self.scrollElement.getBoundingClientRect().width;

    // tabindex forces the browser to keep focus on the scrolling list, fixes #11
    if( ! self.contentElement.hasAttribute('tabindex')) {
      self.contentElement.setAttribute('tabindex', 0);
    }
    // private parameters
    //var columns    = isArray(data.columns) ? data.columns : self.fetchMarkup(),
    var columns    = data.columns,
        cache      = {},
        scrollLeft = self.scrollElement.scrollLeft;

    self.getChunksWidth(columns);

    // append initial data
    self.insertToDOM(columns, cache);

    // restore the scroll position
    self.scrollElement.scrollLeft = scrollLeft;

    // adding scroll handler
    var lastCluster      = [0, 0],
        scrollDebounce   = 0,
        pointerEventsSet = false,
    scrollEv = function() {
      console.log('clusterize scroll');
      off('scroll', self.scrollElement, scrollEv);
      // fixes scrolling issue on Mac #3
      if (isMac) {
          if( ! pointerEventsSet) {self.contentElement.style.pointerEvents = 'none';}
          pointerEventsSet = true;
          clearTimeout(scrollDebounce);
          scrollDebounce = setTimeout(function () {
              self.contentElement.style.pointerEvents = 'auto';
              pointerEventsSet = false;
          }, 50);
      }
      if (self.options.callbacks.scrollingProgress) {
        self.options.callbacks.scrollingProgress(self.getScrollProgress());
      }

      let currentCluster = self.getBlockNum(columns);

      if (lastCluster[0] !== currentCluster[0] || lastCluster[1] !== currentCluster[1]) {
        self.insertToDOM(columns, cache, currentCluster);
      }
      lastCluster = currentCluster;
      on('scroll', self.scrollElement, scrollEv);
    },
    resizeDebounce = 0,
    resizeEv = function() {
      console.log('resize');
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(self.refresh, 100);
    };
    on('scroll', self.scrollElement, scrollEv);
    on('resize', window,             resizeEv);

    // public methods
    self.destroy = function(clean) {
      off('scroll', self.scrollElement, scrollEv);
      off('resize', window,             resizeEv);
      self.html((clean ? self.generateEmptyColumn() : columns).join(''));
    };
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
      columns = isArray(newColumns) ? newColumns : [];
      var scrollLeft = self.scrollElement.scrollLeft;
      // fixes #39
      if(columns.length * self.options.columnWidth < scrollLeft) {
        self.scrollElement.scrollLeft = 0;
        lastCluster = [0, 0];
      }
      self.insertToDOM(columns, cache);
      self.scrollElement.scrollLeft = scrollLeft;
    };
    self.clear             = function() {self.update([]);};
    self.getColumnsAmount  = function() {return columns.length;};
    self.getScrollProgress = function() {
      return self.options.scrollLeft / ((columns.length * self.options.columnWidth) - self.options.viewportWidth) || 0;
    };

    var add = function(where, _newColumns) {
      var newColumns = isArray(_newColumns) ? _newColumns : [];
      if( ! newColumns.length) {return;}
      columns = where == 'append' ? columns.concat(newColumns) : newColumns.concat(columns);
      self.insertToDOM(columns, cache);
    };
    self.append  = function(columns) {add('append',  columns);};
    self.prepend = function(columns) {add('prepend', columns);};
    self.render  = function() {self.insertToDOM(columns, cache);};
  };

  Clusterize.prototype = {
    constructor: Clusterize,
    // fetch existing markup
    //fetchMarkup: function() {
    //  console.log("fetchMarkup()");
    //  var columns      = [];
    //  var nodes        = [];
    //  var childNodes   = this.contentElement.children;
    //  for (var i = 0, ii = childNodes.length; i < ii; i++) {
    //      nodes.push(childNodes[i]);
    //  }
    //  var columnsNodes = nodes;
    //  while (columnsNodes.length) {
    //    columns.push(columnsNodes.shift().outerHTML);
    //  }
    //  return columns;
    //},
    // get tag name, content tag name, tag width, calc cluster width
    exploreEnvironment: function(columns, cache) {
      console.log("exploreEnvironment()");
      var opts = this.options;
      console.log(opts);
      console.log(this.contentElement);
      //opts.content_tag = this.contentElement.tagName.toLowerCase();
      if( ! columns.length) {return;}
      if(this.contentElement.children.length <= 1) {cache.data = this.html(columns[0] + columns[0] + columns[0]);}
      if( ! opts.tag) {opts.tag = this.contentElement.children[0].tagName.toLowerCase();}
      this.getChunksWidth(columns);
    },
    getChunksWidth: function(columns) {
      console.log("getChunksWidth()");
      console.log(this.options);
      var opts          = this.options;
      //prevItemWidth = opts.columnWidth;
      opts.clusterWidth = 0;
      if (!columns.length) {return;}
      //var nodes = this.contentElement.children;
      //if( ! nodes.length) {return;}
      //var node = nodes[Math.floor(nodes.length / 2)];

      //opts.columnWidth = node.offsetWidth;
      // consider table's border-spacing
      //if(opts.tag == 'tr' && getStyle('borderCollapse', this.contentElement) != 'collapse') {
      //  opts.columnWidth += parseInt(getStyle('borderSpacing', this.contentElement), 10) || 0;
      //}
      opts.blockWidth       = opts.columnWidth     * opts.columnsInBlock;
      opts.blocksInCluster  = Math.max(Math.ceil((opts.viewportWidth / opts.blockWidth) * 2), 2);
      opts.columnsInCluster = opts.blocksInCluster * opts.columnsInBlock;
      opts.clusterWidth     = opts.blocksInCluster * opts.blockWidth;

      //return prevItemWidth != opts.columnWidth;
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
    // generate empty column if no data provided
    generateEmptyColumn: function() {
      console.log("generateEmptyColumn()");
      var opts = this.options;
      if( ! opts.tag || ! opts.showNoDataColumn) {return [];}
      var emptyColumn   = document.createElement(opts.tag),
          noDataContent = document.createTextNode(opts.noDataText), td;
      emptyColumn.className = opts.noDataClass;
      if(opts.tag == 'tr') {
        td = document.createElement('td');
        // fixes #53
        td.colSpan = 100;
        td.appendChild(noDataContent);
      }
      emptyColumn.appendChild(td || noDataContent);
      return [emptyColumn.outerHTML];
    },
    renderExtraTag: function(className, width) {
      var tag = document.createElement(this.options.tag),
        clusterizePrefix = 'clusterize-';
      tag.className = [clusterizePrefix + 'extra-column', clusterizePrefix + className].join(' ');
      width && (tag.style.width = width + 'px');
      return tag.outerHTML;
    },
    // if necessary verify data changed and insert to DOM
    insertToDOM: function(columns, cache, cluster) {
      // explore column's width
      if (!this.options.clusterWidth) {this.exploreEnvironment(columns, cache);}

      var opts          = this.options,
          columnsLength = columns.length,
          leftOffset    = 0,
          rightOffset   = 0,
          columnsBefore = 0,
          itemsStart    = 0,
          itemsEnd      = columnsLength,
          newColumns    =   columnsLength ? columns : this.generateEmptyColumn();
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
        if (leftOffset < 1) {
          columnsBefore++;
        }
      }
      var thisClusterColumns        = newColumns.join(''),
          callbacks                 = this.options.callbacks,
          //thisClusterContentChanged = this.checkChanges('data',  thisClusterColumns, cache),
          thisClusterContentChanged = callbacks.checkUpdatePending(),
          leftOffsetChanged         = this.checkChanges('left',  leftOffset,    cache),
          onlyRightOffsetChanged    = this.checkChanges('right', rightOffset,   cache),
          layout                    = [];

      if(thisClusterContentChanged || leftOffsetChanged) {
        if(leftOffset) {
          this.options.keepParity && layout.push(this.renderExtraTag('keep-parity'));
          layout.push(this.renderExtraTag('left-space', leftOffset));
        }
        layout.push(thisClusterColumns);
        rightOffset && layout.push(this.renderExtraTag('right-space', rightOffset));
        callbacks.clusterWillChange && callbacks.clusterWillChange(itemsStart, itemsEnd);
        this.html(layout.join(''));
        //this.options.content_tag == 'ol' && this.contentElement.setAttribute('start', columnsBefore);
        this.contentElement.style['counter-increment'] = 'clusterize-counter ' + (columnsBefore - 1);
        callbacks.clusterChanged && callbacks.clusterChanged(itemsStart, itemsEnd);
        
      } else if(onlyRightOffsetChanged) {
        this.contentElement.lastChild.style.width = rightOffset + 'px';
      }
      callbacks.clearUpdatePending();
    },

    html: function(data) {this.contentElement.innerHTML = data;},
    checkChanges: function(type, value, cache) {
      var changed = value != cache[type];
      cache[type] = value;
      return changed;
    }
  };

  // support functions
  function on(evt, element, fnc) {
    return element.addEventListener    ? element.addEventListener(evt, fnc, false) : element.attachEvent("on" + evt, fnc);
  }
  function off(evt, element, fnc) {
    return element.removeEventListener ? element.removeEventListener(evt, fnc, false) : element.detachEvent("on" + evt, fnc);
  }
  function isArray(arr) {
    return Object.prototype.toString.call(arr) === '[object Array]';
  }
  //function getStyle(prop, elem) {
  //  return window.getComputedStyle ? window.getComputedStyle(elem)[prop] : elem.currentStyle[prop];
  //}

  return Clusterize;
}));