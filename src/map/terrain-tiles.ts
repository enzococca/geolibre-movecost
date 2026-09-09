import type { GeoJsonFeature } from "../types/geolibre";
import { boundsOf } from "./points";

/**
 * Elevation straight from the browser: AWS Terrarium tiles.
 *
 * The same public bucket elevatr reads (`elevation-tiles-prod`), served with
 * CORS, one 256 px PNG per slippy-map tile, height encoded in the pixel as
 * `(R * 256 + G + B / 256) - 32768` metres. Fetching them here is what lets the
 * in-browser backend get terrain at all: webR's R cannot reach the bucket, but
 * the page can, and R only needs the decoded grid.
 *
 * The result is a Float32 grid in Web Mercator (EPSG:3857), cropped to the
 * area's bounding box. The R engine reprojects it to UTM and masks it to the
 * polygon — see `mcx_grid_to_dtm()`.
 */

const TILE_SIZE = 256;
const EARTH_RADIUS = 6378137;
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS;
const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** Above this the mosaic gets large enough to stall both the fetch and R. */
const MAX_TILES = 64;
const CONCURRENCY = 6;

export interface ElevationGrid {
  width: number;
  height: number;
  /** Row-major from the top-left, NaN where a tile was missing. */
  data: Float32Array;
  /** Web Mercator metres. */
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  crs: "EPSG:3857";
  zoom: number;
  tiles: number;
}

export type TileProgress = (done: number, total: number) => void;

function lonToPixelX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function latToPixelY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const r = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

/** Metres per pixel at this zoom, on the Mercator plane (not the ground). */
export function mercatorResolution(zoom: number): number {
  return (2 * ORIGIN_SHIFT) / (TILE_SIZE * 2 ** zoom);
}

function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

async function fetchTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const url = TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const response = await fetch(url, { mode: "cors", cache: "force-cache" });
  if (!response.ok) return null; // no tile: treat as NoData rather than fail the mosaic
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Downloads and decodes the tiles covering `features` at `zoom`.
 *
 * Throws with a plain message when the area would need more than MAX_TILES —
 * that is a "pick a coarser level or a smaller area" situation, not something
 * to silently downsample.
 */
export async function fetchTerrariumGrid(
  features: GeoJsonFeature[],
  zoom: number,
  onProgress?: TileProgress,
): Promise<ElevationGrid> {
  const bbox = boundsOf(features);
  if (!bbox) throw new Error("The area has no coordinates.");
  const [west, south, east, north] = bbox;
  if (!(east > west && north > south)) throw new Error("The area is degenerate.");

  const px0 = Math.floor(lonToPixelX(west, zoom));
  const px1 = Math.ceil(lonToPixelX(east, zoom));
  const py0 = Math.floor(latToPixelY(north, zoom));
  const py1 = Math.ceil(latToPixelY(south, zoom));

  const tx0 = Math.floor(px0 / TILE_SIZE);
  const tx1 = Math.floor((px1 - 1) / TILE_SIZE);
  const ty0 = Math.floor(py0 / TILE_SIZE);
  const ty1 = Math.floor((py1 - 1) / TILE_SIZE);
  const tilesX = tx1 - tx0 + 1;
  const tilesY = ty1 - ty0 + 1;
  const total = tilesX * tilesY;
  if (total > MAX_TILES) {
    throw new Error(
      `That area needs ${total} tiles at this detail level (the limit is ${MAX_TILES}). ` +
        `Choose a coarser level or a smaller area.`,
    );
  }

  const width = px1 - px0;
  const height = py1 - py0;
  const data = new Float32Array(width * height).fill(NaN);

  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser refused a 2D canvas context.");

  const jobs: Array<{ tx: number; ty: number }> = [];
  for (let ty = ty0; ty <= ty1; ty += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) jobs.push({ tx, ty });
  }

  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      const bitmap = await fetchTile(zoom, job.tx, job.ty);
      if (bitmap) {
        ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
        const originX = job.tx * TILE_SIZE - px0;
        const originY = job.ty * TILE_SIZE - py0;
        for (let row = 0; row < TILE_SIZE; row += 1) {
          const gy = originY + row;
          if (gy < 0 || gy >= height) continue;
          for (let col = 0; col < TILE_SIZE; col += 1) {
            const gx = originX + col;
            if (gx < 0 || gx >= width) continue;
            const o = (row * TILE_SIZE + col) * 4;
            data[gy * width + gx] = decodeTerrarium(pixels[o], pixels[o + 1], pixels[o + 2]);
          }
        }
      }
      done += 1;
      onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  const res = mercatorResolution(zoom);
  return {
    width,
    height,
    data,
    xmin: -ORIGIN_SHIFT + px0 * res,
    xmax: -ORIGIN_SHIFT + px1 * res,
    ymax: ORIGIN_SHIFT - py0 * res,
    ymin: ORIGIN_SHIFT - py1 * res,
    crs: "EPSG:3857",
    zoom,
    tiles: total,
  };
}

/** The grid's raw bytes, as the R engine reads them with `readBin(size = 4)`. */
export function gridBytes(grid: ElevationGrid): Uint8Array {
  // Float32Array is native-endian; every platform this runs on is little-endian,
  // and the engine reads little-endian explicitly, so this is a plain view.
  return new Uint8Array(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength);
}
