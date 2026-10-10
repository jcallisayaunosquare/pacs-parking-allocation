import { Injectable, computed, inject, resource, signal } from '@angular/core';
import {
  CycleRepository,
  ResidentRepository,
  RunRepository,
  SpotRepository,
} from '../domain/repositories';
import { peek, viewState } from './async-state';

/** The four things an administrator is ever asked to produce a list of. */
export type ReportKind = 'residents' | 'bays' | 'periods' | 'draws';

/**
 * The reports.
 *
 * Four read-only views over data the product already holds, assembled here rather than
 * on a new set of endpoints: a report of the register *is* the register, and inventing a
 * parallel `/reports/residents` would be a second definition of the same list, free to
 * drift from the one the administrator works in every day. The one genuinely new read is
 * the draws, because a committed run had no list endpoint at all.
 *
 * Only the chosen report loads. An administrator opening this screen to export the bays
 * should not pay for the register, the periods and every draw the building has ever run.
 */
@Injectable()
export class ReportsFacade {
  private readonly residentsRepo = inject(ResidentRepository);
  private readonly spotsRepo = inject(SpotRepository);
  private readonly cyclesRepo = inject(CycleRepository);
  private readonly runsRepo = inject(RunRepository);

  readonly kind = signal<ReportKind>('residents');

  private readonly residentsRes = resource({
    params: () => ({ on: this.kind() === 'residents' }),
    loader: ({ params }) =>
      params.on ? this.residentsRepo.list({ limit: 100 }) : Promise.resolve(null),
  });

  private readonly spotsRes = resource({
    params: () => ({ on: this.kind() === 'bays' }),
    loader: ({ params }) => (params.on ? this.spotsRepo.list() : Promise.resolve(null)),
  });

  private readonly cyclesRes = resource({
    params: () => ({ on: this.kind() === 'periods' }),
    loader: ({ params }) => (params.on ? this.cyclesRepo.list() : Promise.resolve(null)),
  });

  private readonly runsRes = resource({
    params: () => ({ on: this.kind() === 'draws' }),
    loader: ({ params }) => (params.on ? this.runsRepo.list(100) : Promise.resolve(null)),
  });

  readonly residents = computed(() => peek(this.residentsRes)?.items ?? []);
  readonly bays = computed(() => peek(this.spotsRes) ?? []);
  readonly periods = computed(() => peek(this.cyclesRes) ?? []);
  readonly draws = computed(() => peek(this.runsRes) ?? []);

  /** The state of whichever report is on screen, so one host handles all four. */
  readonly state = computed(() => {
    switch (this.kind()) {
      case 'residents':
        return this.residentsState();
      case 'bays':
        return this.baysState();
      case 'periods':
        return this.periodsState();
      case 'draws':
        return this.drawsState();
    }
  });

  private readonly residentsState = viewState(this.residentsRes, (v) => v !== null && v.items.length === 0);
  private readonly baysState = viewState(this.spotsRes, (v) => v !== null && v.length === 0);
  private readonly periodsState = viewState(this.cyclesRes, (v) => v !== null && v.length === 0);
  private readonly drawsState = viewState(this.runsRes, (v) => v !== null && v.length === 0);

  readonly rowCount = computed(() => {
    switch (this.kind()) {
      case 'residents':
        return this.residents().length;
      case 'bays':
        return this.bays().length;
      case 'periods':
        return this.periods().length;
      case 'draws':
        return this.draws().length;
    }
  });

  refresh(): void {
    switch (this.kind()) {
      case 'residents':
        this.residentsRes.reload();
        break;
      case 'bays':
        this.spotsRes.reload();
        break;
      case 'periods':
        this.cyclesRes.reload();
        break;
      case 'draws':
        this.runsRes.reload();
        break;
    }
  }
}
