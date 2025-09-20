// Description: This file contains the extension logic for the VaporView extension
import * as vscode from 'vscode';

import { TimestampLinkProvider, NetlistLinkProvider } from './terminal_links';
import { WaveformViewerProvider } from './viewer_provider';
import * as path from 'path';
import * as fs from 'fs';

// #region activate()
export async function activate(context: vscode.ExtensionContext) {

  // Load the Wasm module
  const binaryFile = vscode.Uri.joinPath(context.extensionUri, 'target', 'wasm32-unknown-unknown', 'release', 'filehandler.wasm');
  const binaryData = await vscode.workspace.fs.readFile(binaryFile);
  const wasmModule = await WebAssembly.compile(new Uint8Array(binaryData));

  // Register Custom Editor Provider (The viewer window)
  // See package.json for more details
  const viewerProvider = new WaveformViewerProvider(context, wasmModule);

  vscode.window.registerCustomEditorProvider(
    'vaporview.waveformViewer',
    viewerProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    });

  vscode.window.registerTerminalLinkProvider(new TimestampLinkProvider(viewerProvider));

  // I want to get semantic tokens for the current theme
  // The API is not available yet, so I'm just going to log the theme
  vscode.window.onDidChangeActiveColorTheme((e) => {viewerProvider.updateColorTheme(e);});
  vscode.workspace.onDidChangeConfiguration((e) => {viewerProvider.updateConfiguration(e);});

  const markerSetEvent = WaveformViewerProvider.markerSetEventEmitter.event;
  const signalSelectEvent = WaveformViewerProvider.signalSelectEventEmitter.event;
  const addVariableEvent = WaveformViewerProvider.addVariableEventEmitter.event;
  const removeVariableEvent = WaveformViewerProvider.removeVariableEventEmitter.event;
  const externalDropEvent = WaveformViewerProvider.externalDropEventEmitter.event;

  // #region External Commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openFile', async (e) => {
    viewerProvider.log.appendLine("Command called: 'vaporview.openFile ' + " + e.uri.toString());
    if (!e.uri) {return;}
    await vscode.commands.executeCommand('vscode.openWith', e.uri, 'vaporview.waveformViewer');
    if (e.loadAll) {viewerProvider.loadAllVariablesFromFile(e.uri, e.maxSignals);}
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.addVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "add");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.removeVariable', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.removeVariable' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "remove");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.revealInNetlistView', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.revealInNetlistView' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "reveal");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.addSignalValueLink', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.addSignalValueLink' " + JSON.stringify(e));
    viewerProvider.variableActionCommandHandler(e, "addLink");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.setMarker', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.setMarker' " + JSON.stringify(e));
    viewerProvider.markerCommandHandler(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getOpenDocuments', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getOpenDocuments' " + JSON.stringify(e));
    return viewerProvider.getAllDocuments();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getViewerState', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getViewerState' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getSettings();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getValuesAtTime', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getValuesAtTime' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e.uri);
    if (!document) {return;}
    return document.getValuesAtTime(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.getAllInstancePaths', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.getAllInstancePaths' " + JSON.stringify(e));
    const document = viewerProvider.getDocumentFromOptionalUri(e?.uri);
    if (!document) {return;}
    return document.getAllInstancePaths();
  }));

  // Show/hide annotate loading overlay in the active waveform viewer webview
  context.subscriptions.push(vscode.commands.registerCommand('waveformViewer.setAnnotateLoading', (e) => {
    viewerProvider.log.appendLine("Command called: 'waveformViewer.setAnnotateLoading' " + JSON.stringify(e));
    viewerProvider.setAnnotateLoading(!!e?.active, e?.text);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.viewVaporViewSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.vaporView');
  }));

  // Add or remove signal commands
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addVariableByInstancePath', (e) => {
    viewerProvider.addVariableByInstancePathToDocument(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSignal', (e) => {
    if (e.netlistId !== undefined) {
      viewerProvider.removeSignalFromDocument(e.netlistId);
    }
  }));
  
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.deleteSelectedSignals', (e) => {
    viewerProvider.deleteSelectedSignals();
  }));
  
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.selectAllSignals', (e) => {
    viewerProvider.handleKeyBinding(e, "selectAll");
  }));
  
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.ungroupSignals', (e) => {
    viewerProvider.deleteSignalGroup(e, false);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renameSignalGroup', (e) => {
    viewerProvider.renameSignalGroup(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addSelected', (e) => {
    viewerProvider.filterAddSignalsInNetlist(viewerProvider.netlistViewSelectedSignals, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeShallow', (e) => {
    viewerProvider.addAllInScopeToDocument(e, false, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.addAllInScopeRecursive', (e) => {
    viewerProvider.addAllInScopeToDocument(e, true, 128);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.removeSelectedNetlist', (e) => {
    viewerProvider.removeSelectedSignalsFromDocument('netlist');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyName', (e) => {
    let result = "";
    if (e.scopePath !== "") {result += e.scopePath + ".";}
    if (e.name) {result += e.name;}
    if (e.signalName) {result += e.signalName;}
    vscode.env.clipboard.writeText(result);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyValueAtMarker', (e) => {
    viewerProvider.copyValueAtMarker(e);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.saveViewerSettings', (e) => {
    viewerProvider.saveSettingsToFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.loadViewerSettings', (e) => {
    viewerProvider.loadSettingsFromFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.reloadFile', (e) => {
    viewerProvider.reloadFile(e);
  }));

  // #region Keybindings
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.nextEdge', (e) => {
    viewerProvider.handleKeyBinding(e, "nextEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.previousEdge', (e) => {
    viewerProvider.handleKeyBinding(e, "previousEdge");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.zoomToFit', (e) => {
    viewerProvider.handleKeyBinding(e, "zoomToFit");
  }));

  // #region Marker and Timing
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnits', (e) => {
    viewerProvider.updateTimeUnits("");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsSeconds', (e) => {
    viewerProvider.updateTimeUnits("s");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMilliseconds', (e) => {
    viewerProvider.updateTimeUnits("ms");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsMicroseconds', (e) => {
    viewerProvider.updateTimeUnits("µs");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsNanoseconds', (e) => {
    viewerProvider.updateTimeUnits("ns");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsPicoseconds', (e) => {
    viewerProvider.updateTimeUnits("ps");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setTimeUnitsFemtoseconds', (e) => {
    viewerProvider.updateTimeUnits("fs");
  }));

  // #region WaveDrom
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.copyWaveDrom', (e) => {
    viewerProvider.copyWaveDrom();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockRising', (e) => {
    viewerProvider.setWaveDromClock('1', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.setWaveDromClockFalling', (e) => {
    viewerProvider.setWaveDromClock('0', e.netlistId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.unsetWaveDromClock', (e) => {
    viewerProvider.setWaveDromClock('1', null);
  }));

  // #region Value Format
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBinary', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {valueFormat: "binary"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsHexadecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {valueFormat: "hexadecimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {valueFormat: "decimal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsDecimalSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {valueFormat: "signed"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsOctal', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {valueFormat: "octal"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsFloat', (e) => {
    switch (e.width) {
      case 8:  viewerProvider.setValueFormat(e.netlistId, {valueFormat: "float8"}); break;
      case 16: viewerProvider.setValueFormat(e.netlistId, {valueFormat: "float16"}); break;
      case 32: viewerProvider.setValueFormat(e.netlistId, {valueFormat: "float32"}); break;
      case 64: viewerProvider.setValueFormat(e.netlistId, {valueFormat: "float64"}); break;
      default: viewerProvider.setValueFormat(e.netlistId, {valueFormat: "binary"}); break;
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderMultiBit', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {renderType: "multiBit"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinear', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {renderType: "linear"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderStepped', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {renderType: "stepped"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderLinearSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {renderType: "linearSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.renderSteppedSigned', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {renderType: "steppedSigned"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsBFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId,  {valueFormat: "bfloat16"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsTFloat', (e) => {
    viewerProvider.setValueFormat(e.netlistId,  {valueFormat: "tensorfloat32"});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.displayAsAscii', (e) => {
    viewerProvider.setValueFormat(e.netlistId,  {valueFormat: "ascii"});
  }));

  // Simple cache to avoid repeating heavy resolution for the same instancePath
  let lastOpenCache: { instancePath: string; uri: vscode.Uri; range: vscode.Range } | null = null;
  // Scope-level cache: remember the module file for the last resolved instance hierarchy (scopePath)
  let lastScopeCache: { scopePath: string; moduleUri: vscode.Uri } | null = null;

  // Open source for a given instance path (scope-aware resolution)
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openSource', async (e) => {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Opening source…', cancellable: false }, async (progress) => {
        console.log('DEBUG MOUSEDC openSource called with args=', e);
      // Accept instancePath directly (from dblclick) or derive from webview context (right-click menu)
      let instancePath: string | undefined = e?.instancePath;
      if (!instancePath && e?.scopePath && e?.signalName) {
        instancePath = e.scopePath ? `${e.scopePath}.${e.signalName}` : e.signalName;
      }
  if (!instancePath || instancePath.trim() === '') { return; }

        // Normalize the key we use for caching (collapse repeated dots and trim edges)
        const normalizedKey = instancePath.replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
        console.log('DEBUG DCREUSE check', {
          incoming: instancePath,
          normalizedKey,
          cached: lastOpenCache?.instancePath,
          hit: !!lastOpenCache && lastOpenCache.instancePath === normalizedKey,
        });

        // Fast-path: cache hit by normalized instancePath
        if (lastOpenCache && lastOpenCache.instancePath === normalizedKey) {
          console.log('DEBUG DCREUSE hit: reusing cached location', {
            uri: lastOpenCache.uri.toString(),
            range: `${lastOpenCache.range.start.line}:${lastOpenCache.range.start.character}-${lastOpenCache.range.end.line}:${lastOpenCache.range.end.character}`,
          });
          progress.report({ message: 'Reusing last result…', increment: 20 });
          const { uri, range } = lastOpenCache;
          const doc = await vscode.workspace.openTextDocument(uri);
          const activeGroup = vscode.window.tabGroups?.activeTabGroup;
          const activeViewColumn = activeGroup?.viewColumn;
          const openTab = findOpenTabForUri(uri);
          if (openTab) {
            const isDifferentGroup = openTab.group.viewColumn !== activeViewColumn;
            if (isDifferentGroup) {
              await focusTabGroup(openTab.group);
              const ed = await vscode.window.showTextDocument(doc, { viewColumn: openTab.group.viewColumn, preserveFocus: false, preview: false });
              ed.selection = new vscode.Selection(range.start, range.end);
              ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
              return;
            } else {
              const sideColumn = await getOrCreateSideGroupColumn();
              const ed = await vscode.window.showTextDocument(doc, { viewColumn: sideColumn ?? vscode.ViewColumn.Beside, preserveFocus: false, preview: false });
              ed.selection = new vscode.Selection(range.start, range.end);
              ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
              return;
            }
          }
          const existing = vscode.window.visibleTextEditors.find((ed) => sameResource(ed.document.uri, uri));
          if (existing) {
            if (existing.viewColumn && existing.viewColumn !== activeViewColumn) {
              const ed = await vscode.window.showTextDocument(existing.document, { viewColumn: existing.viewColumn, preserveFocus: false, preview: false });
              ed.selection = new vscode.Selection(range.start, range.end);
              ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
              return;
            } else {
              const sideColumn = await getOrCreateSideGroupColumn();
              const ed = await vscode.window.showTextDocument(doc, { viewColumn: sideColumn ?? vscode.ViewColumn.Beside, preserveFocus: false, preview: false });
              ed.selection = new vscode.Selection(range.start, range.end);
              ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
              return;
            }
          }
          const sideColumn = await getOrCreateSideGroupColumn();
          const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: sideColumn ?? vscode.ViewColumn.Beside });
          ed.selection = new vscode.Selection(range.start, range.end);
          ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
          return;
        }

  progress.report({ message: 'Resolving scope…', increment: 10 });

      // Parse scope and leaf signal from instancePath. Example: top.u_core.alu.result -> scopePath=top.u_core.alu, leaf=result
  // Reuse the same normalization for downstream logic
  const normalized = normalizedKey;
  console.log('DEBUG DCREUSE normalized used for resolution', { normalized });
      const parts = normalized.split('.').filter(Boolean);
      const leaf = parts.pop() || normalized; // signal name
      const scopePath = parts.join('.');      // hierarchical instance path without leaf

      // If previous open had the same scope, reuse its document: search new leaf in the same file
      if (lastOpenCache && scopePath) {
        const prevParts = (lastOpenCache.instancePath || '').split('.').filter(Boolean);
        prevParts.pop(); // drop previous leaf
        const prevScope = prevParts.join('.');
        const sameScope = prevScope === scopePath;
        console.log('DEBUG DCREUSE scope-doc-reuse check', { prevScope, scopePath, sameScope });
        if (sameScope) {
          progress.report({ message: `Reusing module for scope…`, increment: 12 });
          try {
            const reuseUri = lastOpenCache.uri;
            const reuseLoc = await findFirstTextMatchInFile(leaf, reuseUri);
            console.log('DEBUG DCREUSE scope-doc-reuse result', { leaf, found: !!reuseLoc, uri: reuseUri.toString() });
            if (reuseLoc) {
              const { uri, range } = reuseLoc;
              const doc = await vscode.workspace.openTextDocument(uri);
              // Update cache to new leaf under same scope
              lastOpenCache = { instancePath: normalized, uri, range };
              const activeGroup = vscode.window.tabGroups?.activeTabGroup;
              const activeViewColumn = activeGroup?.viewColumn;
              const openTab = findOpenTabForUri(uri);
              if (openTab) {
                const isDifferentGroup = openTab.group.viewColumn !== activeViewColumn;
                if (isDifferentGroup) {
                  await focusTabGroup(openTab.group);
                  const ed = await vscode.window.showTextDocument(doc, { viewColumn: openTab.group.viewColumn, preserveFocus: false, preview: false });
                  ed.selection = new vscode.Selection(range.start, range.end);
                  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                  return;
                } else {
                  const sideColumn = await getOrCreateSideGroupColumn();
                  const ed = await vscode.window.showTextDocument(doc, { viewColumn: sideColumn ?? vscode.ViewColumn.Beside, preserveFocus: false, preview: false });
                  ed.selection = new vscode.Selection(range.start, range.end);
                  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                  return;
                }
              }
              const existing = vscode.window.visibleTextEditors.find((ed) => sameResource(ed.document.uri, uri));
              if (existing) {
                if (existing.viewColumn && existing.viewColumn !== activeViewColumn) {
                  const ed = await vscode.window.showTextDocument(existing.document, { viewColumn: existing.viewColumn, preserveFocus: false, preview: false });
                  ed.selection = new vscode.Selection(range.start, range.end);
                  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                  return;
                } else {
                  const sideColumn = await getOrCreateSideGroupColumn();
                  const ed = await vscode.window.showTextDocument(doc, { viewColumn: sideColumn ?? vscode.ViewColumn.Beside, preserveFocus: false, preview: false });
                  ed.selection = new vscode.Selection(range.start, range.end);
                  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                  return;
                }
              }
              const sideColumn = await getOrCreateSideGroupColumn();
              const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: sideColumn ?? vscode.ViewColumn.Beside });
              ed.selection = new vscode.Selection(range.start, range.end);
              ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
              return;
            }
          } catch (reuseErr) {
            console.warn('DEBUG DCREUSE scope-doc-reuse failed, falling back to resolution', reuseErr);
          }
        }
      }

  // Try to resolve the module file for the most specific scope first, then walk up
      const includeGlobs = '**/*.{sv,svh,v,vh,verilog,svt,vhdl,vhd}';
      let resolved: { uri: vscode.Uri, range: vscode.Range } | null = null;
      let moduleUri: vscode.Uri | null = null;

      // Best-effort: infer module type from trailing instance name by finding an instantiation `<ModuleType> ... <instName> (`
      const tryResolveModuleForInstance = async (instName: string): Promise<vscode.Uri | null> => {
        const instRegex = new RegExp(`\\b([A-Za-z_][\\w$]*)\\s*(?:#\\s*\\([\\s\\S]*?\\))?\\s+${escapeRegExp(instName)}\\s*\\(`, 'm');
        const files = await vscode.workspace.findFiles(includeGlobs, '{**/node_modules/**,**/dist/**,**/out/**}', 1500);
        for (const uri of files) {
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText();
            const m = instRegex.exec(text);
            if (m && m[1]) {
              const moduleName = m[1];
              const modDecl = await findModuleDeclaration(moduleName, includeGlobs);
              if (modDecl) return modDecl.uri;
            }
          } catch {/* ignore file errors */}
        }
        return null;
      };

      // If scope matches the last resolved scope, reuse its module file to avoid heavy resolution
      if (lastScopeCache && scopePath && lastScopeCache.scopePath === scopePath) {
        moduleUri = lastScopeCache.moduleUri;
        console.log('DEBUG DCREUSE scope-hit', { scopePath, moduleUri: moduleUri.toString() });
      }

      // Try resolve using most specific instance first (only if not reused from cache)
      for (let i = parts.length - 1; i >= 0 && !moduleUri; i--) {
        const inst = parts[i];
        progress.report({ message: `Resolving instance '${inst}'…`, increment: 10 });
        moduleUri = await tryResolveModuleForInstance(inst);
      }

      // If still unknown, try to use basename heuristic: any scope segment might actually be the module name
      if (!moduleUri) {
        for (let i = parts.length - 1; i >= 0 && !moduleUri; i--) {
          const assumedModuleName = parts[i];
          progress.report({ message: `Searching module '${assumedModuleName}'…`, increment: 10 });
          const decl = await findModuleDeclaration(assumedModuleName, includeGlobs);
          if (decl) moduleUri = decl.uri;
        }
      }

      // If we resolved a module file, search the leaf within that module file; else fallback to global search by leaf
      if (moduleUri) {
        if (scopePath) {
          lastScopeCache = { scopePath, moduleUri };
          console.log('DEBUG DCREUSE scope-update', { scopePath, moduleUri: moduleUri.toString() });
        }
        progress.report({ message: `Searching '${leaf}' in module…`, increment: 15 });
        const leafLoc = await findFirstTextMatchInFile(leaf, moduleUri);
        if (leafLoc) {
          resolved = leafLoc;
        } else {
          // As a fallback, navigate to module declaration
          const modDecl = await findModuleDeclarationInFile(moduleUri);
          if (modDecl) resolved = modDecl;
        }
      }

      if (!resolved) {
        progress.report({ message: `Searching workspace for '${leaf}'…`, increment: 20 });
        // Global fallback: search HDL-like files for the leaf symbol
        const locations = await findFirstTextMatchSimple(leaf, includeGlobs);
        if (locations) {
          resolved = locations;
        }
      }

      if (!resolved) {
        vscode.window.showInformationMessage(`Could not find source for ${leaf}`);
        return;
      }

  const { uri, range } = resolved;
      console.log('DEBUG MOUSEDC openSource found uri=', uri.toString(), 'range=', range);
      progress.report({ message: 'Opening document…', increment: 25 });
      const doc = await vscode.workspace.openTextDocument(uri);

  // Update cache (store the normalized key)
  lastOpenCache = { instancePath: normalizedKey, uri, range };
  console.log('DEBUG DCREUSE update cache', {
    key: normalizedKey,
    uri: uri.toString(),
    range: `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`,
  });

  // Determine active group (likely the waveform viewer). We want the source in a split group.
  const activeGroup = vscode.window.tabGroups?.activeTabGroup;
  const activeViewColumn = activeGroup?.viewColumn;

      // If the document is already open (even if inactive) in any editor group, prefer showing it
      // in a different group than the active one; otherwise, open beside to force a split.
      const openTab = findOpenTabForUri(uri);
      if (openTab) {
        const isDifferentGroup = openTab.group.viewColumn !== activeViewColumn;
        console.log('DEBUG MOUSEDC openSource tab already open in group=', openTab.group.viewColumn, 'activeGroup=', activeViewColumn);
        if (isDifferentGroup) {
          await focusTabGroup(openTab.group);
          const ed = await vscode.window.showTextDocument(doc, {
            viewColumn: openTab.group.viewColumn,
            preserveFocus: false,
            preview: false,
          });
          ed.selection = new vscode.Selection(range.start, range.end);
          ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
          return;
        } else {
          // Open explicitly in a side group to avoid replacing the viewer
          const sideColumn = await getOrCreateSideGroupColumn();
          const ed = await vscode.window.showTextDocument(doc, {
            viewColumn: sideColumn ?? vscode.ViewColumn.Beside,
            preserveFocus: false,
            preview: false,
          });
          ed.selection = new vscode.Selection(range.start, range.end);
          ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
          return;
        }
      }

      // Fallback: check currently visible editors (should be covered by tab search, but keep for safety)
  const existing = vscode.window.visibleTextEditors.find((ed) => sameResource(ed.document.uri, uri));
      if (existing) {
        console.log('DEBUG MOUSEDC openSource found visible editor viewColumn=', existing.viewColumn, 'activeGroup=', activeViewColumn);
        if (existing.viewColumn && existing.viewColumn !== activeViewColumn) {
          const ed = await vscode.window.showTextDocument(existing.document, {
            viewColumn: existing.viewColumn,
            preserveFocus: false,
            preview: false,
          });
          ed.selection = new vscode.Selection(range.start, range.end);
          ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
          return;
        } else {
          const sideColumn = await getOrCreateSideGroupColumn();
          const ed = await vscode.window.showTextDocument(doc, {
            viewColumn: sideColumn ?? vscode.ViewColumn.Beside,
            preserveFocus: false,
            preview: false,
          });
          ed.selection = new vscode.Selection(range.start, range.end);
          ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
          return;
        }
      }

  // Always open in a side group to guarantee a split
  const sideColumn = await getOrCreateSideGroupColumn();
      const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: sideColumn ?? vscode.ViewColumn.Beside });
      console.log('DEBUG MOUSEDC openSource showTextDocument opened in side group viewColumn=', ed.viewColumn);
      ed.selection = new vscode.Selection(range.start, range.end);
      ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
      });
    } catch (err) {
      console.error(err);
    }
  }));


function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function findOpenTabForUri(uri: vscode.Uri): { group: vscode.TabGroup; tab: vscode.Tab } | undefined {
  const groups = vscode.window.tabGroups?.all ?? [];
  for (const group of groups) {
    for (const tab of group.tabs) {
      const input: any = (tab as any).input;
      // Prefer instanceof check when available
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - TabInputText may not exist on older engine typings at build time
      if (input instanceof (vscode as any).TabInputText) {
        if (sameResource(input.uri, uri)) {
          return { group, tab };
        }
      } else if (input && input.uri && typeof input.uri.toString === 'function') {
        if (sameResource(input.uri, uri)) {
          return { group, tab };
        }
      }
    }
  }
  return undefined;
}

async function focusTabGroup(target: vscode.TabGroup): Promise<void> {
  const groups = vscode.window.tabGroups?.all ?? [];
  if (groups.length === 0) { return; }
  const targetIndex = groups.findIndex(g => g.viewColumn === target.viewColumn);
  if (targetIndex < 0) { return; }
  // Determine how many moves left/right from current active group
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  const activeIndex = groups.findIndex(g => g.viewColumn === activeGroup.viewColumn);
  if (activeIndex === -1 || activeIndex === targetIndex) { return; }
  const step = targetIndex > activeIndex ? 1 : -1;
  const moves = Math.abs(targetIndex - activeIndex);
  for (let i = 0; i < moves; i++) {
    if (step > 0) {
      await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    } else {
      await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
    }
  }
}

// Ensure there's a side editor group and return its ViewColumn based on configuration.
// Config:
//   - vaporview.openSource.targetGroup (1-n): if valid, use that view column.
//   - vaporview.openSource.splitDirection: 'left' | 'right' | 'beside' (default 'left').
// Behavior:
//   - If targetGroup valid and exists, use it. If not exists, create if reasonable, else fallback.
//   - Else honor splitDirection: try to keep viewer on opposite side and open source in requested direction.
async function getOrCreateSideGroupColumn(): Promise<vscode.ViewColumn | undefined> {
  try {
  // Prefer Crisp settings, fallback to VaporView settings for compatibility
  const crispCfg = vscode.workspace.getConfiguration('crisp');
  const vaporCfg = vscode.workspace.getConfiguration('vaporview');
  const targetGroupCfg = crispCfg.get<number>('openSource.targetGroup', vaporCfg.get<number>('openSource.targetGroup', 0));
  const splitDirection = crispCfg.get<'left' | 'right' | 'beside'>('openSource.splitDirection', vaporCfg.get<'left' | 'right' | 'beside'>('openSource.splitDirection', 'left'));
    const groups = vscode.window.tabGroups?.all ?? [];
    const active = vscode.window.tabGroups?.activeTabGroup;
    // If targetGroup is specified, try to use it
    if (typeof targetGroupCfg === 'number' && targetGroupCfg >= 1) {
      const target = groups.find(g => g.viewColumn === targetGroupCfg);
      if (target) { return target.viewColumn; }
      // If requesting a right group that doesn't exist, create one(s) until index exists (only create one step for safety)
      if (targetGroupCfg > (active?.viewColumn ?? 1)) {
        await vscode.commands.executeCommand('workbench.action.newGroupRight');
        const after = vscode.window.tabGroups?.all ?? [];
        const created = after.find(g => g.viewColumn === targetGroupCfg) || after.find(g => g.viewColumn !== active?.viewColumn);
        if (created) { return created.viewColumn; }
      }
      // Fallback to beside if cannot satisfy exact group
      return undefined;
    }
    if (groups.length >= 2) {
      // Prefer a non-active group; choose left or right depending on splitDirection
      if (splitDirection === 'left') {
        const left = groups.find(g => g.viewColumn === vscode.ViewColumn.One && g.viewColumn !== active?.viewColumn);
        if (left) { return left.viewColumn; }
        const other = groups.find(g => g.viewColumn !== active?.viewColumn);
        return other?.viewColumn;
      } else if (splitDirection === 'right') {
        const right = groups.find(g => g.viewColumn && g.viewColumn !== vscode.ViewColumn.One && g.viewColumn !== active?.viewColumn);
        if (right) { return right.viewColumn; }
        const other = groups.find(g => g.viewColumn !== active?.viewColumn);
        return other?.viewColumn;
      } else {
        // beside: let VS Code decide by returning undefined to use ViewColumn.Beside
        return undefined;
      }
    }

    // Only one group exists; split based on splitDirection
    if (splitDirection === 'left') {
      // Move current viewer to right, then use left for source
      try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
        return vscode.ViewColumn.One;
      } catch (moveErr) {
        console.warn('moveEditorToRightGroup failed, attempting splitEditorRight then focus left:', moveErr);
      }
      try {
        await vscode.commands.executeCommand('workbench.action.splitEditorRight');
        await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
        const newActive = vscode.window.tabGroups?.activeTabGroup;
        return newActive?.viewColumn;
      } catch (splitErr) {
        console.warn('splitEditorRight failed, falling back to Beside:', splitErr);
      }
    } else if (splitDirection === 'right') {
      try {
        await vscode.commands.executeCommand('workbench.action.splitEditorRight');
        // The new right group becomes active; use it
        const newActive = vscode.window.tabGroups?.activeTabGroup;
        return newActive?.viewColumn;
      } catch (splitErr) {
        console.warn('splitEditorRight failed, falling back to Beside:', splitErr);
      }
    } else {
      // beside: no-op, let VS Code decide
      return undefined;
    }

    return undefined;
  } catch (e) {
    console.warn('getOrCreateSideGroupColumn failed, falling back to Beside:', e);
    return undefined;
  }
}

async function findFirstTextMatchSimple(symbol: string, includeGlob: string): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const files = await vscode.workspace.findFiles(includeGlob, '{**/node_modules/**,**/dist/**,**/out/**}', 1000);
    const wordPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const match = wordPattern.exec(text);
        if (match) {
          const start = doc.positionAt(match.index);
          const end   = doc.positionAt(match.index + match[0].length);
          return { uri, range: new vscode.Range(start, end) };
        }
      } catch { /* ignore file errors */ }
    }
  } catch {
    // ignore
  }
  return null;
}

// Find the declaration of a SystemVerilog/Verilog module/interface/package by name across the workspace
async function findModuleDeclaration(moduleName: string, includeGlob: string): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const files = await vscode.workspace.findFiles(includeGlob, '{**/node_modules/**,**/dist/**,**/out/**}', 1500);
    const declPattern = new RegExp(`\\b(module|interface|package)\\s+${escapeRegExp(moduleName)}\\b`);
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const m = declPattern.exec(text);
        if (m) {
          const start = doc.positionAt(m.index);
          const end = doc.positionAt(m.index + m[0].length);
          return { uri, range: new vscode.Range(start, end) };
        }
      } catch { /* ignore file errors */ }
    }
  } catch {
    // ignore
  }
  return null;
}

// Find the declaration of the first module/interface/package in a specific file (fallback when name unknown)
async function findModuleDeclarationInFile(uri: vscode.Uri): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const declPattern = /\b(module|interface|package)\s+([A-Za-z_][\w$]*)\b/;
    const m = declPattern.exec(text);
    if (m) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      return { uri, range: new vscode.Range(start, end) };
    }
  } catch { /* ignore */ }
  return null;
}

// Find the first word-boundary match of a symbol within a specific file
async function findFirstTextMatchInFile(symbol: string, uri: vscode.Uri): Promise<{uri: vscode.Uri, range: vscode.Range} | null> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const m = pattern.exec(text);
    if (m) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      return { uri, range: new vscode.Range(start, end) };
    }
  } catch { /* ignore */ }
  return null;
}

function sameResource(a: vscode.Uri | undefined, b: vscode.Uri | undefined): boolean {
  if (!a || !b) { return false; }
  if (a.scheme !== b.scheme) { return false; }
  if (a.scheme === 'file') {
    // Normalize fsPath for case sensitivity differences on macOS/Windows
    const norm = (u: vscode.Uri) => u.fsPath.replace(/\\/g, '/');
    return norm(a) === norm(b);
  }
  return a.toString() === b.toString();
}
  // #region Annotate Edges
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotatePosedge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {annotateValue: ["1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNegedge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {annotateValue: ["0"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateAllEdge', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {annotateValue: ["0", "1"]});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.annotateNone', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {annotateValue: []});
  }));

  // #region Custom Color
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 0});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.defaultColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 3});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor1', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor2', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 5});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor3', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 6});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.customColor4', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {colorIndex: 7});
  }));

  // #region Row Height
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight1x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {rowHeight: 1});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight2x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {rowHeight: 2});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight4x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {rowHeight: 4});
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.rowHeight8x', (e) => {
    viewerProvider.setValueFormat(e.netlistId, {rowHeight: 8});
  }));

  // #region Vertical Scale
  context.subscriptions.push(vscode.commands.registerCommand('vaporview.increaseVerticalScale', (e) => {
    console.log("Increasing vertical scale");
    viewerProvider.handleKeyBinding(e, "increaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.decreaseVerticalScale', (e) => {
    console.log("Decreasing vertical scale");
    viewerProvider.handleKeyBinding(e, "decreaseVerticalScale");
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.showRulerLines', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', true, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.hideRulerLines', (e) => {
    vscode.workspace.getConfiguration('vaporview').update('showRulerLines', false, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.dummy', (e) => {
    viewerProvider.log.appendLine("Command called: 'vaporview.dummy' " + JSON.stringify(e));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('vaporview.openRemoteViewer', async (e) => {
    if (e && e.url) {
      viewerProvider.openRemoteViewer(e.url, e.bearerToken);
      return;
    }
    const serverUrl = await vscode.window.showInputBox({
      prompt: 'Enter the Surfer server URL',
      value: ''
    });
    
    if (!serverUrl) {
      return;
    }
    
    const bearerToken = await vscode.window.showInputBox({
      prompt: 'Enter bearer token (optional)',
      password: true,
      value: ''
    });
    
    viewerProvider.openRemoteViewer(serverUrl, bearerToken);
  }));

  return {
    onDidSetMarker: markerSetEvent,
    onDidSelectSignal: signalSelectEvent,
    onDidAddVariable: addVariableEvent,
    onDidRemoveVariable: removeVariableEvent,
    onDidDropInWaveformViewer: externalDropEvent
  };
}

export default WaveformViewerProvider;

export function deactivate() {}

export function getTokenColorsForTheme(themeName: string) {
  const tokenColors = new Map();
  let currentThemePath;
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON.contributes && extension.packageJSON.contributes.themes;
    const currentTheme = themes && themes.find((theme: any) => theme.id === themeName);
    if (currentTheme) {
      currentThemePath = path.join(extension.extensionPath, currentTheme.path);
      break;
    }
  }
  const themePaths = [];
  if (currentThemePath) { themePaths.push(currentThemePath); }
  while (themePaths.length > 0) {
    const themePath: any = themePaths.pop();
    const theme: any = JSON.parse(fs.readFileSync(themePath, 'utf8'));
    if (theme) {
      if (theme.include) {
        themePaths.push(path.join(path.dirname(themePath), theme.include));
      }
      if (theme.tokenColors) {
        theme.tokenColors.forEach((rule: any) => {
          if (typeof rule.scope === "string" && !tokenColors.has(rule.scope)) {
            tokenColors.set(rule.scope, rule.settings);
          } else if (rule.scope instanceof Array) {
            rule.scope.forEach((scope: any) => {
              if (!tokenColors.has(rule.scope)) {
                tokenColors.set(scope, rule.settings);
              }
            });
          }
        });
      }
    }
  }
  return tokenColors;
}
