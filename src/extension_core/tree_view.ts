import * as vscode from 'vscode';
import { NetlistId, SignalId } from './viewer_provider';
import { VaporviewDocument } from './document';

// Scopes
const scopeColor    = new vscode.ThemeColor('charts.purple');
const moduleIcon    = new vscode.ThemeIcon('chip',             scopeColor);
const taskIcon      = new vscode.ThemeIcon('debug-stackframe', scopeColor);
const funcIcon      = new vscode.ThemeIcon('symbol-module',    scopeColor);
const beginIcon     = new vscode.ThemeIcon('debug-start',      scopeColor);
const forkIcon      = new vscode.ThemeIcon('repo-forked',      scopeColor);
const structIcon    = new vscode.ThemeIcon('symbol-structure', scopeColor);
const unionIcon     = new vscode.ThemeIcon('surround-with',    scopeColor);
const classIcon     = new vscode.ThemeIcon('symbol-misc',      scopeColor);
const interfaceIcon = new vscode.ThemeIcon('debug-disconnect', scopeColor);
const packageIcon   = new vscode.ThemeIcon('package',          scopeColor);
const scopeIcon     = new vscode.ThemeIcon('symbol-module',    scopeColor);

export function createScope(
  name: string,
  type: string,
  path: string,
  netlistId: number,
  scopeOffsetIdx: number, 
  uri: vscode.Uri
) {

  let icon = scopeIcon;
  const typename = type.toLocaleLowerCase();
  switch (typename) {
    case 'module':           {icon = moduleIcon; break;}
    case 'task':             {icon = taskIcon; break;}
    case 'function':         {icon = funcIcon; break;}
    case 'begin':            {icon = beginIcon; break;}
    case 'fork':             {icon = forkIcon; break;}
    case 'generate':         {icon = scopeIcon; break;}
    case 'struct':           {icon = structIcon; break;}
    case 'union':            {icon = unionIcon; break;}
    case 'class':            {icon = classIcon; break;}
    case 'interface':        {icon = interfaceIcon; break;}
    case 'package':          {icon = packageIcon; break;}
    case 'program':          {icon = scopeIcon; break;}
    case 'vhdlarchitecture': {icon = scopeIcon; break;}
    case 'vhdlprocedure':    {icon = taskIcon; break;}
    case 'vhdlfunction':     {icon = funcIcon; break;}
    case 'vhdlrecord':       {icon = scopeIcon; break;}
    case 'vhdlprocess':      {icon = scopeIcon; break;}
    case 'vhdlblock':        {icon = scopeIcon; break;}
    case 'vhdlforgenerate':  {icon = scopeIcon; break;}
    case 'vhdlifgenerate':   {icon = scopeIcon; break;}
    case 'vhdlgenerate':     {icon = scopeIcon; break;}
    case 'vhdlpackage':      {icon = packageIcon; break;}
    case 'ghwgeneric':       {icon = scopeIcon; break;}
    case 'vhdlarray':        {icon = scopeIcon; break;}
  }

  // fsdb vhdlarray might contain feild, remove it to align with wellen
  if (typename === 'vhdlarray') {
    const regex  = /\[(\d+:)?(\d+)\]$/;
    name = name.replace(regex, '');
  }

  const module    = new NetlistItem(name, typename, 'none', 0, 0, netlistId, name, path, 0, 0, "", scopeOffsetIdx, [], vscode.TreeItemCollapsibleState.Collapsed, undefined, uri);
  module.iconPath = icon;

  return module;
}
  
function bitRangeString(msb: number, lsb: number): string {
  if (msb < 0 || lsb < 0) {return "";}
  if (msb === lsb) {return " [" + msb + "]";}
  return "[" + msb + ":" + lsb + "]";
}

// Variables
const chartsGreen  = new vscode.ThemeColor('charts.green');
const chartsOrange = new vscode.ThemeColor('charts.orange');
const chartsYellow = new vscode.ThemeColor('charts.yellow');
const chartsBlue   = new vscode.ThemeColor('charts.blue');
const regIcon     = new vscode.ThemeIcon('symbol-array',     chartsGreen);
const wireIcon    = new vscode.ThemeIcon('symbol-interface', chartsGreen);
const intIcon     = new vscode.ThemeIcon('symbol-variable',  chartsGreen);
const paramIcon   = new vscode.ThemeIcon('settings',         chartsBlue);
const realIcon    = new vscode.ThemeIcon('pulse',            chartsOrange);
const defaultIcon = new vscode.ThemeIcon('file-binary',      chartsGreen);
const stringIcon  = new vscode.ThemeIcon('symbol-key',       chartsYellow);
const portIcon    = new vscode.ThemeIcon('plug',             chartsGreen);
const timeIcon    = new vscode.ThemeIcon('watch',            chartsGreen);
const enumIcon    = new vscode.ThemeIcon('symbol-parameter', chartsGreen);

export function createVar(
  name: string,
  type: string,
  encoding: string,
  path: string,
  netlistId: NetlistId,
  signalId: SignalId,
  width: number,
  msb: number,
  lsb: number,
  enumType: string,
  isFsdb: boolean,
  uri: vscode.Uri
) {
  const field = bitRangeString(msb, lsb);
  let label = name;

  // field is already included in signal name for fsdb
  if (!isFsdb) label = name + field;

  if (isFsdb) { // remove field from signal name for fsdb to align with wellen
    const regex  = /\[(\d+:)?(\d+)\]$/;
    name = name.replace(regex, '');
  }

  const variable = new NetlistItem(label, type, encoding, width, signalId, netlistId, name, path, msb, lsb, enumType, -1, [], vscode.TreeItemCollapsibleState.None, vscode.TreeItemCheckboxState.Unchecked, uri);
  const typename = type.toLocaleLowerCase();
  let icon;

  switch (typename) {
    case 'event':           {icon = defaultIcon; break;}
    case 'integer':         {icon = intIcon; break;}
    case 'parameter':       {icon = paramIcon; break;}
    case 'real':            {icon = realIcon; break;}
    case 'reg':             {icon = defaultIcon; break;}
    case 'supply0':         {icon = defaultIcon; break;}
    case 'supply1':         {icon = defaultIcon; break;}
    case 'time':            {icon = timeIcon; break;}
    case 'tri':             {icon = defaultIcon; break;}
    case 'triand':          {icon = defaultIcon; break;}
    case 'trior':           {icon = defaultIcon; break;}
    case 'trireg':          {icon = defaultIcon; break;}
    case 'tri0':            {icon = defaultIcon; break;}
    case 'tri1':            {icon = defaultIcon; break;}
    case 'wand':            {icon = defaultIcon; break;}
    case 'wire':            {icon = wireIcon; break;}
    case 'wor':             {icon = defaultIcon; break;}
    case 'string':          {icon = stringIcon; break;}
    case 'port':            {icon = portIcon; break;}
    case 'sparsearray':     {icon = defaultIcon; break;}
    case 'realtime':        {icon = timeIcon; break;}
    case 'bit':             {icon = defaultIcon; break;}
    case 'logic':           {icon = defaultIcon; break;}
    case 'int':             {icon = intIcon; break;}
    case 'shortint':        {icon = intIcon; break;}
    case 'longint':         {icon = intIcon; break;}
    case 'byte':            {icon = defaultIcon; break;}
    case 'enum':            {icon = enumIcon; break;}
    case 'shortreal':       {icon = defaultIcon; break;}
    case 'boolean':         {icon = defaultIcon; break;}
    case 'bitvector':       {icon = defaultIcon; break;}
    case 'stdlogic':        {icon = defaultIcon; break;}
    case 'stdlogicvector':  {icon = defaultIcon; break;}
    case 'stdulogic':       {icon = defaultIcon; break;}
    case 'stdulogicvector': {icon = defaultIcon; break;}
  }

  variable.iconPath = icon;
  if ((typename === 'wire') || (typename === 'reg') || (icon === defaultIcon)) {
    if (width > 1) {variable.iconPath = regIcon;}
    else           {variable.iconPath = wireIcon;}
  }

  return variable;
}

export function getInstancePath(netlistItem: NetlistItem): string {
  let path = netlistItem.label;
  if (netlistItem.scopePath !== "") {
    path = netlistItem.scopePath + "." + path;
  }
  return path;
}


// #region WebviewCollection
/**
 * Tracks all webviews.
 */
export class WebviewCollection {

  private numWebviews = 0;
  public get getNumWebviews() {return this.numWebviews;}

  private readonly _webviews = new Set<{
    readonly resource: string;
    readonly webviewPanel: vscode.WebviewPanel;
  }>();

  /**
   * Get all known webviews for a given uri.
   */
  public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
    const key = uri.toString();
    for (const entry of this._webviews) {
      if (entry.resource === key) {
        yield entry.webviewPanel;
      }
    }
  }

  /**
   * Add a new webview to the collection.
   */
  public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
    const entry = { resource: uri.toString(), webviewPanel };
    this._webviews.add(entry);
    this.numWebviews++;

    webviewPanel.onDidDispose(() => {
      this._webviews.delete(entry);
      this.numWebviews--;
    });
  }
}

// #region NetlistTreeDataProvider
export class NetlistTreeDataProvider implements vscode.TreeDataProvider<NetlistItem> {

  private treeData: NetlistItem[] = [];
  private _onDidChangeTreeData: vscode.EventEmitter<NetlistItem | undefined> = new vscode.EventEmitter<NetlistItem | undefined>();
  readonly onDidChangeTreeData: vscode.Event<NetlistItem | undefined> = this._onDidChangeTreeData.event;
  private document: VaporviewDocument | undefined;

  public setCheckboxState(netlistItem: NetlistItem, checkboxState: vscode.TreeItemCheckboxState) {
    netlistItem.checkboxState = checkboxState;
    this._onDidChangeTreeData.fire(undefined); // Trigger a refresh of the Netlist view
  }

  public loadDocument(document: VaporviewDocument) {
    this.setTreeData(document.treeData);
    this.document = document;
  }

  // Method to set the tree data
  public setTreeData(netlistItems: NetlistItem[]) {
    this.treeData = netlistItems;
    this._onDidChangeTreeData.fire(undefined); // Trigger a refresh of the Netlist view
  }

  public hide() {
    this.setTreeData([]);
    this.document = undefined;
  }

  public getTreeData(): NetlistItem[] {return this.treeData;}
  getTreeItem(element:  NetlistItem): vscode.TreeItem {return element;}
  getChildren(element?: NetlistItem): Thenable<NetlistItem[]> {
    return this.document?.getChildrenExternal(element) ?? Promise.resolve([]);
  }

  getParent(element: NetlistItem): vscode.ProviderResult<NetlistItem> {
    if (this.document && element.scopePath !== "") {
      return Promise.resolve(this.document.findTreeItem(element.scopePath, undefined, undefined));
    }
    return null;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

}

interface TreeCheckboxChangeEvent<T> {
  item: T;
  checked: boolean;
}

// #region NetlistItem
export class NetlistItem extends vscode.TreeItem {
  private _onDidChangeCheckboxState: vscode.EventEmitter<vscode.TreeItem | undefined | null> = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  onDidChangeCheckboxState: vscode.Event<vscode.TreeItem | undefined | null> = this._onDidChangeCheckboxState.event;

  public numberFormat: string;
  public fsdbVarLoaded: boolean = false; // Only used in fsdb
  public resourceUri: vscode.Uri;

  constructor(
    public readonly label:      string,
    public readonly type:       string,
    public readonly encoding:   string,
    public readonly width:      number,
    public readonly signalId:   SignalId, // Signal-specific information
    public readonly netlistId:  NetlistId, // Netlist-specific information
    public readonly name:       string,
    public readonly scopePath: string,
    public readonly msb:        number,
    public readonly lsb:        number,
    public readonly enumType:   string,
    public readonly scopeOffsetIdx: number, // Only used in fsdb
    public children:         NetlistItem[] = [],
    public collapsibleState: vscode.TreeItemCollapsibleState,
    public checkboxState:    vscode.TreeItemCheckboxState | undefined = undefined, // Display preference
    uri: vscode.Uri
  ) {
    let fullName = "";
    if (scopePath !== "") {fullName += scopePath + ".";}
    fullName;

    super(label, collapsibleState);
    this.numberFormat = "hexadecimal";
    this.tooltip = "Name: " + fullName + label + "\n" + "Type: " + type + "\n";
    let fragmentId = "";
    if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
      fragmentId = 'var=' + netlistId;
      this.contextValue = 'netlistVar'; // Set a context value for leaf nodes
      this.tooltip += "Width: " + width + "\n" + "Encoding: " + encoding;
    } else {
      fragmentId = 'scope=' + netlistId;
      this.contextValue = 'netlistScope'; // Set a context value for parent nodes
    }

    this.resourceUri = vscode.Uri.parse(`waveform://${uri.fsPath}#${fragmentId}&net=${fullName + name}`);
  }

  // Method to recursively find a child element in the tree
  async findChild(label: string, document: VaporviewDocument, msb: number | undefined, lsb: number | undefined): Promise<NetlistItem | null> {

    // If the label is empty, return the current item, but try to find the child with the specified msb and lsb
    if (label === '') {
      if (this.children.length === 0 || this.children === undefined) {return this;}
      if (msb === undefined || lsb === undefined) {return this;}
      if (this.msb === msb && this.lsb === lsb) {return this;}

      const returnItem = this.children.find(childItem => childItem.msb === msb && childItem.lsb === lsb);
      if (returnItem) {return returnItem;}
      return this;
    }

    const subModules    = label.split(".");
    const currentModule = subModules.shift();
    if (this.children.length === 0 ||
      (document.fileType === 'fsdb' && this.fsdbVarLoaded === false)) { // For fsdb, variables are loaded on demand
      await document.getChildrenExternal(this);
    }

    const childItem     = this.children.find((child) => child.name === currentModule);


    if (childItem) {
      return await childItem.findChild(subModules.join("."), document, msb, lsb);
    } else {
      return null;
    }
  }

  handleCommand() {
    //console.log("handleCommand()");
    //console.log(this);
  }

  // Method to toggle the checkbox state
  toggleCheckboxState() {
    this.checkboxState = this.checkboxState === vscode.TreeItemCheckboxState.Checked
      ? vscode.TreeItemCheckboxState.Unchecked
      : vscode.TreeItemCheckboxState.Checked;
    this._onDidChangeCheckboxState.fire(this);
  }
}

// We don't need to do anything special for drag and drop because the resource URI has the data we need
export const netlistItemDragAndDropController: vscode.TreeDragAndDropController<NetlistItem> = {
  dragMimeTypes: [],
  dropMimeTypes: [],
  handleDrag: (source: readonly NetlistItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken) => {
    return Promise.resolve()
  },
  handleDrop: (target: NetlistItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken) => {return Promise.resolve()},
}