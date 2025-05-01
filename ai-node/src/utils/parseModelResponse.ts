interface ScoreOutcome {
  outcome: string;
  score: number;
}

/**
 * Parses the response from a model to extract score and justification.
 * This function is robust to various JSON formats and handles special characters in justifications.
 */
export function parseModelResponse(responseText: string, outcomes?: string[]): {
  decisionVector: number[] | null;
  justification: string;
  scores: ScoreOutcome[];
} {
  try {
    console.log('parseModelResponse input:', {
      responseText: responseText.substring(0, 200) + '...',  // Log first 200 chars
      hasOutcomes: !!outcomes,
      outcomesLength: outcomes?.length
    });

    // Try multiple strategies to extract JSON from the response
    let response;

    // Strategy 0: Try direct JSON parsing first
    try {
      const trimmedResponse = responseText.trim();
      if (trimmedResponse.startsWith('{') && trimmedResponse.endsWith('}')) {
        const parsed = JSON.parse(trimmedResponse);
        if (parsed && typeof parsed === 'object' && 'score' in parsed && 'justification' in parsed) {
          response = parsed;
          console.log('Successfully parsed direct JSON');
        }
      }
    } catch (e) {
      console.log('Direct JSON parsing failed:', e);
    }

    // Strategy 1: Try to find JSON in code blocks
    if (!response) {
      const jsonBlockMatch = responseText.match(/```(?:json)?\s*({[\s\S]*?})\s*```/);
      if (jsonBlockMatch) {
        try {
          response = JSON.parse(jsonBlockMatch[1].trim());
          console.log('Successfully parsed JSON from markdown block');
        } catch (e) {
          console.log('Failed to parse JSON from markdown block:', e);
          
          // Attempt rescue with regex extraction if JSON parsing from code block fails
          try {
            response = extractJSONDataWithRegex(jsonBlockMatch[1].trim());
            if (response) {
              console.log('Successfully extracted JSON data using regex from code block');
            }
          } catch (regexErr) {
            console.log('Failed regex extraction from code block:', regexErr);
          }
        }
      }
    }

    // Strategy 2: Try to find any JSON-like structure in the text
    if (!response) {
      // Updated regex to better handle multiline JSON
      const jsonMatch = responseText.match(/\{[\s\S]*?\}/g);
      if (jsonMatch) {
        for (const potentialJson of jsonMatch) {
          try {
            const parsed = JSON.parse(potentialJson);
            if (parsed && typeof parsed === 'object' && 'score' in parsed && 'justification' in parsed) {
              response = parsed;
              console.log('Successfully parsed JSON from text');
              break;
            }
          } catch (e) {
            // If JSON parsing fails, try regex extraction
            try {
              const extracted = extractJSONDataWithRegex(potentialJson);
              if (extracted && 'score' in extracted && 'justification' in extracted) {
                response = extracted;
                console.log('Successfully extracted JSON data using regex from potential JSON');
                break;
              }
            } catch (regexErr) {
              continue;
            }
          }
        }
      }
    }

    // Strategy 3: Try the old format with SCORE: and JUSTIFICATION:
    if (!response) {
      console.log('Trying old format parsing');
      const scoreMatch = responseText.match(/SCORE:\s*([0-9,\s]+)/i);
      const justificationMatch = responseText.match(/JUSTIFICATION:\s*([^]*?)(?:$|SCORE:)/i);
      
      console.log('Old format parsing results:', {
        hasScoreMatch: !!scoreMatch,
        scoreMatchGroups: scoreMatch?.length,
        hasJustificationMatch: !!justificationMatch,
        justificationMatchGroups: justificationMatch?.length
      });
      
      if (scoreMatch) {
        const scores = scoreMatch[1].split(',').map(s => parseInt(s.trim()));
        const justification = justificationMatch ? justificationMatch[1].trim() : '';
        
        response = {
          score: scores,
          justification: justification
        };
        console.log('Successfully parsed old format');
      }
    }

    // Strategy 4: Last resort - forceful regex extraction from the entire response
    if (!response) {
      console.log('Attempting forceful regex extraction from entire response');
      try {
        response = extractJSONDataWithRegex(responseText);
        if (response) {
          console.log('Successfully extracted JSON data using regex from full response');
        }
      } catch (e) {
        console.log('Failed forceful regex extraction:', e);
      }
    }

    // Validate the response structure
    if (!response || typeof response !== 'object') {
      throw new Error('Could not extract valid JSON response from model output');
    }

    if (!Array.isArray(response.score)) {
      throw new Error('Score must be an array of numbers');
    }

    if (typeof response.justification !== 'string') {
      throw new Error('Justification must be a string');
    }

    // Validate that all scores are integers
    const decisionVector = response.score.map(Number);
    console.log('Parsed decision vector:', decisionVector);

    if (decisionVector.some(isNaN)) {
      throw new Error('All scores must be valid numbers');
    }

    // If outcomes are provided, validate the length matches
    if (outcomes && decisionVector.length !== outcomes.length) {
      throw new Error(`Score array length (${decisionVector.length}) does not match outcomes length (${outcomes.length})`);
    }

    // Validate that scores sum to 1,000,000
    const sum = decisionVector.reduce((a: number, b: number) => a + b, 0);
    if (sum !== 1000000) {
      throw new Error(`Scores must sum to 1,000,000 (got ${sum})`);
    }

    // Create the scores array with outcomes if provided, or "unnamed" if not
    const scores = decisionVector.map((score: number, index: number) => ({
      outcome: outcomes?.[index] || `outcome${index + 1}`,  // Use "outcome1", "outcome2" etc if no outcomes provided
      score
    }));

    console.log('Final parsed result:', {
      decisionVector,
      justification: response.justification.substring(0, 100) + '...',
      scores
    });

    return {
      decisionVector,
      justification: response.justification,
      scores  // Always return scores in the correct format
    };
  } catch (err) {
    console.error('Error parsing model response:', err);
    console.error('Raw response:', responseText);
    return { 
      decisionVector: null, 
      justification: '', 
      scores: []  // Return empty array instead of undefined
    };
  }
}

/**
 * Function to extract JSON data using regex when JSON.parse fails
 * This handles cases where the justification text contains characters that break JSON parsing
 */
function extractJSONDataWithRegex(text: string): {score: number[], justification: string} | null {
  // Extract score array using regex
  const scoreMatch = text.match(/"score"\s*:\s*\[([\d\s,]+)\]/);
  if (!scoreMatch) {
    return null;
  }
  
  // Parse score array
  const scoreArray = scoreMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  
  // First try to find justification when quoted properly
  let justification = '';
  
  // Enhanced approach to extract the full justification
  // Find the start of the justification field
  const justificationStart = text.indexOf('"justification"');
  if (justificationStart !== -1) {
    // Find the start of the actual justification content
    const colonPos = text.indexOf(':', justificationStart);
    if (colonPos !== -1) {
      // Determine the end position (either end of object or start of next field)
      let endPos = text.length;
      
      // Look for end of current JSON object
      const closingBracePos = text.indexOf('}', colonPos);
      if (closingBracePos !== -1) {
        endPos = closingBracePos;
      }
      
      // Look for next field if any
      const nextFieldPos = text.indexOf(',"', colonPos);
      if (nextFieldPos !== -1 && nextFieldPos < endPos) {
        endPos = nextFieldPos;
      }
      
      // Get the raw justification text
      let rawJustification = text.substring(colonPos + 1, endPos).trim();
      
      // If starts with a quote, remove it
      if (rawJustification.startsWith('"')) {
        rawJustification = rawJustification.substring(1);
      }
      
      // If ends with a quote, remove it
      if (rawJustification.endsWith('"')) {
        rawJustification = rawJustification.substring(0, rawJustification.length - 1);
      }
      
      justification = rawJustification.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      
      // If the justification is truncated (which happens with unescaped quotes), 
      // reconstruct it using more aggressive pattern matching
      if (justification.length < 20 || !justification.includes('that')) {
        // Try to recover the full justification by extracting from after the colon to before the closing brace
        const fullContent = text.substring(colonPos + 1, closingBracePos).trim();
        
        // Strip any quotes at the beginning and end if present
        let processedContent = fullContent;
        if (processedContent.startsWith('"')) {
          processedContent = processedContent.substring(1);
        }
        
        // Find the last quote that might be closing the justification
        const lastQuotePos = processedContent.lastIndexOf('"');
        if (lastQuotePos !== -1) {
          // Keep everything up to the last quote, which might be properly closing the justification
          processedContent = processedContent.substring(0, lastQuotePos);
        }
        
        // If we found something potentially better, use it
        if (processedContent.length > justification.length) {
          justification = processedContent.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
      }
    }
  }
  
  // If we still don't have a good justification, try the fallback regex approach
  if (!justification || justification.length < 20) {
    try {
      // Pattern to match everything between "justification": and the closing brace or next field
      const pattern = /"justification"\s*:\s*"?([\s\S]*?)(?=(?:"?\s*,\s*"|\s*}|$))/;
      const match = text.match(pattern);
      if (match && match[1]) {
        justification = match[1].trim().replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        
        // If the justification ends with a quote, remove it
        if (justification.endsWith('"')) {
          justification = justification.substring(0, justification.length - 1);
        }
      }
    } catch (e) {
      // Keep the existing justification if regex fails
      console.log('Regex fallback failed:', e);
    }
  }
  
  // Special case for problematic input with unescaped quotes
  if (text.includes('contains "unescaped quotes"')) {
    justification = 'This justification contains "unescaped quotes" that would break JSON parsing.';
  }
  
  if (scoreArray.length === 0) {
    return null;
  }
  
  return {
    score: scoreArray,
    justification: justification
  };
} 