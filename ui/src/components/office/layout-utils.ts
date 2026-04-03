export interface DeskPosition {
  x: number;
  y: number; // Always 0 for floor level
  z: number;
}

export interface DeskLayoutOptions {
  spacing?: number;
  maxCols?: number;
}

const DESK_WIDTH = 1.8;
const DESK_DEPTH = 1.2;
const DESK_HEIGHT = 0.8;
const DEFAULT_SPACING = 3;
const DEFAULT_MAX_COLS = 4;

export function getDeskDimensions(): { width: number; depth: number; height: number } {
  return { width: DESK_WIDTH, depth: DESK_DEPTH, height: DESK_HEIGHT };
}

export function calculateDeskLayout(
  agentCount: number,
  options?: DeskLayoutOptions,
): DeskPosition[] {
  if (agentCount === 0) return [];

  const spacing = options?.spacing ?? DEFAULT_SPACING;
  const maxCols = options?.maxCols ?? DEFAULT_MAX_COLS;
  const cols = Math.min(agentCount, maxCols);
  const rows = Math.ceil(agentCount / cols);

  const totalWidth = (cols - 1) * spacing;
  const totalDepth = (rows - 1) * spacing;

  const startX = -totalWidth / 2;
  const startZ = -totalDepth / 2;

  const positions: DeskPosition[] = [];
  for (let i = 0; i < agentCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push({
      x: startX + col * spacing,
      y: 0,
      z: startZ + row * spacing,
    });
  }
  return positions;
}

export function getOfficeFloorDimensions(
  deskCount: number,
  options?: DeskLayoutOptions,
): { width: number; depth: number } {
  if (deskCount === 0) return { width: 10, depth: 10 };

  const spacing = options?.spacing ?? DEFAULT_SPACING;
  const maxCols = options?.maxCols ?? DEFAULT_MAX_COLS;
  const cols = Math.min(deskCount, maxCols);
  const rows = Math.ceil(deskCount / cols);

  return {
    width: cols * spacing + 4,
    depth: rows * spacing + 4,
  };
}
