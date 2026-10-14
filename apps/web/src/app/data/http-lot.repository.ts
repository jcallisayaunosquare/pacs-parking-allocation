import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import type { BayOccupancy, BayStatus, LotLevel } from '../domain/lot-layout';
import type { SpotType } from '../domain/models';
import { SeedLotRepository } from './seed-lot.repository';

interface BayOccupancyDto {
  readonly spotId: string;
  readonly spotCode: string;
  readonly type: SpotType;
  readonly status: BayStatus;
  readonly occupant: { readonly displayName: string; readonly unit: string } | null;
  readonly validUntil: string | null;
  readonly isMine: boolean;
}

/**
 * The lot plan against `GET /lots/{levelId}/occupancy`: real status, real types, and the
 * viewer's own bay as the server says it is.
 *
 * The geometry is still generated - there are no geometry tables yet - so this extends
 * the seed and keeps its placement. What changes is everything that was invented on top
 * of it: which bays are held, which are out of service, what type each is, and which
 * one is yours. The seed marked the same bay as every resident's own whether or not
 * they held anything; this marks one only when the server returns `isMine`.
 *
 * Bays are matched by code, which is the identifier the building and the generator
 * share. A generated placement with no bay of that code in the inventory reads as out
 * of service, because there is no bay there to park in.
 */
@Injectable()
export class HttpLotRepository extends SeedLotRepository {
  private readonly http = inject(HttpClient);
  private readonly cache = new Map<string, Promise<readonly BayOccupancyDto[]>>();

  private fetch(levelId: string, fresh: boolean): Promise<readonly BayOccupancyDto[]> {
    const hit = this.cache.get(levelId);
    if (hit && !fresh) return hit;
    const req = firstValueFrom(
      this.http.get<{ items: BayOccupancyDto[] }>(
        `${environment.apiBaseUrl}/lots/${encodeURIComponent(levelId)}/occupancy`,
      ),
    ).then((r) => r.items ?? []);
    this.cache.set(levelId, req);
    req.catch(() => this.cache.delete(levelId));
    return req;
  }

  override async levels(): Promise<readonly LotLevel[]> {
    const generated = await super.levels();
    return Promise.all(
      generated.map(async (level) => {
        const byCode = new Map((await this.fetch(level.levelId, false)).map((b) => [b.spotCode, b]));
        return {
          ...level,
          bays: level.bays.map((p) => {
            const real = byCode.get(p.spotCode);
            return real ? { ...p, type: real.type } : p;
          }),
        };
      }),
    );
  }

  override async occupancy(levelId: string): Promise<readonly BayOccupancy[]> {
    const level = (await super.levels()).find((l) => l.levelId === levelId);
    if (!level) return [];
    const byCode = new Map((await this.fetch(levelId, true)).map((b) => [b.spotCode, b]));

    this.mine = null;
    const out: BayOccupancy[] = [];
    for (const p of level.bays) {
      const real = byCode.get(p.spotCode);
      if (!real) continue;
      if (real.isMine) this.mine = p.spotId;
      out.push({
        spotId: p.spotId,
        status: real.status,
        occupant: real.occupant,
        validUntil: real.validUntil ? new Date(real.validUntil) : null,
      });
    }
    return out;
  }
}
