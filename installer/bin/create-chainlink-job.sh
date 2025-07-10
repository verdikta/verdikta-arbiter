#!/bin/bash

# Verdikta Validator Node - Chainlink Job Creation Script
# Automates the creation of Chainlink jobs via API

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script usage
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Creates a Chainlink job automatically via API"
    echo ""
    echo "Options:"
    echo "  -f, --file FILE          Path to TOML job specification file (required)"
    echo "  -e, --email EMAIL        Chainlink node API email (optional, will be auto-detected)"
    echo "  -p, --password PASSWORD  Chainlink node API password (optional, will be auto-detected)"
    echo "  -u, --url URL           Chainlink node URL (default: http://localhost:6688)"
    echo "  -o, --output FILE       Output file to save job ID (optional)"
    echo "  -v, --verbose           Verbose output"
    echo "  -h, --help              Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 -f /path/to/job_spec.toml"
    echo "  $0 -f job_spec.toml -o job_id.txt"
    echo "  $0 -f job_spec.toml -e admin@example.com -p mypassword"
    echo ""
    echo "Note: If email/password are not provided, the script will attempt to"
    echo "      read them from ~/.chainlink-sepolia/.api"
}

# Default values
CHAINLINK_URL="http://localhost:6688"
JOB_SPEC_FILE=""
API_EMAIL=""
API_PASSWORD=""
OUTPUT_FILE=""
VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--file)
            JOB_SPEC_FILE="$2"
            shift 2
            ;;
        -e|--email)
            API_EMAIL="$2"
            shift 2
            ;;
        -p|--password)
            API_PASSWORD="$2"
            shift 2
            ;;
        -u|--url)
            CHAINLINK_URL="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Unknown option $1${NC}"
            usage
            exit 1
            ;;
    esac
done

# Verbose logging function
log_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}[VERBOSE] $1${NC}"
    fi
}

# Validate required parameters
if [ -z "$JOB_SPEC_FILE" ]; then
    echo -e "${RED}Error: Job specification file is required. Use -f option.${NC}"
    usage
    exit 1
fi

if [ ! -f "$JOB_SPEC_FILE" ]; then
    echo -e "${RED}Error: Job specification file not found: $JOB_SPEC_FILE${NC}"
    exit 1
fi

# Auto-detect API credentials if not provided
if [ -z "$API_EMAIL" ] || [ -z "$API_PASSWORD" ]; then
    log_verbose "Attempting to auto-detect API credentials from ~/.chainlink-sepolia/.api"
    
    if [ -f "$HOME/.chainlink-sepolia/.api" ]; then
        API_CREDENTIALS=( $(cat "$HOME/.chainlink-sepolia/.api") )
        if [ -z "$API_EMAIL" ]; then
            API_EMAIL="${API_CREDENTIALS[0]}"
        fi
        if [ -z "$API_PASSWORD" ]; then
            API_PASSWORD="${API_CREDENTIALS[1]}"
        fi
        log_verbose "API credentials loaded from ~/.chainlink-sepolia/.api"
    else
        echo -e "${RED}Error: API credentials not found. Please provide -e and -p options or ensure ~/.chainlink-sepolia/.api exists.${NC}"
        exit 1
    fi
fi

if [ -z "$API_EMAIL" ] || [ -z "$API_PASSWORD" ]; then
    echo -e "${RED}Error: API email and password are required.${NC}"
    exit 1
fi

echo -e "${BLUE}Creating Chainlink job from specification: $JOB_SPEC_FILE${NC}"

# Function to clean up temporary files
cleanup() {
    rm -f /tmp/chainlink_cookies_job.txt
    rm -f /tmp/job_spec_escaped.json
}
trap cleanup EXIT

# Function to login to Chainlink node API and get session cookie
login_to_chainlink() {
    log_verbose "Attempting to login to Chainlink node at $CHAINLINK_URL"
    
    # Login and get session cookie (CSRF not required for newer Chainlink versions)
    log_verbose "Logging in with provided credentials"
    LOGIN_RESPONSE=$(curl -sS -c /tmp/chainlink_cookies_job.txt \
        -X POST -H "Content-Type: application/json" \
        -d "{\"email\":\"$API_EMAIL\",\"password\":\"$API_PASSWORD\"}" \
        "$CHAINLINK_URL/sessions")
    
    # Check if login was successful
    if echo "$LOGIN_RESPONSE" | grep -q "error"; then
        echo -e "${RED}Error: Failed to login to Chainlink node. Response: $LOGIN_RESPONSE${NC}"
        return 1
    fi
    
    # Verify we got an authenticated session
    if ! echo "$LOGIN_RESPONSE" | grep -q '"authenticated":true'; then
        echo -e "${RED}Error: Authentication failed. Response: $LOGIN_RESPONSE${NC}"
        return 1
    fi
    
    log_verbose "Login successful"
    return 0
}

# Function to properly escape TOML content for JSON
escape_toml_for_json() {
    local toml_file="$1"
    
    log_verbose "Escaping TOML content for JSON transmission"
    
    # Read the TOML file and escape it properly for JSON
    # This handles newlines, quotes, and other special characters
    python3 -c "
import json
import sys

try:
    with open('$toml_file', 'r') as f:
        toml_content = f.read()
    
    # Create JSON payload with escaped TOML content
    payload = {'toml': toml_content}
    print(json.dumps(payload))
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
" > /tmp/job_spec_escaped.json
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Failed to escape TOML content for JSON.${NC}"
        return 1
    fi
    
    log_verbose "TOML content successfully escaped"
    return 0
}

# Function to create the job via API
create_job() {
    log_verbose "Preparing to create job via API"
    
    # Escape TOML content for JSON
    if ! escape_toml_for_json "$JOB_SPEC_FILE"; then
        return 1
    fi
    
    # Create job (CSRF not required for newer Chainlink versions)
    log_verbose "Sending job creation request to $CHAINLINK_URL/v2/jobs"
    JOB_RESPONSE=$(curl -sS -b /tmp/chainlink_cookies_job.txt \
        -X POST \
        -H "Content-Type: application/json" \
        -d @/tmp/job_spec_escaped.json \
        "$CHAINLINK_URL/v2/jobs")
    
    log_verbose "Job creation response received"
    
    # Check if job creation failed (look for actual top-level errors)
    if ! echo "$JOB_RESPONSE" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    
    # Check for top-level errors array with actual error content
    if 'errors' in data and isinstance(data['errors'], list) and len(data['errors']) > 0:
        # Check if any error has actual content
        has_real_errors = False
        for error in data['errors']:
            if isinstance(error, dict) and ('detail' in error or 'message' in error):
                has_real_errors = True
                break
        if has_real_errors:
            sys.exit(1)  # Has actual errors
    
    # Check for successful job creation response
    if 'data' in data and isinstance(data['data'], dict):
        # Look for job type and external job ID to confirm success
        if (data['data'].get('type') == 'jobs' and 
            'attributes' in data['data'] and 
            'externalJobID' in data['data']['attributes']):
            sys.exit(0)  # Successful job creation
    
    # If we get here, it's an unexpected response format
    sys.exit(1)
except Exception as e:
    # JSON parsing error or other exception
    sys.exit(1)
"; then
        # Check if it's a duplicate job error
        if echo "$JOB_RESPONSE" | grep -q "duplicate key value violates unique constraint"; then
            echo -e "${YELLOW}Warning: A job with the same name already exists.${NC}"
            
            # Try to find the existing job ID
            EXISTING_JOB_ID=$(curl -sS -b /tmp/chainlink_cookies_job.txt "$CHAINLINK_URL/v2/jobs" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'data' in data:
        for job in data['data']:
            if 'attributes' in job and 'name' in job['attributes']:
                # Extract job name from TOML to compare
                import re
                with open('$JOB_SPEC_FILE', 'r') as f:
                    toml_content = f.read()
                match = re.search(r'name\s*=\s*\"([^\"]+)\"', toml_content)
                if match:
                    job_name = match.group(1)
                    if job['attributes']['name'] == job_name:
                        if 'externalJobID' in job['attributes']:
                            print(job['attributes']['externalJobID'])
                        else:
                            print('External job ID not found', file=sys.stderr)
                        sys.exit(0)
    print('Job not found', file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
")
            
            if [ -n "$EXISTING_JOB_ID" ]; then
                echo -e "${BLUE}Found existing job with ID: $EXISTING_JOB_ID${NC}"
                JOB_ID="$EXISTING_JOB_ID"
            else
                echo -e "${RED}Error: Could not find existing job ID.${NC}"
                echo "$JOB_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$JOB_RESPONSE"
                return 1
            fi
        else
            echo -e "${RED}Error: Failed to create job. Response:${NC}"
            echo "$JOB_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$JOB_RESPONSE"
            return 1
        fi
    else
        # Extract job ID from successful creation response
        JOB_ID=$(echo "$JOB_RESPONSE" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'data' in data and 'attributes' in data['data'] and 'externalJobID' in data['data']['attributes']:
        print(data['data']['attributes']['externalJobID'])
    elif 'data' in data and 'id' in data['data']:
        print(data['data']['id'])
    elif 'id' in data:
        print(data['id'])
    else:
        print('Job ID not found in response', file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f'Error parsing response: {e}', file=sys.stderr)
    sys.exit(1)
")
        
        if [ -z "$JOB_ID" ]; then
            echo -e "${RED}Error: Could not extract job ID from response.${NC}"
            echo "Response: $JOB_RESPONSE"
            return 1
        fi
        
        echo -e "${GREEN}Job created successfully!${NC}"
    fi
    
    echo -e "${BLUE}Job ID: $JOB_ID${NC}"
    
    # Save job ID to output file if specified
    if [ -n "$OUTPUT_FILE" ]; then
        echo "$JOB_ID" > "$OUTPUT_FILE"
        echo -e "${BLUE}Job ID saved to: $OUTPUT_FILE${NC}"
    fi
    
    # Export job ID for potential use by calling scripts
    echo "export JOB_ID=\"$JOB_ID\""
    echo "export JOB_ID_NO_HYPHENS=\"$(echo "$JOB_ID" | tr -d '-')\""
    
    return 0
}

# Check if Chainlink node is running
echo -e "${BLUE}Checking if Chainlink node is accessible...${NC}"
if ! curl -s "$CHAINLINK_URL/health" > /dev/null; then
    echo -e "${RED}Error: Chainlink node is not accessible at $CHAINLINK_URL${NC}"
    echo -e "${YELLOW}Please ensure the Chainlink node is running and accessible.${NC}"
    exit 1
fi

log_verbose "Chainlink node is accessible"

# Login to Chainlink node
echo -e "${BLUE}Logging in to Chainlink node...${NC}"
if ! login_to_chainlink; then
    echo -e "${RED}Failed to login to Chainlink node. Please check your credentials.${NC}"
    exit 1
fi

# Create the job
echo -e "${BLUE}Creating job...${NC}"
if ! create_job; then
    echo -e "${RED}Failed to create job.${NC}"
    exit 1
fi

echo -e "${GREEN}Job creation completed successfully!${NC}"
exit 0 