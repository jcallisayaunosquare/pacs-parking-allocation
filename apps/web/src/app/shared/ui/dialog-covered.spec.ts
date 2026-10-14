import { describe, expect, it } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { dialogCovered } from './dialog-covered';

/**
 * Against the real MatDialog, because the defect lived in the order Material emits its
 * close and updates its list - a stub would have agreed with whatever the code assumed.
 */
describe('dialogCovered', () => {
  @Component({ template: '' })
  class Page {
    readonly covered = dialogCovered();
  }

  @Component({ template: '<p>confirm</p>' })
  class Confirm {}

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      TestBed.tick();
    }
  };

  it('is covered while a dialog is open and clear once it has closed', async () => {
    const fixture = TestBed.createComponent(Page);
    const page = fixture.componentInstance;
    expect(page.covered()).toBe(false);

    const ref = TestBed.inject(MatDialog).open(Confirm);
    await settle();
    expect(page.covered()).toBe(true);

    ref.close(true);
    await settle();
    expect(page.covered()).toBe(false);
  });

  it('clears after a second dialog too, not only the first', async () => {
    const fixture = TestBed.createComponent(Page);
    const page = fixture.componentInstance;
    const dialog = TestBed.inject(MatDialog);

    for (let i = 0; i < 2; i += 1) {
      const ref = dialog.open(Confirm);
      await settle();
      expect(page.covered()).toBe(true);
      ref.close();
      await settle();
      expect(page.covered()).toBe(false);
    }
  });
});
