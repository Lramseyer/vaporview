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

  // detect ie9 and lower
  // https://gist.github.com/padolsey/527683#comment-786682
  // var ie = (function(){
  //   for( var v = 3,
  //             el = document.createElement('b'),
  //            all = el.all || [];
  //        el.innerHTML = '<!--[if gt IE ' + (++v) + ']><i><![endif]-->',
  //        all[0];
  //      ){}
  //   return v > 4 ? v : document.documentMode;
  // }()),
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
    var columns    = isArray(data.columns) ? data.columns : self.fetchMarkup(),
        cache      = {},
        scrollLeft = self.scrollElement.scrollLeft;

    // append initial data
    self.insertToDOM(columns, cache);

    // restore the scroll position
    self.scrollElement.scrollLeft = scrollLeft;

    // adding scroll handler
    var lastCluster      = false,
        scrollDebounce   = 0,
        pointerEventsSet = false,
    scrollEv = function() {
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
      if (lastCluster != (lastCluster = self.getClusterNum(columns))) {
        self.insertToDOM(columns, cache);
      }
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
      const scrollProgress     = self.getScrollProgress();

      if (columnWidth) {
        self.options.columnWidth = columnWidth;
      }

      if (prevColumnWidth !== columnWidth) {
        self.update(columns);
        self.getChunksWidth(columns);
      }

      if (self.scrollElement) {
        self.updateViewportWidth();
        //self.options.viewportWidth    = self.scrollElement.getBoundingClientRect().width;
        if ((columnWidth) && (columnWidth !== prevColumnWidth)) {
          self.scrollElement.scrollLeft = scrollProgress * ((columns.length * self.options.columnWidth) - self.options.viewportWidth);
        }
        //if (self.options.callbacks.setViewerWidth) {
        //  self.options.callbacks.setViewerWidth(self.options.viewportWidth);
        //}
      }
    };
    self.update = function(newColumns, columnWidth) {
      columns = isArray(newColumns) ? newColumns : [];
      var scrollLeft = self.scrollElement.scrollLeft;
      // fixes #39
      if(columns.length * self.options.columnWidth < scrollLeft) {
        self.scrollElement.scrollLeft = 0;
        lastCluster = 0;
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
    fetchMarkup: function() {
      console.log("fetchMarkup()");
      var columns      = [],
          columnsNodes = this.getChildNodes(this.contentElement);

      while (columnsNodes.length) {
        columns.push(columnsNodes.shift().outerHTML);
      }
      return columns;
    },
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
      var opts          = this.options
          //prevItemWidth = opts.columnWidth;
      opts.clusterWidth = 0;
      if( ! columns.length) {return;}
      var nodes = this.contentElement.children;
      if( ! nodes.length) {return;}
      //var node = nodes[Math.floor(nodes.length / 2)];

      //opts.columnWidth = node.offsetWidth;
      // consider table's border-spacing
      //if(opts.tag == 'tr' && getStyle('borderCollapse', this.contentElement) != 'collapse') {
      //  opts.columnWidth += parseInt(getStyle('borderSpacing', this.contentElement), 10) || 0;
      //}
      opts.blockWidth       = opts.columnWidth     * opts.columnsInBlock;
      opts.columnsInCluster = opts.blocksInCluster * opts.columnsInBlock;
      opts.clusterWidth     = opts.blocksInCluster * opts.blockWidth;

      //return prevItemWidth != opts.columnWidth;
    },
    // get current cluster number
    getClusterNum: function (columns) {
      var opts           = this.options;
      opts.scrollLeft    = this.scrollElement.scrollLeft;
      var clusterDivider = opts.clusterWidth - opts.blockWidth;

      var currentCluster = Math.floor(opts.scrollLeft / clusterDivider);
      var maxCluster     = Math.floor((columns.length * opts.columnWidth) / clusterDivider);
      return Math.min(currentCluster, maxCluster);
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
    // generate cluster for current scroll position
    generate: function (columns) {
      var opts          = this.options,
          columnsLength = columns.length,
          returnData    = {
            leftOffset:    0,
            rightOffset:   0,
            columnsBefore: 0,
            columns:       columnsLength ? columns : this.generateEmptyColumn(),
            itemsStart:    0,
            itemsEnd:      columnsLength
          };
      if (columnsLength <= opts.columnsInBlock) {
        returnData.columns = this.options.callbacks.fetchColumns(returnData.itemsStart, returnData.itemsEnd);
        return returnData;
      }

      returnData.itemsStart    = Math.max((opts.columnsInCluster - opts.columnsInBlock) * this.getClusterNum(columns), 0),
      returnData.itemsEnd      = Math.min(returnData.itemsStart + opts.columnsInCluster, columnsLength);
      returnData.leftOffset    = Math.max(returnData.itemsStart * opts.columnWidth, 0);
      returnData.rightOffset   = Math.max((columnsLength - returnData.itemsEnd) * opts.columnWidth, 0);
      returnData.columns       = this.options.callbacks.fetchColumns(returnData.itemsStart, returnData.itemsEnd);
      returnData.columnsBefore = returnData.itemsStart;
      if(returnData.leftOffset < 1) {
        returnData.columnsBefore++;
      }
      return returnData;
    },
    renderExtraTag: function(className, width) {
      var tag = document.createElement(this.options.tag),
        clusterizePrefix = 'clusterize-';
      tag.className = [clusterizePrefix + 'extra-column', clusterizePrefix + className].join(' ');
      width && (tag.style.width = width + 'px');
      return tag.outerHTML;
    },
    // if necessary verify data changed and insert to DOM
    insertToDOM: function(columns, cache) {
      // explore column's width
      console.log("insertToDOM()");
      if( ! this.options.clusterWidth) {
        this.exploreEnvironment(columns, cache);
      }
      var data                      = this.generate(columns);
      var thisClusterColumns        = data.columns.join(''),
          callbacks                 = this.options.callbacks,
          //thisClusterContentChanged = this.checkChanges('data',  thisClusterColumns, cache),
          thisClusterContentChanged = callbacks.checkUpdatePending(),
          leftOffsetChanged         = this.checkChanges('left',  data.leftOffset,    cache),
          onlyRightOffsetChanged    = this.checkChanges('right', data.rightOffset,   cache),
          layout                    = [];

      if(thisClusterContentChanged || leftOffsetChanged) {
        if(data.leftOffset) {
          this.options.keepParity && layout.push(this.renderExtraTag('keep-parity'));
          layout.push(this.renderExtraTag('left-space', data.leftOffset));
        }
        layout.push(thisClusterColumns);
        data.rightOffset && layout.push(this.renderExtraTag('right-space', data.rightOffset));
        callbacks.clusterWillChange && callbacks.clusterWillChange(data.itemsStart, data.itemsEnd);
        this.html(layout.join(''));
        //this.options.content_tag == 'ol' && this.contentElement.setAttribute('start', data.columnsBefore);
        this.contentElement.style['counter-increment'] = 'clusterize-counter ' + (data.columnsBefore-1);
        callbacks.clusterChanged && callbacks.clusterChanged(data.itemsStart, data.itemsEnd);
      } else if(onlyRightOffsetChanged) {
        this.contentElement.lastChild.style.width = data.rightOffset + 'px';
      }
      callbacks.clearUpdatePending();
    },

    html: function(data) {this.contentElement.innerHTML = data;},
    getChildNodes: function(tag) {
        var childNodes = tag.children, nodes = [];
        for (var i = 0, ii = childNodes.length; i < ii; i++) {
            nodes.push(childNodes[i]);
        }
        return nodes;
    },
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