import { describe, it, expect } from 'vitest';
import { squarify } from './treemap';
import type { SectorPerformance } from './api';

describe('Squarified Treemap Algorithm', () => {
  const createMockDatum = (name: string, change_pct: number): SectorPerformance => ({
    name,
    change_pct,
    turnover: 100000000,
    source: 'TWSE',
  });

  it('should return empty tiles if input is empty', () => {
    expect(squarify([], 100, 100)).toEqual([]);
  });

  it('should layout single item to cover the entire container', () => {
    const input = [
      { key: 'A', value: 10, datum: createMockDatum('A', 10) }
    ];
    const tiles = squarify(input, 100, 100);
    expect(tiles.length).toBe(1);
    expect(tiles[0].x).toBe(0);
    expect(tiles[0].y).toBe(0);
    expect(tiles[0].w).toBe(100);
    expect(tiles[0].h).toBe(100);
    expect(tiles[0].item.key).toBe('A');
  });

  it('should partition a 100x100 space proportionally for two items of values 6 and 4', () => {
    const input = [
      { key: 'A', value: 6, datum: createMockDatum('A', 6) },
      { key: 'B', value: 4, datum: createMockDatum('B', 4) },
    ];
    const tiles = squarify(input, 100, 100);
    expect(tiles.length).toBe(2);

    // Sum of areas should equal 10000.
    // Total value = 10. Scale = 10000 / 10 = 1000.
    // A area = 6000. B area = 4000.
    // Width = 100, Height = 100.
    // Since 100 >= 100 (horizontal), shorter side is 100.
    // First, try row [A]. thickness = 6000 / 100 = 60. worst ratio = max(60^2/6000, 6000/60^2) = max(0.6, 1.666) = 1.666.
    // Try row [A, B]. nextSum = 10000. thickness = 10000/100 = 100.
    // worst ratio for [A, B] = max(aspect(A), aspect(B))
    // aspect(A) = max(100^2 / 6000, 6000 / 100^2) = max(1.666, 0.6) = 1.666.
    // aspect(B) = max(100^2 / 4000, 4000 / 100^2) = max(2.5, 0.4) = 2.5.
    // worst ratio = 2.5.
    // Since 2.5 > 1.666, it got worse. So row [A] is finalized, then [B] is laid out in the remaining space.
    // A: x=0, y=0, w=60, h=100.
    // Remaining: rx=60, ry=0, rw=40, rh=100.
    // B: x=60, y=0, w=40, h=100.
    
    // Sort tiles to make comparison stable
    const tileA = tiles.find(t => t.item.key === 'A')!;
    const tileB = tiles.find(t => t.item.key === 'B')!;

    expect(tileA.w).toBeCloseTo(60);
    expect(tileA.h).toBe(100);
    expect(tileA.x).toBe(0);
    expect(tileA.y).toBe(0);

    expect(tileB.w).toBeCloseTo(40);
    expect(tileB.h).toBe(100);
    expect(tileB.x).toBeCloseTo(60);
    expect(tileB.y).toBe(0);
  });
});
