#!/bin/bash

# Blog Post Test Archive Creation Script
# This script creates the ZIP archives for the blog post evaluation test

set -e  # Exit on any error

echo "==========================================="
echo "Blog Post Test - Archive Creation"
echo "==========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if blog post file exists
if [ ! -f "work-product-submission/BlogPostSubmission.rtf" ]; then
    echo -e "${RED}ERROR: Blog post file not found at work-product-submission/BlogPostSubmission.rtf${NC}"
    echo "Please ensure the file exists and contains your blog post content."
    exit 1
fi

# Check if file is not empty
if [ ! -s "work-product-submission/BlogPostSubmission.rtf" ]; then
    echo -e "${RED}ERROR: BlogPostSubmission.rtf is empty${NC}"
    echo "Please add your blog post content to work-product-submission/BlogPostSubmission.rtf"
    exit 1
fi

echo -e "${GREEN}✓${NC} Blog post content found ($(wc -c < work-product-submission/BlogPostSubmission.rtf) bytes)"
echo ""

# Step 1: Create work product archive
echo "Step 1: Creating work product submission archive..."
cd work-product-submission
rm -f ../hunterSubmission.zip
zip -r ../hunterSubmission.zip . -x "*.DS_Store" -x "__MACOSX*"
cd ..
echo -e "${GREEN}✓${NC} Created hunterSubmission.zip"
echo ""

# Verify work product archive
echo "Verifying work product archive contents..."
unzip -l hunterSubmission.zip
echo ""

# Upload work product to IPFS
echo "==========================================="
echo "MANUAL STEP REQUIRED:"
echo "==========================================="
echo ""
echo "Upload hunterSubmission.zip to IPFS and get the CID:"
echo ""
echo "Option 1 (IPFS CLI):"
echo "  ipfs add hunterSubmission.zip"
echo ""
echo "Option 2 (Web UI):"
echo "  - Visit https://app.pinata.cloud or https://web3.storage"
echo "  - Upload hunterSubmission.zip"
echo "  - Copy the CID"
echo ""
echo -e "${YELLOW}Please upload the file and enter the CID below:${NC}"
read -p "Work Product CID: " WORK_PRODUCT_CID

# Validate CID format (basic check)
if [[ ! $WORK_PRODUCT_CID =~ ^(Qm|bafy) ]]; then
    echo -e "${RED}ERROR: Invalid CID format. CID should start with 'Qm' or 'bafy'${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Work Product CID: $WORK_PRODUCT_CID"
echo ""

# Step 2: Update primary manifest with work product CID
echo "Step 2: Creating primary archive with CID reference..."
cd primary-archive
cp manifest.json.template manifest.json
# Replace placeholder with actual CID
sed -i "s/REPLACE_WITH_WORK_PRODUCT_CID/$WORK_PRODUCT_CID/g" manifest.json
rm -f ../blogPostEvaluation.zip
zip -r ../blogPostEvaluation.zip . -x "*.template" -x "*.DS_Store" -x "__MACOSX*"
cd ..
echo -e "${GREEN}✓${NC} Created blogPostEvaluation.zip"
echo ""

# Verify primary archive
echo "Verifying primary archive contents..."
unzip -l blogPostEvaluation.zip
echo ""

# Upload primary archive to IPFS
echo "==========================================="
echo "MANUAL STEP REQUIRED:"
echo "==========================================="
echo ""
echo "Upload blogPostEvaluation.zip to IPFS and get the CID:"
echo ""
echo "Option 1 (IPFS CLI):"
echo "  ipfs add blogPostEvaluation.zip"
echo ""
echo "Option 2 (Web UI):"
echo "  - Visit https://app.pinata.cloud or https://web3.storage"
echo "  - Upload blogPostEvaluation.zip"
echo "  - Copy the CID"
echo ""
echo -e "${YELLOW}Please upload the file and enter the CID below:${NC}"
read -p "Primary Archive CID: " PRIMARY_CID

# Validate CID format
if [[ ! $PRIMARY_CID =~ ^(Qm|bafy) ]]; then
    echo -e "${RED}ERROR: Invalid CID format. CID should start with 'Qm' or 'bafy'${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Primary Archive CID: $PRIMARY_CID"
echo ""

# Summary
echo "==========================================="
echo "Archive Creation Complete!"
echo "==========================================="
echo ""
echo "Your CIDs:"
echo "  Rubric CID:        QmUPGQpJakBMBpY4AihKPJRFiQtTxyMLMr6tSEuPqgApAz"
echo "  Work Product CID:  $WORK_PRODUCT_CID"
echo "  Primary CID:       $PRIMARY_CID"
echo ""
echo "To test the evaluation, run:"
echo ""
echo "  curl -X POST http://localhost:8080/evaluate \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"cid\": \"$PRIMARY_CID,$WORK_PRODUCT_CID\"}'"
echo ""
echo "Or save these CIDs to a file for later use:"
echo "  echo '$PRIMARY_CID,$WORK_PRODUCT_CID' > test-cids.txt"
echo ""

