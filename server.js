const express = require("express");
const path = require("path");
const JSZip = require("jszip");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const JOB_TTL_MS = 1000 * 60 * 60 * 2;
const jobs = new Map();

function now() {
  return Date.now();
}

function cleanupJobs() {
  const limit = now() - JOB_TTL_MS;
  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt < limit) {
      jobs.delete(jobId);
    }
  }
}

setInterval(cleanupJobs, 1000 * 60 * 15);

function detectExtensionFromContentType(contentType = "") {
  const type = String(contentType).toLowerCase();

  if (type.includes("image/avif")) return "avif";
  if (type.includes("image/jpeg")) return "jpg";
  if (type.includes("image/jpg")) return "jpg";
  if (type.includes("image/png")) return "png";
  if (type.includes("image/webp")) return "webp";
  if (type.includes("image/gif")) return "gif";
  if (type.includes("image/svg")) return "svg";

  return "jpg";
}

function buildSafeFilename(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function createModelColorBrand({ id, label, templateHeader, candidateViews }) {
  return {
    id,
    label,
    templateHeader,

    parseCode(code) {
      const clean = String(code || "").trim();

      const exactMatch = clean.match(/^(.+)-([A-Za-z0-9]{2,3})-(\d{3})$/);
      if (exactMatch) {
        return {
          type: "exact",
          raw: clean,
          model: exactMatch[1],
          color: exactMatch[2],
          sourceView: exactMatch[3]
        };
      }

      const baseMatch = clean.match(/^(.+)-([A-Za-z0-9]{2,3})$/);
      if (baseMatch) {
        return {
          type: "base",
          raw: clean,
          model: baseMatch[1],
          color: baseMatch[2],
          sourceView: null
        };
      }

      return null;
    },

    getCandidateEntries(parsed) {
      if (parsed.type === "exact" && parsed.sourceView) {
        const fullCode = `${parsed.model}-${parsed.color}-${parsed.sourceView}`;
        return [{
          displayCode: fullCode,
          sourceLabel: parsed.sourceView,
          url: `https://media.mango.com/is/image/punto/${fullCode}?wid=2048`
        }];
      }

      return candidateViews.map(view => {
        const fullCode = `${parsed.model}-${parsed.color}-${view}`;
        return {
          displayCode: fullCode,
          sourceLabel: view,
          url: `https://media.mango.com/is/image/punto/${fullCode}?wid=2048`
        };
      });
    }
  };
}

function createEtamBrand() {
  const etamViews = [
    { suffix: "x", folder: "dwecc25dfe" },
    { suffix: "a", folder: "dw9316ac3d" },
    { suffix: "b", folder: "dw3a4ad450" },
    { suffix: "c", folder: "dw406218bb" },
    { suffix: "f", folder: "dwc01a062a" },
    { suffix: "g", folder: "dwaf67e97f" },
    { suffix: "d", folder: "dwfb8de729" }
  ];

  return {
    id: "etam",
    label: "ETAM",
    templateHeader: "Modelo etam",

    parseCode(code) {
      const clean = String(code || "").trim();

      const exactMatch = clean.match(/^([A-Za-z0-9]+)[_-]([a-z])$/i);
      if (exactMatch) {
        return {
          type: "exact",
          raw: clean,
          model: exactMatch[1],
          sourceView: exactMatch[2].toLowerCase()
        };
      }

      const baseMatch = clean.match(/^([A-Za-z0-9]+)$/);
      if (baseMatch) {
        return {
          type: "base",
          raw: clean,
          model: baseMatch[1],
          sourceView: null
        };
      }

      return null;
    },

    getCandidateEntries(parsed) {
      if (parsed.type === "exact" && parsed.sourceView) {
        const found = etamViews.find(v => v.suffix === parsed.sourceView);
        if (!found) return [];

        return [{
          displayCode: `${parsed.model}_${found.suffix}`,
          sourceLabel: found.suffix,
          url: `https://images.etam.com/on/demandware.static/-/Sites-ELIN-master/default/${found.folder}/${parsed.model}_${found.suffix}.jpg?sw=1250`
        }];
      }

      return etamViews.map(view => ({
        displayCode: `${parsed.model}_${view.suffix}`,
        sourceLabel: view.suffix,
        url: `https://images.etam.com/on/demandware.static/-/Sites-ELIN-master/default/${view.folder}/${parsed.model}_${view.suffix}.jpg?sw=1250`
      }));
    }
  };
}

const BRANDS = {
  mango: createModelColorBrand({
    id: "mango",
    label: "Mango / Kid-Teen",
    templateHeader: "Modelo mango",
    candidateViews: ["002", "001", "003", "004", "081", "084", "082", "023", "021", "030"]
  }),

  mango_man: createModelColorBrand({
    id: "mango_man",
    label: "Mango Man",
    templateHeader: "Modelo mango man",
    candidateViews: ["002", "001", "003", "004", "008", "558", "007", "023", "021", "030"]
  }),

  mango_accesorio: createModelColorBrand({
    id: "mango_accesorio",
    label: "Mango Accesorio / Calzado",
    templateHeader: "Modelo mango accesorio",
    candidateViews: ["051", "016", "052", "055", "053", "054", "061", "056"]
  }),

  etam: createEtamBrand()
};

async function downloadRemoteImage(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": url
      }
    });

    if (!response.ok) {
      return { ok: false, reason: "not_found" };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return { ok: false, reason: "not_image" };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer.length) {
      return { ok: false, reason: "empty" };
    }

    return {
      ok: true,
      buffer,
      contentType,
      ext: detectExtensionFromContentType(contentType)
    };
  } catch (error) {
    return { ok: false, reason: "fetch_error" };
  }
}

function buildManifestText(rowResults) {
  const okRows = rowResults.filter(row => row.ok);
  const badRows = rowResults.filter(row => !row.ok);

  const lines = [];

  lines.push("DESCARGADO CORRECTAMENTE");
  lines.push("");

  if (okRows.length) {
    okRows.forEach(row => {
      lines.push(
        `Fila ${row.rowNumber} | ${row.inputCode} | SKU ${row.skuFalabella} | ${row.downloadedFiles.join(", ")}`
      );
    });
  } else {
    lines.push("Sin registros.");
  }

  lines.push("");
  lines.push("NO DESCARGO");
  lines.push("");

  if (badRows.length) {
    badRows.forEach(row => {
      lines.push(
        `Fila ${row.rowNumber} | ${row.inputCode || "(sin código)"} | SKU ${row.skuFalabella || "(sin SKU)"}`
      );
    });
  } else {
    lines.push("Sin registros.");
  }

  return lines.join("\n");
}

app.get("/api/brands", (req, res) => {
  const brands = Object.values(BRANDS).map(brand => ({
    id: brand.id,
    label: brand.label,
    templateHeader: brand.templateHeader
  }));

  res.json({ brands });
});

app.post("/api/process", async (req, res) => {
  cleanupJobs();

  const { brand: brandId, rows } = req.body || {};
  const brand = BRANDS[brandId];

  if (!brand) {
    return res.status(400).json({ error: "Marca no válida." });
  }

  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: "Rows inválido." });
  }

  const items = [];
  const errors = [];
  const rowResults = [];
  const usedNames = new Set();

  for (const row of rows) {
    const rowNumber = Number(row.rowNumber || 0);
    const inputCode = String(row.modelCode || "").trim();
    const skuFalabella = String(row.skuFalabella || "").trim();

    const rowResult = {
      rowNumber,
      inputCode,
      skuFalabella,
      downloadedFiles: [],
      ok: false
    };

    if (!inputCode || !skuFalabella) {
      errors.push(`Fila ${rowNumber}: faltan datos.`);
      rowResults.push(rowResult);
      continue;
    }

    const parsed = brand.parseCode(inputCode);
    if (!parsed) {
      errors.push(`Fila ${rowNumber}: código inválido "${inputCode}".`);
      rowResults.push(rowResult);
      continue;
    }

    const candidateEntries = brand.getCandidateEntries(parsed);
    const foundItemsForRow = [];

    for (const entry of candidateEntries) {
      const result = await downloadRemoteImage(entry.url);
      if (!result.ok) continue;

      foundItemsForRow.push({
        rowNumber,
        inputCode,
        foundCode: entry.displayCode,
        skuFalabella,
        sourceView: entry.sourceLabel,
        originalUrl: entry.url,
        buffer: result.buffer,
        mimeType: result.contentType,
        ext: result.ext
      });
    }

    if (foundItemsForRow.length === 0) {
      if (parsed.type === "exact") {
        errors.push(`Fila ${rowNumber}: no existe "${inputCode}".`);
      } else {
        errors.push(`Fila ${rowNumber}: no se encontraron vistas para "${inputCode}".`);
      }

      rowResults.push(rowResult);
      continue;
    }

    foundItemsForRow.forEach((item, index) => {
      const finalView = index + 1;
      const outputFilename = buildSafeFilename(`${item.skuFalabella}_${finalView}.${item.ext}`);
      const duplicateKey = outputFilename.toLowerCase();

      if (usedNames.has(duplicateKey)) {
        errors.push(`Fila ${rowNumber}: nombre repetido "${outputFilename}".`);
        return;
      }

      usedNames.add(duplicateKey);

      item.id = crypto.randomUUID();
      item.targetView = finalView;
      item.outputFilename = outputFilename;

      items.push(item);
      rowResult.downloadedFiles.push(outputFilename);
    });

    rowResult.ok = rowResult.downloadedFiles.length > 0;
    rowResults.push(rowResult);
  }

  const manifestText = buildManifestText(rowResults);
  const jobId = crypto.randomUUID();

  jobs.set(jobId, {
    createdAt: now(),
    brandId,
    brandLabel: brand.label,
    items,
    rowResults,
    manifestText
  });

  const responseItems = items.map(item => ({
    id: item.id,
    rowNumber: item.rowNumber,
    inputCode: item.inputCode,
    foundCode: item.foundCode,
    sourceView: item.sourceView,
    skuFalabella: item.skuFalabella,
    outputFilename: item.outputFilename,
    previewUrl: `/api/job/${jobId}/file/${item.id}`,
    downloadUrl: `/api/job/${jobId}/file/${item.id}?download=1`,
    originalUrl: item.originalUrl
  }));

  res.json({
    jobId,
    brandLabel: brand.label,
    items: responseItems,
    rowResults,
    errors
  });
});

app.get("/api/job/:jobId/file/:itemId", (req, res) => {
  const { jobId, itemId } = req.params;
  const download = req.query.download === "1";

  const job = jobs.get(jobId);
  if (!job) return res.status(404).send("Job no encontrado");

  const item = job.items.find(x => x.id === itemId);
  if (!item) return res.status(404).send("Archivo no encontrado");

  res.setHeader("Content-Type", item.mimeType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(item.outputFilename)}"`
  );

  res.send(item.buffer);
});

app.get("/api/download/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).send("Job no encontrado");

  const zip = new JSZip();

  job.items.forEach(item => {
    zip.file(item.outputFilename, item.buffer);
  });

  zip.file("manifest.txt", job.manifestText || "");

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const d = new Date();
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const zipName = `${job.brandId}-${YYYY}${MM}${DD}-${hh}${mm}.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
  res.send(zipBuffer);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
