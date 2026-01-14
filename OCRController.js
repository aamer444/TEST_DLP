const catchAsync = require("../utils/catchAsync");
const OCRService = require("../services/OCRService");
const AppError = require("../utils/appError");
const httpCodes = require("../config/httpCodes");
const messages = require("../config/messages");
const responses = require("../middlewares/responses");
const { VALIDATION_CONFIG } = require("../config/constants");
const redisClient = require("../middlewares/redisClient");

exports.createOCR_old = catchAsync(async (req, res) => {
  const { file } = req;
  const { docType } = req.body;

  const result = await OCRService.processDocument({ file, docType });

  res.status(200).json({
    status: "success",
    data: result,
  });
});

const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/svg+xml",
  "application/pdf",
];

const bufferFromBase64 = (base64String) => {
  const base64Data = base64String.replace(/^data:.+;base64,/, "");
  return Buffer.from(base64Data, "base64");
};

const getMimeTypeFromBase64 = (base64String) => {
  const match = base64String.match(/^data:(.+);base64,/);
  return match?.[1] || "image/jpeg"; // default fallback
};

exports.createOCR = catchAsync(async (req, res) => {
  // const fileSizeInMB = req.file.size / (1024 * 1024);
  // console.log("File size in MB:", fileSizeInMB.toFixed(2), req.file.size);
  const { docType } = req.body;
  let fileBuffer;
  let mimeType = "image/jpeg";

  if (req.file) {
    fileBuffer = req.file.buffer;
    mimeType = req.file.mimetype;
  } else if (req.body.docFile) {
    fileBuffer = bufferFromBase64(req.body.docFile);
    mimeType = getMimeTypeFromBase64(req.body.docFile);
  } else {
    throw new AppError(
      "No file uploaded. Please upload a file or base64 string.",
      400
    );
  }
  // console.log("mimeType---", mimeType);

  if (!SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new AppError(`Unsupported image type: ${mimeType}`, 400);
  }

  const result = await OCRService.processDocument({
    file: { buffer: fileBuffer, mimetype: mimeType },
    docType,
  });

  res.status(200).json({
    status: "success",
    data: result,
  });
  // return responses.success(
  //   req,
  //   res,
  //   httpCodes.HTTP_OK,
  //   result,
  //   messages.SUCCESS
  // );
});


// New: handle multiple files and return results (no DB save)

// ...existing code...
// exports.createOCRBatch = catchAsync(async (req, res) => {
//   try {
//     const files = req.files || [];
//     if (files.length !== 6) {
//       return res.status(400).json({ success: false, message: "Please upload Civil id,Driving license and mulkiya." });
//     }

//     // Optional: client may send docTypes[] aligned with files; otherwise leave empty for auto-detect
//     let docTypes = [];
//     if (req.body.docTypes) {
//       if (Array.isArray(req.body.docTypes)) docTypes = req.body.docTypes;
//       else if (typeof req.body.docTypes === "string")
//         docTypes = req.body.docTypes.split(",").map((s) => s.trim());
//     }

//     const concurrency = Math.max(1, parseInt(req.body.concurrency, 10) || 4);
//     console.log(docTypes, 'docTypes<<<')
//     // call service batch processor
//     const results = await OCRService.processDocumentsBatch({ files, concurrency, docTypes, productType: req.body.productType });

//     // sanitize results: remove raw OCR payloads and large binary/base64 fields 
//     const sanitized = (results || []).map((r) => {
//       if (!r || typeof r !== "object") return r;
//       const out = { ...r };

//       if (out.data && typeof out.data === "object") {
//         const dataCopy = { ...out.data };

//         // common raw/full response fields to drop
//         delete dataCopy.raw;
//         delete dataCopy.fullResponse;
//         delete dataCopy.ocrRaw;

//         // drop any Buffer values or very large base64 strings
//         Object.keys(dataCopy).forEach((key) => {
//           const val = dataCopy[key];
//           if (Buffer.isBuffer(val)) delete dataCopy[key];
//           if (typeof val === "string" && val.length > 10000 && /^data:/.test(val)) delete dataCopy[key];
//         });

//         out.data = dataCopy;
//       }

//       return out;
//     });

//     return res.status(200).json({ success: true, count: sanitized.length, results: sanitized });

//   } catch (error) {
//     return res.status(500).json({ success: false, message: error.message || "Internal Server Error" });
//   }

// });


exports.createOCRBatch = catchAsync(async (req, res) => {
  try {
    // 1️⃣ Fixed upload keys
    const fileKeys = ['doc1', 'doc2', 'doc3', 'doc4', 'doc5', 'doc6'];
    let { useFor, newPlate, productType, clientId } = req.body;

    if (!useFor || !productType) {
      return res.status(400).json({
        success: false,
        message: 'Both fields (useFor, productType) are required and cannot be empty.'
      });
    }

    useFor = useFor.trim();
    productType = productType.trim();

    if (!req.files) {
      return res.status(400).json({
        success: false,
        message: "No files uploaded"
      });
    }

    // 2️⃣ Normalize files (ordered)
    const files = fileKeys
      .map(key => req.files[key]?.[0])
      .filter(Boolean)
      .sort((a, b) => a.fieldname.localeCompare(b.fieldname));

    if (!files.length) {
      return res.status(400).json({
        success: false,
        message: "No valid files uploaded"
      });
    }

    const sharedOpts = { productType, docCounts: {} };

    // 3️⃣ Process all files (PDF → image → OCR)
    const processingPromises = files.map(async (file) => {
      try {
        // ---------- PDF HANDLING ----------
        if (file.mimetype === "application/pdf") {
          const orig = file.originalname || "pdf";

          // Convert PDF → images
          const pages = await OCRService.extractImagesFromPDF(file.buffer, orig);
          console.log(`Extracted ${pages.length} pages from PDF: ${orig}`);
          // // Minimum page validation
          // if (
          //   pages.length < 2 &&
          //   newPlate !== "EXPORT_CERTIFICATE" &&
          //   newPlate !== "AGENCY_PURCHASE_RECEIPT" &&
          //   productType !== "TRAVEL"
          // ) {
          //   throw new Error(`PDF ${orig} must contain at least 2 pages (front & back)`);
          // }

          // OCR each page image
          const pagePromises = pages.map(async (img, idx) => {
            const out = await OCRService.processSingle(img, {
              ...sharedOpts,
              useFor
            });

            return {
              success: true,
              file: `${orig} (page ${idx + 1})`,
              docType: out.docType,
              data: OCRService.sanitizeOCRData(out.data)
            };
          });

          return Promise.all(pagePromises);
        }

        // ---------- IMAGE HANDLING ----------
        const out = await OCRService.processSingle(file, {
          ...sharedOpts,
          useFor
        });

        return {
          success: true,
          file: file.originalname || 'image',
          docType: out.docType,
          data: OCRService.sanitizeOCRData(out.data)
        };

      } catch (err) {
        throw err;
      }
    });

    // 4️⃣ Wait for all (safe)
    const settledResults = await Promise.allSettled(processingPromises);

    // 5️⃣ Normalize + flatten
    const results = settledResults.flatMap(r => {
      if (r.status === "fulfilled") {
        return Array.isArray(r.value) ? r.value : [r.value];
      }
      return [{
        success: false,
        error: r.reason?.message || "File processing failed"
      }];
    });
    console.log("Results:>", results);
    // 6️⃣ Validate + store batch
    const validationRes = await OCRService.validateAndStoreBatchResults({
      clientId,
      records: results,
      productType,
      newPlate,
      useFor,
      redisClient
    });

    // 7️⃣ Final response
    if (validationRes.missing.length > 0) {
      return res.status(400).json({
        success: false,
        clientId: validationRes.clientId,
        expectedCount: validationRes.state.expectedCount,
        validCount: validationRes.state.validCount,
        extractedNumbers: validationRes.extractedNumbers,
        isIdLicenseMatch: validationRes.isIdLicenseMatch,
        wrongUploads: validationRes.wrongUploads.documentDetected.length
          ? validationRes.wrongUploads
          : {},
        message: `Missing required documents: ${validationRes.missing.join(", ")}`,
        validDocs: Object.keys(validationRes.state.counts)
      });
    }

    return res.status(200).json({
      success: true,
      clientId: validationRes.clientId,
      expectedCount: validationRes.state.expectedCount,
      validCount: validationRes.state.validCount,
      extractedNumbers: validationRes.extractedNumbers,
      isIdLicenseMatch: validationRes.isIdLicenseMatch,
      wrongUploads: validationRes.wrongUploads.documentDetected.length
        ? validationRes.wrongUploads
        : {},
      results: validationRes.state.files
    });

  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Something went wrong"
    });
  }
});
