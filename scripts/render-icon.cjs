const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\EdgeCore\\150.0.4078.83\\msedge.exe";
const cropSvgPath = path.join(root, "src", "assets", "icons", "crop.svg");
const sizes = [16, 24, 32, 48, 64, 128, 256];

function fileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

function renderMattedPng(size, matte) {
  const matteName = matte === "#fff" ? "white" : "black";
  const htmlPath = path.join(os.tmpdir(), `clip-trimmer-icon-${size}-${matteName}.html`);
  const outPath = path.join(os.tmpdir(), `clip-trimmer-icon-${size}-${matteName}.png`);
  const html = `<!doctype html>
<html>
  <head>
    <style>
      html,
      body {
        width: ${size}px;
        height: ${size}px;
        margin: 0;
        overflow: hidden;
        background: ${matte};
      }

      body {
        display: grid;
        place-items: center;
      }

      .icon {
        width: ${size}px;
        height: ${size}px;
        display: grid;
        place-items: center;
        overflow: hidden;
        border-radius: ${Math.round((size * 56) / 256)}px;
        background: linear-gradient(180deg, #17466f 0%, #0f2438 50%, #0b0e12 100%);
      }

      img {
        display: block;
        width: ${(size * 196) / 256}px;
        height: ${(size * 196) / 256}px;
        opacity: 0.96;
        filter: brightness(0) invert(1);
      }
    </style>
  </head>
  <body><div class="icon"><img src="${fileUrl(cropSvgPath)}" /></div></body>
</html>`;

  fs.writeFileSync(htmlPath, html);
  fs.rmSync(outPath, { force: true });
  execFileSync(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${size},${size}`,
    `--screenshot=${outPath}`,
    fileUrl(htmlPath),
  ]);
  fs.rmSync(htmlPath, { force: true });
  return outPath;
}

function readPng(filePath) {
  const buffer = fs.readFileSync(filePath);

  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${filePath} is not a PNG file.`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ data, type });

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    }

    offset += 12 + length;
  }

  return { buffer, chunks, colorType, height, width };
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDelta = Math.abs(estimate - left);
  const aboveDelta = Math.abs(estimate - above);
  const upperLeftDelta = Math.abs(estimate - upperLeft);

  if (leftDelta <= aboveDelta && leftDelta <= upperLeftDelta) {
    return left;
  }

  return aboveDelta <= upperLeftDelta ? above : upperLeft;
}

function unfilterScanlines(png) {
  const zlib = require("node:zlib");
  const idat = Buffer.concat(png.chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const inflated = zlib.inflateSync(idat);
  const channels = png.colorType === 6 ? 4 : png.colorType === 2 ? 3 : 0;

  if (!channels) {
    throw new Error(`Unsupported PNG color type ${png.colorType}.`);
  }

  const bytesPerPixel = channels;
  const stride = png.width * bytesPerPixel;
  const unfiltered = Buffer.alloc(png.height * stride);
  let inputOffset = 0;

  for (let y = 0; y < png.height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = rowOffset - stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= bytesPerPixel ? unfiltered[rowOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? unfiltered[previousRowOffset + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? unfiltered[previousRowOffset + x - bytesPerPixel] : 0;
      let value = raw;

      if (filter === 1) {
        value += left;
      } else if (filter === 2) {
        value += above;
      } else if (filter === 3) {
        value += Math.floor((left + above) / 2);
      } else if (filter === 4) {
        value += paethPredictor(left, above, upperLeft);
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter type ${filter}.`);
      }

      unfiltered[rowOffset + x] = value & 0xff;
    }

    inputOffset += stride;
  }

  if (channels === 4) {
    return unfiltered;
  }

  const rgba = Buffer.alloc(png.width * png.height * 4);

  for (let source = 0, target = 0; source < unfiltered.length; source += 3, target += 4) {
    rgba[target] = unfiltered[source];
    rgba[target + 1] = unfiltered[source + 1];
    rgba[target + 2] = unfiltered[source + 2];
    rgba[target + 3] = 255;
  }

  return rgba;
}

function writePng(filePath, width, height, pixels) {
  const zlib = require("node:zlib");
  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * stride;
    const targetStart = y * (stride + 1);
    scanlines[targetStart] = 0;
    pixels.copy(scanlines, targetStart + 1, sourceStart, sourceStart + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  fs.writeFileSync(
    filePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function dematte(whitePath, blackPath) {
  const whitePng = readPng(whitePath);
  const blackPng = readPng(blackPath);

  if (whitePng.width !== blackPng.width || whitePng.height !== blackPng.height) {
    throw new Error("Rendered matte PNG sizes do not match.");
  }

  const white = unfilterScanlines(whitePng);
  const black = unfilterScanlines(blackPng);
  const output = Buffer.alloc(black.length);

  for (let index = 0; index < black.length; index += 4) {
    const alphaFromRed = 255 - (white[index] - black[index]);
    const alphaFromGreen = 255 - (white[index + 1] - black[index + 1]);
    const alphaFromBlue = 255 - (white[index + 2] - black[index + 2]);
    const alpha = Math.max(0, Math.min(255, Math.round((alphaFromRed + alphaFromGreen + alphaFromBlue) / 3)));

    output[index + 3] = alpha;

    if (alpha === 0) {
      output[index] = 0;
      output[index + 1] = 0;
      output[index + 2] = 0;
      continue;
    }

    output[index] = Math.max(0, Math.min(255, Math.round((black[index] * 255) / alpha)));
    output[index + 1] = Math.max(0, Math.min(255, Math.round((black[index + 1] * 255) / alpha)));
    output[index + 2] = Math.max(0, Math.min(255, Math.round((black[index + 2] * 255) / alpha)));
  }

  return {
    height: blackPng.height,
    pixels: output,
    width: blackPng.width,
  };
}

function writeIco(entries) {
  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  entries.forEach((entry, index) => {
    const directoryOffset = 6 + index * 16;
    header[directoryOffset] = entry.size === 256 ? 0 : entry.size;
    header[directoryOffset + 1] = entry.size === 256 ? 0 : entry.size;
    header[directoryOffset + 2] = 0;
    header[directoryOffset + 3] = 0;
    header.writeUInt16LE(1, directoryOffset + 4);
    header.writeUInt16LE(32, directoryOffset + 6);
    header.writeUInt32LE(entry.bytes.length, directoryOffset + 8);
    header.writeUInt32LE(offset, directoryOffset + 12);
    offset += entry.bytes.length;
  });

  fs.writeFileSync(path.join(buildDir, "icon.ico"), Buffer.concat([header, ...entries.map((entry) => entry.bytes)]));
}

if (!fs.existsSync(edgePath)) {
  throw new Error(`Microsoft Edge was not found at ${edgePath}`);
}

const icoEntries = [];

for (const size of sizes) {
  const whitePath = renderMattedPng(size, "#fff");
  const blackPath = renderMattedPng(size, "#000");
  const png = dematte(whitePath, blackPath);
  const outPath = path.join(buildDir, size === 256 ? "icon.png" : `icon-${size}.png`);

  writePng(outPath, png.width, png.height, png.pixels);
  const bytes = fs.readFileSync(outPath);
  icoEntries.push({ bytes, size });
  fs.rmSync(whitePath, { force: true });
  fs.rmSync(blackPath, { force: true });

  if (size !== 256) {
    fs.rmSync(outPath, { force: true });
  }
}

writeIco(icoEntries);

console.log("Rendered build/icon.png and build/icon.ico from src/assets/icons/crop.svg.");
