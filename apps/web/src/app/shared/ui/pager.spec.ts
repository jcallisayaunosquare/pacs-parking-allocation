import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Pager } from './pager';

/** The range is the pager's only arithmetic, and the first thing a wrong page shows. */
describe('Pager', () => {
  const render = (page: number, pageSize: number, count: number) => {
    const fixture = TestBed.createComponent(Pager);
    const ref = fixture.componentRef;
    ref.setInput('page', page);
    ref.setInput('pageSize', pageSize);
    ref.setInput('count', count);
    ref.setInput('hasPrevious', page > 1);
    ref.setInput('hasNext', count === pageSize);
    fixture.detectChanges();
    return fixture;
  };

  it('counts rows across pages, not from 1 on each', () => {
    expect(render(2, 15, 15).componentInstance.range()).toBe('Rows 16–30 · page 2');
  });

  it('ends the range at the rows the last page actually has', () => {
    expect(render(3, 25, 7).componentInstance.range()).toBe('Rows 51–57 · page 3');
  });

  it('disables Previous on the first page and Next on the last', () => {
    const el = render(1, 15, 4).nativeElement as HTMLElement;
    const [prev, next] = Array.from(el.querySelectorAll('button'));
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });
});
