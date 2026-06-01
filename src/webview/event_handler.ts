import { DocumentId, RowId } from '../common/types';

export enum ActionType {
  MarkerSet,
  SignalSelect,
  ReorderSignals,
  AddVariable,
  RemoveVariable,
  RedrawVariable,
  Resize,
  UpdateColorTheme,
  ExitBatchMode,
}

interface ActionTypeMap {
  [ActionType.MarkerSet]:        [time: number, markerType: number, dragging: boolean];
  [ActionType.SignalSelect]:     [rowIdList: RowId[], lastSelected: RowId | null];
  [ActionType.ReorderSignals]:   [rowIdList: number[], newGroupId: number, newIndex: number];
  [ActionType.AddVariable]:      [rowIdList: RowId[], updateFlag: boolean];
  [ActionType.RemoveVariable]:   [rowIdList: RowId[], recursive: boolean];
  [ActionType.RedrawVariable]:   [rowId: RowId];
  [ActionType.Resize]:           [];
  [ActionType.UpdateColorTheme]: [];
  [ActionType.ExitBatchMode]:    [];
}

export class EventHandler {
  private subscribers = new Map<ActionType, ((...args: unknown[]) => void)[]>();
  private batchMode = false;
  public get isBatchMode(): boolean {return this.batchMode;}
  private signalSelectArgs: ActionTypeMap[ActionType.SignalSelect] = [[], null];

  enterBatchMode() {
    this.batchMode = true;
  }

  exitBatchMode() {
    this.batchMode = false;
    this.signalSelect(...this.signalSelectArgs);
    this.fire(ActionType.ExitBatchMode);
  }

  subscribe<T extends ActionType>(action: T, callback: (...args: ActionTypeMap[T]) => void) {
    if (!this.subscribers.has(action)) {
      this.subscribers.set(action, []);
    }
    this.subscribers.get(action)!.push(callback as (...args: unknown[]) => void);
  }

  private fire<T extends ActionType>(action: T, ...args: ActionTypeMap[T]) {
    this.subscribers.get(action)?.forEach((callback) => callback(...args));
  }

  // Event calls
  markerSet(time: number, markerType: number, dragging: boolean) {
    this.fire(ActionType.MarkerSet, time, markerType, dragging);
  }

  signalSelect(rowIdList: RowId[], lastSelected: RowId | null) {
    this.signalSelectArgs = [rowIdList, lastSelected];
    if (this.batchMode) {return;}
    this.fire(ActionType.SignalSelect, rowIdList, lastSelected);
  }

  reorderSignals(rowIdList: number[], newGroupId: number, newIndex: number) {
    this.fire(ActionType.ReorderSignals, rowIdList, newGroupId, newIndex);
  }

  addVariable(rowIdList: RowId[], updateFlag: boolean) {
    this.fire(ActionType.AddVariable, rowIdList, updateFlag);
  }

  removeVariable(rowIdList: RowId[], recursive: boolean) {
    this.fire(ActionType.RemoveVariable, rowIdList, recursive);
  }

  redrawVariable(rowId: RowId) {
    if (this.batchMode) {return;}
    this.fire(ActionType.RedrawVariable, rowId);
  }

  resize() {
    this.fire(ActionType.Resize);
  }

  updateColorTheme() {
    this.fire(ActionType.UpdateColorTheme);
  }
}

// A single owner for all pointer-driven and native-DnD drag gestures in the webview.
//
// There is at most one active drag at a time. Each gesture provides a DragSession
// describing how to handle movement and termination; the controller owns the
// document-level listener bookkeeping, pointer capture, focus-on-start, and the
// uniform abort path (Escape / pointercancel / drag leaving the webview).
//
// Two session kinds are supported:
//   - 'pointer':  driven by pointermove/pointerup/pointercancel on `document`.
//   - 'external': driven by native HTML5 drag-and-drop (dragover/drop) coming from
//                 outside the webview. The controller attaches NO pointer listeners
//                 for these; it only tracks the session so abort and the
//                 single-active-drag invariant work through one path.

export type DragKind = 'pointer' | 'external';

export interface DragSession {
  kind: DragKind;
  onMove(event: MouseEvent | DragEvent): void;
  onEnd(event: MouseEvent | DragEvent | KeyboardEvent | null, abort: boolean): void;

  // Pointer-session options (ignored for 'external'):
  capture?: HTMLElement;      // setPointerCapture target (e.g. the scrollbar thumb)
  focusOnStart?: boolean;     // focus #contentArea so keyboard nav works mid/after drag
  preventDefault?: boolean;   // call preventDefault() on the initiating event
}

export class DragController {

  private activeSession: DragSession | null = null;
  private lastPointerEvent: MouseEvent | null = null;
  private capturedElement: HTMLElement | null = null;
  private capturedPointerId: number | null = null;

  constructor() {
    this.handlePointerMove   = this.handlePointerMove.bind(this);
    this.handlePointerUp     = this.handlePointerUp.bind(this);
    this.handlePointerCancel = this.handlePointerCancel.bind(this);
  }

  get isActive(): boolean { return this.activeSession !== null; }

  begin(event: MouseEvent | DragEvent, session: DragSession) {
    // Defensively clear any stale drag before starting a new one.
    if (this.activeSession) { this.end(null, true); }
    this.activeSession = session;

    if (session.kind === 'pointer') {
      this.lastPointerEvent = event;
      if (session.preventDefault) { event.preventDefault(); }
      if (session.focusOnStart)   { document.getElementById('contentArea')?.focus(); }
      if (session.capture && typeof (event as PointerEvent).pointerId === 'number') {
        const pointerId = (event as PointerEvent).pointerId;
        try {
          session.capture.setPointerCapture(pointerId);
          this.capturedElement   = session.capture;
          this.capturedPointerId = pointerId;
        } catch { /* capture not supported / already released */ }
      }
      document.addEventListener('pointermove',   this.handlePointerMove);
      document.addEventListener('pointerup',     this.handlePointerUp);
      document.addEventListener('pointercancel', this.handlePointerCancel);
    }
    // 'external' sessions are driven by native dragover/drop; no listeners here.
  }

  // Re-fire the active session's onMove using the last known pointer position.
  // Used when the viewport scrolls mid-drag so divider/highlight positions stay
  // accurate even when the pointer itself hasn't moved.
  contentMoved() {
    if (this.activeSession && this.lastPointerEvent) {
      this.activeSession.onMove(this.lastPointerEvent);
    }
  }

  // Uniform abort entry point (Escape, pointercancel, drag leaving the webview).
  cancel(event: MouseEvent | DragEvent | KeyboardEvent | null = null) {
    this.end(event, true);
  }

  // Clear controller state without invoking onEnd. Used when a session terminates
  // through its own channel (e.g. a successful native drop already ran its cleanup).
  markEnded() {
    if (!this.activeSession) { return; }
    const wasPointer = this.activeSession.kind === 'pointer';
    this.activeSession    = null;
    this.lastPointerEvent = null;
    if (wasPointer) { this.detachPointerListeners(); }
  }

  end(event: MouseEvent | DragEvent | KeyboardEvent | null, abort: boolean) {
    const session = this.activeSession;
    if (!session) { return; }
    this.activeSession    = null;
    this.lastPointerEvent = null;
    if (session.kind === 'pointer') { this.detachPointerListeners(); }
    session.onEnd(event, abort);
  }

  private detachPointerListeners() {
    document.removeEventListener('pointermove',   this.handlePointerMove);
    document.removeEventListener('pointerup',     this.handlePointerUp);
    document.removeEventListener('pointercancel', this.handlePointerCancel);
    if (this.capturedElement && this.capturedPointerId !== null) {
      try { this.capturedElement.releasePointerCapture(this.capturedPointerId); }
      catch { /* capture already released */ }
    }
    this.capturedElement   = null;
    this.capturedPointerId = null;
  }

  private handlePointerMove(event: PointerEvent) {
    this.lastPointerEvent = event;
    this.activeSession?.onMove(event);
  }

  private handlePointerUp(event: PointerEvent) {
    this.end(event, false);
  }

  private handlePointerCancel(event: PointerEvent) {
    this.end(event, true);
  }
}
