import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import * as THREE from 'three';
import {
  type Bay,
  type LotLevel,
  type NavKey,
  bayLabel,
  renderLabel,
} from '../../domain/lot-layout';

/**
 * The lot in real 3D, on WebGL.
 *
 * This component is lazy-loaded and nothing imports it eagerly: `three` is about 170 kB
 * gzipped, which is the entire initial-route budget, so it may not sit in the first
 * download. Choosing the 3D view pays for it; every other visitor does not.
 *
 * A canvas has no accessibility tree -- no child nodes, no roles, no focusable elements,
 * nothing for a screen reader to find. So the same invisible HTML grid that sits over the
 * SVG map sits over this canvas too, and its cells are positioned by projecting each bay
 * through the camera. That is the mandatory mitigation for any pixel renderer, and it is
 * the reason the keyboard behaviour here is identical to the plan view rather than absent.
 *
 * The camera is fixed and turned in steps by buttons rather than dragged, which keeps
 * SC 2.5.7 satisfied without a separate control path. The scene renders on demand, not on
 * a RAF loop: a car park does not animate, and a spinning idle loop would cost battery for
 * nothing.
 */
@Component({
  selector: 'app-lot-scene',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <div class="scene" #wrap>
      <canvas class="scene__canvas" #canvas aria-hidden="true"></canvas>

      <div
        class="scene__grid"
        role="grid"
        [attr.aria-label]="level().label + ' parking map, 3D view'"
        [attr.aria-rowcount]="rows().length"
        [attr.aria-colcount]="maxCols()"
        (keydown)="onKeydown($event)"
      >
        @for (row of rows(); track row.row; let r = $index) {
          <div role="row" [attr.aria-rowindex]="r + 1">
            @for (bay of row.bays; track bay.placement.spotId; let c = $index) {
              <div
                role="gridcell"
                class="scene__cell"
                [attr.aria-colindex]="c + 1"
                [attr.aria-selected]="bay.placement.spotId === selected() ? 'true' : 'false'"
                [attr.aria-label]="name(bay)"
                [attr.data-spot-id]="bay.placement.spotId"
                [attr.title]="name(bay)"
                [tabindex]="bay.placement.spotId === focused() ? 0 : -1"
                [class.scene__cell--selected]="bay.placement.spotId === selected()"
                [style.left.px]="boxOf(bay).x"
                [style.top.px]="boxOf(bay).y"
                [style.width.px]="boxOf(bay).w"
                [style.height.px]="boxOf(bay).h"
                (click)="activate.emit(bay.placement.spotId)"
                (focus)="focusMove.emit(bay.placement.spotId)"
              ></div>
            }
          </div>
        }
      </div>

      <!-- Turning the camera in steps, so orbiting never requires a drag (SC 2.5.7). -->
      <div class="scene__controls" role="group" aria-label="Camera">
        <button type="button" (click)="turn(-1)" aria-label="Turn camera left">&#8634;</button>
        <button type="button" (click)="tilt(1)" aria-label="Raise camera">&uarr;</button>
        <button type="button" (click)="tilt(-1)" aria-label="Lower camera">&darr;</button>
        <button type="button" (click)="turn(1)" aria-label="Turn camera right">&#8635;</button>
        <button
          type="button"
          [disabled]="dolly() <= 0.45"
          aria-label="Move camera closer"
          (click)="zoom(-1)"
        >
          <mat-icon>zoom_in</mat-icon>
        </button>
        <button
          type="button"
          [disabled]="dolly() >= 1.6"
          aria-label="Move camera back"
          (click)="zoom(1)"
        >
          <mat-icon>zoom_out</mat-icon>
        </button>
        @if (selected()) {
          <button type="button" aria-label="Centre on the selected bay" (click)="centre()">
            <mat-icon>my_location</mat-icon>
          </button>
        }
        <button type="button" aria-label="Reset the camera" (click)="reset()">
          <mat-icon>fit_screen</mat-icon>
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .scene {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 10;
        background: var(--concrete);
        contain: layout paint;
      }

      .scene__canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
      }

      .scene__grid {
        position: absolute;
        inset: 0;
      }

      .scene__grid [role='row'] {
        display: contents;
      }

      .scene__cell {
        position: absolute;
        background: transparent;
        cursor: pointer;
      }

      .scene__cell:focus {
        outline: none;
      }

      .scene__cell:focus-visible::after,
      .scene__cell--selected::after {
        content: '';
        position: absolute;
        inset: -4px;
        border: 3px solid var(--bay-line);
        box-shadow: 0 0 0 3px var(--surface-1);
      }

      .scene__controls {
        position: absolute;
        right: var(--sp-3);
        bottom: var(--sp-3);
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 2px;
        /* Four to a row on a phone, one row on a desk. */
        max-width: calc(44px * 4 + 6px);
      }

      .scene__controls button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font: inherit;
        min-width: 44px;
        min-height: 44px;
        border: 1px solid var(--rule);
        border-radius: 3px;
        background: var(--slab);
        color: var(--steel);
        cursor: pointer;
      }

      .scene__controls button:disabled {
        opacity: 0.4;
        cursor: default;
      }

      @media (hover: hover) and (pointer: fine) {
        .scene__controls button:not(:disabled):hover {
          border-color: var(--steel-faint);
        }
      }

      .scene__controls button:focus-visible {
        outline: 3px solid var(--bay-line);
        outline-offset: 2px;
      }
    `,
  ],
})
export class LotScene implements OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly wrapRef = viewChild.required<ElementRef<HTMLElement>>('wrap');

  readonly level = input.required<LotLevel>();
  readonly bays = input.required<readonly Bay[]>();
  readonly visible = input<ReadonlySet<string> | null>(null);
  readonly selected = input<string | null>(null);
  readonly focused = input<string | null>(null);

  readonly activate = output<string>();
  readonly focusMove = output<string>();
  readonly navigate = output<NavKey>();
  readonly search = output<string>();

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /** Camera angle in steps rather than free orbit: predictable, and keyboard-reachable. */
  private readonly azimuth = signal(Math.PI / 4);
  private readonly elevation = signal(0.9);

  /** Distance, as a multiple of the framing that fits the whole level. */
  readonly dolly = signal(1);

  /** The bay the camera is pointed at, or null for the centre of the level. */
  private readonly framed = signal<string | null>(null);

  /** Screen-space boxes for the overlay, recomputed whenever the camera or size changes. */
  private readonly boxes = signal<ReadonlyMap<string, { x: number; y: number; w: number; h: number }>>(
    new Map(),
  );

  private readonly typeBuffer = signal('');
  private typeTimer: ReturnType<typeof setTimeout> | null = null;

  readonly rows = computed(() => {
    const groups = new Map<number, Bay[]>();
    for (const bay of this.bays()) {
      const list = groups.get(bay.placement.row) ?? [];
      list.push(bay);
      groups.set(bay.placement.row, list);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, bays]) => ({ row, bays: bays.sort((x, y) => x.placement.col - y.placement.col) }));
  });

  readonly maxCols = computed(() => Math.max(1, ...this.rows().map((r) => r.bays.length)));

  constructor() {
    effect(() => {
      // Reading these keeps the scene in step with the data and the camera.
      const bays = this.bays();
      const level = this.level();
      this.azimuth();
      this.elevation();
      this.dolly();
      this.framed();
      this.visible();
      this.selected();
      queueMicrotask(() => this.build(level, bays));
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.dispose();
  }

  /** Frees the GPU buffers of the previous scene. The renderer and its GL context stay. */
  private clearScene(): void {
    this.scene?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.scene = null;
  }

  private dispose(): void {
    this.clearScene();
    this.renderer?.dispose();
    this.renderer = null;
  }

  /** Colours come from the stylesheet, so the 3D view cannot drift from the 2D one. */
  private token(name: string, fallback: string): number {
    const v = getComputedStyle(this.hostEl.nativeElement).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback).getHex();
  }

  private colourFor(bay: Bay): number {
    if (bay.isMine) return this.token('--bay-mine', '#4b46b8');
    switch (bay.status) {
      case 'FREE':
        return this.token('--bay-free', '#317a62');
      case 'OUT_OF_SERVICE':
        return this.token('--bay-closed', '#9e424a');
      case 'HELD':
        return this.token('--bay-held', '#5a5e70');
    }
  }

  private build(level: LotLevel, bays: readonly Bay[]): void {
    const canvas = this.canvasRef().nativeElement;
    const wrap = this.wrapRef().nativeElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;

    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      /*
       * Shadows, because this is the one view whose whole justification is that it is
       * three-dimensional: flat-lit boxes on a flat plane read as a chart of rectangles,
       * which the plan view already is and does better. A soft map at 1024 is enough for
       * a deck of boxes and costs one render, not a loop.
       */
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.resizeObserver = new ResizeObserver(() => this.build(this.level(), this.bays()));
      this.resizeObserver.observe(wrap);
    }
    this.renderer.setSize(w, h, false);

    this.clearScene();
    const scene = new THREE.Scene();
    this.scene = scene;

    // The lot is modelled in metres, with the level's centre at the origin, so the camera
    // maths does not have to carry the centimetre offsets the 2D view uses.
    const W = level.viewBox.w / 100;
    const H = level.viewBox.h / 100;

    /*
     * Standard rather than Lambert: the deck is matte concrete and the bays are painted
     * over it, and a roughness difference is the only thing that says so. There is no
     * environment map and no metal anywhere - this is a car park, not a showroom.
     */
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(W, 0.4, H),
      new THREE.MeshStandardMaterial({
        color: this.token('--concrete', '#15171f'),
        roughness: 0.96,
        metalness: 0,
      }),
    );
    slab.position.set(0, -0.2, 0);
    slab.receiveShadow = true;
    scene.add(slab);

    this.addShell(scene, W, H);
    this.addAisles(scene, W, H);

    const bayHeight = 0.22;
    for (const bay of bays) {
      const g = bay.placement.geometry;
      const dim = this.visible() !== null && !this.visible()!.has(bay.placement.spotId);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(g.w / 100, bayHeight, g.h / 100),
        new THREE.MeshStandardMaterial({
          color: this.colourFor(bay),
          roughness: 0.72,
          metalness: 0,
          transparent: dim,
          opacity: dim ? 0.25 : 1,
        }),
      );
      mesh.position.set(
        (g.x + g.w / 2) / 100 - W / 2,
        bayHeight / 2,
        (g.y + g.h / 2) / 100 - H / 2,
      );
      mesh.rotation.y = (-g.rotation * Math.PI) / 180;
      mesh.userData['spotId'] = bay.placement.spotId;
      // A dimmed bay casts nothing: a shadow from a bay that is filtered out is a lie.
      mesh.castShadow = !dim;
      mesh.receiveShadow = true;
      scene.add(mesh);

      if (bay.placement.spotId === this.selected()) {
        /*
         * The selection is a post standing in the bay rather than a wireframe box around
         * it: a box at this scale is four lines lost among two hundred edges, and a
         * vertical is the one direction nothing else in the scene occupies.
         */
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.07, 0.07, 2.6, 12),
          new THREE.MeshBasicMaterial({ color: this.token('--signal', '#8d87ff') }),
        );
        post.position.set(mesh.position.x, 1.3, mesh.position.z);
        scene.add(post);

        const ring = new THREE.Mesh(
          new THREE.RingGeometry(g.w / 220, g.w / 180, 32),
          new THREE.MeshBasicMaterial({
            color: this.token('--signal', '#8d87ff'),
            side: THREE.DoubleSide,
          }),
        );
        ring.position.set(mesh.position.x, bayHeight + 0.02, mesh.position.z);
        ring.rotation.x = -Math.PI / 2;
        scene.add(ring);
      }
    }

    /*
     * One key light high and to one side so the boxes read as solid, one dim fill from
     * the opposite side so the shadow sides do not go to black, and ambient low enough
     * that the key still has something to do.
     */
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(W * 0.45, Math.max(W, H) * 1.1, H * 0.35);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const span = Math.max(W, H) * 0.75;
    key.shadow.camera.left = -span;
    key.shadow.camera.right = span;
    key.shadow.camera.top = span;
    key.shadow.camera.bottom = -span;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = Math.max(W, H) * 4;
    key.shadow.bias = -0.0012;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-W * 0.5, Math.max(W, H) * 0.5, -H * 0.4);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(42, w / h, 0.5, Math.max(W, H) * 8);
    this.camera = camera;
    /*
     * Framing. The deck plus its perimeter wall has to sit inside a 16:10 canvas at any
     * window width, so the distance is taken from whichever of the two the frame is
     * tighter on - at a narrow window the width is what runs out first, and a radius
     * fixed to the larger dimension alone pushed the far rows off the canvas.
     */
    const fit = Math.max(W / (w / h), H) * 1.5;
    const radius = fit * this.dolly();
    const el = this.elevation();
    const at = this.lookAt(bays, W, H);
    camera.position.set(
      at.x + Math.cos(this.azimuth()) * radius * Math.cos(el),
      radius * Math.sin(el),
      at.z + Math.sin(this.azimuth()) * radius * Math.cos(el),
    );
    camera.lookAt(at.x, 0, at.z);

    this.renderer.render(scene, camera);
    this.measure(bays, camera, w, h, W, H, bayHeight);
  }

  /**
   * A low perimeter wall. Without it the deck is a slab floating in nothing and the eye
   * has no idea where the level ends; with it the bays sit inside a structure, which is
   * the only reason to be rendering this in three dimensions at all.
   */
  private addShell(scene: THREE.Scene, W: number, H: number): void {
    const material = new THREE.MeshStandardMaterial({
      color: this.token('--concrete-deep', '#272b38'),
      roughness: 0.95,
      metalness: 0,
    });
    const t = 0.18;
    const high = 1.1;

    for (const [w, h, x, z] of [
      [W + t * 2, t, 0, -H / 2],
      [W + t * 2, t, 0, H / 2],
      [t, H, -W / 2, 0],
      [t, H, W / 2, 0],
    ] as const) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, high, h), material);
      wall.position.set(x, high / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      scene.add(wall);
    }
  }

  /**
   * The aisle between each pair of facing rows, painted flat on the deck. Same source as
   * the plan view's dashed line - the authored row order - so the two views cannot
   * disagree about where the traffic runs.
   */
  private addAisles(scene: THREE.Scene, W: number, H: number): void {
    const rows = this.rows();
    const material = new THREE.MeshStandardMaterial({
      color: this.token('--rule', '#333849'),
      roughness: 1,
      metalness: 0,
    });

    for (let i = 0; i + 1 < rows.length; i += 2) {
      const a = rows[i]!.bays[0]?.placement.geometry;
      const b = rows[i + 1]!.bays[0]?.placement.geometry;
      if (!a || !b) continue;
      const z = (a.y + a.h + b.y) / 200 - H / 2;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, 0.02, 0.09), material);
      stripe.position.set(0, 0.01, z);
      stripe.receiveShadow = true;
      scene.add(stripe);
    }
  }

  /**
   * Where the camera is pointed. The centre of the level, unless a bay has been framed -
   * at which point it is that bay, because "centre on the selected bay" has to actually
   * move the thing a person is looking for into the middle of the frame.
   */
  private lookAt(bays: readonly Bay[], W: number, H: number): { x: number; z: number } {
    const id = this.framed();
    if (!id) return { x: 0, z: 0 };
    const g = bays.find((b) => b.placement.spotId === id)?.placement.geometry;
    if (!g) return { x: 0, z: 0 };
    return { x: (g.x + g.w / 2) / 100 - W / 2, z: (g.y + g.h / 2) / 100 - H / 2 };
  }

  /**
   * Projects each bay's top face to screen space, which is what gives the invisible grid
   * its coordinates. Without this the canvas would be one opaque element to the keyboard
   * and to a screen reader -- the defect that rules WebGL out as a sole renderer.
   */
  private measure(
    bays: readonly Bay[],
    camera: THREE.PerspectiveCamera,
    w: number,
    h: number,
    W: number,
    H: number,
    bayHeight: number,
  ): void {
    const out = new Map<string, { x: number; y: number; w: number; h: number }>();
    const v = new THREE.Vector3();

    for (const bay of bays) {
      const g = bay.placement.geometry;
      const cx = (g.x + g.w / 2) / 100 - W / 2;
      const cz = (g.y + g.h / 2) / 100 - H / 2;
      const hw = g.w / 200;
      const hh = g.h / 200;
      const rot = (-g.rotation * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const [dx, dz] of [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ]) {
        v.set(cx + dx! * cos - dz! * sin, bayHeight, cz + dx! * sin + dz! * cos);
        v.project(camera);
        const sx = ((v.x + 1) / 2) * w;
        const sy = ((1 - v.y) / 2) * h;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      }

      out.set(bay.placement.spotId, {
        x: minX,
        y: minY,
        // Never smaller than the WCAG 2.2 minimum target, even when the camera is far out.
        w: Math.max(24, maxX - minX),
        h: Math.max(24, maxY - minY),
      });
    }

    this.boxes.set(out);
  }

  boxOf(bay: Bay): { x: number; y: number; w: number; h: number } {
    return this.boxes().get(bay.placement.spotId) ?? { x: -9999, y: -9999, w: 24, h: 24 };
  }

  name(bay: Bay): string {
    const dim = this.visible() !== null && !this.visible()!.has(bay.placement.spotId);
    return renderLabel(bayLabel(bay, dim));
  }

  turn(direction: number): void {
    this.azimuth.update((a) => a + (direction * Math.PI) / 8);
  }

  tilt(direction: number): void {
    this.elevation.update((e) => Math.min(1.45, Math.max(0.25, e + direction * 0.15)));
  }

  /** Dolly in and out in fixed steps, for the same reason the orbit is stepped. */
  zoom(direction: number): void {
    this.dolly.update((d) => Math.min(1.6, Math.max(0.45, d + direction * 0.18)));
  }

  /** Points the camera at the selected bay and closes in on it. */
  centre(): void {
    const id = this.selected();
    if (!id) return;
    this.framed.set(id);
    this.dolly.set(0.5);
  }

  /** Back to the whole level, square on. */
  reset(): void {
    this.framed.set(null);
    this.dolly.set(1);
    this.azimuth.set(Math.PI / 4);
    this.elevation.set(0.9);
  }

  /** Identical to the plan view's handler, because the keyboard contract must not change. */
  onKeydown(event: KeyboardEvent): void {
    const nav: Record<string, NavKey> = {
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft',
      ArrowRight: 'ArrowRight',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
    };

    const key = nav[event.key];
    if (key) {
      event.preventDefault();
      this.navigate.emit(key);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const id = this.focused();
      if (id) this.activate.emit(id);
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next = this.typeBuffer() + event.key;
      this.typeBuffer.set(next);
      this.search.emit(next);
      if (this.typeTimer) clearTimeout(this.typeTimer);
      this.typeTimer = setTimeout(() => this.typeBuffer.set(''), 1000);
    }
  }

  focusCell(spotId: string): void {
    this.hostEl.nativeElement
      .querySelector<HTMLElement>(`[data-spot-id="${spotId}"]`)
      ?.focus();
  }
}
