import { describe, expect, it } from 'vitest';
import { Injector, resource } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { reloaded } from './async-state';

/**
 * `reloaded` is what keeps a dialog open, its button pending, until the table behind it
 * shows the write. If it resolved early the dialog would close on the old rows again;
 * if it never resolved the button would spin for ever. Both ends are pinned here.
 */
describe('reloaded', () => {
  /** A resource whose every load waits for the test to release it. */
  const gated = () => {
    const pending: (() => void)[] = [];
    let loads = 0;
    const res = TestBed.runInInjectionContext(() =>
      resource({
        loader: () => {
          loads += 1;
          const n = loads;
          return new Promise<number>((r) => pending.push(() => r(n)));
        },
      }),
    );
    return { res, release: () => pending.shift()?.(), loads: () => loads };
  };

  /** Let promises settle and effects run, a few rounds. */
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      TestBed.tick();
    }
  };

  it('waits for the reload to land before resolving', async () => {
    const { res, release, loads } = gated();
    await flush();
    release();
    await flush();
    expect(res.value()).toBe(1);

    let done = false;
    void reloaded(TestBed.inject(Injector), res).then(() => (done = true));
    await flush();
    expect(loads()).toBe(2);
    expect(done).toBe(false);

    release();
    await flush();
    expect(done).toBe(true);
    expect(res.value()).toBe(2);
  });

  it('resolves rather than rejecting when the reload fails', async () => {
    let fail = false;
    const res = TestBed.runInInjectionContext(() =>
      resource({ loader: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve(1)) }),
    );
    await flush();
    fail = true;

    let done = false;
    void reloaded(TestBed.inject(Injector), res).then(() => (done = true));
    await flush();
    expect(done).toBe(true);
    expect(res.status()).toBe('error');
  });
});
