import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import type { BayOccupancy, BayStatus, LotLevel } from '../domain/lot-layout';
import type { SpotType } from '../domain/models';
import { DEFAULT_LOT_CONFIG, SeedLotRepository, buildLevel } from './seed-lot.repository';

interface BayOccupancyDto {
  readonly spotId: string;
  readonly spotCode: string;
  readonly type: SpotType;
  readonly status: BayStatus;
  readonly occupant: { readonly displayName: string; readonly unit: string } | null;
  readonly validUntil: string | null;
  readonly isMine: boolean;
}

/** Bay codes in the order a person reads them: B1-2 before B1-10. */
const byCode = (a: { spotCode: string }, b: { spotCode: string }) =>
  a.spotCode.localeCompare(b.spotCode, undefined, { numeric: true });

/**
 * The lot plan against the API: `GET /lots` for the levels, and
 * `GET /lots/{level}/occupancy` for every bay on each - its code, type, status, who holds
 * it (administrators only) and whether it is the viewer's own.
 *
 * Only the geometry is still generated, because there are no geometry tables yet: the
 * generator lays out as many places as the level has bays, and each place is then given
 * a real bay, in code order. The plan used to invent its own codes as well (B1-A01...),
 * which matched nothing in an inventory of B1-01, B2-01 - so a bay the draw had just
 * assigned was never drawn as held.
 *
 * It extends the seed so the lot facade's "which bay is mine" hook keeps working; none of
 * the seed's invented occupancy is used.
 */
@Injectable()
export class HttpLotRepository extends SeedLotRepository {
  private readonly http = inject(HttpClient);
  private loaded: Promise<readonly LotLevel[]> | null = null;

  private bays(level: string): Promise<readonly BayOccupancyDto[]> {
    return firstValueFrom(
      this.http.get<{ items: BayOccupancyDto[] }>(
        `${environment.apiBaseUrl}/lots/${encodeURIComponent(level)}/occupancy`,
      ),
    ).then((r) => [...(r.items ?? [])].sort(byCode));
  }

  override levels(): Promise<readonly LotLevel[]> {
    const load = (async () => {
      const res = await firstValueFrom(
        this.http.get<{ items: { levelId: string; bays: number }[] }>(
          `${environment.apiBaseUrl}/lots`,
        ),
      );
      const levels = await Promise.all(
        (res.items ?? []).map(async (l, order): Promise<LotLevel | null> => {
          const real = await this.bays(l.levelId);
          if (real.length === 0) return null;
          const geometry = buildLevel(l.levelId, `Level ${l.levelId}`, order, {
            ...DEFAULT_LOT_CONFIG,
            totalBays: real.length,
          });
          return {
            ...geometry,
            bays: geometry.bays.map((place, i) => ({
              ...place,
              spotCode: real[i]!.spotCode,
              type: real[i]!.type,
            })),
          };
        }),
      );
      return levels.filter((l): l is LotLevel => l !== null);
    })();
    this.loaded = load;
    load.catch(() => (this.loaded = null));
    return load;
  }

  override async occupancy(levelId: string): Promise<readonly BayOccupancy[]> {
    const level = (await (this.loaded ?? this.levels())).find((l) => l.levelId === levelId);
    if (!level) return [];
    const real = new Map((await this.bays(levelId)).map((b) => [b.spotCode, b]));

    this.mine = null;
    const out: BayOccupancy[] = [];
    for (const place of level.bays) {
      const bay = real.get(place.spotCode);
      if (!bay) continue;
      if (bay.isMine) this.mine = place.spotId;
      out.push({
        spotId: place.spotId,
        status: bay.status,
        occupant: bay.occupant,
        validUntil: bay.validUntil ? new Date(bay.validUntil) : null,
      });
    }
    return out;
  }
}
