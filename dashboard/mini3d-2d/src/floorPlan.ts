/** Floor plan JSON from Python structure analyzer (Mappedin-style). */

export type FloorPlanBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type FloorPlanWall = { x1: number; z1: number; x2: number; z2: number };

export type FloorPlanRoom = {
  id: string;
  polygon: [number, number][];
  label: string;
};

export type FloorPlanObstacle = { x: number; z: number; w: number; d: number };

export type AnalyzedFloorPlan = {
  version: number;
  sliceY: number;
  cellSize: number;
  bounds: FloorPlanBounds;
  floors: [number, number][][];
  corridors: [number, number][][];
  rooms: FloorPlanRoom[];
  walls: FloorPlanWall[];
  obstacles: FloorPlanObstacle[];
};

export const MAPPEDIN_STYLE = {
  background: '#F5F5F0',
  floor: '#EBEBEB',
  corridor: '#EBEBEB',
  room: '#F7F5F2',
  wallFace: '#A0A0A0',
  wallTop: '#B0B0B0',
  wallEdge: '#4A4A4A',
  obstacle: '#F7F5F2',
  obstacleEdge: '#A0A0A0',
  route: '#3B6FD9',
  routeOutline: '#ffffff',
  poiLabel: '#4A3F55',
  origin: '#4CAF50',
  destination: '#7B2D8E',
  wallHeightPx: 7,
} as const;
