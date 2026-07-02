export interface TreemapInput<T = any> {
  key: string;
  value: number; // must be > 0
  datum: T;
}

export interface TreemapTile<T = any> {
  x: number;
  y: number;
  w: number;
  h: number;
  item: TreemapInput<T>;
}

/**
 * Squarified Treemap Layout algorithm (Bruls, Huizing, van Wijk 2000).
 * Fits tiles into a rectangle of size [width, height].
 * Items must be sorted in descending order of value, and values must be > 0.
 */
export function squarify<T = any>(items: TreemapInput<T>[], width: number, height: number): TreemapTile<T>[] {
  if (items.length === 0 || width <= 0 || height <= 0) return [];

  // 1. Calculate the sum of all values
  const totalValue = items.reduce((sum, item) => sum + item.value, 0);
  if (totalValue <= 0) return [];

  // 2. Scale values so that total area equals width * height
  const totalArea = width * height;
  const scale = totalArea / totalValue;

  interface ScaledItem extends TreemapInput<T> {
    scaledArea: number;
  }

  const scaledItems: ScaledItem[] = items.map(item => ({
    ...item,
    scaledArea: item.value * scale,
  }));

  // Ensure they are sorted in descending order of scaledArea
  scaledItems.sort((a, b) => b.scaledArea - a.scaledArea);

  const tiles: TreemapTile[] = [];

  // Current remaining rectangle coordinates and dimensions
  let rx = 0;
  let ry = 0;
  let rw = width;
  let rh = height;

  let index = 0;

  while (index < scaledItems.length) {
    const side = Math.min(rw, rh);
    if (side <= 0) break;

    let currentRow: ScaledItem[] = [];
    let currentSum = 0;
    let bestWorstRatio = Infinity;

    // Build the row greedily
    while (index < scaledItems.length) {
      const nextItem = scaledItems[index];
      const nextRow = [...currentRow, nextItem];
      const nextSum = currentSum + nextItem.scaledArea;

      // Calculate worst aspect ratio if we add nextItem
      const thickness = nextSum / side;
      let worstRatio = 0;
      for (const item of nextRow) {
        const area = item.scaledArea;
        // aspect ratio is max(thickness^2 / area, area / thickness^2)
        const ratio = Math.max((thickness * thickness) / area, area / (thickness * thickness));
        if (ratio > worstRatio) {
          worstRatio = ratio;
        }
      }

      // If this is the first item in the row, or the worst ratio improves, accept it
      if (currentRow.length === 0 || worstRatio < bestWorstRatio) {
        currentRow = nextRow;
        currentSum = nextSum;
        bestWorstRatio = worstRatio;
        index++;
      } else {
        // The worst ratio deteriorated, so we finalize the row without this item
        break;
      }
    }

    // Layout the currentRow along the shorter side of the remaining rectangle
    const thickness = currentSum / side;
    const horizontal = rw >= rh; // If width >= height, shorter side is height, row is laid out vertically along x

    let offset = 0;
    for (const item of currentRow) {
      const itemLen = item.scaledArea / thickness;
      if (horizontal) {
        // Lay out vertically: row thickness is along the x-axis, items are stacked vertically along the y-axis
        tiles.push({
          x: rx,
          y: ry + offset,
          w: thickness,
          h: itemLen,
          item: { key: item.key, value: item.value, datum: item.datum },
        });
        offset += itemLen;
      } else {
        // Lay out horizontally: row thickness is along the y-axis, items are placed horizontally along the x-axis
        tiles.push({
          x: rx + offset,
          y: ry,
          w: itemLen,
          h: thickness,
          item: { key: item.key, value: item.value, datum: item.datum },
        });
        offset += itemLen;
      }
    }

    // Subtract the row's area from the remaining rectangle
    if (horizontal) {
      rx += thickness;
      rw -= thickness;
    } else {
      ry += thickness;
      rh -= thickness;
    }
  }

  return tiles;
}
