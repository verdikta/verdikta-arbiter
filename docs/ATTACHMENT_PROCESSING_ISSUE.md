# Attachment Processing Issue and Long-Term Solution

## Issue Summary

**Critical Bug Introduced:** Commit 9a707b9  
**Symptom:** DOCX attachments stopped being processed correctly  
**Impact:** Arbitration requests with Word documents failed to extract text  
**Status:** Resolved. The hardcoded model lists are gone (2026-11): each attachment is routed per juror, and only a PDF is ever sent as a file. See [What replaced the lists](#what-replaced-the-lists-2026-11). Everything below that section is the record of the incident and of the proposal it led to.

---

## What replaced the lists (2026-11)

The short-term fix kept DOCX working by making sure the "native" path was never
taken: the lists stopped at GPT-4.1 and Claude 4.x and compared the provider name
case-sensitively, so every current jury fell through to text extraction. That
also meant no juror could see a picture that exists only inside a PDF. On bounty
398 a hunter put 16 recording frames in a 19-page PDF; the jury
(`openai / gpt-5.6-terra`, `anthropic / claude-sonnet-5`) was sent the PDF's text
and nothing else.

There were four lists, and they disagreed: two in the rank-and-justify route
(one for a debug log), one in the attachment processor (which decided from the
first model of the jury only), and one in the Anthropic provider (which left a
PDF out of the request for any model not on it, without telling the model).

What exists now:

| Question | Where it is answered |
|---|---|
| Does this provider, model and route read a PDF natively? | `ai-node/src/lib/llm/pdf-support.ts`, `nativePdfSupport(provider, model)`. One function, read from the model's version (Claude 3.5 and later; GPT-5 and later, GPT-4o / 4.1 / 4.5, the o-series with image input), any case of the provider name. A class routed to OpenRouter gets text. An id it cannot read gets text. |
| Which form of which attachment does each juror get? | `ai-node/src/lib/attachments/pdfRouting.ts`, `attachmentsForJuror`. |
| What are the limits? | `PDF_LIMITS` in the same file, with the doc sources, and `IMAGE_LIMITS` in `normalizeImages.ts` for the request-wide ones. |
| What is each juror told? | `documentNotes` in `ai-node/src/utils/attachment-processor.ts`: a line in that juror's own prompt for every PDF it was not sent as a PDF. |

The rules:

- **Only a PDF can be sent as itself.** Every other document (DOCX, DOC, RTF,
  Markdown, ...) is its extracted text, for every juror. This is the property
  whose loss caused the incident below, and it no longer depends on which models
  are in the jury.
- **Per juror, not per request.** A juror that reads PDFs gets the file; in the
  same request a juror that does not gets the extracted text and the note "Only
  its text is shown to you: pictures and page images inside the PDF are not
  shown." A mixed jury no longer drags everyone down to text, and no longer
  hands a `document` block to a provider that drops it.
- **Limits per juror.** A PDF that would put a juror's request over a provider
  limit (pages, bytes; with Claude, images and pages together against 100, and
  20 MB for the whole request) is text for that juror, with the reason in the
  note. PDFs take what the images leave, in attachment order.
- **A PDF with no text layer still reaches the jurors that read PDFs.** The
  others are told it is not shown to them. Before, such a PDF was skipped for
  everyone with only a response warning.
- **A rejection does not cost the juror.** If a provider answers 400 / 413 / 422
  to a request that carried a PDF as a file, the juror is asked once more with
  the text and the note says the file was not accepted.
- **Nothing is left out silently.** A provider handed something its request
  cannot carry names it in the prompt (`provider-attachments.ts`); a model that
  is sent no attachments at all is told what the request held.

Each juror's result reports the form it got: `model_results[].pdf_inputs`
(`ai-node/API_RESPONSE_SPECIFICATION.md`, "PDF attachments").

How this differs from the proposal further down this page:

- The proposal put capabilities in `modelConfig` flags. That table is generated
  from ClassID data on each node and its `supportsAttachments` means "the arbiter
  accepts files for this model", which is what broke things in the first place.
  The capability is derived from the model id instead, so a new model in a known
  family needs no edit and a table sync cannot change the routing.
- The proposal sent everything as text whenever a request mixed file types
  ("Mixed or unknown → use text extraction"). Routing is per attachment, so a
  PDF beside a DOCX is still a PDF.
- The proposal's warnings were per request. They are per juror
  (`pdf_text_only`, with the reason), because the answer differs per juror.

Tests: `ai-node/src/__tests__/api/rank-and-justify.pdf.test.ts` runs the route,
the providers and their real client libraries against a local stub and asserts
on the request bodies (a PDF block for each provider, DOCX as text, the note for
a juror without PDF input, the limits, the rejection fallback). The test matrix
below is covered there and in `pdfRouting.test.ts`. What no local test can show
is that the real APIs accept these requests: that is the `pdf-canary` scenario on
the class-5555 canaries (`docs/release-runbook.md`, 3b).

---

## Problem Analysis

### What Happened

**Commit 9a707b9 changed model capability detection from hardcoded lists to `modelConfig` lookup:**

**Before (Working):**
```typescript
const allModelsSupportNativePDF = body.models.every(modelInfo => {
  if (modelInfo.provider === 'OpenAI') {
    return ['gpt-4o', 'gpt-4.1', 'gpt-5'].some(model => 
      modelInfo.model.toLowerCase().includes(model.toLowerCase())
    );
  }
  // Partial matching - gpt-5.2-2025-12-11 does NOT match 'gpt-5'
});
// Result: allModelsSupportNativePDF = false → text extraction path
```

**After (Broken):**
```typescript
function modelSupportsAttachments(provider: string, modelName: string): boolean {
  const providerModels = (modelConfig as any)[provider.toLowerCase()];
  const modelInfo = providerModels.find((m: any) => m.name === modelName);
  return modelInfo ? modelInfo.supportsAttachments : false;
  // Exact matching - gpt-5.2-2025-12-11 DOES match in modelConfig
}

const allModelsSupportNativePDF = body.models.every(modelInfo => 
  modelSupportsAttachments(modelInfo.provider, modelInfo.model)
);
// Result: allModelsSupportNativePDF = true → native PDF path
```

### Root Cause

**The code has two different attachment processing paths:**

#### **Path 1: Native PDF Processing** (when `allModelsSupportNativePDF = true`)
```typescript
if (allModelsSupportNativePDF) {
  // Pass attachments directly to models as base64
  // Models handle PDF natively via their APIs
  // ✅ Works for: PDF files
  // ❌ Broken for: DOCX, DOC, RTF, TXT files
}
```

#### **Path 2: Text Extraction** (when `allModelsSupportNativePDF = false`)
```typescript
else {
  // Use processAttachments() to extract text from documents
  // Converts DOCX/DOC/RTF/PDF → plain text
  // ✅ Works for: All document types (PDF, DOCX, DOC, RTF, TXT)
  // ⚠️  Less accurate for: Complex PDFs with images/tables
}
```

### Why It Broke

**Model version detection changed behavior:**

1. **Old hardcoded lists:** Used **partial matching** (`includes()`)
   - `gpt-5.2-2025-12-11` does NOT match `gpt-5` exactly
   - Many newer models fell through to text extraction
   - ✅ DOCX processed via text extraction

2. **New modelConfig lookup:** Used **exact matching** (`find()`)
   - `gpt-5.2-2025-12-11` DOES match in `modelConfig`
   - Models found with `supportsAttachments: true`
   - Routed to native PDF path
   - ❌ DOCX sent as base64, not extracted

### The Semantic Mismatch

**The variable name `allModelsSupportNativePDF` is misleading:**

- **Name implies:** "Models can natively process PDF files"
- **Actually controls:** "Should we use native processing or text extraction?"
- **Problem:** Native processing only works well for actual PDF files, not DOCX

**The flag `supportsAttachments` in `modelConfig` is ambiguous:**

- **Could mean:** Model accepts file attachments via API
- **Could mean:** Model can natively process PDF documents
- **Could mean:** Model supports vision/image inputs
- **Actually used for:** Determining if text extraction is needed

---

## Short-Term Fix (Implemented, since replaced)

> Superseded in 2026-11: the lists this section restored were removed. See
> [What replaced the lists](#what-replaced-the-lists-2026-11).

**Reverted to hardcoded lists** to restore working DOCX processing:

```typescript
// Restored original hardcoded lists with partial matching
const allModelsSupportNativePDF = body.models.every(modelInfo => {
  if (modelInfo.provider === 'OpenAI') {
    return ['gpt-4o', 'gpt-4o-mini', 'o1', 'gpt-4.1', 'gpt-4.1-mini'].some(supportedModel => 
      modelInfo.model.toLowerCase().includes(supportedModel.toLowerCase())
    );
  }
  // ... etc
});
```

**Result:**
- ✅ DOCX processing works (text extraction path)
- ✅ No false warnings (removed warning generation)
- ✅ Stable, tested behavior
- ⚠️  Hardcoded lists will need manual updates for new models

---

## Long-Term Solution Proposal

> Implemented in 2026-11 in a different shape (per attachment and per juror,
> capability from the model id). See
> [What replaced the lists](#what-replaced-the-lists-2026-11) for the
> differences. The proposal is kept as written.

### The Real Problem

The code conflates two separate concepts:
1. **Document type support** - What file formats can be processed?
2. **Processing method** - Should we extract text or send natively?

### Proposed Architecture

#### **1. Add Document Type Detection**

```typescript
interface AttachmentInfo {
  mimeType: string;
  requiresTextExtraction: boolean;
  isImage: boolean;
  isDocument: boolean;
}

function analyzeAttachment(attachment: string): AttachmentInfo {
  if (attachment.startsWith('data:')) {
    const mimeType = attachment.split(',')[0].split(';')[0].replace('data:', '');
    
    return {
      mimeType,
      isImage: mimeType.startsWith('image/'),
      isDocument: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
        'application/msword', // DOC
        'application/rtf',
        'text/plain'
      ].includes(mimeType),
      requiresTextExtraction: [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
        'application/msword', // DOC
        'application/rtf'
      ].includes(mimeType)
    };
  }
  
  return { mimeType: 'unknown', requiresTextExtraction: true, isImage: false, isDocument: false };
}
```

#### **2. Separate Model Capabilities**

Enhance `models.ts` with granular capabilities:

```typescript
export const modelConfig = {
  openai: [
    { 
      name: 'gpt-5.2-2025-12-11',
      capabilities: {
        supportsImages: true,
        supportsNativePDF: true,      // Can process PDF via API
        supportsNativeDOCX: false,    // Cannot process DOCX via API
        requiresTextExtraction: ['docx', 'doc', 'rtf']  // These need extraction
      }
    },
  ],
  // ...
};
```

#### **3. Smart Routing Logic**

```typescript
// Analyze all attachments
const attachmentAnalysis = body.attachments.map(analyzeAttachment);

// Determine processing strategy
const hasDocxFiles = attachmentAnalysis.some(a => a.requiresTextExtraction);
const hasPdfOnly = attachmentAnalysis.every(a => a.mimeType === 'application/pdf');
const hasImagesOnly = attachmentAnalysis.every(a => a.isImage);

// Route based on actual file types
if (hasDocxFiles) {
  // Any DOCX/DOC/RTF → always use text extraction
  console.log('Document files detected, using text extraction...');
  useTextExtraction = true;
} else if (hasPdfOnly && allModelsSupport('nativePDF')) {
  // PDF-only and all models support → use native
  console.log('PDF files with native support, using native processing...');
  useTextExtraction = false;
} else if (hasImagesOnly) {
  // Images → send natively
  console.log('Image files, sending natively...');
  useTextExtraction = false;
} else {
  // Mixed or unknown → use text extraction (safer)
  console.log('Mixed or unknown file types, using text extraction...');
  useTextExtraction = true;
}
```

#### **4. Accurate Warnings**

```typescript
// Only warn if we're using a suboptimal path
if (hasDocxFiles && !allModelsSupport('nativeDOCX')) {
  warnings.push({
    type: 'attachment_text_extraction',
    message: 'DOCX files will be converted to text (native DOCX processing not supported)',
    severity: 'info'
  });
}

if (hasPdfOnly && useTextExtraction) {
  warnings.push({
    type: 'attachment_text_extraction', 
    message: 'PDF files will be converted to text for compatibility',
    severity: 'info'
  });
}
```

---

## Benefits of Long-Term Solution

### ✅ Functionality
- Proper handling for all file types (PDF, DOCX, images, text)
- Smart routing based on actual content, not just model capabilities
- Fallback to text extraction when needed

### ✅ Accuracy  
- Warnings only when actually relevant
- Specific to file type (no "PDF warning" for DOCX)
- Clear about what's happening

### ✅ Maintainability
- Centralized capability definitions in modelConfig
- No hardcoded lists scattered in routing code
- Easy to add new file types or model capabilities

### ✅ User Experience
- Accurate warnings help users understand processing
- No confusing messages (PDF warning for .sol files)
- Transparent about extraction vs native processing

---

## Implementation Plan

### Phase 1: Enhanced Type Detection (Low Risk)
1. Add `analyzeAttachment()` function
2. Detect MIME types for all attachments
3. Categorize: images, PDFs, DOCX, other documents
4. **No behavior changes** - just better logging

### Phase 2: Granular Model Capabilities (Medium Risk)
1. Enhance `modelConfig` schema with detailed capabilities
2. Add `supportsNativePDF`, `supportsNativeDOCX`, etc.
3. Update during ClassID integration
4. **Test extensively** with all file types

### Phase 3: Smart Routing (Higher Risk)
1. Replace boolean flag with routing decision tree
2. Route based on file type AND model capabilities
3. Comprehensive testing with combinations:
   - PDF + capable models
   - DOCX + any models
   - Mixed attachments
   - Image attachments

### Phase 4: Accurate Warnings (Low Risk)
1. Generate warnings based on actual routing decisions
2. Specific messages per file type
3. Different severity levels
4. Test that warnings are helpful, not confusing

---

## Testing Strategy

### Test Matrix

| File Type | Models | Expected Path | Expected Warning |
|-----------|--------|---------------|------------------|
| PDF | gpt-4o, claude-4 | Native PDF | None |
| PDF | gpt-5.2, claude-sonnet-4-5 | Native PDF or Text | None or Info |
| DOCX | Any models | Text Extraction | Info (DOCX → text) |
| DOC | Any models | Text Extraction | Info (DOC → text) |
| .sol (text) | Any models | Native (as text) | None |
| Images | Vision models | Native | None |
| Mixed (PDF+DOCX) | Any models | Text Extraction | Info (mixed types) |

### Validation Criteria

- ✅ All file types process correctly
- ✅ No data loss during extraction
- ✅ Warnings are accurate and helpful
- ✅ No false warnings for working scenarios
- ✅ Degradation is graceful (text extraction fallback)

---

## Risks and Mitigation

### Risk 1: Text Extraction Quality
**Issue:** Converting DOCX/PDF to text loses formatting, images, tables  
**Mitigation:** 
- Document limitations clearly
- Provide option for users to pre-convert to plain text
- Consider adding structured extraction for tables/lists

### Risk 2: Model Capability Changes
**Issue:** Models add/remove features, our config gets stale  
**Mitigation:**
- Sync with @verdikta/common ClassID data
- Version capabilities with model versions
- Test regularly against actual model APIs

### Risk 3: New File Types
**Issue:** Users upload formats we don't handle (PPTX, XLSX, etc.)  
**Mitigation:**
- Extensible MIME type detection
- Generic text extraction fallback
- Clear error messages for unsupported types

---

## Current Status

As of 2026-11 (see [What replaced the lists](#what-replaced-the-lists-2026-11)):

- Document type detection: done, from the bytes (`media-type.ts`), per attachment.
- Model capabilities: one function derived from the model id, not `modelConfig`.
- Routing by file type and by juror: done.
- Warnings: per juror, with the reason.
- Not done: a PDF block through OpenRouter. A class routed there gets the
  extracted text and the note.

The status at the time of the incident:

### ✅ Working (Short-Term Fix)
- Hardcoded model lists (manual maintenance required)
- Text extraction for most models
- DOCX processing functional
- No false warnings

### 🔄 Needed (Long-Term Solution)
- Document type detection
- Granular model capabilities in modelConfig
- Smart routing based on file type + model
- Accurate, helpful warnings

### 📋 Action Items

1. **Immediate:** Commit revert fix (critical bug resolved)
2. **Short-term:** Document hardcoded list maintenance process
3. **Medium-term:** Design enhanced attachment processing architecture
4. **Long-term:** Implement and test comprehensive solution

---

## Recommended Next Steps

### Step 1: Stabilize Current Code
- ✅ Revert committed
- ✅ DOCX working
- ✅ Document this issue (this file)

### Step 2: Enhance modelConfig Schema
- Add granular capability flags
- Sync with @verdikta/common when available
- Version with model versions

### Step 3: Implement Smart Routing
- File type detection first
- Then check model capabilities
- Route appropriately

### Step 4: Comprehensive Testing
- Test all file type combinations
- Verify no regressions
- Document supported formats

---

## Lessons Learned

### 1. Semantic Clarity Matters
- Variable name `allModelsSupportNativePDF` was misleading
- Actually controlled: "use native vs text extraction"
- Should have been: `shouldUseTextExtraction` or `requiresDocumentExtraction`

### 2. Feature Flags ≠ Processing Paths
- `supportsAttachments` in modelConfig is too generic
- Doesn't distinguish between PDF, DOCX, images
- Need granular capability detection

### 3. Test Document Types Explicitly
- Assumed PDF and DOCX would work the same way
- They don't - DOCX requires text extraction
- Need explicit test cases for each document type

### 4. Backward Compatibility Testing
- Enhanced error reporting worked ✅
- Model config changes broke existing functionality ❌
- Need regression tests for all attachment types

---

## Future Architecture Vision

### Ideal Attachment Processing Flow

```typescript
// 1. Analyze attachments
const attachments = body.attachments.map(att => ({
  data: att,
  ...analyzeAttachment(att)
}));

// 2. Categorize by processing needs
const needTextExtraction = attachments.filter(a => a.requiresTextExtraction);
const canSendNatively = attachments.filter(a => !a.requiresTextExtraction);

// 3. Process each category appropriately
let processedAttachments = [];

if (needTextExtraction.length > 0) {
  const extracted = await extractText(needTextExtraction);
  processedAttachments.push(...extracted);
}

if (canSendNatively.length > 0) {
  processedAttachments.push(...canSendNatively);
}

// 4. Send to models with appropriate format
const result = await callModels(prompt, processedAttachments);

// 5. Generate accurate warnings
if (needTextExtraction.length > 0) {
  warnings.push({
    type: 'document_extraction',
    message: `${needTextExtraction.length} document(s) converted to text for processing`,
    details: { types: needTextExtraction.map(a => a.mimeType) }
  });
}
```

### Enhanced modelConfig Schema

```typescript
interface ModelCapabilities {
  supportsImages: boolean;
  supportsNativePDF: boolean;       // Can process PDF via API
  supportsNativeDOCX: boolean;      // Can process DOCX via API (rare)
  supportsVision: boolean;          // Can analyze images
  maxFileSize: number;              // Bytes
  supportedMimeTypes: string[];     // Explicit list
  requiresTextExtraction: string[]; // MIME types that need extraction
}

export const modelConfig = {
  openai: [
    {
      name: 'gpt-5.2-2025-12-11',
      capabilities: {
        supportsImages: true,
        supportsNativePDF: true,
        supportsNativeDOCX: false,  // Key distinction!
        supportsVision: true,
        maxFileSize: 20_000_000,
        supportedMimeTypes: ['image/*', 'application/pdf'],
        requiresTextExtraction: ['application/vnd.openxmlformats-officedocument.*']
      }
    }
  ]
};
```

---

## Comparison: Current vs Proposed

### Current (Hardcoded Lists)

**Pros:**
- ✅ Works reliably for DOCX
- ✅ Simple, predictable behavior
- ✅ Well-tested over time

**Cons:**
- ❌ Manual maintenance for new models
- ❌ Can get out of sync with models.ts
- ❌ No granular control over file types

### Proposed (Smart Routing)

**Pros:**
- ✅ Automatic sync with @verdikta/common
- ✅ Handles all file types correctly
- ✅ Accurate, helpful warnings
- ✅ Extensible for new file types

**Cons:**
- ⚠️  More complex logic
- ⚠️  Requires thorough testing
- ⚠️  Higher risk of regressions

---

## Migration Path

### Option A: Incremental Enhancement (Recommended)

**Phase 1:** Keep hardcoded lists, add file type detection (logging only)  
**Phase 2:** Add granular capabilities to modelConfig (parallel to hardcoded)  
**Phase 3:** Switch routing to use new capabilities (feature flag)  
**Phase 4:** Remove hardcoded lists once validated  

**Timeline:** 2-3 weeks with thorough testing

### Option B: Full Rewrite

**Replace entire attachment processing logic at once**  
**Timeline:** 1 week implementation + 2 weeks testing  
**Risk:** Higher (touching critical path)

### Option C: Accept Current State

**Keep hardcoded lists indefinitely**  
**Pros:** Stable, working  
**Cons:** Manual maintenance burden

---

## Recommendation

**Proceed with Option A (Incremental Enhancement):**

1. **Week 1:** Add file type detection and logging (no behavior change)
2. **Week 2:** Design and implement enhanced modelConfig schema
3. **Week 3:** Implement smart routing with feature flag
4. **Week 4:** Comprehensive testing with all file types
5. **Week 5:** Deploy with feature flag enabled, monitor
6. **Week 6:** Remove hardcoded lists if no issues

This provides safety through gradual rollout while moving toward the better architecture.

---

## Immediate Action Items

### For This Commit
- ✅ Revert to hardcoded lists (route.ts)
- ✅ Document the issue (this file)
- ✅ Test DOCX processing works
- ✅ Verify no false warnings

### For Next Sprint
- [ ] Design enhanced attachment type system
- [ ] Prototype file type detection
- [ ] Create test suite for all document types
- [ ] Implement behind feature flag

### For Future
- [ ] Sync model capabilities with @verdikta/common
- [ ] Remove hardcoded lists
- [ ] Full document type support (PPTX, XLSX, etc.)
- [ ] Optimize extraction quality

---

## Summary

**Current Fix:**
- Reverted to hardcoded lists
- DOCX processing restored
- No false warnings
- Stable, working state

**Long-Term Vision:**
- File-type-aware routing
- Granular model capabilities
- Smart extraction decisions
- Accurate, contextual warnings

**The immediate issue is resolved. The long-term solution requires careful design and testing to avoid breaking working functionality again.**
