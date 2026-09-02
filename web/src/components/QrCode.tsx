import { useMemo } from "react";
import { qrMatrix, qrWithQuietZone } from "../../../src/qrcode.ts";

const MODULE_DARK = "#000000";
const MODULE_LIGHT = "#ffffff";

function modulesToPath(grid: boolean[][]): string {
  const parts: string[] = [];
  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c += 1) {
      if (row[c]) {
        parts.push(`M${c} ${r}h1v1h-1z`);
      }
    }
  }
  return parts.join("");
}

export function QrCode({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const packed = useMemo(() => {
    try {
      return qrWithQuietZone(qrMatrix(value), 4);
    } catch {
      return null;
    }
  }, [value]);

  if (!packed) {
    return null;
  }

  const size = packed.length;
  const d = modulesToPath(packed);
  const caption = label ?? `QR code for ${value}`;

  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={caption}
      viewBox={`0 0 ${size} ${size}`}
      width={200}
      height={200}
      shapeRendering="crispEdges"
    >
      <title>{caption}</title>
      <rect width={size} height={size} fill={MODULE_LIGHT} />
      <path d={d} fill={MODULE_DARK} />
    </svg>
  );
}
