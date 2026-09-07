import { useMemo, useState } from "react";
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
      return { grid: qrWithQuietZone(qrMatrix(value), 4), error: undefined as string | undefined };
    } catch (err) {
      return { grid: null as boolean[][] | null, error: err instanceof Error ? err.message : "QR encode failed" };
    }
  }, [value]);

  const [copied, setCopied] = useState(false);

  if (!packed.grid) {
    return (
      <div className="qr-code-fallback" role="img" aria-label={`QR code unavailable for ${value}`}>
        <p>QR code unavailable ({packed.error ?? "unknown error"}).</p>
        <p>
          Open this link instead: <code>{value}</code>
        </p>
        <button
          type="button"
          onClick={() => {
            setCopied(true);
            navigator.clipboard?.writeText(value).catch(() => {
              setCopied(false);
            });
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    );
  }

  const size = packed.grid.length;
  const d = modulesToPath(packed.grid);
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
