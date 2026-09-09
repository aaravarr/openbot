import fs from "node:fs";
import { deflateSync } from "node:zlib";
import { qrWithQuietZone, qrMatrix } from "./qrcode.ts";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

export function qrPngBytes(text: string, scale = 8): Uint8Array {
  if (!Number.isInteger(scale) || scale < 1 || scale > 32) {
    throw new Error("OpenBot: QR PNG scale must be an integer from 1 to 32");
  }
  const matrix = qrWithQuietZone(qrMatrix(text), 4);
  const modules = matrix.length;
  const size = modules * scale;
  const raw = new Uint8Array(size * (size + 1));
  let offset = 0;
  for (const row of matrix) {
    for (let repeat = 0; repeat < scale; repeat += 1) {
      raw[offset] = 0;
      offset += 1;
      for (const cell of row) {
        for (let x = 0; x < scale; x += 1) {
          raw[offset] = cell ? 0 : 255;
          offset += 1;
        }
      }
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8;
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const compressed = deflateSync(raw);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function writeQrPng(text: string, path: string, scale = 8): void {
  fs.writeFileSync(path, qrPngBytes(text, scale));
}

export function pngChunkCrc(bytes: Uint8Array): number {
  return crc32(bytes);
}
