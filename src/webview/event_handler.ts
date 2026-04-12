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
  [ActionType.MarkerSet]:        [time: number, markerType: number];
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
  markerSet(time: number, markerType: number) {
    this.fire(ActionType.MarkerSet, time, markerType);
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