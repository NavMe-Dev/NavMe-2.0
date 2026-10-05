import { extractWallsFromWalk, type WallSeg } from './floorWallExtract';

type WallWorkerRequest = {
  jobId: number;
  walk: Uint8Array;
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  cell: number;
};

type WallWorkerReply = {
  jobId: number;
  walls: WallSeg[];
};

self.onmessage = (e: MessageEvent<WallWorkerRequest>) => {
  const { jobId, walk, cols, rows, minX, minZ, cell } = e.data;
  const walls = extractWallsFromWalk(walk, cols, rows, minX, minZ, cell);
  const reply: WallWorkerReply = { jobId, walls };
  self.postMessage(reply);
};
