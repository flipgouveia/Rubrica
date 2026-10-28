// Mock engine entry point (CONTRACTS §5): assembles every domain module
// into one object with the exact same shape as the real `commands`/`events`
// exports from `src/ipc/bindings.ts`, so `src/ipc/index.ts` can pick either
// at runtime and the rest of the app never has to know which one it got.
//
// `commands`/`events` below are annotated with `CommandsShape`/`EventsShape`
// — types lifted from bindings.ts via `import type` (fully erased, no
// runtime Tauri code pulled in) — so TypeScript enforces full command-surface
// coverage: forgetting a command, or drifting from its real signature, is a
// compile error here rather than a silent gap wave-1 UI agents discover
// later.
import type { commands as RealCommands, events as RealEvents } from "../bindings";

import { annotAdd, annotDelete, annotList, annotUpdate } from "./annotations";
import { journalRecover, prefsGet, prefsSet, printRender, recentsClear, recentsList } from "./app";
import { docClose, docListOpen, docOpen, docOutline, docSave, docSaveAs } from "./document";
import { docStateChanged, recoveryAvailable, saveState, searchBatch } from "./events";
import { formFields, formSetValue } from "./forms";
import { historyRedo, historyState, historyUndo } from "./history";
import { pagesDelete, pagesInsertBlank, pagesInsertFromFile, pagesReorder, pagesRotate } from "./pages";
import { redactApply } from "./redact";
import { textExtractRange, textPageLayout, textSearchCancel, textSearchStart } from "./text";
import { imageobjAdd, objectDelete, textobjAdd, textObjects, textobjSetText } from "./textedit";

export { mockThumbUrl, mockThumbUrlAsync, mockTileUrl, mockTileUrlAsync } from "./render";
export type { DocKind } from "./state";

type CommandsShape = typeof RealCommands;
type EventsShape = typeof RealEvents;

export const commands: CommandsShape = {
  docOpen,
  docClose,
  docSave,
  docSaveAs,
  docListOpen,
  docOutline,
  textPageLayout,
  textExtractRange,
  textSearchStart,
  textSearchCancel,
  historyUndo,
  historyRedo,
  historyState,
  annotList,
  annotAdd,
  annotUpdate,
  annotDelete,
  pagesReorder,
  pagesRotate,
  pagesDelete,
  pagesInsertBlank,
  pagesInsertFromFile,
  formFields,
  formSetValue,
  textObjects,
  textobjSetText,
  textobjAdd,
  imageobjAdd,
  objectDelete,
  redactApply,
  recentsList,
  recentsClear,
  prefsGet,
  prefsSet,
  printRender,
  journalRecover,
};

export const events: EventsShape = {
  docStateChanged,
  recoveryAvailable,
  saveState,
  searchBatch,
};
