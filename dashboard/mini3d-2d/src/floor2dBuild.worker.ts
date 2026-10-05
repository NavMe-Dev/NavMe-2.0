import { finalizeFloor2DFromWalkLite } from './floor2dFinalize';
import { rasterizeFloorTriangles } from './floor2dRaster';

export type FloorRasterizeRequest = {
  type: 'rasterize';
  id: number;
  positions: Float32Array;
  triCount: number;
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  cellSize: number;
};

export type FloorRasterizeResponse = {
  type: 'rasterize';
  id: number;
  walk: Uint8Array;
};

export type FloorFinalizeRequest = {
  type: 'finalize';
  id: number;
  sliceY: number;
  cellSize: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cols: number;
  rows: number;
  walk: Uint8Array;
};

export type FloorFinalizeResponse = {
  type: 'finalize';
  id: number;
  map: ReturnType<typeof finalizeFloor2DFromWalkLite>;
};

export type FloorWorkerRequest = FloorRasterizeRequest | FloorFinalizeRequest;
export type FloorWorkerResponse = FloorRasterizeResponse | FloorFinalizeResponse;

self.onmessage = (ev: MessageEvent<FloorWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'rasterize') {
    const walk = new Uint8Array(msg.cols * msg.rows);
    rasterizeFloorTriangles(
      msg.positions,
      msg.triCount,
      walk,
      msg.cols,
      msg.rows,
      msg.minX,
      msg.minZ,
      msg.cellSize,
      1,
    );
    const out: FloorRasterizeResponse = { type: 'rasterize', id: msg.id, walk };
    self.postMessage(out);
    return;
  }

  if (msg.type === 'finalize') {
    const map = finalizeFloor2DFromWalkLite({
      sliceY: msg.sliceY,
      cellSize: msg.cellSize,
      minX: msg.minX,
      maxX: msg.maxX,
      minZ: msg.minZ,
      maxZ: msg.maxZ,
      cols: msg.cols,
      rows: msg.rows,
      walk: msg.walk,
    });
    const out: FloorFinalizeResponse = { type: 'finalize', id: msg.id, map };
    self.postMessage(out);
  }
};
