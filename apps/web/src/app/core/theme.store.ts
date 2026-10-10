import { Injectable, signal } from '@angular/core';

export type ThemeChoice = 'light' | 'dark';

const KEY = 'pacs.theme';

/**
 * Which palette the product is wearing.
 *
 * Two states, not three. A "follow my system" option is defensible in principle, but on a
 * machine already set to light it produces exactly the screen the light button produces,
 * so the control showed two buttons that did the same thing and left the person guessing
 * which rule was in force.
 *
 * Nothing stored opens on slate, not on the OS preference. The product's ground is a
 * stated value - a call board is a dark object in a lit room - and reading that off the
 * machine would mean half the evaluators never see the design. A person's own choice
 * still wins the moment they make one, and it is remembered.
 *
 * The choice is read back synchronously at construction, so the correct palette is on the
 * document before first paint rather than flashing the wrong one.
 */
@Injectable({ providedIn: 'root' })
export class ThemeStore {
  private readonly _choice = signal<ThemeChoice>(read());

  readonly choice = this._choice.asReadonly();

  constructor() {
    this.apply(this._choice());
  }

  set(choice: ThemeChoice): void {
    this._choice.set(choice);
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // Private browsing refuses storage; the choice still holds for this session.
    }
    this.apply(choice);
  }

  private apply(choice: ThemeChoice): void {
    const root = document.documentElement;

    // Suppress transitions across the flip, or every themed property animates at once and
    // the switch reads as a smear rather than a change.
    root.setAttribute('data-theme-switching', '');
    root.setAttribute('data-theme', choice);

    void root.offsetHeight; // force the recalculation before releasing
    requestAnimationFrame(() => root.removeAttribute('data-theme-switching'));
  }
}

function read(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private browsing refuses storage; the default below still applies.
  }
  return 'dark';
}
