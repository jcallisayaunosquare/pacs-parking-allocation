import { computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { from, map, merge, mergeMap, scan } from 'rxjs';

/**
 * Whether a dialog is open over the caller. Call from an injection context.
 *
 * The admin facades are root singletons, so a page and the dialog it opened read the same
 * `busy()` and `error()`. While the dialog is up, those belong to it: its button shows
 * the save, its form shows the server's refusal. A page that rendered them as well
 * printed the same error twice - once in the dialog, once on the screen behind it - and
 * drew a loader nobody could see. Pages and regions gate their own copy on this.
 *
 * A caller inside a dialog does not count that dialog as covering it, only another one
 * opened on top.
 *
 * The set of open dialogs is kept here, from open and close events, rather than read
 * from `MatDialog.openDialogs` when a close fires. That list is only updated by a
 * subscriber of its own, and when the dialog's `afterClosed` reached this code first the
 * closing dialog was still in it: the count stuck at one, the page believed it was
 * covered for good, and the refusal of a confirmed removal never reached a toast.
 */
export function dialogCovered(): Signal<boolean> {
  const dialog = inject(MatDialog);
  const own = inject(MatDialogRef, { optional: true });

  type Change = { readonly ref: MatDialogRef<unknown>; readonly open: boolean };
  const closes = (ref: MatDialogRef<unknown>) =>
    ref.afterClosed().pipe(map((): Change => ({ ref, open: false })));

  const open = toSignal(
    merge(
      dialog.afterOpened.pipe(map((ref): Change => ({ ref, open: true }))),
      dialog.afterOpened.pipe(mergeMap(closes)),
      // Dialogs already open when this was created close too, and must leave the set.
      from(dialog.openDialogs).pipe(mergeMap(closes)),
    ).pipe(
      scan((set, change) => {
        const next = new Set(set);
        if (change.open) next.add(change.ref);
        else next.delete(change.ref);
        return next;
      }, new Set<MatDialogRef<unknown>>(dialog.openDialogs)),
      map((set) => set.size),
    ),
    { initialValue: dialog.openDialogs.length },
  );
  return computed(() => open() > (own ? 1 : 0));
}
