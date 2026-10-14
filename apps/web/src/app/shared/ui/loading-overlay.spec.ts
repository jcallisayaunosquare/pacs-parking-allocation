import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { LoadingOverlay } from './loading-overlay';

/**
 * The overlay's only real behaviour is time: it must not flash on a fast call, and once
 * drawn it must not vanish after a frame. Both are the difference between feedback and
 * a glitch, and neither is visible in a screenshot - so they are pinned here.
 */
describe('LoadingOverlay', () => {
  let fixture: ComponentFixture<LoadingOverlay>;

  const set = (active: boolean): void => {
    fixture.componentRef.setInput('active', active);
    TestBed.tick();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fixture = TestBed.createComponent(LoadingOverlay);
    fixture.componentRef.setInput('label', 'Saving the bay');
    TestBed.tick();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws nothing for a call that finishes inside the delay', () => {
    set(true);
    vi.advanceTimersByTime(150);
    set(false);
    vi.advanceTimersByTime(1000);
    expect(fixture.componentInstance.shown()).toBe(false);
  });

  it('draws the veil once a call outlasts the delay', () => {
    set(true);
    vi.advanceTimersByTime(200);
    expect(fixture.componentInstance.shown()).toBe(true);
  });

  it('holds the veil for the minimum even when the call ends just after it appears', () => {
    set(true);
    vi.advanceTimersByTime(210);
    set(false);
    vi.advanceTimersByTime(100);
    expect(fixture.componentInstance.shown()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(fixture.componentInstance.shown()).toBe(false);
  });

  it('makes the content inert and announces the label while drawn', () => {
    set(true);
    vi.advanceTimersByTime(200);
    TestBed.tick();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.body')?.hasAttribute('inert')).toBe(true);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Saving the bay');
  });
});
