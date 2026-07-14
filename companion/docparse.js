// Extract plain text from binary document formats so they can be indexed for memory.
// - .docx: zero-dep. A .docx is a ZIP; we read word/document.xml from the central directory,
//   inflate it (raw deflate via node:zlib), and strip the WordprocessingML tags.
// - .pdf:  uses pdfjs-dist (the standard, reliable extractor) page-by-page text content. A naive
//   hand-rolled PDF parser garbles subset/CID-font PDFs, so we lean on pdf.js here.
// Everything runs locally; nothing leaves the machine.
import zlib from "node:zlib";

// Bounds against malicious documents (a hostile PDF/docx the user was sent, then indexed):
const MAX_INFLATE = 64 * 1024 * 1024;   // cap a docx's inflated word/document.xml (decompression bomb)
const MAX_DOC_CHARS = 2 * 1024 * 1024;  // cap extracted text per file so one doc can't explode the chunk/embed count
const MAX_PDF_PAGES = 5000;             // cap the pdf.js page loop

// ---- ZIP: read one entry's bytes via the central directory (handles data descriptors, unlike
// scanning local headers, because the central dir always carries the real compressed size). ----
function readZipEntry(buf, wantName) {
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
  // find the End Of Central Directory record (scan backwards; it's near the end, after any comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let off = buf.readUInt32LE(eocd + 16);          // start of the central directory
  const total = buf.readUInt16LE(eocd + 10);      // number of central-dir entries
  for (let n = 0; n < total && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === wantName) {
      if (localOff + 30 > buf.length) return null;            // crafted offset past EOF -> bail (no over-read)
      // jump to the local header to find where the data actually starts (its name/extra lengths)
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;                          // stored
      // cap the inflated size: a malicious docx can deflate a few MB into GBs (decompression bomb).
      if (method === 8) { try { return zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATE }); } catch { return null; } }
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const decodeXmlEntities = (s) => s
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ""; } })
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseDocx(buf) {
  const xmlBuf = readZipEntry(buf, "word/document.xml");
  if (!xmlBuf) return "";
  const xml = xmlBuf.toString("utf8");
  const text = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")          // paragraph end -> newline
    .replace(/<[^>]+>/g, "");           // drop every remaining tag
  return decodeXmlEntities(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_DOC_CHARS);
}

// pdfjs is loaded lazily (it's a heavy import) and only when a .pdf is actually indexed.
let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return _pdfjs;
}
export async function parsePdf(buf) {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const doc = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const out = [];
  let chars = 0;
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const t = content.items.map((it) => it.str).join(" ");
    out.push(t); chars += t.length; page.cleanup();
    if (chars > MAX_DOC_CHARS) break; // stop once we have plenty (bounds huge/hostile PDFs)
  }
  try { await doc.destroy(); } catch { /* */ }
  // pdf.js joins glyph runs with spaces, leaving multi-space gaps; collapse them for clean embedding.
  return out.join("\n\n").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_DOC_CHARS);
}
