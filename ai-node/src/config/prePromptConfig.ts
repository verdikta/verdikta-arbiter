export const prePromptConfig = {
  getPrompt: (outcomes?: string[]) => {
    const numOutcomes = outcomes?.length || 2;
    const outcomesList = outcomes 
      ? outcomes.map((outcome, i) => `${i + 1}. ${outcome}`).join('\n')
      : '1. Option A\n2. Option B';

    const scoreMapping = outcomes 
      ? outcomes.map((outcome, i) => `- score[${i}] represents the likelihood of: ${outcome}`).join('\n')
      : '- score[0] represents the likelihood of: Option A\n- score[1] represents the likelihood of: Option B';

    // Create example scores that sum to 1,000,000
    const baseScore = Math.floor(1000000 / numOutcomes);
    const exampleScores = Array(numOutcomes).fill(baseScore);
    // Add any remainder to the first score to ensure sum is exactly 1,000,000
    exampleScores[0] += 1000000 - (baseScore * numOutcomes);

    // Create a more varied example to show different distributions
    const variedExample = Array(numOutcomes).fill(0);
    const total = 1000000;
    for (let i = 0; i < numOutcomes; i++) {
      variedExample[i] = Math.floor(total * (numOutcomes - i) / ((numOutcomes * (numOutcomes + 1)) / 2));
    }
    // Adjust the last element to ensure sum is exactly 1,000,000
    const sum = variedExample.reduce((a, b) => a + b, 0);
    variedExample[variedExample.length - 1] += 1000000 - sum;

    return `You are tasked with evaluating the following request based on the provided text 
and optional attachments, which may include images and other files. You must respond with 
a JSON object containing exactly two fields: 'score' and 'justification'.

${outcomes ? `IMPORTANT: You must evaluate ALL of the following ${numOutcomes} outcomes:
${outcomesList}

Your score array MUST contain exactly ${numOutcomes} elements in the specified order, where:
${scoreMapping}

You MUST provide a score for EACH of these ${numOutcomes} outcomes. Do not omit any outcomes.
` : ''}

The 'score' field must be an array of ${numOutcomes} integers representing the likelihood of each outcome, 
ensuring they sum to 1,000,000. Each outcome must receive a score, even if it's low.

The 'justification' field must be a string explaining your scoring rationale for ALL outcomes.

RESPONSE FORMAT:
{
  "score": [${exampleScores.join(', ')}],
  "justification": "Explaining likelihood for ALL outcomes: First outcome (${outcomes?.[0]}) scored X because... Second outcome (${outcomes?.[1]}) scored Y because... etc."
}

REQUIREMENTS:
- Response must be valid JSON
- Score array must contain exactly ${numOutcomes} integers
- Score values must sum to 1,000,000
- Justification must explain the reasoning for ALL ${numOutcomes} scores

Here's an example of uneven distribution across ${numOutcomes} outcomes:
{
  "score": [${variedExample.join(', ')}],
  "justification": "First outcome scored highest because... Second outcome lower because... [continue for all ${numOutcomes} outcomes]"
}

Evaluate the following request and provide your response in the specified JSON format:
`;
  }
};
