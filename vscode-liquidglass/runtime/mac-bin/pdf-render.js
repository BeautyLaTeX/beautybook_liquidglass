/* Minimal PDFKit bridge for the argument forms used by Studio and lgbuild.py. */
ObjC.import('AppKit');
ObjC.import('PDFKit');

function run(args) {
  const isInfo = args[0] === 'info';
  const file = args[isInfo ? 1 : args.length - 2];
  const url = $.NSURL.fileURLWithPath(file);
  const doc = $.PDFDocument.alloc.initWithURL(url);
  const count = Number(doc.pageCount);
  if (!count) throw new Error('Cannot open PDF: ' + file);
  if (isInfo) return 'Pages: ' + count;
  const arg = (flag,fallback) => args.includes(flag) ? Number(args[args.indexOf(flag)+1]) : fallback;
  const requested = arg('-f',1);
  if (!Number.isInteger(requested) || requested < 1 || requested > count) throw new Error('Page out of range');
  const page = doc.pageAtIndex(requested-1);
  if (args.includes('-hide-annotations')) page.displaysAnnotations = false;
  const box = 0; // kPDFDisplayBoxMediaBox, also used by default by pdftoppm
  const bounds = page.boundsForBox(box).size;
  const sideways = Number(page.rotation) % 180 !== 0;
  const width = sideways ? bounds.height : bounds.width;
  const height = sideways ? bounds.width : bounds.height;
  const longest = arg('-scale-to',0);
  const scale = longest ? longest / Math.max(width,height) : arg('-r',144)/72;
  const w = Math.ceil(width*scale), h = Math.ceil(height*scale);
  if (!Number.isFinite(w*h) || w < 1 || h < 1 || w*h > 24e6) throw new Error('Unsupported PDF raster dimensions');
  const image = page.thumbnailOfSizeForBox($.NSMakeSize(w,h),box);
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  if (!png.writeToFileAtomically(args[args.length-1]+'.png',true)) throw new Error('Could not write PNG');
}
