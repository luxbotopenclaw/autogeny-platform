import { describe, expect, it } from "vitest";
import {
  calculateDeskLayout,
  getDeskDimensions,
  getOfficeFloorDimensions,
} from "./layout-utils";

describe("calculateDeskLayout", () => {
  it("returns empty array for 0 agents", () => {
    expect(calculateDeskLayout(0)).toEqual([]);
  });

  it("returns single position centered at origin for 1 agent", () => {
    const positions = calculateDeskLayout(1);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("places 4 agents in a single row with same z", () => {
    const positions = calculateDeskLayout(4);
    expect(positions).toHaveLength(4);
    const zValues = positions.map((p) => p.z);
    expect(new Set(zValues).size).toBe(1);
  });

  it("y is always 0 (floor level)", () => {
    for (const p of calculateDeskLayout(8)) {
      expect(p.y).toBe(0);
    }
  });

  it("wraps to a second row when count exceeds maxCols", () => {
    const positions = calculateDeskLayout(5, { maxCols: 4 });
    expect(positions).toHaveLength(5);
    const zValues = positions.map((p) => p.z);
    expect(new Set(zValues).size).toBe(2);
  });

  it("centers the grid so midpoint X is ~0", () => {
    const positions = calculateDeskLayout(4);
    const xs = positions.map((p) => p.x);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(midX).toBeCloseTo(0);
  });

  it("respects custom spacing", () => {
    const positions = calculateDeskLayout(2, { spacing: 5 });
    expect(positions).toHaveLength(2);
    const dx = Math.abs(positions[1]!.x - positions[0]!.x);
    expect(dx).toBeCloseTo(5);
  });

  it("handles 20 agents without error", () => {
    const positions = calculateDeskLayout(20);
    expect(positions).toHaveLength(20);
    for (const p of positions) expect(p.y).toBe(0);
  });

  it("uses custom maxCols", () => {
    const positions = calculateDeskLayout(6, { maxCols: 2 });
    expect(positions).toHaveLength(6);
    const zValues = positions.map((p) => p.z);
    expect(new Set(zValues).size).toBe(3);
  });
});

describe("getDeskDimensions", () => {
  it("returns positive dimensions", () => {
    const dims = getDeskDimensions();
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.depth).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });

  it("returns consistent values", () => {
    expect(getDeskDimensions()).toEqual(getDeskDimensions());
  });
});

describe("getOfficeFloorDimensions", () => {
  it("returns default 10x10 for 0 agents", () => {
    const dims = getOfficeFloorDimensions(0);
    expect(dims.width).toBe(10);
    expect(dims.depth).toBe(10);
  });

  it("returns positive dimensions for 1 agent", () => {
    const dims = getOfficeFloorDimensions(1);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.depth).toBeGreaterThan(0);
  });

  it("returns a larger floor for more agents", () => {
    const small = getOfficeFloorDimensions(1);
    const large = getOfficeFloorDimensions(20);
    expect(large.depth).toBeGreaterThanOrEqual(small.depth);
  });

  it("respects custom spacing", () => {
    const tight = getOfficeFloorDimensions(4, { spacing: 2 });
    const spaced = getOfficeFloorDimensions(4, { spacing: 6 });
    expect(spaced.width).toBeGreaterThan(tight.width);
  });
});
